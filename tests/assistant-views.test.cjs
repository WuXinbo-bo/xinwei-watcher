const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, homeFixture, mediaItem } = require('./helpers.cjs');

function close(f) { f.api.state.running = false; f.api.state.epoch++; f.window.close(); }
function setup(f) {
  const { state } = f.api;
  const key = f.api.currentCourseKey();
  const snapshot = f.api.getDirectorySnapshot();
  state.tabId = 1;
  state.job = { runId: 'ui-run', running: false, phase: 'paused', scope: 'all',
    homeTabId: 1, workerTabId: 1, targetIndex: 0, targetPurpose: 'play', targetPercent: 90,
    candidates: [{ key: 'candidate', courseKey: key, title: '当前测试课', status: 'inspected', directory: snapshot, records: {} },
      { key: 'unknown', title: '尚未统计的大课', status: 'uninspected' },
      { key: 'saved', courseKey: 'saved', title: '已离开的课程', status: 'inspected',
        directory: { items: [{ key: 'old', title: '旧版无章节元数据', mediaType: 'audio', durationSeconds: null }] }, records: {} }] };
  f.api.updateTaskControls();
  return { ui: state.uiController, job: state.job, box: f.window.document.getElementById('wb-study-ui'), body: f.window.document.getElementById('wb-body') };
}

test('home stays compact; logs and destructive controls require navigation', () => {
  const f = fixture([]);
  try {
    const { ui, box } = setup(f);
    assert.equal(box.querySelector('[data-view=home]').hidden, false);
    for (const id of ['wb-log', 'wb-playback-target', 'wb-reset']) assert.equal(box.querySelector(`#${id}`).closest('[data-view]').hidden, true);
    assert.equal(box.querySelectorAll('[data-view=home] .primary:not([hidden])').length, 1);
    assert.equal(box.querySelector('#wb-sponsor-link').getAttribute('rel'), 'noopener noreferrer sponsored');
    ui.navigate('details'); box.querySelector('[data-ui-view=logs]').click();
    assert.equal(box.dataset.view, 'logs');
    box.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(box.dataset.view, 'details');
  } finally { close(f); }
});

test('course and chapter browsing is read-only, distinguishes unknown counts and supports old snapshots', () => {
  const f = fixture([mediaItem('视频一'), mediaItem('音频一', 'audio')]);
  try {
    const { ui, box } = setup(f);
    let commands = 0, pageClicks = 0;
    f.window.chrome.runtime.sendMessage = async () => { commands++; return { ok: true }; };
    f.window.document.querySelector('.sub-menu-area').addEventListener('click', () => pageClicks++);
    ui.navigate('courses');
    assert.match(box.querySelector('[data-course="1"]').textContent, /数量待统计/);
    box.querySelector('[data-course="0"]').click();
    assert.match(box.querySelector('[data-view=course]').textContent, /第一章 · 2 项/);
    assert.match(box.querySelector('[data-view=course]').textContent, /视频 1 · 音频 1/);
    box.querySelector('[data-resource="1"]').click();
    assert.match(box.querySelector('[data-view=resource]').textContent, /音频一/);
    box.querySelector('[data-ui-locate]').click();
    ui.navigate('courses'); box.querySelector('[data-course="1"]').click();
    assert.match(box.querySelector('[data-view=course]').textContent, /尚未读取/);
    ui.navigate('courses'); box.querySelector('[data-course="2"]').click();
    assert.match(box.querySelector('[data-view=course]').textContent, /上次读取的目录/);
    assert.match(box.querySelector('[data-view=course]').textContent, /时长未知/);
    assert.equal(pageClicks, 0); assert.equal(commands, 0); assert.equal(f.media.paused, true);
  } finally { close(f); }
});

test('reading position and selected resource survive updates and round trips', () => {
  const f = fixture([mediaItem('视频一'), mediaItem('音频一', 'audio')]);
  try {
    const { ui, job, box, body } = setup(f);
    ui.navigate('courses'); body.scrollTop = 40;
    box.querySelector('[data-course="0"]').click(); body.scrollTop = 65;
    box.querySelector('[data-resource="1"]').click(); body.scrollTop = 22;
    job.candidates[0].records[job.candidates[0].directory.items[1].key] = { targetReached: true };
    ui.render();
    assert.equal(box.dataset.view, 'resource'); assert.equal(body.scrollTop, 22);
    assert.match(box.querySelector('[data-view=resource]').textContent, /达到播放目标/);
    ui.navigate('course'); assert.equal(body.scrollTop, 65);
    ui.navigate('courses'); assert.equal(body.scrollTop, 40);
    box.querySelector('[data-course="1"]').click(); assert.equal(body.scrollTop, 0);
    ui.navigate('courses'); box.querySelector('[data-course="0"]').click(); assert.equal(body.scrollTop, 65);
  } finally { close(f); }
});

test('target reached never implies natural end or platform confirmation; labels are escaped', () => {
  const f = fixture([mediaItem('视频一')]);
  try {
    const { ui, job, box } = setup(f);
    const c = job.candidates[2], item = c.directory.items[0];
    c.title = '<img src=x onerror=alert(1)>'; item.title = '<script>unsafe</script>';
    c.records[item.key] = { targetReached: true, ended: false, confirmed: false, effectiveTarget: 85 };
    ui.navigate('courses'); box.querySelector('[data-course="2"]').click(); box.querySelector('[data-resource]').click();
    const page = box.querySelector('[data-view=resource]');
    assert.match(page.textContent, /达到播放目标/);
    assert.match(page.textContent, /自然结束尚无记录/);
    assert.match(page.textContent, /平台确认尚未确认/);
    assert.match(page.textContent, /播放目标85%/);
    assert.match(page.textContent, /<script>unsafe<\/script>/);
    assert.equal(page.querySelector('script,img'), null);
    c.records[item.key].ended = true; ui.render();
    assert.match(page.textContent, /自然结束已记录/);
    assert.match(page.textContent, /平台确认尚未确认/);
    c.records[item.key].confirmed = true; ui.render(); assert.match(page.textContent, /平台确认已确认/);
  } finally { close(f); }
});

test('task phases, pending operations and local manual stop have truthful home states', () => {
  const f = fixture([mediaItem('视频一')]);
  try {
    const { job, box } = setup(f); const state = f.api.state;
    const check = (expected) => { f.api.updateTaskControls(); assert.equal(box.querySelector('#wb-ui-status').textContent, expected); };
    job.running = true;
    for (const [phase, purpose, expected] of [['go-agent', 'play', '正在准备'], ['scan-home', 'inspect', '正在扫描课程'], ['opening', 'inspect', '正在打开统计页'], ['course', 'inspect', '正在统计音视频'], ['course', 'play', '正在学习']]) {
      job.phase = phase; job.targetPurpose = purpose; check(expected);
    }
    job.candidates[0].currentResource = { stage: 'opening' }; check('正在切换资源');
    assert.equal(box.querySelector('#wb-ui-progress').hidden, true); delete job.candidates[0].currentResource;
    job.candidates[0].status = 'retry'; check('等待稍后重试');
    job.candidates[0].status = 'inspected'; state.routeRecoveryPending = true; check('正在自动恢复'); state.routeRecoveryPending = false;
    state.tabId = 99; check('任务在其他标签页'); assert.equal(box.querySelector('#wb-stop').hidden, true); state.tabId = 1;
    job.running = false; job.phase = 'paused'; check('已暂停');
    state.startPending = true; check('正在开始'); assert.equal(box.querySelector('#wb-stop').hidden, false); assert.equal(box.querySelector('#wb-stop').disabled, false); state.startPending = false;
    state.pausePending = true; check('正在暂停'); assert.equal(box.querySelector('#wb-stop').disabled, true); state.pausePending = false;
    job.phase = 'interrupted'; check('任务已中断');
    job.phase = 'manual'; job.reason = '请处理验证码'; check('需要你处理'); assert.match(box.querySelector('#wb-ui-subtitle').textContent, /验证码/); assert.equal(box.querySelector('#wb-ui-notice').hidden, true);
    state.storageFailed = true; check('保存失败'); assert.equal(box.querySelector('#wb-start').hidden, true); state.storageFailed = false;
    state.resetPending = true; check('正在重置'); state.resetPending = false;
    state.mode = 'resetting'; check('重置尚未完成');
    const retry = box.querySelector('#wb-ui-reset-retry');
    assert.equal(retry.hidden, false);
    assert.equal(retry.hasAttribute('data-ui-view'), false, '重试按钮应直接执行重置，而不是只打开确认页');
    state.mode = 'manual'; state.manualNotice = '登录失效'; state.job = null; check('需要你处理');
    assert.match(box.querySelector('#wb-ui-notice').textContent, /登录失效/);
  } finally { close(f); }
});

test('empty scan completion does not claim that platform confirmed resources', () => {
  const f = homeFixture([]);
  try {
    f.api.state.job = { runId: 'empty', running: false, phase: 'finished', candidates: [] };
    f.api.updateTaskControls();
    assert.equal(f.window.document.getElementById('wb-ui-status').textContent, '本轮处理结束');
    assert.match(f.window.document.getElementById('wb-ui-title').textContent, /没有发现/);
    assert.notEqual(f.window.document.getElementById('wb-study-ui').dataset.tone, 'success');
  } finally { close(f); }
});

test('chapter display metadata is optional and does not change recovery identity', () => {
  const f = fixture([mediaItem('视频一')]);
  try {
    const snapshot = f.api.getDirectorySnapshot();
    assert.equal(snapshot.items[0].chapterTitle, '第一章');
    const old = JSON.parse(JSON.stringify(snapshot)); delete old.items[0].chapterTitle;
    assert.equal(f.api.directorySignature(snapshot), f.api.directorySignature(old));
  } finally { close(f); }
});

test('overview shows three metrics and keeps technical statistics collapsed across updates', () => {
  const f = fixture([mediaItem('视频一'), mediaItem('音频一', 'audio')]);
  try {
    const { ui, job, box } = setup(f); ui.navigate('details');
    const page = box.querySelector('[data-view=details]'), more = box.querySelector('#wb-overview-more');
    assert.equal(page.querySelector('h2').textContent, '任务概览');
    assert.equal(page.querySelectorAll('.wb-metric').length, 3); assert.equal(more.open, false);
    assert.equal(box.querySelector('#wb-count').closest('details'), more);
    assert.equal(box.querySelector('#wb-ui-statistics').closest('details'), more);
    assert.match(box.querySelector('#wb-overview-current').textContent, /当前测试课/);
    more.open = true; job.candidates[0].records[job.candidates[0].directory.items[0].key] = { targetReached: true };
    ui.render(); assert.equal(more.open, true);
    assert.equal(box.querySelector('#wb-overview-media').textContent, '统计中', 'target reached is not platform confirmation');
    page.querySelector('[data-ui-view=alerts]').click(); assert.equal(ui.view, 'alerts');
  } finally { close(f); }
});

test('overview counts distinct confirmed media and never invents an unknown denominator', () => {
  const f = fixture([mediaItem('视频一'), mediaItem('音频一', 'audio')]);
  try {
    const { ui, job, box } = setup(f), items = job.candidates[0].directory.items;
    job.candidates[0].records[items[0].key] = { confirmed: true, ended: true };
    job.candidates[0].records[items[1].key] = { targetReached: true, ended: true, confirmed: false };
    ui.navigate('details'); assert.equal(box.querySelector('#wb-overview-media').textContent, '1 / …');
    assert.match(box.querySelector('#wb-metric-media').getAttribute('aria-label'), /总数尚未统计完整/);
    job.candidates[1].directory = { items: [] }; job.candidates[1].status = 'complete';
    job.candidates[2].records.old = { confirmed: true }; ui.render();
    assert.equal(box.querySelector('#wb-overview-media').textContent, '2 / 3');
    assert.equal(box.querySelector('#wb-overview-courses').textContent, '1 / 3');
    job.phase = 'scan-home'; ui.render();
    assert.equal(box.querySelector('#wb-overview-courses').textContent, '统计中');
    assert.equal(box.querySelector('#wb-overview-media').textContent, '2 / …');
  } finally { close(f); }
});

test('loading a partial directory preserves the saved total; new resources do not inherit old confirmation', () => {
  const f = fixture([mediaItem('视频一'), mediaItem('音频一', 'audio')]);
  try {
    const { ui, job, box } = setup(f), c = job.candidates[0];
    job.candidates[1].directory = { items: [] };
    c.total = 4; c.remaining = 3;
    ui.navigate('details');
    assert.equal(box.querySelector('#wb-overview-media').textContent, '1 / 5');
    c.total = 2; c.remaining = 0; c.status = 'complete';
    f.window.document.querySelector('.el-sub-menu ul').insertAdjacentHTML('beforeend', mediaItem('新出现的视频'));
    ui.render();
    assert.equal(box.querySelector('#wb-overview-media').textContent, '2 / …');
  } finally { close(f); }
});

test('idle inner pages omit the task strip, while paused tasks keep their return control', () => {
  const f = homeFixture([]);
  try {
    const ui = f.api.state.uiController;
    ui.navigate('details'); assert.equal(f.window.document.getElementById('wb-ui-task-strip').hidden, true);
    f.api.state.job = { runId: 'paused', phase: 'paused', running: false, candidates: [] };
    f.api.updateTaskControls(); assert.equal(f.window.document.getElementById('wb-ui-task-strip').hidden, false);
  } finally { close(f); }
});

test('status explanations stay on demand and live updates preserve keyboard focus and disclosure state', () => {
  const f = fixture([mediaItem('视频一'), mediaItem('音频一', 'audio')]);
  try {
    const { ui, job, box, body } = setup(f);
    ui.navigate('courses'); box.querySelector('[data-course="0"]').click();
    const back = box.querySelector('.wb-view[data-view=course] .wb-back'); back.focus();
    const item = job.candidates[0].directory.items[0];
    job.candidates[0].records[item.key] = { error: '此前加载失败' }; ui.render();
    assert.equal(f.window.document.activeElement.dataset.uiView, 'courses');
    box.querySelector('[data-resource="0"]').click();
    let page = box.querySelector('.wb-view[data-view=resource]');
    assert.equal(page.querySelector('details').open, false);
    assert.match(page.querySelector('.wb-error').textContent, /需处理/);
    page.querySelector('details').open = true; page.querySelector('summary').focus(); body.scrollTop = 31;
    job.candidates[0].records[item.key].confirmed = true; ui.render();
    page = box.querySelector('.wb-view[data-view=resource]');
    assert.equal(page.querySelector('.wb-error'), null, 'an old failure must not override platform confirmation');
    assert.match(page.querySelector('details').textContent, /此前加载失败/);
    assert.equal(page.querySelector('details').open, true);
    assert.equal(f.window.document.activeElement.tagName, 'SUMMARY'); assert.equal(body.scrollTop, 31);
    ui.navigate('course'); box.querySelector('[data-resource="1"]').click();
    assert.equal(box.querySelector('.wb-view[data-view=resource] details').open, false, 'each resource has independent explanation state');
  } finally { close(f); }
});

function preferenceChrome(values, blocked = false) {
  return {
    runtime: { sendMessage: async () => ({ ok: true, job: null, tabId: 1 }) },
    storage: { local: {
      async get(key) { if (blocked) throw new Error('storage blocked'); return { [key]: values[key] }; },
      async set(next) { if (blocked) throw new Error('storage blocked'); Object.assign(values, JSON.parse(JSON.stringify(next))); }
    } }
  };
}
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

test('a full document change restores the same task view and scroll without resuming media', async () => {
  const values = {};
  const first = fixture([mediaItem('视频一'), mediaItem('音频一', 'audio')], { chrome: preferenceChrome(values) });
  try {
    const { ui, box, body } = setup(first); await settled();
    first.window.document.getElementById('wb-assistant-button').click();
    ui.navigate('courses'); box.querySelector('[data-course="0"]').click();
    box.querySelector('[data-resource="1"]').click(); body.scrollTop = 32;
    first.window.dispatchEvent(new first.window.Event('pagehide')); await settled();
    assert.equal(values['wb-assistant-ui-v1:1'].view, 'resource');
    assert.equal(first.window.sessionStorage.length, 0, 'view preferences belong to extension storage');
  } finally { close(first); }
  const second = fixture([mediaItem('视频一'), mediaItem('音频一', 'audio')], { chrome: preferenceChrome(values) });
  try {
    const { ui, box, body } = setup(second); await settled();
    assert.equal(ui.view, 'resource');
    assert.match(box.querySelector('[data-view=resource]').textContent, /音频一/);
    assert.equal(body.scrollTop, 32); assert.equal(box.hidden, false);
    assert.equal(second.window.document.getElementById('wb-assistant-button').getAttribute('aria-expanded'), 'true');
    assert.equal(second.media.paused, true);
  } finally { close(second); }
  values['wb-assistant-ui-v1:1'].runId = 'previous-unrelated-task';
  const third = fixture([], { chrome: preferenceChrome(values) });
  try { const { ui } = setup(third); await settled(); assert.equal(ui.view, 'home'); } finally { close(third); }
});

test('unavailable preference storage cannot prevent controls or navigation', async () => {
  const f = fixture([], { chrome: preferenceChrome({}, true) });
  try {
    const { ui } = setup(f); await settled(); ui.navigate('settings');
    f.window.dispatchEvent(new f.window.Event('pagehide')); await settled();
    assert.equal(ui.view, 'settings');
    ui.navigate('home'); assert.equal(f.window.document.getElementById('wb-start').disabled, false);
  } finally { close(f); }
});

test('tab identity arriving after the first render restores an expanded shell on a new document', async () => {
  const values = {
    'wb-assistant-ui-v1:1': {
      runId: null, view: 'home', shell: { expanded: true, left: 620, top: 120 }
    }
  };
  const f = fixture([], { chrome: preferenceChrome(values) });
  try {
    const box = f.window.document.getElementById('wb-study-ui');
    assert.equal(f.api.state.tabId, null, 'the initial render runs before the tab handshake');
    assert.equal(box.hidden, true);
    await f.api.syncSharedJob();
    await settled();
    assert.equal(box.hidden, false);
    assert.equal(f.window.document.getElementById('wb-assistant-button').hidden, true);
    assert.equal(box.style.left, '620px');
    assert.ok(parseFloat(box.style.top) >= 8, 'restored panel stays inside the visible viewport');
  } finally { close(f); }
});
