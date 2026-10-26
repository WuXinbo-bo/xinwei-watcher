const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fixture, mediaItem, homeFixture, homeCard } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');
const LEARN = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';
const KEY = 'xinwei-job-v3';
const auth = j => ({ runId: j.runId, generation: j.generation, resetEpoch: j.resetEpoch });
const plain = value => JSON.parse(JSON.stringify(value));

test('mouse path, hover, press/release, final click and all click timing settings remain unchanged', () => {
  const current = fs.readFileSync('content.js', 'utf8');
  const click = s => s.slice(s.indexOf('  async function humanClick('), s.indexOf('  function pauseMedia('));
  // Baseline 5e69a30, without requiring Git history in a source archive/CI.
  assert.equal(crypto.createHash('sha256').update(click(current)).digest('hex'),
    '283e54e0ed62b30e7a846df79e8a540e5cb4f8d30d69a0c1a88afad40db3bfd2');
  for (const [key, value] of Object.entries({ beforeClickDelayMin: 120, beforeClickDelayMax: 360,
    hoverDelayMin: 80, hoverDelayMax: 220, afterExpandDelayMin: 300, afterExpandDelayMax: 900 })) {
    const pattern = new RegExp(key + ': (\\d+)');
    assert.equal(Number(current.match(pattern)?.[1]), value);
  }
});

test('directory expansion waits for component animation and late items, retaining the real click sequence', async () => {
  const f = fixture([mediaItem('one')]);
  try {
    const chapter = f.window.document.querySelector('li.el-sub-menu');
    const markup = chapter.querySelector('ul').innerHTML;
    chapter.querySelector('ul').innerHTML = '';
    chapter.setAttribute('aria-expanded', 'false');
    chapter.classList.remove('is-opened');
    let moving = false, finished = false, clicks = 0;
    const events = [];
    chapter.getAnimations = () => moving ? [{ playState: 'running', effect: { getComputedTiming: () => ({ endTime: 900 }) } }] : [];
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) chapter.addEventListener(type, () => events.push(type));
    chapter.querySelector('.el-sub-menu__title').onclick = () => {
      clicks++; moving = true; chapter.setAttribute('aria-expanded', 'true');
      chapter.classList.add('is-opened');
      setTimeout(() => { chapter.querySelector('ul').innerHTML = markup; }, 20);
      setTimeout(() => { moving = false; finished = true; }, 300);
    };
    f.api.state.running = true;
    const result = await f.api.waitForDirectory(f.api.state.epoch);
    assert.equal(finished, true);
    assert.equal(result.videoItems.length, 1);
    assert.equal(clicks, 1);
    assert.deepEqual(events, ['mouseover', 'mousedown', 'mouseup', 'click']);
    assert.equal(f.api.state.scanPerformance.at(-1).ok, true);
  } finally { f.api.state.running = false; f.dom.window.close(); }
});

test('navigation to a different current course rejects an otherwise valid completion batch', async () => {
  const { c, id, f, job } = await prepared();
  try {
    c.tabs.get(id).url = LEARN.replace('course-1', 'other-course');
    const r = await c.request(id, f.api.state.instanceId, 'record-completions', {
      ...auth(job), entries: [{ key: f.api.getItemKey(f.api.getMenuItems()[0]), completionSource: 'page-marker' }]
    }, LEARN);
    assert.equal(r.ok, false);
    assert.equal(Object.keys(c.storage.local[KEY].candidates[0].records).length, 0);
  } finally { f.api.state.running = false; f.dom.window.close(); }
});

test('directory reuse invalidates synchronously for metadata, completion, insertion, reorder and root replacement', () => {
  const f = fixture([mediaItem('one'), mediaItem('two', 'audio')]);
  try {
    const a = f.api, first = a.readDirectory();
    const snapshot = first.snapshot;
    assert.equal(a.readDirectory().snapshot, snapshot);
    const item = first.items[0];
    item.querySelector('.video-duration').textContent = '02 分 00 秒';
    assert.equal(a.getDirectorySnapshot().items[0].durationSeconds, 120);
    item.querySelector('.lecture-status').innerHTML = '<i class=done-icon></i>';
    assert.equal(a.isPageCompletedItem(a.getMenuItems()[0]), true);
    const list = item.parentElement;
    list.insertAdjacentHTML('beforeend', mediaItem('three'));
    assert.equal(a.getDirectorySnapshot().items.length, 3);
    list.prepend(list.lastElementChild);
    assert.equal(a.getDirectorySnapshot().items[0].title, 'three');
    const root = f.window.document.querySelector('.sub-menu-area');
    root.outerHTML = '<div class=sub-menu-area><ul>' + mediaItem('new') + '</ul></div>';
    assert.deepEqual(plain(a.getDirectorySnapshot().items.map(i => i.title)), ['new']);
    assert.equal(item.isConnected, false);
    assert.notEqual(a.readDirectory().snapshot, snapshot);
  } finally { f.dom.window.close(); }
});

test('validated homepage reuses stable content but invalidates when cards are replaced with identical text', async () => {
  const f = homeFixture([homeCard('course')]);
  try {
    f.api.state.running = true;
    await f.api.waitForHomeCards(0);
    const first = f.api.state.homeValidation;
    await f.api.waitForHomeCards(0);
    assert.equal(f.api.state.homeValidation, first);
    const cards = f.window.document.querySelector('.cards');
    cards.innerHTML = cards.innerHTML;
    await f.api.waitForHomeCards(0);
    assert.notEqual(f.api.state.homeValidation, first);
    f.api.state.running = false;
    await assert.rejects(f.api.waitForHomeCards(0));
  } finally { f.dom.window.close(); }
});

async function prepared(count = 2) {
  const c = coordinator(), id = c.addTab(LEARN);
  const f = fixture(Array.from({ length: count }, (_, i) => mediaItem('video ' + i, 'video', 'done')), { connect: c.connect(id) });
  let job = await f.api.jobCommand('start', { title: '测试课程', scope: 'single', singlePass: true, targetPercent: 80 });
  await f.api.jobCommand('directory-checkpoint', { snapshot: f.api.getDirectorySnapshot() });
  job = f.api.state.job;
  f.api.state.activeGeneration = job.generation;
  f.api.state.running = true;
  return { c, id, f, job };
}

test('65 platform-completed resources use three durable batches and a repeated scan writes nothing', async () => {
  const { c, id, f } = await prepared(65);
  try {
    const revision = f.api.state.job.revision;
    await f.api.saveVisibleCompletions(f.api.getMenuItems(), f.api.state.epoch);
    assert.equal(f.api.state.job.revision - revision, 3);
    const records = c.storage.local[KEY].candidates[0].records;
    assert.equal(Object.keys(records).length, 65);
    assert.equal(Object.values(records).every(r => r.confirmed && !r.ended && !r.targetReached), true);
    const savedRevision = f.api.state.job.revision;
    await f.api.saveVisibleCompletions(f.api.getMenuItems(), f.api.state.epoch);
    assert.equal(f.api.state.job.revision, savedRevision);
    assert.equal(f.api.state.scanPerformance.at(-1).stage, 'completion-checkpoint');
    assert.equal((await c.request(id, f.api.state.instanceId, 'get')).job.running, true);
  } finally { f.api.state.running = false; f.dom.window.close(); }
});

test('invalid entry rolls back the entire batch, and stale ownership cannot save confirmations', async () => {
  const { c, id, f, job } = await prepared();
  try {
    const entry = { key: f.api.getMenuItems().map(f.api.getItemKey)[0], completionSource: 'page-marker' };
    let r = await c.request(id, f.api.state.instanceId, 'record-completions', { ...auth(job), entries: [entry, { key: 'missing', completionSource: 'page-marker' }] });
    assert.equal(r.ok, false);
    assert.equal(Object.keys(c.storage.local[KEY].candidates[0].records).length, 0);
    r = await c.request(id, 'unrelated-document', 'record-completions', { ...auth(job), entries: [entry] });
    assert.equal(r.ok, false);
    r = await c.request(id, f.api.state.instanceId, 'pause', auth(job));
    r = await c.request(id, f.api.state.instanceId, 'record-completions', { ...auth(r.job), entries: [entry] });
    assert.equal(r.ok, false);
    assert.equal(Object.keys(c.storage.local[KEY].candidates[0].records).length, 0);
  } finally { f.api.state.running = false; f.dom.window.close(); }
});

test('batch preserves natural-end evidence and retry budgets, rejects weak or duplicated evidence', async () => {
  const { c, id, f, job } = await prepared();
  try {
    const key = f.api.getItemKey(f.api.getMenuItems()[0]);
    const entry = { key, completionSource: 'page-marker' };
    for (const entries of [[{ key, completionSource: 'site-progress', sitePercent: 79 }], [entry, entry], [{ key, completionSource: 'page-marker', sitePercent: 101 }]]) {
      assert.equal((await c.request(id, f.api.state.instanceId, 'record-completions', { ...auth(job), entries })).ok, false);
    }
    const stored = c.storage.session[KEY].candidates[0];
    stored.records[key] = { title: 'video 0', ended: true, effectiveTarget: 100, finalAttempts: 2, playbackAttempt: { finished: { currentTime: 60 }, events: [{ type: 'ended' }] } };
    const r = await c.request(id, f.api.state.instanceId, 'record-completions', { ...auth(job), entries: [entry] });
    assert.equal(r.ok, true);
    const record = r.job.candidates[0].records[key];
    assert.equal(record.finalAttempts, 2);
    assert.equal(record.effectiveTarget, 100);
    assert.equal(record.ended, true);
    assert.equal(record.playbackAttempt.finished.currentTime, 60);
  } finally { f.api.state.running = false; f.dom.window.close(); }
});

test('saving failure stops the task and does not confirm local resources', async () => {
  const { c, f } = await prepared();
  try {
    c.failStorage();
    await assert.rejects(f.api.saveVisibleCompletions(f.api.getMenuItems(), f.api.state.epoch));
    assert.equal(f.api.state.job.running, false);
    assert.equal([...f.api.state.processedItems.values()].some(r => r.confirmed), false);
  } finally { f.api.state.running = false; f.dom.window.close(); }
});

test('guide returns to the selected resource with scroll and focus; repository uses a safe external link', () => {
  const f = fixture([mediaItem('video')]);
  try {
    const a = f.api, ui = a.state.uiController, box = ui.element;
    a.state.tabId = 1;
    a.state.job = { runId: 'guide', running: false, phase: 'paused', scope: 'single', targetIndex: 0, candidates: [{ key: a.currentCourseKey(), courseKey: a.currentCourseKey(), directory: a.getDirectorySnapshot(), title: '测试课程', records: {} }] };
    ui.render(); ui.navigate('course', { course: a.currentCourseKey() });
    box.querySelector('[data-resource]').click();
    box.querySelector('#wb-body').scrollTop = 60;
    const before = JSON.stringify(a.state.job);
    box.querySelector('#wb-help').click();
    assert.equal(ui.view, 'help');
    assert.match(box.querySelector('[data-view=help]').textContent, /收起面板只隐藏界面/);
    box.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(ui.view, 'resource');
    assert.equal(box.querySelector('#wb-body').scrollTop, 60);
    assert.equal(f.window.document.activeElement.id, 'wb-help');
    assert.equal(JSON.stringify(a.state.job), before);
    const link = box.querySelector('#wb-github');
    assert.equal(link.href, 'https://github.com/WuXinbo-bo/xinwei-watcher');
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
  } finally { f.dom.window.close(); }
});
