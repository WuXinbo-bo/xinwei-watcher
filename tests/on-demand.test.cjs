const test = require('node:test');
const assert = require('node:assert/strict');
const { coordinator } = require('./coordinator.cjs');
const { homeFixture, homeCard, fixture, mediaItem, waitFor } = require('./helpers.cjs');
const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const URL = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/a/video/v?classId=class-a';
const KEY = 'xinwei-job-v3';
const auth = job => ({ runId: job.runId, generation: job.generation });
const entries = () => ['课程 A', '课程 B'].map((title, i) => ({ key: title, title, page: 1, order: i, status: 'uninspected', total: null, remaining: null }));
const snapshot = (items = [{ key: 'v', title: '视频', mediaType: 'video', durationSeconds: 60, observedCompleted: false }]) => ({ version: 1, courseKey: 'a::class-a', items });
async function ok(c, tab, instance, action, payload = {}) {
  const r = await c.request(tab, instance, action, payload);
  assert.equal(r.ok, true, action + ': ' + r.error); return r.job;
}
async function catalog() {
  const c = coordinator(), home = c.addTab(HOME);
  let job = await ok(c, home, 'home', 'start', { workflow: 'manual', scope: 'all', singlePass: true });
  job = await ok(c, home, 'home', 'scan-result', { ...auth(job), candidates: entries() });
  return { c, home, job };
}
async function inspect(f, announce = true) {
  let { c, home, job } = f;
  job = await ok(c, home, 'home', 'course-select', { ...auth(job), index: 0, candidateKey: '课程 A', purpose: 'inspect' });
  job = await ok(c, home, 'home', 'open', { ...auth(job), index: 0, purpose: 'inspect' });
  const worker = c.addTab(URL, home);
  if (announce) job = await ok(c, worker, 'worker', 'hello', { title: '课程 A' });
  return { ...f, job, worker };
}
async function scanned() {
  let f = await inspect(await catalog());
  f.job = await ok(f.c, f.worker, 'worker', 'directory-checkpoint', { ...auth(f.job), snapshot: snapshot() });
  f.job = await ok(f.c, f.worker, 'worker', 'course-result', { ...auth(f.job), result: { total: 1, remaining: 1 } });
  return f;
}
async function learning() {
  const f = await catalog();
  f.job = await ok(f.c, f.home, 'home', 'course-select', { ...auth(f.job), index: 0, candidateKey: '课程 A', purpose: 'learn', targetPercent: 80 });
  f.job = await ok(f.c, f.home, 'home', 'open', { ...auth(f.job), index: 0, purpose: 'inspect' });
  f.worker = f.c.addTab(URL, f.home);
  f.job = await ok(f.c, f.worker, 'worker', 'hello', { title: '课程 A' });
  return f;
}

test('one click scans selected course before playback, then authorizes only that course', async () => {
  const f = await learning();
  assert.equal(f.job.targetPurpose, 'inspect'); assert.equal(f.job.learnAfterScan, true);
  f.job = await ok(f.c, f.worker, 'worker', 'directory-checkpoint', { ...auth(f.job), snapshot: snapshot() });
  const inspected = f.job;
  f.job = await ok(f.c, f.worker, 'worker', 'course-result', { ...auth(f.job), result: { total: 1, remaining: 1 } });
  assert.equal(f.job.running, true); assert.equal(f.job.operation, 'play'); assert.equal(f.job.selectedIndex, 0);
  assert.equal(f.job.targetPercent, 80); assert.equal(f.job.candidates[0].scanState, 'ready');
  assert.equal(f.job.candidates[1].total, null);
  assert.equal((await f.c.request(f.worker, 'worker', 'course-result', { ...auth(inspected), result: { total: 1, remaining: 1 } })).error, 'TASK_CANCELLED');
});

for (const completed of [true, false]) {
  test('scan ending after pause cannot authorize playback; completed=' + completed, async () => {
    const f = await learning();
    f.job = await ok(f.c, f.worker, 'worker', 'directory-checkpoint', { ...auth(f.job), snapshot: snapshot() });
    const scanning = f.job;
    f.job = await ok(f.c, f.worker, 'worker', 'pause', auth(f.job));
    assert.equal((await f.c.request(f.worker, 'worker', 'course-result', { ...auth(scanning), result: { total: 1, remaining: completed ? 0 : 1 } })).error, 'TASK_CANCELLED');
    assert.equal(f.c.storage.session[KEY].running, false);
  });
}
test('one-click scan with all platform markers completes without starting playback', async () => {
  const f = await learning();
  const done = snapshot([{ key: 'v', title: '视频', mediaType: 'video', durationSeconds: 60, observedCompleted: true }]);
  f.job = await ok(f.c, f.worker, 'worker', 'directory-checkpoint', { ...auth(f.job), snapshot: done });
  f.job = await ok(f.c, f.worker, 'worker', 'course-result', { ...auth(f.job), result: { total: 1, remaining: 0 } });
  assert.equal(f.job.phase, 'selection'); assert.equal(f.job.running, false); assert.equal(f.job.learnAfterScan, undefined);
  assert.equal(f.job.candidates[0].records.v.confirmed, true);
});

test('pause requested during scan-to-play handoff fences both operation generations', async () => {
  const f = await learning();
  f.job = await ok(f.c, f.worker, 'worker', 'directory-checkpoint', { ...auth(f.job), snapshot: snapshot() });
  const scanning = f.job, receiver = { location: { href: URL } };
  f.c.connect(f.worker)(receiver);
  let pause;
  receiver.chrome.runtime.onMessage.addListener(message => {
    if (!pause && message.job?.running && message.job.operation === 'play') {
      pause = f.c.request(f.worker, 'worker', 'pause', auth(scanning));
    }
  });
  f.job = await ok(f.c, f.worker, 'worker', 'course-result', { ...auth(scanning), result: { total: 1, remaining: 1 } });
  assert.ok(pause, 'pause arrives while the play generation is broadcasting');
  assert.equal(f.job.running, false);
  await pause;
  assert.equal(f.c.storage.session[KEY].running, false);
  assert.equal(f.c.storage.session[KEY].phase, 'paused');
  assert.equal(f.c.storage.session[KEY].candidates[1].total, null);
});

test('catalog ends at selection without opening or learning; unknown totals remain null', async () => {
  const { c, home, job } = await catalog();
  assert.equal(job.phase, 'selection'); assert.equal(job.running, false);
  assert.equal(job.candidates.length, 2);
  assert.equal(job.candidates.every(c => c.total === null && c.remaining === null), true);
  const stale = await c.request(home, 'home', 'open', { ...auth(job), index: 0, purpose: 'inspect' });
  assert.equal(stale.error, 'TASK_CANCELLED'); assert.equal(c.navigation.length, 0);
});

test('only selected course can open; scan commits atomically then waits without playing', async () => {
  const f = await catalog();
  const selected = await ok(f.c, f.home, 'home', 'course-select', { ...auth(f.job), index: 0, candidateKey: '课程 A', purpose: 'inspect' });
  assert.equal((await f.c.request(f.home, 'home', 'open', { ...auth(selected), index: 1, purpose: 'inspect' })).ok, false);
  assert.equal((await f.c.request(f.home, 'home', 'open', { ...auth(selected), index: 0, purpose: 'play' })).ok, false);
  let job = await ok(f.c, f.home, 'home', 'open', { ...auth(selected), index: 0, purpose: 'inspect' });
  const worker = f.c.addTab(URL, f.home);
  job = await ok(f.c, worker, 'worker', 'hello', { title: '课程 A' });
  job = await ok(f.c, worker, 'worker', 'directory-checkpoint', { ...auth(job), snapshot: snapshot() });
  assert.equal(job.candidates[0].directory, undefined); assert.equal(job.candidates[0].scanDraft.items.length, 1);
  job = await ok(f.c, worker, 'worker', 'course-result', { ...auth(job), result: { total: 1, remaining: 1 } });
  assert.equal(job.phase, 'selection'); assert.equal(job.running, false);
  assert.equal(job.candidates[0].scanState, 'ready'); assert.ok(job.candidates[0].scannedAt);
  assert.equal(job.candidates[1].total, null); assert.equal(job.candidates[1].scanState, undefined);
  assert.equal(f.c.removed.length, 0); assert.equal(f.c.navigation.some(n => n.url), false);
});

test('unscanned course cannot play; duplicate operation and late results cannot authorize work', async () => {
  const f = await catalog();
  const bad = await f.c.request(f.home, 'home', 'course-select', { ...auth(f.job), index: 1, candidateKey: '课程 B', purpose: 'play' });
  assert.match(bad.error, /先完整扫描/);
  let job = await ok(f.c, f.home, 'home', 'course-select', { ...auth(f.job), index: 0, candidateKey: '课程 A', purpose: 'inspect' });
  const duplicate = await f.c.request(f.home, 'home', 'course-select', { ...auth(f.job), index: 0, candidateKey: '课程 A', purpose: 'inspect' });
  assert.equal(duplicate.error, 'TASK_CANCELLED');
  const running = job;
  job = await ok(f.c, f.home, 'home', 'pause', auth(job));
  assert.equal(job.running, false); assert.equal(job.candidates[0].scanState, 'paused');
  assert.equal((await f.c.request(f.home, 'home', 'open', { ...auth(running), index: 0, purpose: 'inspect' })).error, 'TASK_CANCELLED');
});

test('failed rescan preserves committed directory and timestamp, draft does not replace cache', async () => {
  const f = await scanned(), previous = f.job.candidates[0];
  let job = await ok(f.c, f.worker, 'worker', 'course-select', { ...auth(f.job), index: 0, candidateKey: previous.courseKey, purpose: 'inspect' });
  job = await ok(f.c, f.worker, 'worker', 'directory-checkpoint', { ...auth(job), snapshot: snapshot([{ key: 'changed', title: '新目录', mediaType: 'audio', durationSeconds: 2 }]) });
  job = await ok(f.c, f.worker, 'worker', 'manual', { ...auth(job), reason: '网络未就绪' });
  assert.deepEqual(job.candidates[0].directory, previous.directory);
  assert.equal(job.candidates[0].scannedAt, previous.scannedAt); assert.equal(job.candidates[0].scanState, 'error');
  assert.equal(job.interruption, undefined); assert.equal(job.candidates[1].total, null);
});

test('user refresh pauses inspection; background worker restart and browser restart never revive it', async () => {
  const f = await inspect(await catalog());
  let job = await ok(f.c, f.worker, 'refreshed-worker', 'hello', { title: '课程 A' });
  assert.equal(job.running, false); assert.equal(job.phase, 'paused'); assert.equal(job.resumePhase, 'course');
  f.c.restartWorker();
  job = await ok(f.c, f.worker, 'refreshed-worker', 'get'); assert.equal(job.running, false);
  f.c.restartBrowser(); job = await ok(f.c, f.worker, 'refreshed-worker', 'hello', { title: '课程 A' });
  assert.equal(job.running, false); assert.equal(f.c.navigation.some(n => n.url), false);
});

test('selected playback with unconfirmed resources ends without switching to another course', async () => {
  const f = await scanned();
  let job = await ok(f.c, f.worker, 'worker', 'course-select', { ...auth(f.job), index: 0, candidateKey: 'a::class-a', purpose: 'play', targetPercent: 80 });
  assert.equal(job.phase, 'course'); assert.equal(job.targetPercent, 80);
  job = await ok(f.c, f.worker, 'worker', 'course-result', { ...auth(job), result: { total: 1, remaining: 1, finalPass: true } });
  assert.equal(job.running, false); assert.equal(job.phase, 'selection'); assert.equal(job.candidates[0].status, 'manual');
  assert.equal(job.candidates[1].remaining, null); assert.equal(f.c.navigation.some(n => n.url), false);
});

test('catalog refresh retains historical scan as stale and does not trust title as teaching-class identity', async () => {
  const f = await scanned();
  let job = await ok(f.c, f.worker, 'worker', 'start', { ...auth(f.job), workflow: 'manual', scope: 'all', restart: true });
  // The ordinary site navigation is simulated by the test browser.
  f.c.tabs.get(f.worker).url = HOME;
  job = await ok(f.c, f.worker, 'new-home', 'hello');
  job = await ok(f.c, f.worker, 'new-home', 'scan-result', { ...auth(job), candidates: entries() });
  assert.equal(job.phase, 'selection'); assert.equal(job.candidates[0].scanState, 'stale');
  assert.ok(job.candidates[0].directory); assert.equal(job.candidates[0].courseKey, undefined);
  assert.equal(job.candidates[0].learnUrl, undefined);
});

test('public UI collects list, browsing is read-only, explicit scan only enters chosen card', async () => {
  const c = coordinator(), id = c.addTab(HOME), f = homeFixture(entries().map(c => homeCard(c.title)), { connect: c.connect(id) });
  const doc = f.window.document; doc.querySelector('.btn-next').disabled = true;
  const clicks = [];
  doc.querySelectorAll('.item-bg-text p.sle').forEach(el => el.addEventListener('click', () => clicks.push(el.textContent)));
  try {
    await f.api.start(); await waitFor(() => f.api.state.job?.phase === 'selection' && !f.api.state.jobPromise);
    assert.equal(clicks.length, 0); assert.equal(c.navigation.some(n => n.url), false);
    f.api.state.uiController.navigate('courses');
    doc.querySelector('[data-course="0"]').click(); assert.equal(clicks.length, 0);
    assert.match(doc.querySelector('.wb-view[data-view=course]').textContent, /尚未读取/);
    doc.querySelector('.wb-view[data-view=course] [data-course-action=inspect]').click();
    await waitFor(() => clicks.length === 1); assert.deepEqual(clicks, ['课程 A']);
    assert.equal(c.storage.session[KEY].targetPurpose, 'inspect');
  } finally { f.api.state.running = false; f.api.state.epoch++; f.window.close(); }
});

test('course inspection with actual directory saves media markers and never starts the player', async () => {
  const start = await inspect(await catalog(), false);
  const f = fixture([mediaItem('已完成视频', 'video', 'done'), mediaItem('待完成音频', 'audio')], { title: '课程 A', url: URL, connect: start.c.connect(start.worker) });
  try {
    await f.api.syncSharedJob(); await waitFor(() => f.api.state.job?.phase === 'selection' && !f.api.state.jobPromise);
    const course = f.api.state.job.candidates[0];
    assert.equal(course.total, 2); assert.equal(course.remaining, 1); assert.equal(f.media.paused, true);
    assert.equal(course.directory.items[0].observedCompleted, true);
    assert.equal(course.records[course.directory.items[0].key].confirmed, true);
    assert.equal(f.api.state.job.candidates[1].total, null);
  } finally { f.api.state.running = false; f.api.state.epoch++; f.window.close(); }
});

test('extension verification reload is consumed once; next user refresh pauses', async () => {
  const f = await scanned();
  let job = await ok(f.c, f.worker, 'worker', 'course-select', { ...auth(f.job), index: 0, candidateKey: 'a::class-a', purpose: 'play' });
  job = await ok(f.c, f.worker, 'worker', 'course-refresh', { ...auth(job), token: 'verification' });
  assert.equal(f.c.reloads.length, 1);
  job = await ok(f.c, f.worker, 'own-reload', 'hello', { title: '课程 A' });
  assert.equal(job.running, true); assert.equal(job.expectedRefresh, undefined);
  job = await ok(f.c, f.worker, 'user-reload', 'hello', { title: '课程 A' });
  assert.equal(job.running, false); assert.equal(job.phase, 'paused');
});

test('failed persistence cannot navigate to a selected course', async () => {
  const f = await scanned(), count = f.c.navigation.length;
  f.c.tabs.get(f.home).url = HOME; f.c.failStorage();
  const r = await f.c.request(f.home, 'home', 'course-select', { ...auth(f.job), index: 0, candidateKey: 'a::class-a', purpose: 'play' });
  assert.equal(r.ok, false); assert.equal(f.c.navigation.length, count);
});
