/* Presentation only: task execution remains in content.js/background.js. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const icons = {
    collapse: '<path d="m6 15 6-6 6 6"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 1.9-2.4 3.5M12 17h.01"/>',
    github: '<path d="M9 19c-4.3 1.3-4.3-2.2-6-2.7M15 22v-3.4c0-1 .1-1.6-.5-2.2 3.1-.4 6.4-1.5 6.4-7A5.4 5.4 0 0 0 19.4 6a5 5 0 0 0-.1-3.4S18.1 2.2 15 4a13.2 13.2 0 0 0-6 0C5.9 2.2 4.7 2.6 4.7 2.6A5 5 0 0 0 4.6 6a5.4 5.4 0 0 0-1.5 3.4c0 5.5 3.3 6.6 6.4 7-.5.5-.6 1.1-.5 2.2V22"/>',
    settings: '<path d="M9.17 5.16 L10.35 2.64 L13.65 2.64 L14.83 5.16 L14.83 5.16 L17.45 4.22 L19.78 6.55 L18.84 9.17 L18.84 9.17 L21.36 10.35 L21.36 13.65 L18.84 14.83 L18.84 14.83 L19.78 17.45 L17.45 19.78 L14.83 18.84 L14.83 18.84 L13.65 21.36 L10.35 21.36 L9.17 18.84 L9.17 18.84 L6.55 19.78 L4.22 17.45 L5.16 14.83 L5.16 14.83 L2.64 13.65 L2.64 10.35 L5.16 9.17 L5.16 9.17 L4.22 6.55 L6.55 4.22 L9.17 5.16Z"/><circle cx="12" cy="12" r="3.2"/>',
    sponsor: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/>',
    back: '<path d="m14 6-6 6 6 6"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3Z"/>',
    audio: '<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>',
    file: '<path d="M14 3H5v18h14V8Z M14 3v5h5M8 13h8m-8 4h6"/>'
  };
  const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`;
  const time = seconds => Number.isFinite(seconds) && seconds >= 0
    ? `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}` : '时长未知';
  const types = { video: '视频', audio: '音频', media: '音视频', document: '文档', other: '其他' };
  const courseStates = { uninspected: '待统计', inspected: '已统计', complete: '已确认', completed: '已确认', manual: '待处理', retry: '等待重试' };
  const isMedia = item => ['video', 'audio', 'media'].includes(item.mediaType);
  const button = (label, view, cls = '') => `<button type="button" class="btn ${cls}" data-ui-view="${view}">${esc(label)}</button>`;
  const note = text => `<p class="wb-note">${esc(text)}</p>`;
  const kv = (label, value) => `<div class="kv"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;

  function create({ getModel, imageUrl, promotion = {}, onReset, onLocate, onCourseAction, onFocusTask, onView, getShell, onRestoreShell }) {
    const box = document.createElement('section');
    box.id = 'wb-study-ui';
    box.setAttribute('aria-label', '芯位教育助手');
    box.innerHTML = `
      <header class="hd" id="wb-drag">
        <div class="wb-brand"><span>芯位教育助手</span></div>
        <a class="wb-icon" id="wb-github" href="https://github.com/WuXinbo-bo/xinwei-watcher" target="_blank" rel="noopener noreferrer" aria-label="GitHub 项目仓库（新标签页）" title="GitHub 项目仓库">${svg('github')}</a>
        <button class="wb-icon" id="wb-help" type="button" data-ui-view="help" aria-label="使用指南" title="使用指南">${svg('help')}</button>
        <button class="wb-icon" type="button" data-ui-view="settings" aria-label="设置" title="设置">${svg('settings')}</button>
        <button class="wb-icon" id="wb-min" type="button" aria-label="收起芯位教育助手" title="收起面板">${svg('collapse')}</button>
      </header>
      <aside class="wb-sponsor" id="wb-sponsor" aria-label="项目赞助" hidden>
        <a id="wb-sponsor-link" target="_blank" rel="noopener noreferrer sponsored"><span class="wb-sponsor-mark" aria-hidden="true"><img class="wb-sponsor-image" alt="" draggable="false"></span><span class="wb-sponsor-copy"><span class="wb-sponsor-label">项目赞助</span><span id="wb-sponsor-message"></span></span><span class="wb-sponsor-arrow" aria-hidden="true">↗</span></a>
      </aside>
      <div class="bd" id="wb-body">
        <section class="wb-view" data-view="home">
          <div class="wb-summary-card" id="wb-home-summary" hidden><div id="wb-home-task-progress"></div><div class="wb-course-progress" id="wb-home-course-progress" hidden></div></div>
          <div class="wb-learning-status"><div class="wb-status-line" id="wb-ui-status" role="status" aria-live="polite"></div><button class="wb-target-badge" id="wb-ui-target-badge" type="button" data-ui-view="settings" hidden></button></div>
          <h2 class="wb-title" id="wb-ui-title"></h2><p class="wb-subtitle" id="wb-ui-subtitle"></p>
          <div class="wb-playback-meta" id="wb-ui-progress" hidden><span id="wb-ui-progress-label"></span><span id="wb-ui-progress-text"></span></div>
          <p class="wb-caption" id="wb-ui-caption"></p>
          <p class="wb-notice" id="wb-ui-notice" hidden></p>
          <div class="wb-actions"><button class="btn primary start" id="wb-start" type="button">开始</button><button class="btn primary stop" id="wb-stop" type="button" hidden>暂停</button><button class="btn" id="wb-ui-directory" type="button" hidden>查看本课目录</button><button class="btn" id="wb-ui-results" type="button" data-ui-view="alerts" hidden>查看待处理事项</button><button class="btn" id="wb-ui-reset-retry" type="button" hidden>重试重置</button></div>
        </section>
        <section class="wb-view" data-view="courses" hidden></section>
        <section class="wb-view" data-view="course" hidden></section>
        <section class="wb-view" data-view="resource" hidden></section>
        <section class="wb-view" data-view="alerts" hidden>
          <button class="wb-link wb-back" type="button" data-ui-view="home">${svg('back')}任务首页</button>
          <h2 class="wb-title">待处理事项</h2><ul id="wb-manual-list" class="manual-empty" aria-live="polite"></ul>
        </section>
        <section class="wb-view" data-view="details" hidden>
          <button class="wb-link wb-back" type="button" data-ui-view="home">${svg('back')}任务首页</button>
          <h2 class="wb-title">任务概览</h2>
          <div class="wb-metrics" aria-label="任务统计">
            <div class="wb-metric" id="wb-metric-courses"><span>课程确认</span><strong id="wb-overview-courses">待扫描</strong><small>门</small></div>
            <div class="wb-metric" id="wb-metric-media"><span>音视频确认</span><strong id="wb-overview-media">待统计</strong><small>项</small></div>
            <button class="wb-metric" type="button" data-ui-view="alerts" aria-label="查看待处理事项"><span>待处理</span><strong id="wb-overview-alerts">0</strong><small>项</small></button>
          </div>
          <div class="wb-overview-current" id="wb-overview-current" hidden><span class="wb-caption" id="wb-overview-phase"></span><p id="wb-overview-course"></p><p class="wb-caption" id="wb-overview-resource" hidden></p></div>
          <div class="wb-actions wb-actions-inline">${button('待处理事项', 'alerts')}${button('运行日志', 'logs')}</div>
          <details class="wb-more" id="wb-overview-more" data-ui-disclosure="overview"><summary>更多统计与说明</summary>
            <div id="wb-ui-statistics"></div>
            <div id="wb-scan-performance"></div>
            <div class="kv"><span>课程任务</span><span id="wb-job-summary">尚未开始</span></div>
            <div class="kv"><span>本轮自然结束</span><span id="wb-count">0</span></div>
            <div class="kv"><span>当前课页面已确认</span><span id="wb-confirmed">—</span></div>
            <div class="kv"><span>页面考核点（参考）</span><span id="wb-course-progress">未识别</span></div>
            <p class="wb-caption">播放目标、自然结束与平台确认分别记录，不可相加。总数未统计完整时不显示完成比例。</p>
          </details>
        </section>
        <section class="wb-view" data-view="logs" hidden>
          <button class="wb-link wb-back" type="button" data-ui-view="details">${svg('back')}任务概览</button>
          <h2 class="wb-title">运行日志</h2><button class="log-new" id="wb-log-new" type="button" aria-live="polite" hidden></button>
          <div class="log" id="wb-log" role="log" aria-label="运行日志" aria-live="off"></div><p class="wb-caption" id="wb-ui-log-empty">还没有运行记录</p>
        </section>
        <section class="wb-view" data-view="settings" hidden>
          <button class="wb-link wb-back" type="button" data-ui-view="home">${svg('back')}任务首页</button><h2 class="wb-title">设置</h2>
          <section class="wb-setting-card wb-setting-target-card" aria-labelledby="wb-setting-target-title">
            <div class="wb-setting-card-head"><div><h3 id="wb-setting-target-title">播放目标</h3><p>达到目标后切换学习项，平台完成状态单独核对。</p></div><strong id="wb-setting-target-summary">100%</strong></div>
            <div class="wb-target-presets" role="group" aria-label="播放目标"><button type="button" data-target-preset="80" aria-pressed="false">80%</button><label class="wb-setting-input" for="wb-playback-target"><span>自定义目标</span><span class="target-value"><input id="wb-playback-target" type="number" min="80" max="100" step="1" value="100" aria-label="播放目标百分比"><span>%</span></span></label></div>
            <p class="wb-setting-feedback" id="wb-setting-feedback" role="status" aria-live="polite"></p>
          </section>
          <section class="wb-setting-card wb-setting-links" aria-labelledby="wb-setting-tools-title">
            <div class="wb-setting-card-head"><div><h3 id="wb-setting-tools-title">界面辅助</h3><p>查看任务状态和使用说明。</p></div></div>
            <button class="wb-setting-row" type="button" data-ui-view="details">任务概览与日志<span>›</span></button>
            <button class="wb-setting-row" type="button" data-ui-view="help">使用指南<span>›</span></button>
            <button class="wb-setting-row" type="button" data-ui-view="about">关于与项目赞助<span>›</span></button>
          </section>
          <section class="wb-setting-card wb-setting-danger" aria-labelledby="wb-setting-data-title">
            <div class="wb-setting-card-head"><div><h3 id="wb-setting-data-title">任务数据</h3><p>只清除插件记录，不影响网站学习进度。</p></div></div>
            <button class="wb-setting-row danger" id="wb-reset-menu" type="button" data-ui-view="reset">重置任务记录<span>›</span></button>
          </section>
        </section>
        <section class="wb-view" data-view="reset" hidden>
          <button class="wb-link wb-back" id="wb-reset-cancel" type="button" data-ui-view="settings">${svg('back')}取消</button>
          <h2 class="wb-title">重置任务记录？</h2><p class="wb-notice">将停止当前任务，清除本地任务、断点、课程统计、日志和错误记录。网站登录和学习进度不会删除。</p>
          <div class="wb-actions"><button class="btn danger" id="wb-reset" type="button">确认重置</button>${button('保留记录', 'settings')}</div>
        </section>
        <section class="wb-view" data-view="about" hidden></section>
        <section class="wb-view" data-view="help" hidden></section>
        <div class="wb-legacy" aria-hidden="true"><span id="wb-status"></span><span id="wb-current"></span><span id="wb-course"></span><span id="wb-progress"></span><div id="wb-notice"></div><span id="wb-manual"></span><span id="wb-manual-count"></span><span id="wb-video-count"></span><span id="wb-pending-count"></span><div id="wb-video-list"></div><button id="wb-scan" type="button">查看最新目录</button></div>
      </div>
      <nav class="wb-nav" id="wb-ui-nav" aria-label="助手导航"><button class="wb-link" type="button" data-ui-view="courses">全部课程</button><button class="wb-link" id="wb-ui-alert-link" type="button" data-ui-view="alerts" hidden></button><button class="wb-link" type="button" data-ui-view="details">概览</button></nav>
      <div class="wb-task-strip" id="wb-ui-task-strip" hidden><span id="wb-ui-task-label"></span><button class="wb-link" type="button" data-ui-view="home">回到任务</button></div>`;
    const $ = id => box.querySelector(`#${id}`);
    if (imageUrl) box.querySelector('.wb-sponsor-image').src = imageUrl;
    const body = $('wb-body');
    let view = 'home', selectedCourse = null, selectedResource = null, courseFilter = 'all', model = null;
    let helpReturn = 'home';
    let resourceFilter = 'all';
    let contentSignature = '', summarySignature = '', scheduled = false, runId = null;
    const scroll = new Map(), chapters = new Map(), disclosures = new Map();
    let restore = null, storageKey = null, preferencesReady = false, viewRevision = 0;
    const sponsor = $('wb-sponsor'), sponsorLink = $('wb-sponsor-link');
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let sponsorItems = [], sponsorSignature = '', sponsorIndex = 0;
    let sponsorTimer = null, sponsorFadeTimer = null, sponsorHover = false, sponsorFocus = false;
    function sponsorData() {
      if (!promotion.enabled || !String(promotion.brand || '').trim()) return null;
      try {
        const url = new URL(promotion.url);
        if (url.protocol !== 'https:') return null;
        const services = Array.isArray(promotion.services) ? promotion.services.filter(s => typeof s === 'string' && s.trim()) : [];
        return { url: url.href, brand: String(promotion.brand), items: [...new Set(services.length ? services : [String(promotion.tagline || promotion.brand)])] };
      } catch { return null; }
    }
    function stopSponsor() {
      window.clearTimeout(sponsorTimer); window.clearTimeout(sponsorFadeTimer);
      sponsorTimer = sponsorFadeTimer = null;
      sponsor.classList.remove('wb-sponsor-fading');
      sponsor.dataset.motion = 'static';
    }
    function showSponsor(data) {
      const label = `${data.brand} · ${sponsorItems[sponsorIndex]}`;
      $('wb-sponsor-message').textContent = label;
      sponsorLink.href = data.url;
      sponsorLink.title = `第三方商业服务：${label}`;
      sponsorLink.setAttribute('aria-label', `${label}，第三方商业服务，在新标签页打开`);
    }
    function syncSponsor() {
      const data = sponsorData();
      sponsor.hidden = !data;
      if (!data) { stopSponsor(); sponsorSignature = ''; return; }
      const signature = JSON.stringify(data);
      if (signature !== sponsorSignature) {
        stopSponsor(); sponsorSignature = signature; sponsorItems = data.items; sponsorIndex = 0; showSponsor(data);
      }
      const canAnimate = !reducedMotion?.matches &&
        !sponsorHover && !sponsorFocus && !document.hidden && !box.hidden && box.isConnected && view !== 'reset';
      if (!canAnimate) { stopSponsor(); return; }
      sponsor.dataset.motion = 'active';
      if (sponsorItems.length < 2) { stopSponsor(); sponsor.dataset.motion = 'active'; return; }
      if (sponsorTimer != null || sponsorFadeTimer != null) return;
      sponsorTimer = window.setTimeout(() => {
        sponsorTimer = null; sponsor.classList.add('wb-sponsor-fading');
        sponsorFadeTimer = window.setTimeout(() => {
          sponsorFadeTimer = null;
          sponsorIndex = (sponsorIndex + 1) % sponsorItems.length;
          showSponsor(data); sponsor.classList.remove('wb-sponsor-fading'); syncSponsor();
        }, 140);
      }, 10000);
    }
    sponsor.addEventListener('pointerenter', () => { sponsorHover = true; syncSponsor(); });
    sponsor.addEventListener('pointerleave', () => { sponsorHover = false; syncSponsor(); });
    sponsor.addEventListener('focusin', () => { sponsorFocus = true; syncSponsor(); });
    sponsor.addEventListener('focusout', event => { sponsorFocus = sponsor.contains(event.relatedTarget); syncSponsor(); });
    document.addEventListener('visibilitychange', syncSponsor);
    reducedMotion?.addEventListener?.('change', syncSponsor);
    window.addEventListener('pagehide', stopSponsor);
    window.addEventListener('pageshow', syncSponsor);
    const text = (id, value) => { const el = $(id); const valueText = String(value ?? ''); if (el.textContent !== valueText) el.textContent = valueText; };
    const title = (label, parent = 'home', parentLabel = '任务首页') => `<button class="wb-link wb-back" type="button" data-ui-view="${parent}">${svg('back')}${parentLabel}</button><h2 class="wb-title">${esc(label)}</h2>`;
    const courseKey = course => course.courseKey || course.key;
    const findCourse = () => model.courses.find(c => courseKey(c) === selectedCourse || c.key === selectedCourse);
    const isCourseComplete = course => ['complete', 'completed'].includes(course.status) && (!model.manualMode || course.scanState === 'ready');
    const progressData = course => model.overview.courseProgress.find(item => item.key === courseKey(course));
    const remaining = data => data.total == null ? null : Math.max(0, data.total - data.confirmed);
    function progressBar(label, confirmed, total) {
      if (total == null || total === 0) return '';
      const percent = Math.max(0, Math.min(100, Math.floor(confirmed / total * 100)));
      return `<div class="wb-completion-line"><div class="wb-track" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${confirmed} / ${total}，${percent}%"><div class="wb-fill" style="width:${percent}%" data-complete="${confirmed === total}"></div></div><span class="wb-percent">${percent}%</span></div>`;
    }
    function taskSummary() {
      if (model.manualMode) {
        const busy = model.job?.running || model.operationPending || model.resetPending;
        const loading = ['go-agent', 'entry-home', 'scan-home'].includes(model.job?.phase);
        return '<div class="wb-summary-heading"><strong>已发现 ' + model.courses.length + ' 门课程</strong><button class="wb-link" type="button" data-refresh-list ' + (busy ? 'disabled' : '') + '>重新加载</button></div>' +
          (loading ? '<p class="wb-progress-meta" role="status">正在读取完整课表，请稍候…</p>' : '') +
          '<div class="wb-home-courses" role="region" aria-label="已发现的课程" tabindex="0">' +
          (model.courses.map((c, index) => homeCourseCard(c, index)).join('') || note(loading ? '课程会在识别后逐步显示。' : '没有发现正在上的课程，可重新扫描课表。')) + '</div>';
      }
      const o = model.overview, pending = o.courseTotal == null ? null : Math.max(0, o.courseTotal - o.courseConfirmed);
      const scanning = ['go-agent', 'entry-home', 'scan-home'].includes(model.job?.phase);
      return `<div class="wb-summary-heading"><button type="button" class="wb-link" data-course-filter="all">课程总览 <span aria-hidden="true">›</span></button><span class="wb-summary-total">${o.courseTotal == null ? scanning ? '扫描中' : '待扫描' : `共 ${o.courseTotal} 门`}</span></div>` +
        (o.courseTotal == null ? `<p class="wb-summary-discovered">已发现 ${model.courses.length} 门课程</p>` :
          `<div class="wb-summary-counts"><button type="button" data-course-filter="complete">已完成 <strong>${o.courseConfirmed}</strong> 门</button><button type="button" data-course-filter="pending">待完成 <strong>${pending}</strong> 门</button></div>`) +
        progressBar('课程完成比例（平台确认）', o.courseConfirmed, o.courseTotal) +
        (model.courses.some(c => c.status === 'manual') ? `<button class="wb-summary-attention" type="button" data-course-filter="attention">其中待处理 ${model.courses.filter(c => c.status === 'manual').length} 门 <span aria-hidden="true">›</span></button>` : '');
    }
    function learningProgress(course, interactive = false) {
      const data = progressData(course);
      if (!data) return '';
      const count = data.total == null ? `${data.confirmed ? `已完成 ${data.confirmed} 项 · ` : ''}总数统计中` :
        data.total === 0 ? '本课没有音视频学习项' : `已完成 ${data.confirmed} 项 · 待完成 ${remaining(data)} 项`;
      return `<div class="wb-learning-heading">${interactive ? '<button type="button" class="wb-link" data-current-directory>本课学习项 <span aria-hidden="true">›</span></button>' : '<span>本课学习项</span>'}<span class="wb-learning-count">${data.total == null ? '统计中' : `${data.confirmed} / ${data.total}`}</span></div>` +
        progressBar('本课学习项完成比例（平台确认）', data.confirmed, data.total) + `<p class="wb-progress-meta">${count}</p>`;
    }
    function resourceStatus(item, course) {
      const record = course.records?.[item.key];
      if (record?.confirmed || item.observedCompleted === true) return '平台已确认';
      if (model.activeCourseKey === courseKey(course) && model.activeResourceKey === item.key && model.job?.running && model.job.targetPurpose !== 'inspect') return '正在学习';
      if (record?.error) return '失败待处理';
      if (record?.targetReached) return '达到播放目标';
      if (record?.ended) return '自然结束 · 待确认';
      if (record?.started || record?.attempted) return '处理中断';
      return model.manualMode && course.scanState === 'ready' && isMedia(item) ? '待完成' : course.live ? '未开始' : '暂无播放记录';
    }
    function courseCount(course) {
      if (!Array.isArray(course.directory?.items)) return Number.isInteger(course.total) ? `音视频 ${course.total} 项` : '音视频数量待统计';
      const counts = { video: 0, audio: 0, media: 0 };
      course.directory.items.forEach(item => { if (item.mediaType in counts) counts[item.mediaType] += 1; });
      return Object.entries(counts).filter(([, n]) => n).map(([kind, n]) => `${types[kind]} ${n}`).join(' · ') || '没有可处理的音视频';
    }
    function courseLabel(course) {
      if (model.manualMode) {
        if (model.job?.running && model.job.selectedIndex === model.courses.indexOf(course)) return model.job.operation === 'inspect' ? '正在扫描' : '正在学习';
        if (course.scanState === 'error') return '扫描未完成';
        if (course.scanState === 'paused') return '扫描已暂停';
        if (course.scanState !== 'ready') return course.scannedAt ? '待重新核对' : '尚未扫描';
        return isCourseComplete(course) ? '音视频已确认' : '待完成 ' + (course.remaining ?? '—') + ' 项';
      }
      if (model.activeCourseKey === courseKey(course) && model.job?.running) return model.job.targetPurpose === 'inspect' ? '正在统计' : '正在处理';
      return courseStates[course.status] || (course.live ? '当前课程' : '待统计');
    }
    function courseActions(c) {
      if (!model.manualMode) return '';
      const disabled = model.job?.running || model.operationPending || model.resetPending || !model.job ? ' disabled' : '';
      const index = model.courses.indexOf(c);
      const scan = '<button class="btn" type="button" data-course-action="inspect" data-action-course="' + index + '"' + disabled + '>' + (c.scannedAt ? '重扫本课目录' : '扫描目录') + '</button>';
      return '<div class="wb-actions wb-actions-inline wb-course-actions">' + learningAction(c, index) + scan + '</div>';
    }
    function learningAction(c, index) {
      const active = model.job?.targetIndex === index;
      const running = active && model.job?.running;
      const paused = active && model.job?.phase === 'paused';
      const disabled = model.job?.running || model.operationPending || model.resetPending || !model.job ||
        (paused && model.job.ownerTabId !== model.tabId);
      if (running) return '<span class="wb-course-state" role="status">' + (model.job.operation === 'inspect' ? '扫描中' : '学习中') + '</span>';
      const label = paused ? '继续学习' :
        c.scanState === 'error' ? '重试本课' : isCourseComplete(c) ? '重新核对' : '开始学习';
      return '<button class="btn primary wb-course-start" type="button" data-course-action="' + (paused ? 'continue' : 'learn') + '" data-action-course="' + index + '" aria-label="' + esc(label + '：' + c.title) + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
    }
    function homeCourseCard(c, index) {
      const status = model.job?.running && model.job.targetIndex === index ?
        '' :
        c.scanState === 'error' ? '目录未完整读取，请重试' :
        c.scanState === 'ready' ? isCourseComplete(c) ? '音视频已完成' : '' :
        c.scannedAt ? '待重新核对' : '点击开始，自动扫描本课';
      const scanning = c.scanState === 'scanning' || (model.job?.running && model.job.targetIndex === index && model.job.operation === 'inspect');
      const drawerKey = 'course-drawer:' + index;
      const data = progressData(c);
      let drawer = '';
      if (scanning) disclosures.delete(drawerKey);
      if (!scanning && c.scanState === 'ready' && data && data.total != null) {
        const reveal = !disclosures.has(drawerKey);
        if (!disclosures.has(drawerKey)) disclosures.set(drawerKey, model.job?.targetIndex === index);
        const open = disclosures.get(drawerKey);
        drawer = '<div class="wb-course-drawer" data-open="' + open + '" data-reveal="' + (reveal && open) + '"><button class="wb-drawer-toggle" type="button" data-course-drawer="' + index + '" aria-expanded="' + open + '" aria-controls="wb-drawer-' + index + '" title="展开或收起学习项"><span class="wb-drawer-count" aria-label="音视频已确认数与总数">' + data.confirmed + ' / ' + data.total + '</span><span class="wb-drawer-chevron" aria-hidden="true">' + svg('chevron') + '</span></button><div class="wb-drawer-body" id="wb-drawer-' + index + '" aria-hidden="' + !open + '"' + (open ? '' : ' inert') + '><div class="wb-drawer-clip"><div class="wb-drawer-content">' + progressBar('本课学习项完成比例（平台确认）', data.confirmed, data.total) + '<div class="wb-drawer-footer"><span>' + (data.total ? '待完成 ' + remaining(data) + ' 项' : '没有音视频') + '</span><button class="wb-link" type="button" data-course="' + index + '">查看明细 ›</button></div></div></div></div></div>';
      }
      return '<article class="wb-home-course" data-current="' + (model.job?.targetIndex === index) + '"><div class="wb-home-course-row"><button class="wb-home-course-info" type="button" data-course="' + index + '" aria-label="查看课程详情：' + esc(c.title) + '"><strong>' + esc(c.title) + '</strong>' + (status ? '<span>' + esc(status) + '</span>' : '') + '</button>' + learningAction(c, index) + '</div>' + drawer + '</article>';
    }
    function coursesPage() {
      const inspected = model.courses.filter(c => model.manualMode ? c.scanState === 'ready' : Array.isArray(c.directory?.items) || Number.isInteger(c.total)).length;
      const filters = model.manualMode ? { all: '全部', unscanned: '尚未扫描', pending: '待完成', complete: '已确认' } : { all: '全部', complete: '已完成', pending: '待完成', attention: '待处理' };
      const visible = model.courses.map((c, index) => ({c, index})).filter(({c}) =>
        courseFilter === 'all' || (courseFilter === 'complete' ? isCourseComplete(c) : courseFilter === 'unscanned' ? c.scanState !== 'ready' : courseFilter === 'pending' ? model.manualMode ? c.scanState === 'ready' && c.remaining > 0 : !isCourseComplete(c) : c.status === 'manual'));
      let html = title('全部课程') + '<p class="wb-caption">' + (model.courses.length ? model.courses.length + ' 门课程 · 已统计 ' + inspected + ' 门' : '尚未建立课程列表') + '</p>';
      if (model.courses.length) {
        html += '<div class="wb-filters" role="group" aria-label="筛选课程">' + Object.entries(filters).map(([key, label]) => '<button type="button" data-course-filter="' + key + '" aria-pressed="' + (courseFilter === key) + '">' + label + '</button>').join('') + '</div>';
        html += '<p class="wb-caption">仅查看目录，不会切换播放。</p>';
      }
      if (model.manualMode) html += '<p class="wb-caption">开始学习会先核对目录，再处理本课；也可以只扫描目录。</p>' + (!model.job?.running ? '<button class="wb-link" type="button" data-refresh-list ' + (model.operationPending || model.resetPending ? 'disabled' : '') + '>更新课程列表</button>' : '');
      if (!model.courses.length) return html + note(model.manualMode ? '点击获取课程列表，再选择一门课扫描目录。' : '开始任务后将扫描正在上的课程。扫描期间，已发现的课程会逐步出现在这里。');
      return html + (visible.map(({c, index}) => {
        const row = '<button class="wb-course-row" type="button" data-course="' + index + '"><span class="wb-row-main"><span class="wb-row-title">' + esc(c.title) + '</span><span class="wb-row-meta">' + esc(courseCount(c)) + '</span></span><span class="wb-row-status" data-active="' + (model.activeCourseKey === courseKey(c)) + '">' + esc(courseLabel(c)) + ' ›</span></button>';
        return model.manualMode ? '<div class="wb-course-choice">' + row + courseActions(c) + '</div>' : row;
      }).join('') || note('暂无符合此分类的课程。'));
    }
    function coursePage() {
      const c = findCourse();
      if (!c) return title('课程已更新', 'courses', '全部课程') + note('这门课已不在当前任务中。请返回课程列表查看。');
      const items = c.directory?.items;
      let html = title(c.title, 'courses', '全部课程') + `<p class="wb-caption">${esc(courseCount(c))}</p><div class="wb-course-progress">${learningProgress(c)}</div>`;
      html += courseActions(c);
      if (model.manualMode && c.scannedAt) html += '<details class="wb-more wb-scan-info" data-ui-disclosure="scan-info"><summary>扫描信息' + (!c.live || c.directoryStale ? ' · 目录快照' : '') + '</summary><p class="wb-caption">上次完整扫描：' + esc(new Date(c.scannedAt).toLocaleString('zh-CN', { hour12: false })) + '</p><p class="wb-caption">' + (c.scanState !== 'ready' ? '历史结果，开始学习时重新核对。' : '统计使用已保存的任务记录；目录快照供查看。') + '</p></details>';
      if (model.manualMode && c.scanError) html += note(c.scanError);
      if (!items) {
        if (model.job?.running && model.activeCourseKey === courseKey(c)) return html + note('正在读取课程目录，请稍候。已识别的条目会在目录就绪后显示。');
        if (c.failures?.length || c.status === 'manual') return html + note(`目录尚未读取完成，请检查网站页面。${(c.failures || []).join('；')}`);
        return html + note(model.manualMode ? '尚未读取这门课的目录。“开始学习”会核对目录后自动学习；“扫描目录”只读取结果。' : '尚未读取这门课的目录。统计完成后会展示音视频明细。');
      }
      if ((!c.live || c.directoryStale) && !model.manualMode) html += note('当前显示上次读取的目录，平台状态可能已变化。');
      if (!items.length) return html + note('已读取目录，本课没有可处理的音视频。文档、考试和作业需自行处理。');
      const media = items.filter(isMedia), others = items.filter(i => !isMedia(i));
      html += '<div class="wb-filters" role="group" aria-label="学习项筛选">' + [['all', '全部'], ['pending', '待完成']].map(([key, label]) => '<button type="button" data-resource-filter="' + key + '" aria-pressed="' + (resourceFilter === key) + '">' + label + '</button>').join('') + '</div>';
      const groups = new Map();
      for (const item of media) { if (resourceFilter === 'pending' && resourceStatus(item, c) === '平台已确认') continue; const group = item.chapterTitle || '音视频目录'; if (!groups.has(group)) groups.set(group, []); groups.get(group).push(item); }
      const orderedGroups = [...groups].sort((a, b) => Number(b[1].some(i => i.key === model.activeResourceKey)) - Number(a[1].some(i => i.key === model.activeResourceKey)));
      for (const [name, rows] of orderedGroups) {
        const key = `${selectedCourse}:${name}`;
        const current = rows.some(i => i.key === model.activeResourceKey);
        const open = chapters.has(key) ? chapters.get(key) : current || groups.size === 1;
        html += `<details class="wb-chapter" data-chapter="${esc(key)}" ${open ? 'open' : ''}><summary>${esc(name)} · ${rows.length} 项</summary>`;
        for (const item of rows) {
          const index = items.indexOf(item), status = resourceStatus(item, c);
          html += `<button class="wb-resource-row" type="button" data-resource="${index}"><span class="wb-media-icon">${svg(item.mediaType)}</span><span class="wb-row-main"><span class="wb-row-title">${esc(item.title)}</span><span class="wb-row-meta">${types[item.mediaType]} · ${time(item.durationSeconds)}</span></span><span class="wb-row-status" data-active="${status === '正在学习'}">${status} ›</span></button>`;
        }
        html += '</details>';
      }
      if (others.length) html += `<details class="wb-chapter"><summary>其他资源 · ${others.length} 项，不自动处理</summary>${others.map(i => `<div class="wb-row-meta">${esc(i.title)} · ${types[i.mediaType] || '其他'}</div>`).join('')}</details>`;
      if (!media.length) html += note('这门课只有其他类型的资源，没有可自动处理的音视频。');
      else if (!groups.size) html += note('没有待完成的音视频。');
      return html;
    }
    function resourcePage() {
      const c = findCourse(), item = c?.directory?.items.find(i => i.key === selectedResource);
      if (!item) return title('资源已更新', 'course', '课程目录') + note('当前任务中已无法确认该条目，请回到目录重新查看。');
      const record = c.records?.[item.key];
      const current = c.live && model.activeResourceKey === item.key;
      const confirmed = Boolean(record?.confirmed || item.observedCompleted);
      let html = title(item.title, 'course', '课程目录') + `<p class="wb-caption">${esc(c.title)}${item.chapterTitle ? ` · ${esc(item.chapterTitle)}` : ''}</p>`;
      html += kv('资源类型', types[item.mediaType] || '其他') + kv('时长', time(item.durationSeconds)) + kv('任务记录', resourceStatus(item, c));
      if (current && model.media) html += kv('当前播放位置', time(model.media.position));
      html += kv('播放目标', `${record?.effectiveTarget ?? model.job?.targetPercent ?? model.target}%`);
      html += kv('自然结束', record?.ended === true ? '已记录' : '尚无记录');
      html += kv('平台确认', confirmed ? '已确认' : '尚未确认');
      if (record?.error && !confirmed) html += `<p class="wb-notice wb-error">需处理：${esc(record.error)}</p>`;
      if (record?.recovery?.attempts) html += kv('恢复尝试', record.recovery.attempts);
      if (c.live && item.locatable) html += `<div class="wb-actions"><button class="btn" type="button" data-ui-locate="${esc(item.key)}" title="仅滚动到网页条目，不切换播放">定位到网页条目</button></div>`;
      html += `<details class="wb-more" data-ui-disclosure="${esc(`resource:${selectedCourse}:${selectedResource}`)}"><summary>状态说明</summary><p class="wb-caption">达到播放目标不等于自然结束，也不等于平台已确认完成。</p>${record?.error && confirmed ? `<p class="wb-caption">此前记录：${esc(record.error)}。平台当前已确认。</p>` : ''}</details>`;
      return html;
    }
    function helpPage() {
      return `<button class="wb-link wb-back" type="button" data-help-return>${svg('back')}返回原面板</button><h2 class="wb-title">使用指南</h2>
        <p class="wb-caption">先核对课程，再开始学习。查看指南不会暂停或切换任务。</p>
        <ol class="wb-guide-steps"><li><strong>获取课程列表</strong><p>登录芯位蜜线，打开助手并点击“获取课程列表”。助手只读取课表，完成后等待你选择，不会逐门进入课程。</p></li>
        <li><strong>首页直接选课</strong><p>扫描完成后，课程卡片直接显示在首页。点击“开始学习”，自动进入所选课程，核对完整目录后开始学习。点击课程名称只查看已有结果。</p></li>
        <li><strong>设置播放目标</strong><p>点击齿轮设置 80%–100% 目标。有效整数立即保存，当前正常播放在下一次检查采用新值；异常重试保持 100%。达到目标与平台确认分别记录。</p></li>
        <li><strong>单课结束与暂停</strong><p>只处理所选课程，结束后等待你选择下一门。扫描期间暂停也会取消后续播放；需要继续时点击“继续学习”。收起面板只隐藏界面。</p></li></ol>
        <details class="wb-more" data-ui-disclosure="guide-rules"><summary>任务规则</summary><p class="wb-caption">按需扫描，一次只处理所选课程的音视频。异常恢复时使用 100% 播放目标；完成状态以平台页面确认为准。</p></details><details class="wb-more" data-ui-disclosure="guide-wait"><summary>扫描等待或数量不一致</summary><p class="wb-caption">保持课表和学习页打开，等待章节加载。新增资源、目录变化或网络延迟时会重新核对；请先核对网站目录，不要反复点击开始。可在“设置 → 任务概览与日志”查看原因。</p></details>
        <details class="wb-more" data-ui-disclosure="guide-restart"><summary>更新、中断与重置</summary><p class="wb-caption">更新后重载扩展并刷新课程页。扩展重启后如显示任务已中断，请回到首页点击开始，重新核对课程。重置会停止任务并清除本地断点、统计和日志，不会删除网站进度。</p></details>
        <details class="wb-more" data-ui-disclosure="guide-limits"><summary>哪些内容需要自己处理</summary><p class="wb-caption">登录失效、验证码、题目和平台限制需要人工处理。当前按正在上的课程扫描，不提供仅考核课程筛选或自定义节数。文档、作业和考试仍需自行处理；最终完成状态以平台为准。</p></details>`;
    }
    function aboutPage() {
      let html = title('关于与服务', 'settings', '设置') + '<p class="wb-caption">Xinwei Course Watcher · 1.3.1 按需版本</p>' + note('面向 Beeline AI 学习页面。保留原作者署名与 Apache License 2.0。');
      const data = sponsorData();
      if (data) html += `<p class="wb-caption">第三方商业服务 · 非平台或原作者官方服务</p><a class="wb-external" href="${esc(data.url)}" target="_blank" rel="noopener noreferrer sponsored">${esc(data.brand)} · ${esc(data.items.join(' / '))} ↗</a>`;
      return html;
    }
    function refreshPage() {
      let html;
      if (view === 'courses') html = coursesPage();
      else if (view === 'course') html = coursePage();
      else if (view === 'resource') html = resourcePage();
      else if (view === 'about') html = aboutPage();
      else if (view === 'help') html = helpPage();
      else return;
      const signature = `${view}:${html}`;
      if (signature === contentSignature) return;
      const page = box.querySelector(`.wb-view[data-view="${view}"]`);
      const top = body.scrollTop;
      const focus = box.ownerDocument.activeElement;
      const focused = page.contains(focus);
      const focusAttr = focused && ['data-resource', 'data-course', 'data-course-filter', 'data-resource-filter', 'data-ui-view', 'data-ui-locate'].find(attr => focus.hasAttribute(attr));
      const focusKey = focusAttr ? focus.getAttribute(focusAttr) : null;
      const summaryParent = focused && focus.matches('summary') ? focus.parentElement : null;
      const summaryKey = summaryParent?.dataset.uiDisclosure || summaryParent?.dataset.chapter;
      const headingFocus = focused && focus.matches('.wb-title');
      rememberDisclosures(page);
      page.innerHTML = html;
      restoreDisclosures(page);
      contentSignature = signature;
      body.scrollTop = top;
      let nextFocus = focusAttr ? [...page.querySelectorAll(`[${focusAttr}]`)].find(el => el.getAttribute(focusAttr) === focusKey) : null;
      if (summaryKey) nextFocus = [...page.querySelectorAll('details')].find(el => (el.dataset.uiDisclosure || el.dataset.chapter) === summaryKey)?.querySelector('summary');
      if (headingFocus) { nextFocus = page.querySelector('.wb-title'); if (nextFocus) nextFocus.tabIndex = -1; }
      nextFocus?.focus({ preventScroll: true });
    }
    function rememberDisclosures(page) {
      for (const detail of page.querySelectorAll('details[data-ui-disclosure]')) disclosures.set(detail.dataset.uiDisclosure, detail.open);
      for (const detail of page.querySelectorAll('details[data-chapter]')) chapters.set(detail.dataset.chapter, detail.open);
    }
    function restoreDisclosures(page) {
      for (const detail of page.querySelectorAll('details[data-ui-disclosure]')) {
        if (disclosures.has(detail.dataset.uiDisclosure)) detail.open = disclosures.get(detail.dataset.uiDisclosure);
      }
      for (const detail of page.querySelectorAll('details[data-chapter]')) {
        if (chapters.has(detail.dataset.chapter)) detail.open = chapters.get(detail.dataset.chapter);
      }
    }
    const scrollKey = () => `${view}:${view === 'courses' ? courseFilter : ['course', 'resource'].includes(view) ? selectedCourse || '' : ''}:${view === 'resource' ? selectedResource || '' : ''}`;
    function saveView() {
      rememberDisclosures(box.querySelector(`.wb-view[data-view="${view}"]`));
      scroll.set(scrollKey(), body.scrollTop);
      try {
        if (!storageKey || !preferencesReady) return;
        const snapshot = {
          runId, view: view === 'reset' ? 'settings' : view, helpReturn, selectedCourse, selectedResource, courseFilter, resourceFilter,
          scroll: [...scroll].slice(-300), chapters: [...chapters].slice(-300), disclosures: [...disclosures].slice(-300), shell: getShell?.()
        };
        Promise.resolve(globalThis.chrome?.storage?.local?.set({ [storageKey]: snapshot })).catch(() => {});
      } catch { /* Optional view preferences must never block task controls. */ }
    }
    window.addEventListener('pagehide', saveView);
    function navigate(next, selection = {}) {
      if (!box.querySelector(`[data-view="${next}"]`)) return;
      if (next === 'help' && view !== 'help') helpReturn = view === 'reset' ? 'settings' : view;
      viewRevision++;
      rememberDisclosures(box.querySelector(`.wb-view[data-view="${view}"]`));
      scroll.set(scrollKey(), body.scrollTop);
      if ('course' in selection) { if (selectedCourse !== selection.course) resourceFilter = 'all'; selectedCourse = selection.course; selectedResource = null; }
      if ('resource' in selection) selectedResource = selection.resource;
      if ('filter' in selection) courseFilter = selection.filter;
      view = next; contentSignature = '';
      render();
      body.scrollTop = scroll.get(scrollKey()) || 0;
      const page = box.querySelector(`[data-view="${view}"]`);
      page.classList.remove('wb-enter'); void page.offsetWidth; page.classList.add('wb-enter');
      const target = page.querySelector('h2');
      if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
      onView?.(view);
      saveView();
    }
    function render() {
      rememberDisclosures(box.querySelector(`.wb-view[data-view="${view}"]`));
      model = getModel();
      if (!storageKey && Number.isInteger(model.tabId)) {
        storageKey = `wb-assistant-ui-v1:${model.tabId}`;
        const revision = viewRevision;
        try {
          Promise.resolve(globalThis.chrome?.storage?.local?.get(storageKey)).then(saved => {
            preferencesReady = true;
            if (revision !== viewRevision) { saveView(); return; }
            restore = saved?.[storageKey] || null;
            if (restore?.shell) onRestoreShell?.(restore.shell);
            render();
          }).catch(() => { preferencesReady = true; });
        } catch { preferencesReady = true; }
      }
      let restoredTop = null;
      // Wait for the shared task identity before restoring a task's nested view.
      if (restore && (!restore.runId || model.job?.runId)) {
        if ((restore.runId || null) === (model.job?.runId || null) &&
          typeof restore.view === 'string' && [...box.querySelectorAll('.wb-view')].some(page => page.dataset.view === restore.view)) {
          view = restore.view === 'reset' ? 'settings' : restore.view;
          if (typeof restore.helpReturn === 'string' && restore.helpReturn !== 'help' && restore.helpReturn !== 'reset' &&
            [...box.querySelectorAll('.wb-view')].some(page => page.dataset.view === restore.helpReturn)) helpReturn = restore.helpReturn;
          selectedCourse = typeof restore.selectedCourse === 'string' ? restore.selectedCourse : null;
          selectedResource = typeof restore.selectedResource === 'string' ? restore.selectedResource : null;
          courseFilter = ['all', 'complete', 'pending', 'attention', 'unscanned'].includes(restore.courseFilter) ? restore.courseFilter : 'all';
          resourceFilter = restore.resourceFilter === 'pending' ? 'pending' : 'all';
          for (const entry of Array.isArray(restore.scroll) ? restore.scroll.slice(-300) : []) {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && Number.isFinite(entry[1])) scroll.set(entry[0], Math.max(0, entry[1]));
          }
          for (const entry of Array.isArray(restore.chapters) ? restore.chapters.slice(-300) : []) {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean') chapters.set(...entry);
          }
          for (const entry of Array.isArray(restore.disclosures) ? restore.disclosures.slice(-300) : []) {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean') disclosures.set(...entry);
          }
          restoredTop = scroll.get(scrollKey()) || 0;
          runId = model.job?.runId;
        }
        restore = null;
      }
      if (runId !== model.job?.runId) {
        resourceFilter = 'all';
        if (runId != null) { selectedCourse = null; selectedResource = null; courseFilter = 'all'; chapters.clear(); disclosures.clear(); scroll.clear(); $('wb-overview-more').open = false; contentSignature = ''; }
        runId = model.job?.runId;
      }
      box.dataset.view = view; box.dataset.tone = model.home.tone;
      syncSponsor();
      for (const page of box.querySelectorAll('[data-view]')) page.hidden = page.dataset.view !== view;
      const otherTaskTab = model.job?.running && Number.isInteger(model.job.ownerTabId) && model.job.ownerTabId !== model.tabId;
      $('wb-ui-nav').hidden = true; $('wb-ui-task-strip').hidden = (view === 'home' && !otherTaskTab) || !model.hasTaskState;
      const taskLink = $('wb-ui-task-strip').querySelector('button');
      taskLink.textContent = otherTaskTab ? '前往学习标签页' : '返回助手首页';
      taskLink.toggleAttribute('data-focus-task', Boolean(otherTaskTab));
      taskLink.toggleAttribute('data-ui-view', !otherTaskTab);
      if (!otherTaskTab) taskLink.dataset.uiView = 'home';
      text('wb-ui-status', model.home.status); text('wb-ui-title', model.home.title); text('wb-ui-subtitle', model.home.subtitle);
      const choosing = model.manualMode && model.job?.phase === 'selection' && model.job.lastOperation === 'list';
      const playing = model.manualMode && model.job?.running && model.job.phase === 'course' && model.job.targetPurpose === 'play';
      $('wb-ui-title').hidden = Boolean(choosing || playing);
      $('wb-ui-subtitle').hidden = !model.home.subtitle || Boolean(choosing);
      text('wb-ui-caption', model.home.caption); $('wb-ui-caption').hidden = !model.home.caption;
      $('wb-home-summary').hidden = !model.job;
      $('wb-home-summary').classList.toggle('wb-home-selection', model.manualMode);
      const summary = $('wb-home-task-progress');
      const summaryHtml = model.job ? taskSummary() : '';
      if (summarySignature !== summaryHtml) {
        const focus = summary.contains(document.activeElement) ? document.activeElement : null;
        const attribute = focus && ['data-course-filter', 'data-course', 'data-action-course', 'data-refresh-list', 'data-course-drawer'].find(a => focus.hasAttribute(a));
        const value = attribute && focus.getAttribute(attribute);
        const listTop = summary.querySelector('.wb-home-courses')?.scrollTop || 0;
        summary.innerHTML = summaryHtml;
        summarySignature = summaryHtml;
        if (attribute) [...summary.querySelectorAll('button')].find(el => el.getAttribute(attribute) === value)?.focus({preventScroll: true});
        const list = summary.querySelector('.wb-home-courses');
        if (list) list.scrollTop = listTop;
      }
      const courseList = summary.querySelector('.wb-home-courses');
      if (courseList) courseList.dataset.more = String(courseList.scrollHeight > courseList.clientHeight + courseList.scrollTop + 2);
      const current = model.courses.find(c => courseKey(c) === model.activeCourseKey);
      const courseProgress = $('wb-home-course-progress'), courseHtml = current ? learningProgress(current, true) : '';
      courseProgress.hidden = model.manualMode || !current || !model.job;
      if (courseProgress.innerHTML !== courseHtml) {
        const focused = courseProgress.contains(document.activeElement);
        courseProgress.innerHTML = courseHtml;
        if (focused) courseProgress.querySelector('button')?.focus({preventScroll: true});
      }
      $('wb-ui-directory').hidden = true;
      text('wb-ui-target-badge', model.home.targetBadge.replace(/^(\d+)% 后切换$/, '播放至 $1% 后切换')); $('wb-ui-target-badge').hidden = !model.home.targetBadge;
      text('wb-ui-notice', model.home.notice); $('wb-ui-notice').hidden = !model.home.notice;
      const p = model.home.progress;
      $('wb-ui-progress').hidden = !p;
      if (p) {
        text('wb-ui-progress-label', p.label); text('wb-ui-progress-text', p.text);
      }
      const inlineCourses = model.manualMode && model.courses.length > 0 && model.job?.listScannedAt && !['go-agent', 'entry-home', 'scan-home'].includes(model.job.phase);
      $('wb-start').hidden = !model.home.showStart || Boolean(inlineCourses);
      $('wb-stop').hidden = !model.home.showStop;
      $('wb-ui-results').hidden = !model.home.showResults || Boolean(inlineCourses && !model.alerts.length);
      $('wb-ui-results').dataset.uiView = model.alerts.length ? 'alerts' : 'courses';
      text('wb-ui-results', model.alerts.length ? '查看待处理事项' : '查看课程结果');
      $('wb-ui-reset-retry').hidden = !model.home.resetRetry;
      text('wb-ui-alert-link', `待处理 ${model.alerts.length}`); $('wb-ui-alert-link').hidden = !model.alerts.length;
      text('wb-ui-task-label', model.home.status);
      $('wb-ui-log-empty').hidden = model.logCount > 0;
      $('wb-log').hidden = model.logCount === 0;
      const stats = kv('任务范围', model.manualMode ? '用户选择的单门课程' : model.job?.scope === 'single' ? '当前课程' : '全部正在上的课程') + kv('本轮达到播放目标', model.targetReached) + kv('任务中已确认记录', model.confirmed);
      if ($('wb-ui-statistics').innerHTML !== stats) $('wb-ui-statistics').innerHTML = stats;
      const stages = { 'home-overview': '课表总览', 'course-directory': '本课目录', 'completion-checkpoint': '完成状态核对' };
      const timings = (model.scanPerformance || []).map(item => kv(stages[item.stage] || '扫描', `${(item.durationMs / 1000).toFixed(2)} 秒${item.ok ? '' : ' · 未完成'}`)).join('');
      if ($('wb-scan-performance').innerHTML !== timings) $('wb-scan-performance').innerHTML = timings;
      const overview = model.overview;
      text('wb-overview-courses', overview.courseTotal == null ? model.job ? '统计中' : '待扫描' : `${overview.courseConfirmed} / ${overview.courseTotal}`);
      text('wb-overview-media', overview.mediaTotal == null ? overview.mediaConfirmed ? `${overview.mediaConfirmed} / …` : '统计中' : `${overview.mediaConfirmed} / ${overview.mediaTotal}`);
      $('wb-metric-courses').setAttribute('aria-label', overview.courseTotal == null ? '课程总数尚未统计完整' : `已确认 ${overview.courseConfirmed} 门，共 ${overview.courseTotal} 门课程`);
      $('wb-metric-media').setAttribute('aria-label', `平台已确认 ${overview.mediaConfirmed} 项音视频，${overview.mediaTotal == null ? '总数尚未统计完整' : `共 ${overview.mediaTotal} 项`}`);
      text('wb-overview-alerts', model.alerts.length);
      $('wb-overview-alerts').parentElement.dataset.attention = String(model.alerts.length > 0);
      $('wb-overview-current').hidden = !overview.currentCourse;
      text('wb-overview-phase', '当前课程'); text('wb-overview-course', overview.currentCourse);
      text('wb-overview-resource', overview.currentResource); $('wb-overview-resource').hidden = !overview.currentResource;
      $('wb-reset-menu').disabled = model.resetPending;
      if (view === 'reset' && model.resetPending) { view = 'home'; return render(); }
      refreshPage();
      restoreDisclosures(box.querySelector(`.wb-view[data-view="${view}"]`));
      if (restoredTop != null) body.scrollTop = restoredTop;
      return model;
    }
    box.addEventListener('click', event => {
      const control = event.target.closest('button');
      if (!control || control.disabled) return;
      if (control.hasAttribute('data-course-drawer')) {
        const key = 'course-drawer:' + control.dataset.courseDrawer;
        const open = !disclosures.get(key);
        disclosures.set(key, open);
        control.setAttribute('aria-expanded', String(open));
        control.title = open ? '收起学习项' : '展开学习项';
        const drawer = control.closest('.wb-course-drawer'), body = drawer.querySelector('.wb-drawer-body');
        drawer.dataset.open = String(open); body.setAttribute('aria-hidden', String(!open));
        body.toggleAttribute('inert', !open); saveView(); return;
      }
      if (control.hasAttribute('data-focus-task')) { onFocusTask?.(); return; }
      if (control.hasAttribute('data-resource-filter')) { resourceFilter = control.dataset.resourceFilter; contentSignature = ''; render(); return; }
      if (control.hasAttribute('data-help-return')) { navigate(helpReturn); $('wb-help').focus({ preventScroll: true }); return; }
      if (control.hasAttribute('data-course-action')) {
        const c = model.courses[Number(control.dataset.actionCourse)];
        if (c && !model.job?.running && !model.operationPending) {
          navigate(control.dataset.courseAction === 'inspect' ? 'course' : 'home', { course: courseKey(c) });
          onCourseAction?.(courseKey(c), control.dataset.courseAction);
        }
        return;
      }
      if (control.hasAttribute('data-refresh-list')) { navigate('home'); onCourseAction?.(null, 'list'); return; }
      if (control.hasAttribute('data-course-filter')) navigate('courses', { filter: control.dataset.courseFilter });
      else if (control.id === 'wb-ui-directory' || control.hasAttribute('data-current-directory')) {
        const c = model.courses.find(c => courseKey(c) === model.activeCourseKey);
        if (c) navigate('course', { course: courseKey(c) });
      }
      else if (control.dataset.uiView) navigate(control.dataset.uiView, control.dataset.uiView === 'courses' && view !== 'course' ? {filter: 'all'} : {});
      else if (control.hasAttribute('data-course')) { const c = model.courses[Number(control.dataset.course)]; if (c) navigate('course', { course: courseKey(c) }); }
      else if (control.hasAttribute('data-resource')) { const c = findCourse(); const item = c?.directory?.items[Number(control.dataset.resource)]; if (item) navigate('resource', { resource: item.key }); }
      else if (control.hasAttribute('data-ui-locate')) onLocate?.(selectedCourse, control.dataset.uiLocate);
      else if (control.id === 'wb-reset' || control.id === 'wb-ui-reset-retry') onReset?.();
    });
    box.addEventListener('scroll', event => {
      const list = event.target;
      if (list.matches?.('.wb-home-courses')) list.dataset.more = String(list.scrollHeight > list.clientHeight + list.scrollTop + 2);
    }, true);
    box.addEventListener('toggle', event => {
      const el = event.target;
      if (el.closest?.('.wb-view')?.dataset.view !== view) return;
      if (el.isConnected && el.hasAttribute?.('data-chapter')) chapters.set(el.dataset.chapter, el.open);
      if (el.isConnected && el.hasAttribute?.('data-ui-disclosure')) disclosures.set(el.dataset.uiDisclosure, el.open);
    }, true);
    box.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || view === 'home') return;
      if (view === 'help') { event.stopPropagation(); navigate(helpReturn); $('wb-help').focus({ preventScroll: true }); return; }
      event.stopPropagation(); navigate(view === 'resource' ? 'course' : view === 'course' ? 'courses' : view === 'logs' ? 'details' : 'home');
    });
    return {
      element: box, render, navigate, save: saveView,
      schedule() { if (scheduled) return; scheduled = true; window.setTimeout(() => { scheduled = false; render(); }, 0); },
      feedback(message, error = false) { text('wb-setting-feedback', message); $('wb-setting-feedback').style.color = error ? 'var(--wb-danger)' : ''; },
      get view() { return view; }
    };
  }
  globalThis.XinweiAssistantUI = Object.freeze({ create });
})();
