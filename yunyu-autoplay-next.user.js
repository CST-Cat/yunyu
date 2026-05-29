// ==UserScript==
// @name         蕴瑜课堂手动启动循环播放下一集
// @namespace    http://tampermonkey.net/
// @version      1.4
// @icon         https://courses.gdut.edu.cn/pluginfile.php/1/theme_lambda2/favicon/1776322049/favicon.ico
// @description  手动启动后等待当前视频结束，自动切下一集，并在切集后自动播放
// @match        https://courses.gdut.edu.cn/mod/fsresource/view.php*
// @match        https://jyresource.gdut.edu.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
功能说明：
1. 默认不启动。只有点击右下角“启动”后，才进入循环模式。
2. 当前页启动后先默默待机，只监听 video/audio 或常见播放器的“播放结束”事件，不立刻自动播放当前页。
3. 当前视频自然结束后，优先从 Moodle/蕴瑜课堂左侧课程索引寻找下一集并自动跳转。
4. 脚本自动切到下一集后，才会对新页面做一次有限重试的自动播放。
5. 下一集开始播放后继续待机，等待下一次自然结束，然后重复“切集 -> 自动播放 -> 待机”。
6. 不使用 setInterval 常驻扫描；播放器暂未出现时，只做几次短延迟重试。
7. 不倍速、不伪造观看进度、不跳过视频。
8. 不处理或绕过“按住通过”等课堂注意力校验，也不伪造页面前台、焦点或可见性状态。
*/

(function () {
  'use strict';

  const SOURCE = 'yy-next-watcher';
  const STORAGE_KEY = 'yy_next_watcher_enabled_v1';
  const AUTOPLAY_AFTER_NAV_KEY = 'yy_next_watcher_autoplay_after_nav_v1';
  const LEGACY_KEYS_TO_CLEAR = [
    'yy_auto_play_next_enabled',
    'yy_auto_single_playback_lock_v1',
    'yy_auto_single_playback_lock_v2'
  ];
  const RETRY_DELAYS = [500, 1500, 4000, 8000];
  const AUTOPLAY_RETRY_DELAYS = [300, 1000, 2500, 5000, 9000];
  const isCourseVideoPage = location.hostname === 'courses.gdut.edu.cn' && location.pathname === '/mod/fsresource/view.php';
  const isResourcePlayerPage = location.hostname === 'jyresource.gdut.edu.cn';
  const shouldRun = isCourseVideoPage || isResourcePlayerPage;
  const isTopWindow = window.top === window.self;
  const wiredMedia = new WeakSet();
  const wiredPlayers = new WeakSet();
  let runtimeEnabled = false;
  let nextTriggered = false;
  let retryTimers = [];
  let autoplayTimers = [];
  let autoPlayForThisLoad = false;

  for (const key of LEGACY_KEYS_TO_CLEAR) {
    try {
      localStorage.removeItem(key);
    } catch (_) {}
  }

  if (!shouldRun) return;

  function storedEnabled() {
    return localStorage.getItem(STORAGE_KEY) === '1';
  }

  function isEnabled() {
    return isCourseVideoPage ? storedEnabled() : runtimeEnabled;
  }

  function setEnabled(value) {
    runtimeEnabled = value;
    if (isCourseVideoPage) {
      localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    }
  }

  function shouldAutoplayAfterNavigation() {
    return isCourseVideoPage && localStorage.getItem(AUTOPLAY_AFTER_NAV_KEY) === '1';
  }

  function setAutoplayAfterNavigation(value) {
    if (!isCourseVideoPage) return;
    if (value) {
      localStorage.setItem(AUTOPLAY_AFTER_NAV_KEY, '1');
    } else {
      localStorage.removeItem(AUTOPLAY_AFTER_NAV_KEY);
    }
  }

  function setStatus(message) {
    const status = document.querySelector('#yy-auto-status');
    if (status) status.textContent = message;
  }

  function clearRetries() {
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers = [];
  }

  function clearAutoplayRetries() {
    for (const timer of autoplayTimers) clearTimeout(timer);
    autoplayTimers = [];
  }

  function createPanel() {
    if (!isTopWindow || document.querySelector('#yy-auto-panel')) return;

    const style = document.createElement('style');
    style.textContent = `
      #yy-auto-panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 10px;
        color: #fff;
        background: rgba(20, 24, 32, .92);
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, .24);
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #yy-auto-panel button {
        min-width: 48px;
        border: 0;
        border-radius: 6px;
        padding: 6px 9px;
        cursor: pointer;
        color: #fff;
        background: #2f80ed;
      }
      #yy-auto-panel button.secondary {
        background: #4b5563;
      }
      #yy-auto-status {
        max-width: 190px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `;
    document.documentElement.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'yy-auto-panel';
    panel.innerHTML = `
      <button id="yy-auto-toggle" type="button"></button>
      <button id="yy-auto-next" class="secondary" type="button">下一集</button>
      <span id="yy-auto-status"></span>
    `;
    document.body.appendChild(panel);

    const toggle = document.querySelector('#yy-auto-toggle');
    const refreshToggle = () => {
      toggle.textContent = isEnabled() ? '停止' : '启动';
      setStatus(isEnabled() ? '待机中' : '未启动');
    };

    toggle.addEventListener('click', () => {
      setEnabled(!isEnabled());
      refreshToggle();

      if (isEnabled()) {
        armEndWatcher();
        broadcastEnabledToFrames(true, false);
      } else {
        clearRetries();
        clearAutoplayRetries();
        setAutoplayAfterNavigation(false);
        broadcastEnabledToFrames(false, false);
      }
    });

    document.querySelector('#yy-auto-next').addEventListener('click', () => goNext(true));
    refreshToggle();
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function getPlayerRoots() {
    const roots = [
      ...document.querySelectorAll('video,audio'),
      ...document.querySelectorAll('[aria-label*="视频播放器"]'),
      ...document.querySelectorAll('[role="region"][aria-label*="视频"]'),
      ...document.querySelectorAll('.vjs-player,.video-js,.tcplayer,.tcp-skin,.xgplayer')
    ];
    return roots.filter(isVisible);
  }

  function findPlayerPlayButton() {
    const roots = getPlayerRoots();
    if (!roots.length) return null;

    const buttonSet = new Set();
    for (const root of roots) {
      if (root.matches('video,audio')) {
        const container = root.closest('[aria-label*="视频播放器"],[role="region"],.vjs-player,.video-js,.tcplayer,.tcp-skin,.xgplayer') || root.parentElement;
        if (container) {
          container.querySelectorAll('button').forEach(button => buttonSet.add(button));
        }
      } else {
        root.querySelectorAll('button').forEach(button => buttonSet.add(button));
      }
    }

    return [...buttonSet].filter(isVisible).find(button => {
      const label = [
        button.title,
        button.getAttribute('aria-label'),
        button.textContent
      ].filter(Boolean).join(' ').trim();

      return /播放/i.test(label) && !/暂停/i.test(label);
    });
  }

  function clickPlayerPlayButton() {
    const button = findPlayerPlayButton();
    if (!button) return false;
    button.click();
    setStatus('已点击播放');
    return true;
  }

  function tryAutoplayOnce() {
    if (!isEnabled()) return true;

    const media = document.querySelector('video,audio');
    if (media) {
      wireMedia(media);
      media.autoplay = true;
      media.setAttribute('playsinline', 'playsinline');

      if (!media.paused && !media.ended) {
        setStatus('播放中');
        return true;
      }

      try {
        const result = media.play();
        if (result && typeof result.catch === 'function') {
          result
            .then(() => setStatus('播放中'))
            .catch(() => {
              if (!clickPlayerPlayButton()) setStatus('请手动播放');
            });
        } else {
          setTimeout(() => {
            if (!media.paused && !media.ended) setStatus('播放中');
          }, 500);
        }
        return true;
      } catch (_) {
        return clickPlayerPlayButton();
      }
    }

    return clickPlayerPlayButton();
  }

  function scheduleAutoplayAfterSwitch() {
    if (!isEnabled()) return;

    clearAutoplayRetries();
    setStatus('准备自动播放');

    if (tryAutoplayOnce()) return;

    autoplayTimers = AUTOPLAY_RETRY_DELAYS.map(delay => setTimeout(() => {
      if (!isEnabled()) return;
      if (tryAutoplayOnce()) clearAutoplayRetries();
    }, delay));
  }

  function wireMedia(media) {
    if (wiredMedia.has(media)) return false;
    wiredMedia.add(media);
    media.addEventListener('ended', onEnded);
    return true;
  }

  function wireVideoJs() {
    const videojs = window.videojs;
    if (!videojs) return 0;

    const players = videojs.getPlayers
      ? Object.values(videojs.getPlayers())
      : Object.values(videojs.players || {});

    let count = 0;
    for (const player of players) {
      if (!player || wiredPlayers.has(player)) continue;
      wiredPlayers.add(player);
      if (typeof player.on === 'function') {
        player.on('ended', onEnded);
        count += 1;
      }
    }
    return count;
  }

  function wireCurrentEndSignals() {
    let count = 0;
    for (const media of document.querySelectorAll('video,audio')) {
      wireMedia(media);
      count += 1;
    }
    count += wireVideoJs();
    return count;
  }

  function armEndWatcher(scheduleRetries = true) {
    if (!isEnabled()) return;

    clearRetries();
    const count = wireCurrentEndSignals();
    if (count > 0) {
      setStatus('待机中');
      return;
    }

    setStatus('等待播放器');
    if (!scheduleRetries) return;

    retryTimers = RETRY_DELAYS.map(delay => setTimeout(() => {
      if (!isEnabled()) return;
      const retryCount = wireCurrentEndSignals();
      if (retryCount > 0) {
        clearRetries();
        setStatus('待机中');
      }
    }, delay));
  }

  function onEnded() {
    if (!isEnabled() || nextTriggered) return;
    nextTriggered = true;

    if (isTopWindow) {
      setStatus('本集结束，切换中');
      setTimeout(() => goNext(false), 800);
    } else {
      window.parent.postMessage({ source: SOURCE, type: 'ended' }, '*');
    }
  }

  function samePageResource(url) {
    try {
      const current = new URL(location.href);
      const target = new URL(url, location.href);
      return target.pathname === current.pathname && target.searchParams.get('id') === current.searchParams.get('id');
    } catch (_) {
      return false;
    }
  }

  function isLessonLink(link) {
    if (!link.href) return false;
    try {
      const url = new URL(link.href, location.href);
      if (url.hash) return false;
      return url.origin === location.origin && /\/mod\/fsresource\/view\.php$/i.test(url.pathname) && url.searchParams.has('id');
    } catch (_) {
      return false;
    }
  }

  function getCourseIndexLessonLinks() {
    const roots = [
      document.querySelector('[data-region="courseindex"]'),
      document.querySelector('#courseindex'),
      document.querySelector('.courseindex'),
      document.querySelector('[role="tree"]')
    ].filter(Boolean);

    const scopedLinks = roots.flatMap(root => [...root.querySelectorAll('a[href]')]);
    const links = scopedLinks.length ? scopedLinks : [...document.querySelectorAll('a[href]')];

    const seen = new Set();
    return links.filter(link => {
      if (!isLessonLink(link)) return false;
      const href = new URL(link.href, location.href).href;
      if (seen.has(href)) return false;
      seen.add(href);
      return true;
    });
  }

  function findNextLessonLink() {
    const explicit = [
      '#next-activity-link',
      'a[rel="next"]',
      'a[data-region="next-activity"]',
      'a[aria-label*="下一"]',
      'a[title*="下一"]',
      'a[aria-label*="Next"]',
      'a[title*="Next"]'
    ];

    for (const selector of explicit) {
      const link = document.querySelector(selector);
      if (link && isLessonLink(link) && !samePageResource(link.href)) return link;
    }

    const textNext = [...document.querySelectorAll('a[href]')].find(link => {
      if (!isLessonLink(link)) return false;
      if (samePageResource(link.href)) return false;
      const text = (link.textContent || link.title || link.getAttribute('aria-label') || '').trim();
      return /(下一集|下一节|下一活动|下一个活动|Next)/i.test(text) && !/(上一|Previous|Prev)/i.test(text);
    });
    if (textNext) return textNext;

    const lessons = getCourseIndexLessonLinks();
    const currentIndex = lessons.findIndex(link => samePageResource(link.href));
    if (currentIndex < 0) return null;

    return lessons.slice(currentIndex + 1).find(link => !samePageResource(link.href)) || null;
  }

  function goNext(force) {
    if (!force && !isEnabled()) return;

    const link = findNextLessonLink();
    if (!link) {
      setStatus('没找到下一集');
      nextTriggered = false;
      return;
    }

    setStatus('正在进入下一集');
    if (isEnabled()) setAutoplayAfterNavigation(true);
    location.href = link.href;
  }

  function broadcastEnabledToFrames(enabled, autoplay) {
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        frame.contentWindow.postMessage({ source: SOURCE, type: 'set-enabled', enabled, autoplay }, '*');
      } catch (_) {}
    }
  }

  function handleMessage(event) {
    const data = event.data;
    if (!data || data.source !== SOURCE) return;

    if (data.type === 'ended') {
      onEnded();
      return;
    }

    if (data.type === 'ready' && isTopWindow && isEnabled()) {
      event.source.postMessage({ source: SOURCE, type: 'set-enabled', enabled: true, autoplay: autoPlayForThisLoad }, '*');
      return;
    }

    if (data.type === 'set-enabled' && !isTopWindow) {
      setEnabled(Boolean(data.enabled));
      if (isEnabled()) {
        armEndWatcher();
        if (data.autoplay) scheduleAutoplayAfterSwitch();
      } else {
        clearRetries();
        clearAutoplayRetries();
      }
    }
  }

  function init() {
    createPanel();
    window.addEventListener('message', handleMessage);

    if (isTopWindow) {
      if (isEnabled()) {
        autoPlayForThisLoad = shouldAutoplayAfterNavigation();
        setAutoplayAfterNavigation(false);
        armEndWatcher();
        if (autoPlayForThisLoad) scheduleAutoplayAfterSwitch();
        broadcastEnabledToFrames(true, autoPlayForThisLoad);
        setTimeout(() => broadcastEnabledToFrames(true, autoPlayForThisLoad), 1000);
      }
    } else {
      window.parent.postMessage({ source: SOURCE, type: 'ready' }, '*');
    }
  }

  init();
})();
