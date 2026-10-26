/* Presentation only: task execution remains in content.js/background.js. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const icons = {
    settings: '<path d="M9.17 5.16 L10.35 2.64 L13.65 2.64 L14.83 5.16 L14.83 5.16 L17.45 4.22 L19.78 6.55 L18.84 9.17 L18.84 9.17 L21.36 10.35 L21.36 13.65 L18.84 14.83 L18.84 14.83 L19.78 17.45 L17.45 19.78 L14.83 18.84 L14.83 18.84 L13.65 21.36 L10.35 21.36 L9.17 18.84 L9.17 18.84 L6.55 19.78 L4.22 17.45 L5.16 14.83 L5.16 14.83 L2.64 13.65 L2.64 10.35 L5.16 9.17 L5.16 9.17 L4.22 6.55 L6.55 4.22 L9.17 5.16Z"/><circle cx="12" cy="12" r="3.2"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    play: '<path d="m8 5 11 7-11 7Z"/>',
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

  function create({ getModel, imageUrl, promotion = {}, onReset, onLocate, onView, getShell, onRestoreShell }) {
    const box = document.createElement('section');
    box.id = 'wb-study-ui';
    box.setAttribute('aria-label', '芯位教育课堂助手');
    box.innerHTML = `
      <header class="hd" id="wb-drag">
        <div class="wb-brand"><img class="wb-brand-image" alt="" draggable="false"><span>芯位教育课堂助手</span></div>
        <button class="wb-icon" type="button" data-ui-view="settings" aria-label="设置" title="设置">${svg('settings')}</button>
        <button class="wb-icon" id="wb-min" type="button" aria-label="收起芯位教育课堂助手">−</button>
      </header>
      <aside class="wb-sponsor" id="wb-sponsor" aria-label="赞助支持" hidden>
        <span class="wb-sponsor-label">赞助支持</span>
        <a id="wb-sponsor-link" target="_blank" rel="noopener noreferrer sponsored"><span id="wb-sponsor-message"></span><span aria-hidden="true">↗</span></a>
        <button class="wb-icon" id="wb-sponsor-toggle" type="button" aria-label="暂停赞助轮播" title="暂停赞助轮播" aria-pressed="false">${svg('pause')}</button>
      </aside>
      <div class="bd" id="wb-body">
        <section class="wb-view" data-view="home">
          <div class="wb-status-line" id="wb-ui-status" role="status" aria-live="polite"></div>
          <h2 class="wb-title" id="wb-ui-title"></h2><p class="wb-subtitle" id="wb-ui-subtitle"></p>
          <div class="wb-progress" id="wb-ui-progress" hidden>
            <div class="wb-progress-label"><span id="wb-ui-progress-label"></span><span id="wb-ui-progress-text"></span></div>
            <div class="wb-track" id="wb-ui-progressbar" role="progressbar" aria-label="当前进度" aria-valuemin="0" aria-valuemax="100"><div class="wb-fill" id="wb-ui-fill"></div></div>
          </div>
          <p class="wb-caption" id="wb-ui-caption"></p>
          <p class="wb-notice" id="wb-ui-notice" hidden></p>
          <div class="wb-actions"><button class="btn primary start" id="wb-start" type="button">开始</button><button class="btn primary stop" id="wb-stop" type="button" hidden>暂停</button><button class="btn" id="wb-ui-results" type="button" data-ui-view="alerts" hidden>查看待处理事项</button><button class="btn" id="wb-ui-reset-retry" type="button" data-ui-view="reset" hidden>重试重置</button></div>
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
          <h2 class="wb-title">任务详情</h2><div id="wb-ui-statistics"></div>
          <div class="kv"><span>课程任务</span><span id="wb-job-summary">尚未开始</span></div>
          <div class="kv"><span>本轮自然结束</span><span id="wb-count">0</span></div>
          <div class="kv"><span>当前课页面已确认</span><span id="wb-confirmed">—</span></div>
          <div class="kv"><span>页面考核点（参考）</span><span id="wb-course-progress">未识别</span></div>
          <div class="kv"><span>需人工处理</span><span id="wb-manual">0</span></div>
          <p class="wb-caption">播放目标、自然结束、平台确认分别记录，计数不可相加。</p>
          <div class="wb-actions">${button('查看运行日志', 'logs')}</div>
        </section>
        <section class="wb-view" data-view="logs" hidden>
          <button class="wb-link wb-back" type="button" data-ui-view="details">${svg('back')}任务详情</button>
          <h2 class="wb-title">运行日志</h2><button class="log-new" id="wb-log-new" type="button" aria-live="polite" hidden></button>
          <div class="log" id="wb-log" role="log" aria-label="运行日志" aria-live="off"></div><p class="wb-caption" id="wb-ui-log-empty">还没有运行记录</p>
        </section>
        <section class="wb-view" data-view="settings" hidden>
          <button class="wb-link wb-back" type="button" data-ui-view="home">${svg('back')}任务首页</button><h2 class="wb-title">设置</h2>
          <label class="kv playback-target" for="wb-playback-target"><span>播放目标</span><span class="target-value"><input id="wb-playback-target" type="number" min="80" max="100" step="1" value="100" aria-label="播放目标百分比"><span>%</span></span></label>
          <p class="wb-caption">80%–100%，默认 100%。更改后自动保存；平台完成状态会另行核对。</p><p class="wb-caption" id="wb-setting-feedback" role="status" aria-live="polite"></p>
          <button class="wb-setting-row" type="button" data-ui-view="about">关于与服务<span>›</span></button>
          <button class="wb-setting-row danger" id="wb-reset-menu" type="button" data-ui-view="reset">重置任务记录<span>›</span></button>
        </section>
        <section class="wb-view" data-view="reset" hidden>
          <button class="wb-link wb-back" id="wb-reset-cancel" type="button" data-ui-view="settings">${svg('back')}取消</button>
          <h2 class="wb-title">重置任务记录？</h2><p class="wb-notice">将停止当前任务，清除本地任务、断点、课程统计、日志和错误记录。网站登录和学习进度不会删除。</p>
          <div class="wb-actions"><button class="btn danger" id="wb-reset" type="button">确认重置</button>${button('保留记录', 'settings')}</div>
        </section>
        <section class="wb-view" data-view="about" hidden></section>
        <div class="wb-legacy" aria-hidden="true"><span id="wb-status"></span><span id="wb-current"></span><span id="wb-course"></span><span id="wb-progress"></span><div id="wb-notice"></div><span id="wb-manual-count"></span><span id="wb-video-count"></span><span id="wb-pending-count"></span><div id="wb-video-list"></div><button id="wb-scan" type="button">查看最新目录</button></div>
      </div>
      <nav class="wb-nav" id="wb-ui-nav" aria-label="助手导航"><button class="wb-link" type="button" data-ui-view="courses">全部课程</button><button class="wb-link" id="wb-ui-alert-link" type="button" data-ui-view="alerts" hidden></button><button class="wb-link" type="button" data-ui-view="details">详情</button></nav>
      <div class="wb-task-strip" id="wb-ui-task-strip" hidden><span id="wb-ui-task-label"></span><button class="wb-link" type="button" data-ui-view="home">回到任务</button></div>`;
    const $ = id => box.querySelector(`#${id}`);
    if (imageUrl) box.querySelector('.wb-brand-image').src = imageUrl;
    const body = $('wb-body');
    let view = 'home', selectedCourse = null, selectedResource = null, model = null;
    let contentSignature = '', scheduled = false, runId = null;
    const scroll = new Map(), chapters = new Map();
    let restore = null, storageKey = null, preferencesReady = false, viewRevision = 0;
    const sponsor = $('wb-sponsor'), sponsorLink = $('wb-sponsor-link'), sponsorToggle = $('wb-sponsor-toggle');
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let sponsorItems = [], sponsorSignature = '', sponsorIndex = 0;
    let sponsorTimer = null, sponsorFadeTimer = null, sponsorPaused = false, sponsorHover = false, sponsorFocus = false;
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
      sponsorToggle.hidden = sponsorItems.length < 2 || Boolean(reducedMotion?.matches);
      const canRotate = sponsorItems.length > 1 && !reducedMotion?.matches && !sponsorPaused &&
        !sponsorHover && !sponsorFocus && !document.hidden && !box.hidden && box.isConnected && view !== 'reset';
      if (!canRotate) { stopSponsor(); return; }
      if (sponsorTimer != null || sponsorFadeTimer != null) return;
      sponsorTimer = window.setTimeout(() => {
        sponsorTimer = null; sponsor.classList.add('wb-sponsor-fading');
        sponsorFadeTimer = window.setTimeout(() => {
          sponsorFadeTimer = null;
          sponsorIndex = (sponsorIndex + 1) % sponsorItems.length;
          showSponsor(data); sponsor.classList.remove('wb-sponsor-fading'); syncSponsor();
        }, 140);
      }, 7000);
    }
    sponsor.addEventListener('pointerenter', () => { sponsorHover = true; syncSponsor(); });
    sponsor.addEventListener('pointerleave', () => { sponsorHover = false; syncSponsor(); });
    sponsor.addEventListener('focusin', () => { sponsorFocus = true; syncSponsor(); });
    sponsor.addEventListener('focusout', event => { sponsorFocus = sponsor.contains(event.relatedTarget); syncSponsor(); });
    sponsorToggle.addEventListener('click', () => {
      sponsorPaused = !sponsorPaused;
      sponsorToggle.setAttribute('aria-pressed', String(sponsorPaused));
      const label = sponsorPaused ? '继续赞助轮播' : '暂停赞助轮播';
      sponsorToggle.setAttribute('aria-label', label); sponsorToggle.title = label;
      sponsorToggle.innerHTML = svg(sponsorPaused ? 'play' : 'pause'); syncSponsor();
    });
    document.addEventListener('visibilitychange', syncSponsor);
    reducedMotion?.addEventListener?.('change', syncSponsor);
    window.addEventListener('pagehide', stopSponsor);
    window.addEventListener('pageshow', syncSponsor);
    const text = (id, value) => { const el = $(id); const valueText = String(value ?? ''); if (el.textContent !== valueText) el.textContent = valueText; };
    const title = (label, parent = 'home', parentLabel = '任务首页') => `<button class="wb-link wb-back" type="button" data-ui-view="${parent}">${svg('back')}${parentLabel}</button><h2 class="wb-title">${esc(label)}</h2>`;
    const courseKey = course => course.courseKey || course.key;
    const findCourse = () => model.courses.find(c => courseKey(c) === selectedCourse);
    function resourceStatus(item, course) {
      const record = course.records?.[item.key];
      if (record?.confirmed || item.observedCompleted === true) return '平台已确认';
      if (model.activeCourseKey === courseKey(course) && model.activeResourceKey === item.key && model.job?.running && model.job.targetPurpose !== 'inspect') return '正在学习';
      if (record?.error) return '失败待处理';
      if (record?.targetReached) return '达到播放目标';
      if (record?.ended) return '自然结束 · 待确认';
      if (record?.started || record?.attempted) return '处理中断';
      return course.live ? '未开始' : '暂无播放记录';
    }
    function courseCount(course) {
      if (!Array.isArray(course.directory?.items)) return Number.isInteger(course.total) ? `音视频 ${course.total} 项` : '音视频数量待统计';
      const counts = { video: 0, audio: 0, media: 0 };
      course.directory.items.forEach(item => { if (item.mediaType in counts) counts[item.mediaType] += 1; });
      return Object.entries(counts).filter(([, n]) => n).map(([kind, n]) => `${types[kind]} ${n}`).join(' · ') || '没有可处理的音视频';
    }
    function courseLabel(course) {
      if (model.activeCourseKey === courseKey(course) && model.job?.running) return model.job.targetPurpose === 'inspect' ? '正在统计' : '正在处理';
      return courseStates[course.status] || (course.live ? '当前课程' : '待统计');
    }
    function coursesPage() {
      const inspected = model.courses.filter(c => Array.isArray(c.directory?.items) || Number.isInteger(c.total)).length;
      return title('全部课程') + `<p class="wb-caption">${model.courses.length ? `${model.courses.length} 门课程 · 已统计 ${inspected} 门` : '尚未建立课程列表'}</p>` +
        (model.courses.length ? model.courses.map((c, index) => `<button class="wb-course-row" type="button" data-course="${index}"><span class="wb-row-main"><span class="wb-row-title">${esc(c.title)}</span><span class="wb-row-meta">${esc(courseCount(c))}</span></span><span class="wb-row-status" data-active="${model.activeCourseKey === courseKey(c)}">${esc(courseLabel(c))} ›</span></button>`).join('') :
          note(model.job?.phase === 'finished' ? '没有发现可处理的课程。请在网站核对课程状态。' : '开始任务后将扫描正在上的课程。扫描期间，已发现的课程会逐步出现在这里。'));
    }
    function coursePage() {
      const c = findCourse();
      if (!c) return title('课程已更新', 'courses', '全部课程') + note('这门课已不在当前任务中。请返回课程列表查看。');
      const items = c.directory?.items;
      let html = title(c.title, 'courses', '全部课程') + `<p class="wb-caption">${esc(courseCount(c))}</p>`;
      if (!items) {
        if (model.job?.running && model.activeCourseKey === courseKey(c)) return html + note('正在读取课程目录，请稍候。已识别的条目会在目录就绪后显示。');
        if (c.failures?.length || c.status === 'manual') return html + note(`目录尚未读取完成，请检查网站页面。${(c.failures || []).join('；')}`);
        return html + note('尚未读取这门课的目录。统计完成后会展示音视频明细。');
      }
      if (!c.live || c.directoryStale) html += note('当前显示上次读取的目录，平台状态可能已变化。');
      if (!items.length) return html + note('已读取目录，本课没有可处理的音视频。文档、考试和作业需自行处理。');
      const media = items.filter(isMedia), others = items.filter(i => !isMedia(i));
      const groups = new Map();
      for (const item of media) { const group = item.chapterTitle || '音视频目录'; if (!groups.has(group)) groups.set(group, []); groups.get(group).push(item); }
      for (const [name, rows] of groups) {
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
      html += '<p class="wb-caption">查看目录不会切换播放或改变任务顺序。</p>';
      return html;
    }
    function resourcePage() {
      const c = findCourse(), item = c?.directory?.items.find(i => i.key === selectedResource);
      if (!item) return title('资源已更新', 'course', '课程目录') + note('当前任务中已无法确认该条目，请回到目录重新查看。');
      const record = c.records?.[item.key];
      const current = c.live && model.activeResourceKey === item.key;
      let html = title(item.title, 'course', '课程目录') + `<p class="wb-caption">${esc(c.title)}${item.chapterTitle ? ` · ${esc(item.chapterTitle)}` : ''}</p>`;
      html += kv('资源类型', types[item.mediaType] || '其他') + kv('时长', time(item.durationSeconds)) + kv('任务记录', resourceStatus(item, c));
      if (current && model.media) html += kv('当前播放位置', time(model.media.position));
      html += kv('播放目标', `${record?.effectiveTarget ?? model.job?.targetPercent ?? model.target}%`);
      html += kv('自然结束', record?.ended === true ? '已记录' : '尚无记录');
      html += kv('平台确认', record?.confirmed || item.observedCompleted ? '已确认' : '尚未确认');
      if (record?.error) html += `<p class="wb-notice">${esc(record.error)}</p>`;
      if (record?.recovery?.attempts) html += kv('恢复尝试', record.recovery.attempts);
      html += note('达到播放目标不等于自然结束，也不等于平台已确认完成。');
      if (c.live && item.locatable) html += `<div class="wb-actions"><button class="btn" type="button" data-ui-locate="${esc(item.key)}">定位到网页条目</button></div>`;
      return html;
    }
    function aboutPage() {
      let html = title('关于与服务', 'settings', '设置') + '<p class="wb-caption">Xinwei Course Watcher · 1.1.0 候选版本</p>' + note('面向 Beeline AI 学习页面。保留原作者署名与 Apache License 2.0。');
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
      else return;
      const signature = `${view}:${html}`;
      if (signature === contentSignature) return;
      const top = body.scrollTop;
      const focus = box.ownerDocument.activeElement;
      const focusKey = focus?.getAttribute('data-resource') ?? focus?.getAttribute('data-course');
      const focusAttr = focus?.hasAttribute('data-resource') ? 'data-resource' : 'data-course';
      box.querySelector(`[data-view="${view}"]`).innerHTML = html;
      contentSignature = signature;
      body.scrollTop = top;
      if (focusKey != null) box.querySelector(`[${focusAttr}="${focusKey}"]`)?.focus({ preventScroll: true });
    }
    const scrollKey = () => `${view}:${['course', 'resource'].includes(view) ? selectedCourse || '' : ''}:${view === 'resource' ? selectedResource || '' : ''}`;
    function saveView() {
      scroll.set(scrollKey(), body.scrollTop);
      try {
        if (!storageKey || !preferencesReady) return;
        const snapshot = {
          runId, view: view === 'reset' ? 'settings' : view, selectedCourse, selectedResource,
          scroll: [...scroll].slice(-300), chapters: [...chapters].slice(-300), shell: getShell?.()
        };
        Promise.resolve(globalThis.chrome?.storage?.local?.set({ [storageKey]: snapshot })).catch(() => {});
      } catch { /* Optional view preferences must never block task controls. */ }
    }
    window.addEventListener('pagehide', saveView);
    function navigate(next, selection = {}) {
      if (!box.querySelector(`[data-view="${next}"]`)) return;
      viewRevision++;
      scroll.set(scrollKey(), body.scrollTop);
      if ('course' in selection) { selectedCourse = selection.course; selectedResource = null; }
      if ('resource' in selection) selectedResource = selection.resource;
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
          selectedCourse = typeof restore.selectedCourse === 'string' ? restore.selectedCourse : null;
          selectedResource = typeof restore.selectedResource === 'string' ? restore.selectedResource : null;
          for (const entry of Array.isArray(restore.scroll) ? restore.scroll.slice(-300) : []) {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && Number.isFinite(entry[1])) scroll.set(entry[0], Math.max(0, entry[1]));
          }
          for (const entry of Array.isArray(restore.chapters) ? restore.chapters.slice(-300) : []) {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean') chapters.set(...entry);
          }
          restoredTop = scroll.get(scrollKey()) || 0;
          runId = model.job?.runId;
        }
        restore = null;
      }
      if (runId !== model.job?.runId) {
        if (runId != null) { selectedCourse = null; selectedResource = null; chapters.clear(); scroll.clear(); contentSignature = ''; }
        runId = model.job?.runId;
      }
      box.dataset.view = view; box.dataset.tone = model.home.tone;
      syncSponsor();
      for (const page of box.querySelectorAll('[data-view]')) page.hidden = page.dataset.view !== view;
      $('wb-ui-nav').hidden = view !== 'home'; $('wb-ui-task-strip').hidden = view === 'home';
      text('wb-ui-status', model.home.status); text('wb-ui-title', model.home.title); text('wb-ui-subtitle', model.home.subtitle);
      $('wb-ui-subtitle').hidden = !model.home.subtitle;
      text('wb-ui-caption', model.home.caption); $('wb-ui-caption').hidden = !model.home.caption;
      text('wb-ui-notice', model.home.notice); $('wb-ui-notice').hidden = !model.home.notice;
      const p = model.home.progress;
      $('wb-ui-progress').hidden = !p;
      if (p) {
        text('wb-ui-progress-label', p.label); text('wb-ui-progress-text', p.text);
        $('wb-ui-fill').style.width = `${Math.max(0, Math.min(100, p.percent))}%`;
        $('wb-ui-progressbar').setAttribute('aria-valuenow', String(Math.round(p.percent)));
        $('wb-ui-progressbar').setAttribute('aria-label', p.label);
      }
      $('wb-start').hidden = !model.home.showStart;
      $('wb-stop').hidden = !model.home.showStop;
      $('wb-ui-results').hidden = !model.home.showResults;
      $('wb-ui-results').dataset.uiView = model.alerts.length ? 'alerts' : 'courses';
      text('wb-ui-results', model.alerts.length ? '查看待处理事项' : '查看课程结果');
      $('wb-ui-reset-retry').hidden = !model.home.resetRetry;
      text('wb-ui-alert-link', `待处理 ${model.alerts.length}`); $('wb-ui-alert-link').hidden = !model.alerts.length;
      text('wb-ui-task-label', model.home.status);
      $('wb-ui-log-empty').hidden = model.logCount > 0;
      $('wb-log').hidden = model.logCount === 0;
      const stats = kv('任务范围', model.job?.scope === 'single' ? '当前课程' : '全部正在上的课程') + kv('本轮达到播放目标', model.targetReached) + kv('任务中已确认记录', model.confirmed);
      if ($('wb-ui-statistics').innerHTML !== stats) $('wb-ui-statistics').innerHTML = stats;
      $('wb-reset-menu').disabled = model.resetPending;
      if (view === 'reset' && model.resetPending) { view = 'home'; return render(); }
      refreshPage();
      if (restoredTop != null) body.scrollTop = restoredTop;
      return model;
    }
    box.addEventListener('click', event => {
      const control = event.target.closest('button');
      if (!control || control.disabled) return;
      if (control.dataset.uiView) navigate(control.dataset.uiView);
      else if (control.hasAttribute('data-course')) { const c = model.courses[Number(control.dataset.course)]; if (c) navigate('course', { course: courseKey(c) }); }
      else if (control.hasAttribute('data-resource')) { const c = findCourse(); const item = c?.directory?.items[Number(control.dataset.resource)]; if (item) navigate('resource', { resource: item.key }); }
      else if (control.hasAttribute('data-ui-locate')) onLocate?.(selectedCourse, control.dataset.uiLocate);
      else if (control.id === 'wb-reset') onReset?.();
    });
    box.addEventListener('toggle', event => {
      const el = event.target;
      if (el.isConnected && el.hasAttribute?.('data-chapter')) chapters.set(el.dataset.chapter, el.open);
    }, true);
    box.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || view === 'home') return;
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
