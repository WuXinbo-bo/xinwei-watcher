(() => {
  'use strict';

  const CFG = {
    minThreshold: 0.81,
    maxThreshold: 0.90,
    maxWatchCount: 3,
    pollInterval: 1000,
    clickDelayMin: 900,
    clickDelayMax: 2200,
    documentStayMin: 5000,
    documentStayMax: 9000,
    switchSettleMin: 2500,
    switchSettleMax: 4800,
    hoverDelayMin: 80,
    hoverDelayMax: 220,
    beforeClickDelayMin: 120,
    beforeClickDelayMax: 360,
    afterExpandDelayMin: 300,
    afterExpandDelayMax: 900,
    cooldownMin: 1800,
    cooldownMax: 3200,
    // 仿真行为配置
    scrollIntervalMin: 8000,
    scrollIntervalMax: 18000,
    scrollAmountMin: 30,
    scrollAmountMax: 120,
    idleMouseMoveChance: 0.4,
    idleMouseMoveMin: 80,
    idleMouseMoveMax: 260
  };

  const state = {
    running: false,
    watchedCount: 0,
    targetThreshold: null,
    targetItems: [],
    pendingItems: [],
    videoItems: [],
    visitedKeys: new Set(),
    timer: null,
    logBox: null,
    armed: true,
    switching: false,
    scrollTimer: null
  };

  const SELECTORS = {
    menuItems: [
      '.section-item',
      '[class*="section-item"]',
      '[class*="catalog-item"]',
      '[class*="directory-item"]',
      'li.el-menu-item[role="menuitem"]',
      'li.el-menu-item',
      '.el-menu-item[role="menuitem"]',
      '.el-menu-item',
      'div.section-content',
      '.section-content',
      '.section-area .section-content',
      'ul.el-menu.el-menu--inline li',
      '.courseware-list li',
      '.courseware-list-item',
      '.catalog-list li',
      '.directory-list li'
    ],
    videoIcons: [
      'i.unStart-icon',
      'i.inProgress-icon',
      'i.done-icon',
      'i[class*="unStart"]',
      'i[class*="inProgress"]',
      'i[class*="done"]',
      '.unStart-icon',
      '.inProgress-icon',
      '.done-icon',
      'i[class*="audio"]',
      'i[class*="music"]',
      'i[class*="video"]',
      'i[class*="play"]',
      '[class*="audio-icon"]',
      '[class*="music-icon"]',
      '[class*="video-icon"]',
      '[class*="play-icon"]',
      'svg[class*="audio"]',
      'svg[class*="music"]',
      'svg[class*="video"]',
      'svg[class*="play"]'
    ],
    pendingIcons: [
      'i.unStart-icon',
      'i.inProgress-icon',
      'i[class*="unStart"]',
      'i[class*="inProgress"]',
      '.unStart-icon',
      '.inProgress-icon'
    ],
    chapterRoots: [
      'li.el-sub-menu',
      'li.el-menu-item-group',
      '.el-menu-item-group',
      '.section-area',
      '.courseware-chapter',
      '.chapter-item',
      '.catalog-chapter'
    ],
    chapterTitles: [
      '.el-sub-menu__title',
      '.el-menu-item-group__title',
      '.section-area .el-menu-item-group__title',
      '.courseware-tab-header',
      '.courseware-chapter__title',
      '.courseware__chapter-head',
      '.courseware-chapter-main__title',
      '.chapter-title',
      '.catalog-title'
    ],
    progressTexts: [
      '.progress-text',
      '.study-progress',
      '.course-progress',
      '.video-progress',
      '.current-progress',
      '[class*="progress"]'
    ],
    mediaRoots: [
      'video',
      'audio',
      '.video-js video',
      '.vjs-tech',
      '.audio-player audio',
      '.player-wrapper video',
      '.player-wrapper audio'
    ]
  };

  function log(msg, type = 'info') {
    const prefix = type === 'ok' ? '✅' : type === 'err' ? '⚠️' : 'ℹ️';
    console.log(`${prefix} ${msg}`);
    if (!state.logBox) return;
    const div = document.createElement('div');
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    div.style.color = type === 'ok' ? '#1a7f37' : type === 'err' ? '#d1242f' : '#666';
    state.logBox.appendChild(div);
    state.logBox.scrollTop = state.logBox.scrollHeight;
  }

  function rnd(min, max) {
    return min + Math.random() * (max - min);
  }

  function rndi(min, max) {
    return Math.floor(rnd(min, max + 1));
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // === 仿真行为：鼠标轨迹 ===
  function getBezierPoint(t, p0, p1, p2, p3) {
    const c1 = 3 * (p1 - p0);
    const c2 = 3 * (p2 - p1) - c1;
    const c3 = p3 - p0 - c1 - c2;
    return p0 + c1 * t + c2 * t * t + c3 * t * t * t;
  }

  async function moveMouseAlongBezier(fromX, fromY, toX, toY) {
    const cpX1 = fromX + (toX - fromX) * (0.2 + Math.random() * 0.3);
    const cpY1 = fromY + (toY - fromY) * (0.1 + Math.random() * 0.2) + (Math.random() - 0.5) * 200;
    const cpX2 = fromX + (toX - fromX) * (0.5 + Math.random() * 0.3);
    const cpY2 = fromY + (toY - fromY) * (0.2 + Math.random() * 0.3) + (Math.random() - 0.5) * 200;
    const steps = Math.floor(rnd(8, 18));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = getBezierPoint(t, fromX, cpX1, cpX2, toX);
      const y = getBezierPoint(t, fromY, cpY1, cpY2, toY);
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, view: window,
        clientX: Math.round(x), clientY: Math.round(y)
      }));
      await sleep(rnd(8, 22));
    }
  }

  async function randomIdleMouseMove(el) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const rangeX = window.innerWidth * 0.6;
    const rangeY = window.innerHeight * 0.4;
    const startX = cx + (Math.random() - 0.5) * rangeX;
    const startY = cy + (Math.random() - 0.5) * rangeY;
    const endX = cx + (Math.random() - 0.5) * rangeX;
    const endY = cy + (Math.random() - 0.5) * rangeY;
    await moveMouseAlongBezier(startX, startY, endX, endY);
    await sleep(rndi(CFG.idleMouseMoveMin, CFG.idleMouseMoveMax));
  }

  async function randomHumanScroll() {
    const mainContent = document.querySelector('.course-main, .video-container, .player-wrapper, .main-content') || document.body;
    const amount = rndi(CFG.scrollAmountMin, CFG.scrollAmountMax) * (Math.random() < 0.5 ? 1 : -1);
    mainContent.scrollBy({ top: amount, behavior: 'smooth' });
    await sleep(rnd(400, 900));
  }

  function injectUI() {
    if (document.getElementById('wb-study-ui')) return;

    const style = document.createElement('style');
    style.textContent = `
      #wb-study-ui{
        position:fixed;right:18px;top:90px;width:340px;z-index:999999;
        background:#fff;border:1px solid #e6e6e6;border-radius:12px;
        box-shadow:0 8px 28px rgba(0,0,0,.16);font:13px/1.4 PingFang SC,Arial,sans-serif;color:#222;
        user-select:none;
      }
      #wb-study-ui .hd{
        padding:10px 12px;background:#005eff;color:#fff;border-radius:12px 12px 0 0;
        display:flex;justify-content:space-between;align-items:center;font-weight:700;cursor:move;
      }
      #wb-study-ui .bd{padding:12px}
      #wb-study-ui .row{display:flex;justify-content:space-between;align-items:center;margin:6px 0}
      #wb-study-ui input[type="number"]{
        width:82px;border:1px solid #ddd;border-radius:8px;padding:5px 8px;font:12px PingFang SC;
      }
      #wb-study-ui input[type="checkbox"]{width:16px;height:16px;accent-color:#005eff}
      #wb-study-ui .btn{
        width:100%;border:none;border-radius:10px;padding:9px 10px;margin-top:8px;cursor:pointer;font-weight:700;
      }
      #wb-study-ui .scan{background:#f3f3f3;color:#333}
      #wb-study-ui .start{background:#005eff;color:#fff}
      #wb-study-ui .stop{background:#ff8200;color:#fff}
      #wb-study-ui .kv{display:flex;justify-content:space-between;gap:8px;font-size:12px;margin:4px 0;color:#444}
      #wb-study-ui .log{
        margin-top:8px;height:180px;overflow:auto;background:#fafafa;border:1px solid #eee;border-radius:10px;padding:8px;font-size:11px;
      }
      #wb-study-ui .section{
        margin-top:10px;padding-top:10px;border-top:1px solid #efefef;
      }
      #wb-study-ui .section-title{
        display:flex;justify-content:space-between;align-items:center;
        font-size:12px;font-weight:700;color:#333;margin-bottom:6px;
      }
      #wb-study-ui .section-meta{
        font-size:11px;color:#666;font-weight:400;
      }
      #wb-study-ui .dir-list{
        max-height:220px;overflow:auto;background:#fafafa;border:1px solid #eee;border-radius:10px;padding:6px;
      }
      #wb-study-ui .dir-item{
        display:block;width:100%;border:none;background:#fff;border-radius:8px;
        padding:7px 8px;margin:4px 0;text-align:left;font-size:12px;line-height:1.35;
        color:#333;cursor:pointer;border:1px solid #ececec;
      }
      #wb-study-ui .dir-item:hover{border-color:#005eff;background:#f5f8ff}
      #wb-study-ui .dir-item small{
        display:block;margin-top:3px;color:#7a7a7a;font-size:11px;
      }
      #wb-study-ui .dir-item.is-pending{
        border-color:#bfd4ff;background:#f6f9ff;
      }
      #wb-study-ui .dir-badge{
        display:inline-flex;align-items:center;justify-content:center;
        min-width:46px;height:20px;padding:0 6px;margin-left:8px;border-radius:999px;
        font-size:11px;font-weight:700;
      }
      #wb-study-ui .dir-badge.pending{background:#e8f1ff;color:#005eff}
      #wb-study-ui .dir-badge.done{background:#ebf8ee;color:#1a7f37}
      #wb-study-ui .dir-head{
        display:flex;justify-content:space-between;align-items:flex-start;gap:8px;
      }
      #wb-study-ui .dir-empty{
        font-size:12px;color:#888;padding:6px 4px;
      }
      #wb-study-ui .mini{cursor:pointer;font-size:18px}
    `;
    document.head.appendChild(style);

    const box = document.createElement('div');
    box.id = 'wb-study-ui';
    box.innerHTML = `
      <div class="hd" id="wb-drag">
        <span>课程监督助手</span>
        <span class="mini" id="wb-min">−</span>
      </div>
      <div class="bd" id="wb-body">
        <div class="kv"><span>状态</span><span id="wb-status">未开始</span></div>
        <div class="kv"><span>当前进度</span><span id="wb-progress">-</span></div>
        <div class="kv"><span>随机阈值</span><span id="wb-threshold">-</span></div>
        <div class="kv"><span>已完成数量</span><span id="wb-count">0</span></div>
        <div class="kv"><span>目标数量</span><span id="wb-target">0</span></div>

        <div class="row"><span>最小阈值</span><input id="wb-minp" type="number" step="0.01" min="0.5" max="0.99" value="${CFG.minThreshold}"></div>
        <div class="row"><span>最大阈值</span><input id="wb-maxp" type="number" step="0.01" min="0.5" max="0.99" value="${CFG.maxThreshold}"></div>
        <div class="row"><span>自动完成数量</span><input id="wb-maxcount" type="number" step="1" min="1" max="999" value="${CFG.maxWatchCount}"></div>
        <div class="row"><span>自动继续</span><input id="wb-auto" type="checkbox" checked></div>

        <button class="btn scan" id="wb-scan">扫描目录</button>
        <button class="btn start" id="wb-start">开始监督</button>
        <button class="btn stop" id="wb-stop">暂停</button>

        <div class="section">
          <div class="section-title">
            <span>学习目录</span>
            <span class="section-meta">未完成 <span id="wb-pending-count">0</span> / 总数 <span id="wb-video-count">0</span></span>
          </div>
          <div class="dir-list" id="wb-video-list">
            <div class="dir-empty">暂未识别到学习目录</div>
          </div>
        </div>

        <div class="log" id="wb-log"></div>
      </div>
    `;
    document.body.appendChild(box);
    state.logBox = box.querySelector('#wb-log');

    let dragging = false, dx = 0, dy = 0;
    const drag = box.querySelector('#wb-drag');

    drag.addEventListener('mousedown', e => {
      dragging = true;
      dx = e.clientX - box.getBoundingClientRect().left;
      dy = e.clientY - box.getBoundingClientRect().top;
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      box.style.left = `${e.clientX - dx}px`;
      box.style.top = `${e.clientY - dy}px`;
      box.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => dragging = false);

    box.querySelector('#wb-min').addEventListener('click', () => {
      const body = box.querySelector('#wb-body');
      body.style.display = body.style.display === 'none' ? '' : 'none';
    });

    box.querySelector('#wb-scan').addEventListener('click', scanDirectory);
    box.querySelector('#wb-start').addEventListener('click', start);
    box.querySelector('#wb-stop').addEventListener('click', stop);
  }

  function getMenuItems() {
    const seen = new Set();
    const items = [];

    const addItem = el => {
      const itemEl = normalizeCourseItem(el);
      const title = itemTitle(itemEl);
      if (!title || title.length < 2) return;
      const key = getItemKey(itemEl);
      if (!key || seen.has(key)) return;
      seen.add(key);
      items.push(itemEl);
    };

    getStructuredMediaItems().forEach(addItem);

    SELECTORS.menuItems.forEach(selector => {
      document.querySelectorAll(selector).forEach(addItem);
    });

    inferMediaItemsFromDirectory().forEach(addItem);

    return items.filter(isLikelyCourseItem);
  }

  function normalizeCourseItem(el) {
    if (!el) return null;
    return el.closest([
      'li.el-menu-item[role="menuitem"]',
      'li.el-menu-item',
      '.section-item',
      '[class*="section-item"]',
      '[class*="catalog-item"]',
      '[class*="directory-item"]',
      'div.section-content',
      '.section-content',
      '.el-menu-item[role="menuitem"]',
      '.el-menu-item',
      '.courseware-list-item'
    ].join(', ')) || el;
  }

  function isUnstartedItem(el) {
    if (!isLeafCourseItem(el)) return false;
    const host = getStatusHost(el);
    return SELECTORS.pendingIcons.some(selector => host.querySelector(selector));
  }

  function isVideoItem(el) {
    if (!isLeafCourseItem(el)) return false;
    if (!looksLikePlayableMedia(el)) return false;
    const host = getStatusHost(el);
    return hasMediaDuration(el) || SELECTORS.videoIcons.some(selector => host.querySelector(selector));
  }

  function isDocumentItem(el) {
    if (!isLeafCourseItem(el)) return false;
    const text = getPrimaryItemText(el);
    if (!text) return false;
    if (!/(ppt|课件|讲义|教材|文档|资料|pdf|doc|docx|slides)/i.test(text)) return false;
    return !hasMediaDuration(el);
  }

  function isActionableItem(el) {
    return isVideoItem(el) || isDocumentItem(el);
  }

  function itemTitle(el) {
    return getPrimaryItemText(el).slice(0, 90);
  }

  function getChapterTitle(chapterEl) {
    const titleEl = getChapterTitleEl(chapterEl);
    return titleEl ? (titleEl.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  }

  function getItemKey(el) {
    if (!el) return '';
    const title = itemTitle(el);
    const chapter = getChapterTitle(getChapterRoot(el));
    return `${chapter}__${title}`;
  }

  function isLikelyCourseItem(el) {
    const text = getPrimaryItemText(el);
    if (!text) return false;
    if (el.querySelector('ul, .section-area, .directory-list, .catalog-list') && !el.matches('div.section-content, .section-content, li.el-menu-item, .el-menu-item')) {
      return false;
    }
    if (/^(目录|笔记|课程资料|课程互动)$/.test(text)) return false;
    if (text.length < 3) return false;
    return true;
  }

  function isLeafCourseItem(el) {
    if (!el) return false;
    if (el.matches('li.el-menu-item[role="menuitem"], li.el-menu-item')) return true;
    return !el.querySelector([
      '.section-item',
      '[class*="section-item"]',
      '.section-content',
      'li.el-menu-item',
      '.el-menu-item',
      '.courseware-list-item'
    ].join(', '));
  }

  function looksLikePlayableMedia(el) {
    const text = getPrimaryItemText(el);
    if (!text) return false;
    if (/(讲义|教材|资料|文档|作业|考试|测试|笔记)/.test(text)) return false;
    if (/小节共/.test(text)) return false;
    if (/^(part\s*[ivx0-9]+|unit\s*\d+\s*(audio|video)?|专题|章节|课程章节)$/i.test(text)) return false;
    return hasMediaDuration(el) || /(track|audio|video|听力|口语|录音|音频)/i.test(text);
  }

  function getStatusHost(el) {
    if (!el) return document.createElement('div');
    return el.closest('.section-item, .section-content, li.el-menu-item, .el-menu-item, .courseware-list-item, .section-area') || el.parentElement || el;
  }

  function hasMediaDuration(el) {
    if (!el) return false;
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    return /([0-9]{1,2}\s*[:：]\s*[0-9]{2})|([0-9]{1,2}\s*分\s*[0-9]{1,2}\s*秒)/.test(text);
  }

  function inferMediaItemsFromDirectory() {
    const root = findDirectoryRoot();
    if (!root) return [];

    const nodes = root.querySelectorAll('div, li, button, a');
    const items = [];

    nodes.forEach(node => {
      if (!hasMediaDuration(node)) return;
      const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 160) return;
      if (/^(课程章节|目录|课程资料|课程互动|笔记)$/i.test(text)) return;
      const item = node.closest([
        'li.el-menu-item[role="menuitem"]',
        'li.el-menu-item',
        '.section-item',
        '[class*="section-item"]',
        '[class*="catalog-item"]',
        '[class*="directory-item"]',
        'div.section-content',
        '.section-content',
        '.el-menu-item',
        '.courseware-list-item'
      ].join(', ')) || node;
      items.push(item);
    });

    return items;
  }

  function findDirectoryRoot() {
    return document.querySelector([
      '.sub-menu-area',
      'li.el-sub-menu.is-opened > ul.el-menu.el-menu--inline',
      'ul.el-menu.el-menu--inline',
      '.section-area',
      '[class*="directory"]',
      '[class*="catalog"]',
      '[class*="course-chapter"]',
      '[class*="courseware"]'
    ].join(', '));
  }

  function getStructuredMediaItems() {
    const items = [];

    document.querySelectorAll('li.el-menu-item-group').forEach(group => {
      group.querySelectorAll(':scope > ul > li.el-menu-item[role="menuitem"], :scope > ul > li.el-menu-item').forEach(item => {
        items.push(item);
      });
    });

    document.querySelectorAll('li.el-sub-menu.is-opened > ul.el-menu.el-menu--inline > li.el-menu-item[role="menuitem"], li.el-sub-menu.is-opened > ul.el-menu.el-menu--inline > li.el-menu-item').forEach(item => {
      items.push(item);
    });

    return items;
  }

  function getPrimaryItemText(el) {
    if (!el) return '';
    const lines = (el.innerText || '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!lines.length) return '';

    const primary = lines.find(line => {
      if (/小节共/.test(line)) return false;
      if (/^(目录|笔记|课程资料|课程互动)$/.test(line)) return false;
      return true;
    }) || lines[0];

    return primary.replace(/\s+/g, ' ').trim();
  }

  function getChapterRoot(el) {
    return el ? el.closest(SELECTORS.chapterRoots.join(', ')) : null;
  }

  function isChapterExpanded(chapterEl) {
    if (!chapterEl) return false;
    const cls = chapterEl.className || '';
    const aria = chapterEl.getAttribute('aria-expanded');
    return cls.includes('is-opened') || cls.includes('is-active') || aria === 'true';
  }

  function getChapterTitleEl(chapterEl) {
    if (!chapterEl) return null;
    return chapterEl.querySelector(SELECTORS.chapterTitles.join(', '));
  }

  async function humanClick(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const targetX = rect.left + rect.width * (0.2 + Math.random() * 0.6);
    const targetY = rect.top + rect.height * (0.2 + Math.random() * 0.6);

    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rndi(CFG.beforeClickDelayMin, CFG.beforeClickDelayMax));

    const scrollRect = el.getBoundingClientRect();
    const finalX = scrollRect.left + scrollRect.width * (0.2 + Math.random() * 0.6);
    const finalY = scrollRect.top + scrollRect.height * (0.2 + Math.random() * 0.6);

    const fromX = rnd(100, window.innerWidth - 100);
    const fromY = rnd(100, window.innerHeight - 100);
    await moveMouseAlongBezier(fromX, fromY, finalX, finalY);
    await sleep(rndi(60, 180));

    if (Math.random() < CFG.idleMouseMoveChance) {
      await randomIdleMouseMove();
    }

    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, view: window,
      clientX: Math.round(finalX), clientY: Math.round(finalY)
    }));
    await sleep(rndi(CFG.hoverDelayMin, CFG.hoverDelayMax));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    await sleep(rndi(40, 100));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    await sleep(rndi(35, 110));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    await sleep(rndi(35, 120));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (typeof el.click === 'function') el.click();
    return true;
  }

  async function expandChapterForItem(itemEl) {
    const chapter = getChapterRoot(itemEl);
    if (!chapter || isChapterExpanded(chapter)) return;
    const titleEl = getChapterTitleEl(chapter);
    if (!titleEl) return;
    log(`展开章节：${(titleEl.innerText || '').trim().slice(0, 30)}`, 'ok');
    await humanClick(titleEl);
    await sleep(rndi(CFG.afterExpandDelayMin, CFG.afterExpandDelayMax));
  }

  async function clickMenuItemSafe(el) {
    if (!el) return false;
    await expandChapterForItem(el);
    await sleep(rndi(150, 400));
    const times = rndi(1, 2);
    for (let i = 0; i < times; i++) {
      await humanClick(el);
      await sleep(rndi(120, 260));
    }
    return true;
  }

  function getActiveMediaEl() {
    for (const selector of SELECTORS.mediaRoots) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  async function waitForMediaSwitch(previousProgress) {
    const settleDelay = rndi(CFG.switchSettleMin, CFG.switchSettleMax);
    await sleep(settleDelay);

    const startedAt = Date.now();
    while (Date.now() - startedAt < 12000) {
      const mediaEl = getActiveMediaEl();
      const progress = parseProgressText();
      const currentTime = mediaEl && Number.isFinite(mediaEl.currentTime) ? mediaEl.currentTime : null;
      const readyEnough = !mediaEl || mediaEl.readyState >= 2;
      const progressChanged = progress != null && (previousProgress == null || Math.abs(progress - previousProgress) >= 0.005 || progress < 0.05);
      const timeAdvanced = currentTime != null && currentTime >= 0;

      if (readyEnough && (progressChanged || timeAdvanced)) {
        await sleep(rndi(600, 1200));
        return true;
      }

      await sleep(500);
    }

    log('媒体加载等待超时，继续监控', 'err');
    return false;
  }

  function renderVideoDirectory(videoItems, pendingItems) {
    const listEl = document.getElementById('wb-video-list');
    const videoCountEl = document.getElementById('wb-video-count');
    const pendingCountEl = document.getElementById('wb-pending-count');
    if (!listEl || !videoCountEl || !pendingCountEl) return;

    const pendingKeys = new Set(pendingItems.map(getItemKey));
    const orderedItems = sortActionableItems(videoItems, pendingKeys);

    videoCountEl.textContent = String(videoItems.length);
    pendingCountEl.textContent = String(pendingItems.length);
    listEl.innerHTML = '';

    if (!orderedItems.length) {
      const empty = document.createElement('div');
      empty.className = 'dir-empty';
      empty.textContent = '暂未识别到学习目录';
      listEl.appendChild(empty);
      return;
    }

    orderedItems.forEach((el, idx) => {
      const btn = document.createElement('button');
      btn.className = 'dir-item';
      const title = itemTitle(el);
      const chapter = getChapterTitle(getChapterRoot(el));
      const pending = pendingKeys.has(getItemKey(el));
      const itemType = isDocumentItem(el) ? '文档' : '媒体';
      if (pending) btn.classList.add('is-pending');
      btn.innerHTML = `
        <div class="dir-head">
          <span>${idx + 1}. ${title}</span>
          <span class="dir-badge ${pending ? 'pending' : 'done'}">${pending ? '未完成' : '已完成'}</span>
        </div>
        <small>${[chapter, itemType].filter(Boolean).join(' · ')}</small>
      `;
      btn.addEventListener('click', async () => {
        log(`打开条目：${title}`, 'ok');
        await clickMenuItemSafe(el);
      });
      listEl.appendChild(btn);
    });
  }

  function refreshDirectories(options = {}) {
    const { render = true, logSummary = true } = options;
    const items = getMenuItems();
    const actionableItems = items.filter(isActionableItem);
    const pendingItems = sortActionableItems(actionableItems.filter(isUnstartedItem));
    const videoItems = sortActionableItems(actionableItems);

    state.videoItems = videoItems;
    state.pendingItems = pendingItems;
    state.targetItems = videoItems;

    if (render) renderVideoDirectory(videoItems, pendingItems);
    if (document.getElementById('wb-target')) {
      document.getElementById('wb-target').textContent = String(pendingItems.length);
    }
    if (logSummary) {
      log(`扫描完成，学习目录 ${videoItems.length} 个`, 'ok');
      log(`扫描完成，未完成条目 ${pendingItems.length} 个`, 'ok');
      pendingItems.slice(0, 10).forEach((el, i) => log(`未完成候选 ${i + 1}: ${itemTitle(el)}`));
    }

    return { videoItems, pendingItems };
  }

  function scanDirectory() {
    return refreshDirectories({ render: true, logSummary: true }).pendingItems;
  }

  function sortActionableItems(items, pendingKeys = null) {
    return [...items].sort((a, b) => compareActionableItems(a, b, pendingKeys));
  }

  function compareActionableItems(a, b, pendingKeys = null) {
    if (pendingKeys) {
      const aPending = pendingKeys.has(getItemKey(a)) ? 0 : 1;
      const bPending = pendingKeys.has(getItemKey(b)) ? 0 : 1;
      if (aPending !== bPending) return aPending - bPending;
    }

    const aDoc = isDocumentItem(a) ? 1 : 0;
    const bDoc = isDocumentItem(b) ? 1 : 0;
    if (aDoc !== bDoc) return aDoc - bDoc;

    const aDuration = getDurationSeconds(a);
    const bDuration = getDurationSeconds(b);
    const aHasDuration = Number.isFinite(aDuration) ? 0 : 1;
    const bHasDuration = Number.isFinite(bDuration) ? 0 : 1;
    if (aHasDuration !== bHasDuration) return aHasDuration - bHasDuration;
    if (aHasDuration === 0 && aDuration !== bDuration) return aDuration - bDuration;

    return itemTitle(a).localeCompare(itemTitle(b), 'zh-CN');
  }

  function getDurationSeconds(el) {
    if (!el) return Number.NaN;
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const hm = text.match(/([0-9]{1,2})\s*[:：]\s*([0-9]{2})(?:\s*[:：]\s*([0-9]{2}))?/);
    if (hm) {
      if (hm[3] != null) return Number(hm[1]) * 3600 + Number(hm[2]) * 60 + Number(hm[3]);
      return Number(hm[1]) * 60 + Number(hm[2]);
    }
    const cm = text.match(/([0-9]{1,2})\s*分\s*([0-9]{1,2})\s*秒/);
    if (cm) return Number(cm[1]) * 60 + Number(cm[2]);
    return Number.NaN;
  }

  function parseProgressText() {
    for (const selector of SELECTORS.progressTexts) {
      for (const el of document.querySelectorAll(selector)) {
        const text = (el.innerText || el.textContent || '').trim();
        const m = text.match(/已观看\s*([0-9]+(?:\.[0-9]+)?)\s*%/);
        if (m) return Number(m[1]) / 100;
      }
    }

    const text = document.body.innerText || '';
    const all = [...text.matchAll(/已观看\s*([0-9]+(?:\.[0-9]+)?)\s*%/g)];
    if (!all.length) return null;
    const last = all[all.length - 1];
    return last ? Number(last[1]) / 100 : null;
  }

  function refreshProgressUI(pct) {
    document.getElementById('wb-progress').textContent = pct == null ? '未识别' : `${(pct * 100).toFixed(1)}%`;
  }

  function setThreshold() {
    const min = Math.max(0.5, Math.min(0.99, Number(document.getElementById('wb-minp').value) || CFG.minThreshold));
    const max = Math.max(min, Math.min(0.99, Number(document.getElementById('wb-maxp').value) || CFG.maxThreshold));
    const th = rnd(min, max);
    state.targetThreshold = th;
    document.getElementById('wb-threshold').textContent = `${(th * 100).toFixed(1)}%`;
    log(`本次阈值：${(th * 100).toFixed(1)}%`, 'ok');
    return th;
  }

  function nextUnstartedItem() {
    const { pendingItems } = refreshDirectories({ render: true, logSummary: false });
    return pendingItems.find(el => !state.visitedKeys.has(getItemKey(el))) || null;
  }

  async function cooldown() {
    state.armed = false;
    const cd = rndi(CFG.cooldownMin, CFG.cooldownMax);
    await randomHumanScroll();
    await sleep(cd);
    state.armed = true;
  }

  async function advanceToNext() {
    if (!state.running || state.switching) return;
    state.switching = true;
    state.armed = false;
    const previousProgress = parseProgressText();

    const maxCount = Math.max(1, Number(document.getElementById('wb-maxcount').value) || CFG.maxWatchCount);
    if (state.watchedCount >= maxCount) {
      log(`达到自动完成数量 ${maxCount}，停止`, 'ok');
      state.switching = false;
      stop();
      return;
    }

    const next = nextUnstartedItem();
    if (!next) {
      log('没有更多未完成视频', 'err');
      state.switching = false;
      stop();
      return;
    }

    state.watchedCount += 1;
    document.getElementById('wb-count').textContent = String(state.watchedCount);
    state.visitedKeys.add(getItemKey(next));
    const isDoc = isDocumentItem(next);
    log(`切换到第 ${state.watchedCount} 个：${itemTitle(next)}${isDoc ? '（文档）' : ''}`, 'ok');

    await clickMenuItemSafe(next);
    if (isDoc) {
      const stayMs = rndi(CFG.documentStayMin, CFG.documentStayMax);
      log(`文档停留 ${Math.round(stayMs / 1000)} 秒后继续`, 'ok');
      await sleep(stayMs);
      await cooldown();
      state.switching = false;
      if (state.running && state.armed) {
        await advanceToNext();
      }
      return;
    }

    await sleep(rndi(500, 1200));
    await waitForMediaSwitch(previousProgress);
    setThreshold();
    await cooldown();

    state.switching = false;
  }

  function startIdleScrollLoop() {
    function tick() {
      if (!state.running) return;
      randomHumanScroll().then(() => {
        state.scrollTimer = setTimeout(tick, rndi(CFG.scrollIntervalMin, CFG.scrollIntervalMax));
      });
    }
    state.scrollTimer = setTimeout(tick, rndi(CFG.scrollIntervalMin, CFG.scrollIntervalMax));
  }

  function stopIdleScrollLoop() {
    if (state.scrollTimer) {
      clearTimeout(state.scrollTimer);
      state.scrollTimer = null;
    }
  }

  async function poll() {
    if (!state.running) return;

    const p = parseProgressText();
    refreshProgressUI(p);

    if (p == null) {
      state.timer = setTimeout(poll, CFG.pollInterval);
      return;
    }

    if (state.armed && !state.switching && p >= state.targetThreshold) {
      log(`达到阈值 ${(state.targetThreshold * 100).toFixed(1)}%，准备切换`, 'ok');
      if (document.getElementById('wb-auto').checked) {
        setTimeout(() => {
          if (state.running && state.armed && !state.switching) advanceToNext();
        }, rndi(CFG.clickDelayMin, CFG.clickDelayMax));
      } else {
        stop();
        return;
      }
    }

    state.timer = setTimeout(poll, CFG.pollInterval);
  }

  function start() {
    state.visitedKeys.clear();
    scanDirectory();
    state.running = true;
    state.watchedCount = 0;
    state.armed = true;
    state.switching = false;
    document.getElementById('wb-status').textContent = '运行中';
    document.getElementById('wb-count').textContent = '0';
    setThreshold();
    log('开始监督', 'ok');
    if (state.timer) clearTimeout(state.timer);
    poll();
    startIdleScrollLoop();
  }

  function stop() {
    state.running = false;
    state.armed = true;
    state.switching = false;
    document.getElementById('wb-status').textContent = '已暂停';
    log('已暂停', 'err');
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    stopIdleScrollLoop();
  }

  injectUI();
  scanDirectory();
  log('脚本已注入，可直接点击开始监督', 'ok');

  window.__wbStudyTest = { start, stop, scanDirectory, refreshDirectories, state };
})();
