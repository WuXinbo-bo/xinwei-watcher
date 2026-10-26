const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, mediaItem, waitFor, seedCoursePlaybackFixture } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');
const { observePlayback, endPlayback, markPageCompleted } = require('./player-lifecycle.cjs');

const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const KEY = 'xinwei-job-v3';
const COURSE = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';
const auth = job => ({ runId: job.runId, generation: job.generation });
const plain = value => JSON.parse(JSON.stringify(value));

function connectWithMessages(c, id, messages) {
  return window => {
    c.connect(id)(window);
    const send = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = message => {
      messages.push(plain(message));
      return send(message);
    };
  };
}

function configurePlayer(f, activeIndex = 0) {
  const items = f.api.getMenuItems();
  const clicks = [];
  items[activeIndex]?.classList.add('is-active');
  items.forEach(item => item.addEventListener('click', () => {
    clicks.push(f.api.getItemKey(item));
    items.forEach(other => other.classList.remove('is-active'));
    item.classList.add('is-active');
    // This is the fake website loading the selected resource. The extension
    // can read currentTime but cannot set it in the shared player fixture.
    f.advanceNaturally(0);
    f.media.dispatchEvent(new f.window.Event('loadedmetadata'));
  }));
  return { items, clicks };
}

function finishFromWebsite(f, item, confirmed = true) {
  if (confirmed) markPageCompleted(item);
  endPlayback(f);
}

async function closeStoppedFixture(f, task) {
  if (!f) return;
  await f.api.stop(false);
  await Promise.allSettled([task, f.api.state.jobPromise, f.api.state.syncPromise].filter(Boolean));
  f.dom.window.close();
}

function snapshotFor(items, title, url) {
  const f = fixture(items, { title, url });
  try { return plain(f.api.getDirectorySnapshot()); }
  finally { f.dom.window.close(); }
}

async function prepareAllTask(c) {
  const courses = [
    {
      title: '当前课程', url: COURSE, remaining: 1,
      items: [
        mediaItem('更短视频', 'video', 'done', '00 分 10 秒'),
        mediaItem('正在看的长视频', 'video', 'unStart', '02 分 00 秒')
      ]
    },
    {
      title: '另一门课程',
      url: 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-2/video/resource-2?classId=class-2',
      remaining: 3,
      items: [mediaItem('音频一', 'audio'), mediaItem('音频二', 'audio'), mediaItem('视频三')]
    }
  ];
  const home = c.addTab(HOME);
  let response = await c.request(home, 'home-before-refresh', 'start');
  response = await c.request(home, 'home-before-refresh', 'scan-result', {
    ...auth(response.job),
    candidates: courses.map((course, index) => ({
      title: course.title, key: course.title, page: 1, order: index, status: 'uninspected'
    }))
  });
  for (const [index, course] of courses.entries()) {
    response = await c.request(home, 'home-before-refresh', 'open', {
      ...auth(response.job), index, purpose: 'inspect'
    });
    const inspector = c.addTab(course.url, home);
    response = await c.request(inspector, `inspector-${index}`, 'hello', { title: course.title });
    assert.equal(response.ok, true);
    response = await c.request(inspector, `inspector-${index}`, 'directory-checkpoint', {
      ...auth(response.job), snapshot: snapshotFor(course.items, course.title, course.url)
    });
    assert.equal(response.ok, true);
    response = await c.request(inspector, `inspector-${index}`, 'course-result', {
      ...auth(response.job), result: { total: course.items.length, remaining: course.remaining }
    });
    assert.equal(response.ok, true);
  }
  response = await c.request(home, 'home-before-refresh', 'open', {
    ...auth(response.job), index: 0, purpose: 'play'
  });
  assert.equal(response.ok, true);
  return { home, courses, job: response.job };
}

function attachSavedDirectory(f, snapshot) {
  // Isolate the directory check from the automatic executor. Real refresh
  // ownership and persistence are exercised separately through coordinator.
  f.api.state.running = true;
  f.api.state.activeGeneration = 1;
  f.api.state.tabId = 1;
  f.api.state.jobPromise = Promise.resolve();
  f.api.state.job = {
    runId: 'directory-check', generation: 1, revision: 1, running: true,
    phase: 'course', ownerTabId: 1, ownerInstance: f.api.state.instanceId,
    homeTabId: 1, workerTabId: 1, targetIndex: 0, logs: [],
    candidates: [{ title: '测试课程', courseKey: f.api.currentCourseKey(), directory: snapshot, records: {} }]
  };
  f.api.CFG.directoryLoadTimeout = 1000;
}

test('运行中的学习页刷新自动接管同一全课程任务，断点优先且不重统计其他课', async () => {
  const c = coordinator();
  const { home, courses } = await prepareAllTask(c);
  const messages = [];
  const first = fixture(courses[0].items, {
    title: courses[0].title, url: COURSE, connect: connectWithMessages(c, home, messages)
  });
  let second, firstUnloaded = false;
  try {
    const oldPlayer = configurePlayer(first, 1);
    await first.api.syncSharedJob();
    await waitFor(() => !first.media.paused && c.storage.session[KEY]?.candidates[0].currentResource?.stage === 'ready');
    await observePlayback(first, oldPlayer.items[1], { position: 49 });
    const before = plain(c.storage.session[KEY]);
    const longKey = first.api.getItemKey(oldPlayer.items[1]);
    // Unloading cancels this document only; the saved task remains running
    // so the replacement document can take over without another Start.
    first.api.state.running = false;
    first.api.state.epoch += 1;
    await Promise.allSettled([first.api.state.jobPromise, first.api.state.syncPromise].filter(Boolean));
    first.dom.window.close(); // A refresh unloads the document; it is not a user pause.
    firstUnloaded = true;

    second = fixture([
      mediaItem('更短视频', 'video', 'unStart', '00 分 10 秒'),
      mediaItem('正在看的长视频', 'video', 'done', '02 分 00 秒')
    ], { title: courses[0].title, url: COURSE, connect: connectWithMessages(c, home, messages) });
    const freshPlayer = configurePlayer(second, 0);
    const messagesBeforeRefresh = messages.length;
    await second.api.syncSharedJob();
    await waitFor(() => !second.media.paused && freshPlayer.items[1].classList.contains('is-active'));
    await observePlayback(second, freshPlayer.items[1]);
    const resumed = plain(c.storage.session[KEY]);
    assert.equal(resumed.runId, before.runId);
    assert.equal(resumed.scope, 'all');
    assert.equal(resumed.inspectIndex, 2);
    assert.ok(resumed.generation > before.generation);
    assert.equal(resumed.ownerInstance, second.api.state.instanceId);
    assert.equal(resumed.candidates[0].currentResource.key, longKey);
    assert.deepEqual(resumed.candidates[1], before.candidates[1]);
    assert.deepEqual(freshPlayer.clicks, [longKey]);
    assert.notEqual(second.api.state.job.phase, 'finished');
    assert.equal(second.api.isPageCompletedItem(freshPlayer.items[1]), true);
    assert.equal(resumed.candidates[0].records[longKey].ended, false);
    assert.equal(resumed.candidates[0].records[longKey].confirmed, false);
    const refreshActions = messages.slice(messagesBeforeRefresh).map(message => message.action);
    assert.equal(refreshActions.some(action => ['start', 'scan-result', 'open', 'course-result'].includes(action)), false);
    assert.equal(refreshActions.filter(action => action === 'directory-checkpoint').length, 0);
    assert.equal(c.removed.length, 2, 'only the initial two inspection tabs are closed');
    assert.equal(c.navigation.filter(step => step.url).length, 1);

    finishFromWebsite(second, freshPlayer.items[1]);
    await waitFor(() => !second.media.paused && freshPlayer.items[0].classList.contains('is-active'));
    const shortKey = second.api.getItemKey(freshPlayer.items[0]);
    assert.deepEqual(freshPlayer.clicks, [longKey, shortKey]);
    assert.equal(c.storage.session[KEY].candidates[0].records[longKey].ended, true);
    assert.equal(c.storage.session[KEY].candidates[0].records[longKey].confirmed, true);
    assert.equal(c.storage.session[KEY].candidates[0].currentResource.key, shortKey);
    assert.deepEqual(c.storage.session[KEY].candidates[1], before.candidates[1]);
    await observePlayback(second, freshPlayer.items[0]);
    await second.api.stop(false);
    assert.equal(second.media.paused, true);
  } finally {
    if (!firstUnloaded) {
      first.api.state.running = false;
      first.api.state.epoch += 1;
      await Promise.allSettled([first.api.state.jobPromise, first.api.state.syncPromise].filter(Boolean));
      first.dom.window.close();
    }
    await closeStoppedFixture(second);
  }
});

test('刷新文档的课程标题晚到时重新核对 hello，不需再次点击开始', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const messages = [];
  const first = fixture([mediaItem('续看视频')], {
    url: COURSE, connect: connectWithMessages(c, id, messages)
  });
  let second;
  try {
    configurePlayer(first);
    await seedCoursePlaybackFixture(first);
    await waitFor(() => !first.media.paused);
    const before = plain(c.storage.session[KEY]);
    first.dom.window.close();
    second = fixture([mediaItem('续看视频')], {
      url: COURSE, connect: connectWithMessages(c, id, messages)
    });
    configurePlayer(second);
    const title = second.window.document.querySelector('.course-name');
    title.textContent = '';
    await second.api.syncSharedJob();
    assert.equal(second.media.paused, true);
    assert.equal(second.api.state.job.running, true);
    assert.notEqual(second.api.state.job.ownerInstance, second.api.state.instanceId);
    const retriesBefore = messages.filter(message => message.action === 'hello' &&
      message.instanceId === second.api.state.instanceId).length;
    title.textContent = '测试课程';
    await second.api.syncSharedJob();
    await waitFor(() => !second.media.paused);
    assert.equal(second.api.state.job.runId, before.runId);
    assert.equal(second.api.state.job.ownerInstance, second.api.state.instanceId);
    assert.ok(messages.filter(message => message.action === 'hello' &&
      message.instanceId === second.api.state.instanceId).length > retriesBefore);
    await second.api.stop(false);
  } finally {
    first.dom.window.close();
    second?.dom.window.close();
  }
});

test('标题晚到填满握手诊断后，成功 hello 接管仍在固定槽保留前后时间、所有权和媒体观察', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const first = fixture([mediaItem('晚到标题续看视频')], { url: COURSE, connect: c.connect(id) });
  let second;
  try {
    configurePlayer(first);
    await seedCoursePlaybackFixture(first);
    await waitFor(() => !first.media.paused && c.storage.session[KEY]?.candidates[0].currentResource?.stage === 'ready');
    const before = plain(c.storage.session[KEY]);
    first.dom.window.close();
    const messages = [];
    let loadingObserved = false, pauseCalls = 0, playClicks = 0;
    second = fixture([mediaItem('晚到标题续看视频')], {
      url: COURSE, connect: connectWithMessages(c, id, messages),
      beforeContent: ({ window, media, advanceNaturally }) => {
        window.document.querySelector('.course-name').textContent = '';
        window.document.querySelector('li.el-menu-item').classList.add('is-active');
        const loading = window.document.createElement('div');
        loading.className = 'el-loading-mask';
        window.document.body.append(loading);
        const getStyle = window.getComputedStyle.bind(window);
        window.getComputedStyle = element => {
          if (element === loading) loadingObserved = true;
          return getStyle(element);
        };
        const pause = media.pause;
        media.pause = () => { pauseCalls += 1; pause(); };
        window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { playClicks += 1; });
        // Only this fake website restores its player. Explicit sync retries
        // exercise bounded diagnostics, not real autoplay permission.
        media.play();
        advanceNaturally(17);
      }
    });
    const { clicks } = configurePlayer(second);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await second.api.syncSharedJob();
      await waitFor(() => !second.api.state.syncPromise);
    }
    const diagnostics = second.api.state.playbackDiagnostics;
    assert.equal(diagnostics.handshake.length, 16);
    assert.equal(diagnostics.handshake.every(entry => !entry.owns), true);
    assert.equal(diagnostics.takeover, null);
    assert.equal(second.api.state.job.ownerInstance, before.ownerInstance);
    assert.equal(second.api.state.job.generation, before.generation);
    const boundedHandshake = plain(diagnostics.handshake);
    second.window.document.querySelector('.course-name').textContent = '测试课程';
    await second.api.syncSharedJob();
    await waitFor(() => diagnostics.takeover && loadingObserved && second.api.state.jobPromise);
    const takeover = plain(diagnostics.takeover);
    assert.deepEqual(plain(diagnostics.handshake), boundedHandshake);
    assert.equal(takeover.before.action, 'hello');
    assert.equal(takeover.before.stage, 'before');
    assert.equal(takeover.after.action, 'hello');
    assert.equal(takeover.after.stage, 'after');
    assert.ok(Number.isFinite(takeover.before.time));
    assert.ok(Number.isFinite(takeover.after.time));
    assert.ok(takeover.after.time >= takeover.before.time);
    assert.equal(takeover.before.owns, false);
    assert.equal(takeover.after.owns, true);
    assert.equal(takeover.before.tabKnown, true);
    assert.equal(takeover.after.tabKnown, true);
    assert.equal(takeover.before.taskRunning, true);
    assert.equal(takeover.after.taskRunning, true);
    assert.equal(takeover.before.generation, before.generation);
    assert.equal(takeover.after.generation, before.generation + 1);
    for (const observation of [takeover.before.media, takeover.after.media]) {
      assert.equal(observation.paused, false);
      assert.equal(observation.currentTime, 17);
      assert.equal(observation.connected, true);
      assert.equal(observation.currentMedia, true);
    }
    assert.equal(second.api.state.job.runId, before.runId);
    assert.equal(second.api.state.job.ownerInstance, second.api.state.instanceId);
    assert.equal(pauseCalls, 0);
    assert.equal(playClicks, 0);
    assert.deepEqual(clicks, []);
    await second.api.syncSharedJob();
    assert.deepEqual(plain(diagnostics.takeover), takeover);
    assert.deepEqual(plain(diagnostics.handshake), boundedHandshake);
    assert.equal(messages.some(message => ['start', 'open', 'resource-checkpoint', 'record', 'finish', 'course-result'].includes(message.action)), false);
    await second.api.stop(false);
  } finally {
    first.dom.window.close();
    second?.dom.window.close();
  }
});

for (const action of ['pause', 'manual']) {
  test(`用户${action === 'pause' ? '主动暂停' : '因平台异常停止'}后刷新保持停止，不自动点播放器`, async () => {
    const c = coordinator();
    const id = c.addTab(COURSE);
    const first = fixture([mediaItem('已停止视频')], { url: COURSE, connect: c.connect(id) });
    let second;
    try {
      configurePlayer(first);
      await seedCoursePlaybackFixture(first);
      await waitFor(() => !first.media.paused);
      let stopped;
      if (action === 'pause') {
        await first.api.stop(false);
        stopped = first.api.state.job;
      } else {
        stopped = (await c.request(id, first.api.state.instanceId, 'manual', {
          ...auth(first.api.state.job), reason: '网站要求先处理安全验证'
        })).job;
      }
      first.dom.window.close();
      const messages = [];
      second = fixture([mediaItem('已停止视频')], {
        url: COURSE, connect: connectWithMessages(c, id, messages)
      });
      configurePlayer(second);
      let clicks = 0;
      second.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { clicks += 1; });
      await second.api.syncSharedJob();
      // A site's own automatic playback must also be stopped by a saved pause.
      await second.media.play();
      await second.api.syncSharedJob();
      assert.equal(second.media.paused, true);
      assert.equal(second.api.state.job.runId, stopped.runId);
      assert.equal(second.api.state.job.phase, action === 'pause' ? 'paused' : 'manual');
      assert.equal(second.api.state.job.running, false);
      assert.equal(clicks, 0);
      assert.equal(messages.some(message => ['start', 'resource-checkpoint'].includes(message.action)), false);
    } finally {
      first.dom.window.close();
      second?.dom.window.close();
    }
  });
}

test('保存 opening 断点发生在条目点击之前，刷新不能丢失尚未加载的目标', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const f = fixture([mediaItem('要打开的视频')], { url: COURSE, connect: c.connect(id) });
  try {
    const item = f.api.getMenuItems()[0];
    let atClick;
    item.addEventListener('click', () => {
      atClick = plain(c.storage.session[KEY].candidates[0]);
      item.classList.add('is-active');
      f.media.dispatchEvent(new f.window.Event('loadedmetadata'));
    });
    await seedCoursePlaybackFixture(f);
    await waitFor(() => atClick);
    const key = f.api.getItemKey(item);
    assert.equal(atClick.currentResource.key, key);
    assert.equal(atClick.currentResource.title, '要打开的视频');
    assert.equal(atClick.currentResource.stage, 'opening');
    assert.equal(atClick.records[key]?.attempted, true);
    assert.notEqual(atClick.records[key]?.started, true);
    assert.notEqual(atClick.records[key]?.ended, true);
    await waitFor(() => !f.media.paused);
    assert.equal(c.storage.session[KEY].candidates[0].currentResource.stage, 'ready');
    await f.api.stop(false);
  } finally { f.dom.window.close(); }
});

test('旧版只有唯一未结束记录时优先续看长视频，结束后恢复短时长排序', async () => {
  const f = fixture([
    mediaItem('新短视频', 'video', 'unStart', '00 分 10 秒'),
    mediaItem('旧长视频', 'video', 'unStart', '02 分 00 秒')
  ]);
  let task;
  try {
    const { items, clicks } = configurePlayer(f);
    const longKey = f.api.getItemKey(items[1]);
    const shortKey = f.api.getItemKey(items[0]);
    f.api.state.processedCourseKey = f.api.currentCourseKey();
    f.api.state.processedItems.set(longKey, {
      title: '旧长视频', started: true, ended: false, confirmed: false
    });
    attachSavedDirectory(f, plain(f.api.getDirectorySnapshot()));
    f.api.state.job.candidates[0].records = Object.fromEntries(f.api.state.processedItems);
    // Legacy records have no explicit checkpoint: keep testing the unique
    // unfinished-record fallback while isolating this direct executor call.
    assert.equal(f.api.state.resourceCheckpoint, null);
    assert.equal(f.api.state.job.candidates[0].currentResource, undefined);
    task = f.api.runCourse(f.api.state.epoch);
    task.catch(() => {});
    await waitFor(() => !f.media.paused && items[1].classList.contains('is-active'));
    assert.deepEqual(clicks, [longKey]);
    await observePlayback(f, items[1]);
    finishFromWebsite(f, items[1]);
    await waitFor(() => !f.media.paused && items[0].classList.contains('is-active'));
    assert.deepEqual(clicks, [longKey, shortKey]);
    await observePlayback(f, items[0]);
    finishFromWebsite(f, items[0]);
    const result = await task;
    assert.equal(result.complete, true);
    assert.equal(f.api.state.processedItems.get(longKey).ended, true);
    assert.equal(f.api.state.processedItems.get(shortKey).ended, true);
  } finally { await closeStoppedFixture(f, task); }
});

test('同名条目的明确断点按完整 key 续看第二条，第一条不被冒充完成', async () => {
  const f = fixture([
    mediaItem('同名视频', 'video', 'unStart', '00 分 10 秒'),
    mediaItem('同名视频', 'video', 'unStart', '02 分 00 秒')
  ]);
  let task;
  try {
    const { items, clicks } = configurePlayer(f);
    const firstKey = f.api.getItemKey(items[0]);
    const secondKey = f.api.getItemKey(items[1]);
    assert.notEqual(firstKey, secondKey);
    f.api.state.processedCourseKey = f.api.currentCourseKey();
    f.api.state.processedItems.set(secondKey, {
      title: '同名视频', started: true, ended: false, confirmed: false
    });
    f.api.state.resourceCheckpoint = { key: secondKey, title: '同名视频', stage: 'ready', routeKey: '' };
    attachSavedDirectory(f, plain(f.api.getDirectorySnapshot()));
    Object.assign(f.api.state.job.candidates[0], {
      records: Object.fromEntries(f.api.state.processedItems),
      currentResource: plain(f.api.state.resourceCheckpoint)
    });
    task = f.api.runCourse(f.api.state.epoch);
    task.catch(() => {});
    await waitFor(() => !f.media.paused && items[1].classList.contains('is-active'));
    assert.deepEqual(clicks, [secondKey]);
    assert.equal(f.api.state.processedItems.has(firstKey), false);
    await observePlayback(f, items[1]);
    finishFromWebsite(f, items[1]);
    await waitFor(() => !f.media.paused && items[0].classList.contains('is-active'));
    assert.deepEqual(clicks, [secondKey, firstKey]);
    await observePlayback(f, items[0]);
    finishFromWebsite(f, items[0]);
    assert.equal((await task).complete, true);
    assert.equal(f.api.state.processedItems.size, 2);
  } finally { await closeStoppedFixture(f, task); }
});

test('断点已自然结束而平台待确认时只核对页面，不重播或点击资源', async () => {
  const f = fixture([mediaItem('已经自然结束的视频')], { confirmationTimeout: 5 });
  try {
    const item = f.api.getMenuItems()[0];
    const key = f.api.getItemKey(item);
    let clicks = 0;
    item.addEventListener('click', () => { clicks += 1; });
    f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { clicks += 1; });
    f.api.state.processedCourseKey = f.api.currentCourseKey();
    f.api.state.processedItems.set(key, { title: '已经自然结束的视频', started: true, ended: true, confirmed: false });
    f.api.state.resourceCheckpoint = { key, title: '已经自然结束的视频', stage: 'ready', routeKey: '' };
    attachSavedDirectory(f, plain(f.api.getDirectorySnapshot()));
    Object.assign(f.api.state.job.candidates[0], {
      records: Object.fromEntries(f.api.state.processedItems),
      currentResource: plain(f.api.state.resourceCheckpoint)
    });
    const result = await f.api.runCourse(f.api.state.epoch);
    assert.equal(clicks, 0);
    assert.equal(f.media.paused, true);
    assert.equal(result.complete, false);
    assert.equal(result.unconfirmed.join(','), '已经自然结束的视频');
    assert.equal(f.api.state.processedItems.get(key).ended, true);
    assert.equal(f.api.state.processedItems.get(key).confirmed, false);
  } finally { f.dom.window.close(); }
});

test('完整相同的目录元数据复用新 DOM，不展开全部折叠章节，并读取新的完成标记', async () => {
  const f = fixture([mediaItem('第一视频')]);
  try {
    const old = f.api.getMenuItems()[0];
    const oldDirectory = f.window.document.querySelector('.sub-menu-area');
    const markup = oldDirectory.innerHTML;
    const snapshot = plain(f.api.getDirectorySnapshot());
    oldDirectory.innerHTML = markup;
    const fresh = f.api.getMenuItems()[0];
    assert.notEqual(fresh, old);
    assert.equal(old.isConnected, false);
    fresh.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
    const chapter = f.window.document.querySelector('li.el-sub-menu');
    chapter.classList.remove('is-opened');
    chapter.setAttribute('aria-expanded', 'false');
    let expands = 0;
    chapter.querySelector('.el-sub-menu__title').addEventListener('click', () => { expands += 1; });
    attachSavedDirectory(f, snapshot);
    const result = await f.api.waitForDirectory(f.api.state.epoch);
    assert.equal(expands, 0);
    assert.equal(result.videoItems.length, 1);
    assert.equal(result.videoItems[0], fresh);
    assert.equal(result.pendingItems.length, 0);
    assert.equal(f.api.directorySignature(f.api.getDirectorySnapshot()), f.api.directorySignature(snapshot));
    assert.doesNotMatch(JSON.stringify(snapshot), /unStart|done-icon|is-active|HTMLLIElement/);
  } finally { f.dom.window.close(); }
});

test('存储字段顺序改变但目录值相同时复用新 DOM，零展开并读取新完成标记', async () => {
  const f = fixture([mediaItem('已完成视频'), mediaItem('待看音频', 'audio')]);
  try {
    const snapshot = plain(f.api.getDirectorySnapshot());
    const stored = {
      ...snapshot,
      items: snapshot.items.map(item => ({
        durationSeconds: item.durationSeconds, key: item.key,
        mediaType: item.mediaType, title: item.title, chapterTitle: item.chapterTitle
      }))
    };
    assert.deepEqual(stored.items, snapshot.items);
    assert.notEqual(JSON.stringify(stored.items), JSON.stringify(snapshot.items),
      '旧版直接 stringify 会把相同元数据的字段插入顺序误当成目录变化');
    assert.equal(f.api.directorySignature(stored), f.api.directorySignature(snapshot));

    const root = f.window.document.querySelector('.sub-menu-area');
    const oldNodes = f.api.getMenuItems();
    root.innerHTML = root.innerHTML;
    const freshNodes = f.api.getMenuItems();
    assert.equal(oldNodes.every(node => !node.isConnected), true);
    freshNodes[0].querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
    const chapter = root.querySelector('li.el-sub-menu');
    chapter.classList.remove('is-opened');
    chapter.setAttribute('aria-expanded', 'false');
    let expands = 0;
    chapter.querySelector('.el-sub-menu__title').addEventListener('click', () => { expands += 1; });
    attachSavedDirectory(f, stored);
    const result = await f.api.waitForDirectory(f.api.state.epoch);
    assert.equal(expands, 0);
    assert.equal(result.videoItems.length, 2);
    assert.equal(result.pendingItems.length, 1);
    assert.equal(result.pendingItems[0], freshNodes[1]);
    assert.equal(f.api.isPageCompletedItem(freshNodes[0]), true);
    assert.equal(f.api.isPageCompletedItem(freshNodes[1]), false);
    assert.equal(f.api.directorySignature(f.api.getDirectorySnapshot()), f.api.directorySignature(stored));
    assert.equal(f.api.state.logBox.textContent.includes('沿用已有课程统计和时长'), true);
    assert.equal(f.api.state.playedCount, 0);
    assert.equal(f.media.paused, true);
  } finally { f.dom.window.close(); }
});

test('存储字段顺序改变且一个时长值变化时不复用，正常展开并重新按时长排序', async () => {
  const f = fixture([
    mediaItem('原本较短视频', 'video', 'unStart', '01 分 00 秒'),
    mediaItem('时长变化音频', 'audio', 'unStart', '02 分 00 秒')
  ]);
  try {
    const snapshot = plain(f.api.getDirectorySnapshot());
    const stored = {
      ...snapshot,
      items: snapshot.items.map(item => ({
        durationSeconds: item.durationSeconds, key: item.key,
        mediaType: item.mediaType, title: item.title, chapterTitle: item.chapterTitle
      }))
    };
    assert.equal(f.api.directorySignature(stored), f.api.directorySignature(snapshot));
    const changed = f.api.getMenuItems()[1];
    changed.querySelector('.video-duration').textContent = '00 分 10 秒';
    assert.notEqual(f.api.directorySignature(f.api.getDirectorySnapshot()), f.api.directorySignature(stored));
    const chapter = f.window.document.querySelector('li.el-sub-menu');
    chapter.classList.remove('is-opened');
    chapter.setAttribute('aria-expanded', 'false');
    let expands = 0;
    chapter.querySelector('.el-sub-menu__title').addEventListener('click', () => {
      expands += 1;
      chapter.classList.add('is-opened');
      chapter.setAttribute('aria-expanded', 'true');
    });
    attachSavedDirectory(f, stored);
    const result = await f.api.waitForDirectory(f.api.state.epoch);
    assert.equal(expands, 1);
    assert.equal(result.videoItems.length, 2);
    assert.equal(result.pendingItems.length, 2);
    assert.equal(result.pendingItems[0], changed);
    assert.equal(f.api.getDirectorySnapshot().items[1].durationSeconds, 10);
    assert.equal(f.api.state.logBox.textContent.includes('沿用已有课程统计和时长'), false);
    assert.equal(f.api.state.playedCount, 0);
    assert.equal(f.media.paused, true);
  } finally { f.dom.window.close(); }
});

test('完整目录仅第一章折叠时仍按 DOM 原顺序复用，发现顺序改变不重展开章节', async () => {
  const f = fixture([]);
  try {
    const root = f.window.document.querySelector('.sub-menu-area');
    root.innerHTML = `<ul class="el-menu">
      <li class="el-sub-menu is-opened" aria-expanded="true">
        <div class="el-sub-menu__title">第一章</div>
        <ul class="el-menu el-menu--inline">${mediaItem('第一章长视频', 'video', 'unStart', '02 分 00 秒')}</ul>
      </li>
      <li class="el-sub-menu is-opened" aria-expanded="true">
        <div class="el-sub-menu__title">第二章</div>
        <ul class="el-menu el-menu--inline">${mediaItem('第二章短视频', 'video', 'unStart', '00 分 10 秒')}</ul>
      </li>
    </ul>`;
    const snapshot = plain(f.api.getDirectorySnapshot());
    const directoryKeys = snapshot.items.map(item => item.key);
    assert.deepEqual(snapshot.items.map(item => item.title), ['第一章长视频', '第二章短视频']);
    assert.deepEqual(Array.from(f.api.getMenuItems(), f.api.getItemKey), directoryKeys);

    const [firstChapter] = root.querySelectorAll('li.el-sub-menu');
    firstChapter.classList.remove('is-opened');
    firstChapter.setAttribute('aria-expanded', 'false');
    // Leaves remain loaded. The open second chapter is discovered first by
    // the old selector priority, even though the document order is unchanged.
    assert.deepEqual(Array.from(f.api.getMenuItems(), f.api.getItemKey), directoryKeys.slice().reverse());
    assert.deepEqual(plain(f.api.getDirectorySnapshot()).items.map(item => item.key), directoryKeys);
    assert.equal(f.api.directorySignature(f.api.getDirectorySnapshot()), f.api.directorySignature(snapshot));
    let expands = 0;
    root.querySelectorAll('.el-sub-menu__title').forEach(button =>
      button.addEventListener('click', () => { expands += 1; }));
    attachSavedDirectory(f, snapshot);
    const result = await f.api.waitForDirectory(f.api.state.epoch);
    assert.equal(expands, 0);
    assert.equal(result.videoItems.length, 2);
    assert.equal(result.pendingItems.length, 2);
    assert.equal(result.pendingItems[0].querySelector('.lecture-title').textContent, '第二章短视频');
    assert.equal(f.api.state.logBox.textContent.includes('沿用已有课程统计和时长'), true);
  } finally { f.dom.window.close(); }
});

test('两章混合分组与直接叶条目按 DOM 顺序保存目录，刷新折叠状态不改变签名或短时长队列', async () => {
  const f = fixture([]);
  try {
    const root = f.window.document.querySelector('.sub-menu-area');
    root.innerHTML = `<ul class="el-menu">
      <li class="el-sub-menu is-opened" aria-expanded="true">
        <div class="el-sub-menu__title">第一章</div>
        <ul class="el-menu el-menu--inline">
          ${mediaItem('第一章直接视频', 'video', 'unStart', '01 分 00 秒')}
          <li class="el-menu-item-group"><ul>${mediaItem('第一章分组音频', 'audio', 'unStart', '00 分 30 秒')}</ul></li>
        </ul>
      </li>
      <li class="el-sub-menu is-opened" aria-expanded="true">
        <div class="el-sub-menu__title">第二章</div>
        <ul class="el-menu el-menu--inline">
          ${mediaItem('第二章直接视频', 'video', 'unStart', '00 分 10 秒')}
          <li class="el-menu-item-group"><ul>${mediaItem('第二章分组视频', 'video', 'unStart', '00 分 20 秒')}</ul></li>
        </ul>
      </li>
    </ul>`;
    const oldNodes = [...root.querySelectorAll('li.el-menu-item')];
    const expectedKeys = oldNodes.map(f.api.getItemKey);
    const snapshot = plain(f.api.getDirectorySnapshot());
    assert.notDeepEqual(Array.from(f.api.getMenuItems(), f.api.getItemKey), expectedKeys);
    assert.deepEqual(snapshot.items.map(item => item.key), expectedKeys);
    assert.deepEqual(snapshot.items.map(item => item.title), [
      '第一章直接视频', '第一章分组音频', '第二章直接视频', '第二章分组视频'
    ]);
    assert.deepEqual(snapshot.items.map(item => item.mediaType), ['video', 'audio', 'video', 'video']);
    assert.deepEqual(snapshot.items.map(item => item.durationSeconds), [60, 30, 10, 20]);

    root.innerHTML = root.innerHTML;
    assert.equal(oldNodes.every(node => !node.isConnected), true);
    const [firstChapter] = root.querySelectorAll('li.el-sub-menu');
    firstChapter.classList.remove('is-opened');
    firstChapter.setAttribute('aria-expanded', 'false');
    assert.notDeepEqual(Array.from(f.api.getMenuItems(), f.api.getItemKey), expectedKeys);
    assert.deepEqual(plain(f.api.getDirectorySnapshot()).items.map(item => item.key), expectedKeys);
    assert.equal(f.api.directorySignature(f.api.getDirectorySnapshot()), f.api.directorySignature(snapshot));
    let expands = 0;
    root.querySelectorAll('.el-sub-menu__title').forEach(button =>
      button.addEventListener('click', () => { expands += 1; }));
    attachSavedDirectory(f, snapshot);
    const result = await f.api.waitForDirectory(f.api.state.epoch);
    assert.equal(expands, 0);
    assert.equal(result.videoItems.length, 4);
    assert.equal(result.pendingItems.length, 4);
    assert.deepEqual(Array.from(result.pendingItems, item => item.querySelector('.lecture-title').textContent), [
      '第二章直接视频', '第二章分组视频', '第一章分组音频', '第一章直接视频'
    ]);
    assert.equal(f.api.state.logBox.textContent.includes('沿用已有课程统计和时长'), true);
  } finally { f.dom.window.close(); }
});

test('已有叶条目匹配缓存但新增空章节尚未展开时仍正常展开，不能漏掉新章节资源', async () => {
  const f = fixture([mediaItem('已知视频')]);
  try {
    const snapshot = plain(f.api.getDirectorySnapshot());
    const list = f.window.document.querySelector('.sub-menu-area > ul');
    list.insertAdjacentHTML('beforeend', `
      <li class="el-sub-menu" aria-expanded="false">
        <div class="el-sub-menu__title">新增章节</div><ul></ul>
      </li>`);
    const chapter = list.lastElementChild;
    let expands = 0;
    chapter.querySelector('.el-sub-menu__title').addEventListener('click', () => {
      expands += 1;
      chapter.setAttribute('aria-expanded', 'true');
      chapter.classList.add('is-opened');
      chapter.querySelector('ul').innerHTML = mediaItem('新章节视频');
    });
    assert.equal(f.api.directorySignature(f.api.getDirectorySnapshot()), f.api.directorySignature(snapshot));
    attachSavedDirectory(f, snapshot);
    const result = await f.api.waitForDirectory(f.api.state.epoch);
    assert.equal(expands, 1);
    assert.equal(result.videoItems.length, 2);
    assert.equal(result.pendingItems.length, 2);
    assert.equal(f.api.state.playedCount, 0);
    assert.equal(f.api.state.logBox.textContent.includes('沿用已有课程统计和时长'), false);
  } finally { f.dom.window.close(); }
});

for (const change of ['missing', 'document', 'reordered']) {
  test(`缓存目录${change === 'missing' ? '缺失资源' : change === 'document' ? '视频变文档' : '改变条目顺序'}时不复用，不把旧资源当完成`, async () => {
    const f = fixture([mediaItem('第一视频'), mediaItem('第二视频')]);
    try {
      const snapshot = plain(f.api.getDirectorySnapshot());
      const [first, second] = f.api.getMenuItems();
      if (change === 'missing') second.remove();
      if (change === 'document') second.querySelector('.video-icon').className = 'text-icon';
      if (change === 'reordered') first.parentElement.append(first);
      attachSavedDirectory(f, snapshot);
      f.api.CFG.directoryLoadTimeout = 30;
      await assert.rejects(f.api.waitForDirectory(f.api.state.epoch), /目录|资源/);
      assert.equal(f.api.state.playedCount, 0);
      assert.equal(f.media.paused, true);
      assert.equal(f.api.state.logBox.textContent.includes('沿用已有课程统计和时长'), false);
    } finally { f.dom.window.close(); }
  });
}

test('时长晚到改变目录签名与短时长排序，不冻结未知时长缓存', async () => {
  const f = fixture([
    mediaItem('已知时长视频', 'video', 'unStart', '01 分 00 秒'),
    mediaItem('时长晚到视频', 'video', 'unStart', '')
  ]);
  try {
    const snapshot = plain(f.api.getDirectorySnapshot());
    assert.equal(snapshot.items[1].durationSeconds, null);
    const item = f.api.getMenuItems()[1];
    item.insertAdjacentHTML('beforeend', '<div class="video-duration">00 分 10 秒</div>');
    attachSavedDirectory(f, snapshot);
    const result = await f.api.waitForDirectory(f.api.state.epoch);
    assert.notEqual(f.api.directorySignature(f.api.getDirectorySnapshot()), f.api.directorySignature(snapshot));
    assert.equal(f.api.getDirectorySnapshot().items[1].durationSeconds, 10);
    assert.equal(result.pendingItems[0], item);
    assert.equal(f.api.state.logBox.textContent.includes('沿用已有课程统计和时长'), false);
  } finally { f.dom.window.close(); }
});

test('缓存目录比当前部分目录多时等待新条目加载，不能用部分列表宣布完成', async () => {
  const f = fixture([mediaItem('第一视频'), mediaItem('晚到视频')]);
  try {
    const snapshot = plain(f.api.getDirectorySnapshot());
    const second = f.api.getMenuItems()[1];
    const list = second.parentElement;
    second.remove();
    attachSavedDirectory(f, snapshot);
    f.api.CFG.directoryLoadTimeout = 1000;
    const task = f.api.waitForDirectory(f.api.state.epoch);
    const timer = setTimeout(() => { list.append(second); }, 40);
    try {
      const result = await task;
      assert.equal(result.videoItems.length, 2);
      assert.equal(result.videoItems.includes(second), true);
      assert.equal(result.pendingItems.length, 2);
      assert.equal(f.api.state.playedCount, 0);
    } finally { clearTimeout(timer); }
  } finally { f.dom.window.close(); }
});

test('断点入口与重新打开资源的实际路由不符时停止，不点击播放按钮', async () => {
  const f = fixture([mediaItem('断点视频')]);
  try {
    const { items } = configurePlayer(f);
    let plays = 0;
    f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { plays += 1; });
    f.api.state.resourceCheckpoint = {
      key: f.api.getItemKey(items[0]), title: '断点视频', stage: 'ready',
      routeKey: '/student/#/courseInfo/learn/courseWare/course-1/video/a-different-resource?classId=class-1'
    };
    f.api.state.running = true;
    await assert.rejects(f.api.playItemToEnd(items[0], f.api.state.epoch, f.api.currentCourseKey()), /断点不符|原资源身份/);
    assert.equal(plays, 0);
    assert.equal(f.media.paused, true);
    assert.equal(f.api.state.playedCount, 0);
  } finally { f.dom.window.close(); }
});

test('后台拒绝 ready 断点时立即停止整个任务，不把身份失败当单条失败并点击下一条', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const messages = [];
  const f = fixture([
    mediaItem('当前短视频', 'video', 'unStart', '00 分 10 秒'),
    mediaItem('下一条视频', 'video', 'unStart', '02 分 00 秒')
  ], {
    url: COURSE,
    connect: window => {
      c.connect(id)(window);
      const send = window.chrome.runtime.sendMessage;
      window.chrome.runtime.sendMessage = message => {
        messages.push(plain(message));
        if (message.action === 'resource-checkpoint' && message.stage === 'ready') {
          return Promise.resolve({ ok: false, error: '当前音视频断点无法确认' });
        }
        return send(message);
      };
    }
  });
  try {
    const { items, clicks } = configurePlayer(f);
    const firstKey = f.api.getItemKey(items[0]);
    const secondKey = f.api.getItemKey(items[1]);
    let playClicks = 0;
    f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { playClicks += 1; });
    await seedCoursePlaybackFixture(f);
    await waitFor(() => c.storage.session[KEY]?.phase === 'manual' && !f.api.state.jobPromise);
    const job = plain(c.storage.session[KEY]);
    assert.equal(job.running, false);
    assert.equal(job.phase, 'manual');
    assert.match(job.reason, /当前音视频断点无法确认/);
    assert.equal(f.media.paused, true);
    assert.equal(playClicks, 0);
    assert.deepEqual(clicks, []);
    assert.equal(job.candidates[0].currentResource.key, firstKey);
    assert.equal(job.candidates[0].currentResource.stage, 'opening');
    assert.equal(job.candidates[0].records[firstKey].attempted, true);
    assert.notEqual(job.candidates[0].records[firstKey].started, true);
    assert.notEqual(job.candidates[0].records[firstKey].ended, true);
    assert.notEqual(job.candidates[0].records[firstKey].confirmed, true);
    assert.equal(job.candidates[0].records[secondKey], undefined);
    assert.equal(f.api.state.playedCount, 0);
    assert.equal(messages.filter(message => message.action === 'resource-checkpoint' &&
      message.stage === 'ready').length, 1);
    assert.equal(messages.some(message => ['course-result', 'finish', 'open'].includes(message.action)), false);
    assert.equal(c.navigation.length, 0);
    assert.equal(c.removed.length, 0);
  } finally { f.dom.window.close(); }
});

test('首次进入播放课程没有已观察断点时先暂停网站默认自动播放，目录确认后才启动选定资源', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const messages = [];
  const f = fixture([
    mediaItem('网站默认打开的长视频', 'video', 'unStart', '02 分 00 秒'),
    mediaItem('应优先处理的短视频', 'video', 'unStart', '00 分 10 秒')
  ], { url: COURSE, connect: connectWithMessages(c, id, messages) });
  try {
    const { items, clicks } = configurePlayer(f, 0);
    const shortKey = f.api.getItemKey(items[1]);
    const loading = f.window.document.createElement('div');
    loading.className = 'el-loading-mask';
    f.window.document.body.append(loading);
    const playClicks = [];
    f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => {
      playClicks.push(plain(c.storage.session[KEY].candidates[0].currentResource));
    });
    // This is a site's automatic playback on arrival, before a directory or
    // selected-resource checkpoint has been accepted by the extension.
    await f.media.play();
    assert.equal(f.media.paused, false);
    await seedCoursePlaybackFixture(f);
    await waitFor(() => f.api.state.jobPromise && f.media.paused);
    const waiting = plain(c.storage.session[KEY]);
    assert.equal(waiting.running, true);
    assert.equal(waiting.phase, 'course');
    assert.equal(waiting.targetPurpose, 'play');
    assert.equal(waiting.candidates[0].currentResource, undefined);
    assert.deepEqual(waiting.candidates[0].records, {});
    assert.deepEqual(clicks, []);
    assert.deepEqual(playClicks, []);
    assert.equal(messages.some(message => message.action === 'resource-checkpoint'), false);

    loading.remove();
    await waitFor(() => !f.media.paused && items[1].classList.contains('is-active'));
    assert.deepEqual(clicks, [shortKey]);
    assert.equal(playClicks.length, 1);
    assert.equal(playClicks[0].key, shortKey);
    assert.equal(playClicks[0].stage, 'ready');
    assert.equal(c.storage.session[KEY].candidates[0].records[shortKey].started, true);
    assert.notEqual(c.storage.session[KEY].candidates[0].records[shortKey].ended, true);
    assert.equal(f.api.state.playedCount, 0);
    await f.api.stop(false);
    assert.equal(f.media.paused, true);
  } finally { f.dom.window.close(); }
});

test('刷新到精确已观察断点时保留网站正常续播，核对目录期间不再次暂停或点播放', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const first = fixture([mediaItem('原来正在看的视频')], { url: COURSE, connect: c.connect(id) });
  let second;
  try {
    configurePlayer(first);
    await seedCoursePlaybackFixture(first);
    await waitFor(() => !first.media.paused && c.storage.session[KEY]?.candidates[0].currentResource?.stage === 'ready');
    const before = plain(c.storage.session[KEY]);
    const checkpoint = before.candidates[0].currentResource;
    first.dom.window.close();

    second = fixture([mediaItem('原来正在看的视频')], { url: COURSE, connect: c.connect(id) });
    configurePlayer(second);
    const loading = second.window.document.createElement('div');
    loading.className = 'el-loading-mask';
    second.window.document.body.append(loading);
    let playClicks = 0;
    second.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { playClicks += 1; });
    const observedRoute = `${second.window.location.pathname}${second.window.location.hash}`;
    assert.equal(checkpoint.routeKey, observedRoute);
    // The fake website resumes its own saved position. The extension does not
    // write currentTime or acquire playback permission in this simulation.
    await second.media.play();
    second.advanceNaturally(17);
    await second.api.syncSharedJob();
    await waitFor(() => second.api.state.jobPromise &&
      second.api.state.job.ownerInstance === second.api.state.instanceId);
    assert.equal(second.media.paused, false);
    assert.equal(second.media.currentTime, 17);
    assert.equal(second.api.state.job.runId, before.runId);
    assert.equal(second.api.state.job.candidates[0].currentResource.key, checkpoint.key);
    assert.equal(playClicks, 0);

    loading.remove();
    await waitFor(() => second.api.state.logBox.textContent.includes('正在正常播放'));
    assert.equal(second.media.paused, false);
    assert.equal(second.media.currentTime, 17);
    assert.equal(playClicks, 0);
    assert.equal(c.storage.session[KEY].candidates[0].records[checkpoint.key].ended, false);
    await second.api.stop(false);
    assert.equal(second.media.paused, true);
  } finally {
    first.dom.window.close();
    second?.dom.window.close();
  }
});

test('默认新文档握手从 get 到 hello 接回断点，网站已自行续播时没有扩展初始暂停', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const first = fixture([mediaItem('握手续看视频')], { url: COURSE, connect: c.connect(id) });
  let second;
  try {
    configurePlayer(first);
    await seedCoursePlaybackFixture(first);
    await waitFor(() => !first.media.paused && c.storage.session[KEY]?.candidates[0].currentResource?.stage === 'ready');
    const before = plain(c.storage.session[KEY]);
    const checkpoint = before.candidates[0].currentResource;
    first.dom.window.close();

    const messages = [];
    let loading, loadingObserved = false, pauseCalls = 0, playClicks = 0;
    second = fixture([mediaItem('握手续看视频')], {
      url: COURSE, connect: connectWithMessages(c, id, messages),
      beforeContent: ({ window, media, advanceNaturally }) => {
        window.document.querySelector('li.el-menu-item').classList.add('is-active');
        loading = window.document.createElement('div');
        loading.className = 'el-loading-mask';
        window.document.body.append(loading);
        const getStyle = window.getComputedStyle.bind(window);
        window.getComputedStyle = element => {
          if (element === loading) loadingObserved = true;
          return getStyle(element);
        };
        const pause = media.pause;
        media.pause = () => { pauseCalls += 1; pause(); };
        window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { playClicks += 1; });
        // The fake website owns this restoration, before script injection.
        // It proves neither real browser permission nor real media playback.
        media.play();
        advanceNaturally(17);
      }
    });
    const { clicks } = configurePlayer(second);
    // Fake website events arrive after content injection but before its
    // default timer has sent the first get. They are observation only.
    second.media.dispatchEvent(new second.window.Event('loadstart'));
    second.media.dispatchEvent(new second.window.Event('playing'));
    // Deliberately do not call start/syncSharedJob on the refreshed document.
    // Only the content script's default 0 ms initialization sends get -> hello.
    await waitFor(() => loadingObserved && second.api.state.jobPromise &&
      second.api.state.job.ownerInstance === second.api.state.instanceId);
    assert.deepEqual(messages.slice(0, 2).map(message => message.action), ['get', 'hello']);
    assert.equal(second.api.state.job.runId, before.runId);
    assert.equal(second.api.state.job.ownerInstance, second.api.state.instanceId);
    assert.equal(second.api.state.job.generation, before.generation + 1);
    assert.equal(second.api.state.job.candidates[0].currentResource.key, checkpoint.key);
    assert.equal(second.media.currentTime, 17);
    assert.equal(second.media.paused, false);
    assert.equal(pauseCalls, 0);
    assert.equal(playClicks, 0);
    assert.deepEqual(clicks, []);
    const diagnostics = second.api.state.playbackDiagnostics;
    assert.equal(diagnostics.version, 1);
    assert.equal(diagnostics.entry.paused, false);
    assert.equal(diagnostics.entry.currentTime, 17);
    assert.deepEqual(Array.from(diagnostics.handshake, entry => `${entry.action}:${entry.stage}`),
      ['get:before', 'get:after', 'hello:before', 'hello:after']);
    assert.equal(diagnostics.handshake[0].tabKnown, false);
    assert.equal(diagnostics.handshake[0].phase, null);
    assert.equal(diagnostics.handshake[1].tabKnown, true);
    assert.equal(diagnostics.handshake[1].owns, false);
    assert.equal(diagnostics.handshake[3].owns, true);
    assert.equal(diagnostics.handshake[3].generation, before.generation + 1);
    assert.equal(diagnostics.handshake.every(entry => !entry.media.paused && entry.media.currentTime === 17), true);
    assert.deepEqual(Array.from(diagnostics.mediaEvents, entry => entry.type), ['loadstart', 'playing']);
    assert.equal(diagnostics.mediaEvents.every(entry => entry.currentTime === 17), true);
    assert.equal(diagnostics.guards.some(guard => guard.decision === 'retain-current'), true);
    assert.deepEqual(Array.from(diagnostics.pauses), []);
    assert.deepEqual(Array.from(diagnostics.directory, entry => entry.stage), ['before']);
    assert.deepEqual(Object.keys(c.storage.session), [KEY]);
    assert.deepEqual(Object.keys(c.storage.local), [KEY]);
    assert.equal(Object.hasOwn(c.storage.session[KEY], 'diagnostics'), false);
    assert.equal(Object.hasOwn(c.storage.session[KEY], 'playbackDiagnostics'), false);
    loading.remove();
    await waitFor(() => second.api.state.job.candidates[0].records[checkpoint.key]?.playbackAttempt?.before?.currentTime === 17);
    assert.equal(second.media.paused, false);
    assert.equal(pauseCalls, 0);
    assert.equal(playClicks, 0);
    assert.deepEqual(clicks, []);
    assert.deepEqual(Array.from(diagnostics.directory, entry => entry.stage), ['before', 'reused']);
    assert.equal(second.api.state.playedCount, 0);
    assert.notEqual(second.api.state.job.candidates[0].records[checkpoint.key].ended, true);
    assert.equal(messages.some(message => ['start', 'scan-result', 'open', 'finish', 'course-result'].includes(message.action)), false);
    await second.api.stop(false);
  } finally {
    first.dom.window.close();
    second?.dom.window.close();
  }
});

test('默认新文档握手没有已观察断点时记录扩展初始暂停，再按正常目录选择资源', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const seeded = await c.request(id, 'previous-document', 'start', { title: '测试课程' });
  const messages = [];
  let loading, loadingObserved = false, pauseCalls = 0, playClicks = 0;
  const f = fixture([
    mediaItem('网站默认长视频', 'video', 'unStart', '02 分 00 秒'),
    mediaItem('选定短视频', 'video', 'unStart', '00 分 10 秒')
  ], {
    url: COURSE, connect: connectWithMessages(c, id, messages),
    beforeContent: ({ window, media, advanceNaturally }) => {
      window.document.querySelector('li.el-menu-item').classList.add('is-active');
      loading = window.document.createElement('div');
      loading.className = 'el-loading-mask';
      window.document.body.append(loading);
      const getStyle = window.getComputedStyle.bind(window);
      window.getComputedStyle = element => {
        if (element === loading) loadingObserved = true;
        return getStyle(element);
      };
      const pause = media.pause;
      media.pause = () => { pauseCalls += 1; pause(); };
      window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { playClicks += 1; });
      // The fake website is playing a default resource; the extension may
      // pause it while confirming the directory. No position is written.
      media.play();
      advanceNaturally(17);
    }
  });
  try {
    const { items, clicks } = configurePlayer(f);
    const shortKey = f.api.getItemKey(items[1]);
    await waitFor(() => loadingObserved && f.api.state.jobPromise && f.media.paused);
    assert.deepEqual(messages.slice(0, 2).map(message => message.action), ['get', 'hello']);
    assert.equal(f.api.state.job.runId, seeded.job.runId);
    assert.equal(f.api.state.job.candidates[0].currentResource, undefined);
    assert.equal(pauseCalls, 1);
    assert.equal(playClicks, 0);
    assert.deepEqual(clicks, []);
    assert.equal(f.media.currentTime, 17);
    const diagnostics = f.api.state.playbackDiagnostics;
    assert.equal(diagnostics.entry.paused, false);
    assert.equal(diagnostics.entry.currentTime, 17);
    assert.deepEqual(Array.from(diagnostics.handshake, entry => `${entry.action}:${entry.stage}`),
      ['get:before', 'get:after', 'hello:before', 'hello:after']);
    assert.equal(diagnostics.guards.some(guard => guard.decision === 'pause-initial'), true);
    assert.equal(diagnostics.pauses.length, 1);
    assert.equal(diagnostics.pauses[0].before.paused, false);
    assert.equal(diagnostics.pauses[0].after.paused, true);
    assert.equal(diagnostics.pauses[0].reason, 'initial-resource-check');
    assert.deepEqual(messages.map(message => message.action), ['get', 'hello']);
    loading.remove();
    await waitFor(() => !f.media.paused && items[1].classList.contains('is-active'));
    assert.deepEqual(clicks, [shortKey]);
    assert.equal(playClicks, 1);
    assert.equal(f.api.state.playedCount, 0);
    assert.notEqual(c.storage.session[KEY].candidates[0].records[shortKey].ended, true);
    await f.api.stop(false);
  } finally { f.dom.window.close(); }
});

test('默认新文档握手时网站未自行播放且可见按钮点击无效，诊断不能误称扩展曾暂停或已完成', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const first = fixture([mediaItem('网站未启动视频')], { url: COURSE, connect: c.connect(id) });
  let second;
  try {
    configurePlayer(first);
    await seedCoursePlaybackFixture(first);
    await waitFor(() => !first.media.paused && c.storage.session[KEY]?.candidates[0].currentResource?.stage === 'ready');
    const before = plain(c.storage.session[KEY]);
    const checkpoint = before.candidates[0].currentResource;
    first.dom.window.close();
    const messages = [];
    let pauseCalls = 0, playCalls = 0, playClicks = 0;
    second = fixture([mediaItem('网站未启动视频')], {
      url: COURSE, connect: connectWithMessages(c, id, messages),
      beforeContent: ({ window, media, advanceNaturally }) => {
        window.document.querySelector('li.el-menu-item').classList.add('is-active');
        // Only the fake site sets its restored position. It stays paused.
        // A no-op website button is a deterministic negative simulation,
        // not a claim that Edge denied an actual play() request.
        advanceNaturally(17);
        const pause = media.pause;
        media.pause = () => { pauseCalls += 1; pause(); };
        media.play = async () => { playCalls += 1; };
        const oldButton = window.document.querySelector('.vjs-big-play-button');
        const inertButton = oldButton.cloneNode(true);
        inertButton.getClientRects = () => [{ width: 1, height: 1 }];
        inertButton.addEventListener('click', () => { playClicks += 1; });
        oldButton.replaceWith(inertButton);
      }
    });
    const { clicks } = configurePlayer(second);
    second.api.CFG.gatewayPauseGrace = 20;
    second.api.CFG.stallTimeout = 1000;
    await waitFor(() => c.storage.session[KEY]?.candidates[0].records[checkpoint.key]?.recovery?.attempts === 1);
    const stopped = plain(c.storage.session[KEY]);
    const record = stopped.candidates[0].records[checkpoint.key];
    assert.deepEqual(messages.slice(0, 2).map(message => message.action), ['get', 'hello']);
    assert.equal(stopped.runId, before.runId);
    assert.equal(stopped.running, true);
    assert.equal(stopped.phase, 'course');
    assert.match(record.recovery.lastReason, /播放没有开始/);
    assert.equal(second.media.currentTime, 17);
    assert.equal(second.media.paused, true);
    assert.equal(pauseCalls, 0);
    assert.equal(playCalls, 0);
    assert.equal(playClicks, 1);
    assert.deepEqual(clicks, []);
    assert.equal(record.playbackAttempt.before.paused, true);
    assert.equal(record.playbackAttempt.after.paused, true);
    assert.equal(record.playbackAttempt.stopped.paused, true);
    assert.deepEqual(record.playbackAttempt.events, []);
    assert.notEqual(record.ended, true);
    assert.notEqual(record.confirmed, true);
    assert.equal(second.api.state.playedCount, 0);
    const diagnostics = second.api.state.playbackDiagnostics;
    assert.equal(diagnostics.entry.paused, true);
    assert.equal(diagnostics.entry.currentTime, 17);
    assert.deepEqual(Array.from(diagnostics.handshake, entry => `${entry.action}:${entry.stage}`),
      ['get:before', 'get:after', 'hello:before', 'hello:after']);
    assert.equal(diagnostics.handshake.every(entry => entry.media.paused && entry.media.currentTime === 17), true);
    assert.deepEqual(Array.from(diagnostics.mediaEvents), []);
    assert.equal(diagnostics.guards.some(guard => guard.decision === 'retain-current'), true);
    assert.deepEqual(Array.from(diagnostics.pauses), []);
    assert.deepEqual(Array.from(diagnostics.directory, entry => entry.stage), ['before', 'reused']);
    assert.equal(messages.some(message => ['start', 'scan-result', 'open', 'finish', 'course-result'].includes(message.action)), false);
    assert.equal(c.navigation.length, 0);
    await second.api.stop(false);
    await waitFor(() => c.storage.session[KEY]?.phase === 'paused' && !second.api.state.jobPromise);
    assert.equal(c.storage.session[KEY].running, false);
    assert.equal(second.media.paused, true);
    assert.equal(pauseCalls, 0, 'already-paused media must not acquire a fabricated pause diagnostic');
    assert.equal(playClicks, 1, 'explicit pause cancels the pending retry click');
  } finally {
    first.dom.window.close();
    second?.dom.window.close();
  }
});

for (const action of ['pause', 'manual']) {
  test(`首个 get 尚未返回时${action === 'pause' ? '暂停' : '人工停止'}广播立即停止媒体，迟到响应不能降代次或复活`, async () => {
    const c = coordinator();
    const id = c.addTab(COURSE);
    const seeded = await c.request(id, 'previous-document', 'start', { title: '测试课程' });
    const messages = [];
    let delayedResponse, releaseGet, pauseCalls = 0, playClicks = 0;
    const responseGate = new Promise(resolve => { releaseGet = resolve; });
    const f = fixture([mediaItem('需要立即停止的视频')], {
      url: COURSE,
      connect: window => {
        c.connect(id)(window);
        const send = window.chrome.runtime.sendMessage;
        window.chrome.runtime.sendMessage = async message => {
          messages.push(plain(message));
          const response = await send(message);
          if (message.action === 'get' && !delayedResponse) {
            delayedResponse = plain(response);
            await responseGate;
          }
          return response;
        };
      },
      beforeContent: ({ window, media, advanceNaturally }) => {
        window.document.querySelector('li.el-menu-item').classList.add('is-active');
        const pause = media.pause;
        media.pause = () => { pauseCalls += 1; pause(); };
        window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { playClicks += 1; });
        // Simulated site playback exists before the automatic first get.
        // The extension must stop it without waiting for the next poll.
        media.play();
        advanceNaturally(17);
        const setInterval = window.setInterval.bind(window);
        // Keep automatic first initialization; defer later polling so it
        // cannot hide an incorrect result of this one delayed get.
        window.setInterval = (callback, delay, ...args) =>
          setInterval(callback, Math.max(delay, 60000), ...args);
      }
    });
    try {
      const { clicks } = configurePlayer(f);
      await waitFor(() => delayedResponse);
      assert.equal(f.api.state.tabId, null);
      assert.equal(f.api.state.job, null);
      assert.equal(delayedResponse.job.running, true);
      const stopped = await c.request(id, 'previous-document', action, {
        ...auth(seeded.job), reason: '首个 get 回来之前要求停止'
      });
      assert.equal(stopped.job.running, false);
      assert.equal(f.api.state.job.phase, action === 'manual' ? 'manual' : 'paused');
      assert.ok(f.api.state.job.revision > delayedResponse.job.revision);
      assert.equal(f.api.state.tabId, id, 'the stop broadcast identifies this task tab immediately');
      assert.equal(f.api.state.running, false);
      assert.equal(f.media.paused, true, 'stop playback before releasing the delayed get');
      assert.equal(f.media.currentTime, 17);
      assert.equal(pauseCalls, 1);
      assert.equal(playClicks, 0);
      assert.deepEqual(clicks, []);
      const stopRevision = f.api.state.job.revision;
      const stopGeneration = f.api.state.job.generation;
      releaseGet();
      await waitFor(() => f.api.state.tabId === id && !f.api.state.syncPromise);
      assert.equal(f.api.state.job.runId, seeded.job.runId);
      assert.equal(f.api.state.job.running, false);
      assert.equal(f.api.state.job.phase, action === 'manual' ? 'manual' : 'paused');
      assert.equal(f.api.state.job.ownerInstance, 'previous-document');
      assert.equal(f.api.state.job.generation, stopped.job.generation);
      assert.equal(f.api.state.job.revision, stopRevision);
      assert.equal(f.api.state.job.generation, stopGeneration);
      assert.equal(f.media.paused, true);
      assert.equal(f.media.currentTime, 17);
      assert.equal(pauseCalls, 1);
      assert.equal(playClicks, 0);
      assert.deepEqual(clicks, []);
      assert.deepEqual(messages.map(message => message.action), ['get']);
      assert.equal(f.api.state.jobPromise, null);
      const diagnostics = f.api.state.playbackDiagnostics;
      assert.equal(diagnostics.entry.paused, false);
      assert.equal(diagnostics.entry.currentTime, 17);
      assert.deepEqual(Array.from(diagnostics.handshake, entry => `${entry.action}:${entry.stage}`),
        ['get:before', 'get:after']);
      assert.equal(diagnostics.handshake[0].tabKnown, false);
      assert.equal(diagnostics.handshake[0].media.paused, false);
      assert.equal(diagnostics.handshake[1].tabKnown, true);
      assert.equal(diagnostics.handshake[1].taskRunning, false);
      assert.equal(diagnostics.handshake[1].phase, action === 'manual' ? 'manual' : 'paused');
      assert.equal(diagnostics.handshake[1].media.paused, true);
      assert.deepEqual(Array.from(diagnostics.guards), []);
      assert.deepEqual(Array.from(diagnostics.directory), []);
      assert.equal(diagnostics.pauses.length, 1);
      assert.equal(diagnostics.pauses[0].before.paused, false);
      assert.equal(diagnostics.pauses[0].after.paused, true);
      assert.equal(diagnostics.pauses[0].reason, 'task-stopped');
      assert.equal(c.navigation.length, 0);
      assert.deepEqual(c.storage.session[KEY].candidates[0].records, {});
    } finally {
      releaseGet();
      await Promise.allSettled([f.api.state.syncPromise].filter(Boolean));
      await closeStoppedFixture(f);
    }
  });
}

test('刷新只改变断点路由的参数顺序时接回原资源，目录核对期间保留正常播放', async () => {
  const originalUrl = `${COURSE}&courseResourceId=resource-1&mode=normal&track=a&track=b`;
  const reorderedUrl = COURSE.replace(
    '?classId=class-1',
    '?track=a&courseResourceId=resource-1&track=b&mode=normal&classId=class-1'
  );
  const c = coordinator();
  const id = c.addTab(originalUrl);
  const first = fixture([mediaItem('参数换序续看视频')], { url: originalUrl, connect: c.connect(id) });
  let second;
  try {
    configurePlayer(first);
    await seedCoursePlaybackFixture(first);
    await waitFor(() => !first.media.paused && c.storage.session[KEY]?.candidates[0].currentResource?.stage === 'ready');
    const before = plain(c.storage.session[KEY]);
    const checkpoint = before.candidates[0].currentResource;
    first.dom.window.close();

    const messages = [];
    second = fixture([mediaItem('参数换序续看视频')], {
      url: reorderedUrl, connect: connectWithMessages(c, id, messages)
    });
    const { items, clicks } = configurePlayer(second);
    const loading = second.window.document.createElement('div');
    loading.className = 'el-loading-mask';
    second.window.document.body.append(loading);
    let loadingObserved = false;
    const getStyle = second.window.getComputedStyle.bind(second.window);
    second.window.getComputedStyle = element => {
      if (element === loading) loadingObserved = true;
      return getStyle(element);
    };
    let pauseCalls = 0;
    const pause = second.media.pause;
    second.media.pause = () => { pauseCalls += 1; pause(); };
    let playClicks = 0;
    second.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { playClicks += 1; });
    assert.notEqual(checkpoint.routeKey, `${second.window.location.pathname}${second.window.location.hash}`);
    await second.media.play(); // The fake website restores playback itself.
    second.advanceNaturally(17);
    await second.api.syncSharedJob();
    // Observe the actual directory wait, after the initial playback guard has
    // run, so a late pause cannot be hidden by checking too early.
    await waitFor(() => loadingObserved && second.api.state.jobPromise);
    assert.equal(second.media.paused, false);
    assert.equal(second.media.currentTime, 17);
    assert.equal(pauseCalls, 0);
    assert.equal(playClicks, 0);
    assert.deepEqual(clicks, []);
    assert.equal(second.api.state.job.runId, before.runId);
    assert.equal(second.api.state.job.ownerInstance, second.api.state.instanceId);
    assert.ok(second.api.state.job.generation > before.generation);
    assert.equal(second.api.state.job.candidates[0].currentResource.key, checkpoint.key);

    loading.remove();
    await waitFor(() => second.api.state.job.candidates[0].records[checkpoint.key]?.playbackAttempt?.before?.currentTime === 17);
    assert.equal(second.media.paused, false);
    assert.equal(pauseCalls, 0);
    assert.equal(playClicks, 0);
    assert.deepEqual(clicks, []);
    assert.equal(messages.some(message => ['start', 'scan-result', 'open'].includes(message.action)), false);
    finishFromWebsite(second, items[0]);
    await waitFor(() => c.storage.session[KEY]?.phase === 'finished');
    const completed = plain(c.storage.session[KEY]);
    assert.equal(completed.candidates[0].records[checkpoint.key].ended, true);
    assert.equal(completed.candidates[0].records[checkpoint.key].confirmed, true);
    assert.equal(completed.candidates[0].status, 'completed');
    assert.equal(second.api.state.playedCount, 1);
  } finally {
    first.dom.window.close();
    second?.dom.window.close();
  }
});

const routeIdentityChanges = [
  {
    label: '同名参数的值改变',
    query: 'classId=class-1&courseResourceId=another-resource&mode=normal'
  },
  {
    label: '非资源参数的值改变',
    query: 'classId=class-1&courseResourceId=resource-1&mode=other'
  },
  {
    label: '参数名称改变',
    query: 'classId=class-1&courseResourceId=resource-1&Mode=normal'
  },
  {
    label: '同值重复参数数量增加',
    query: 'classId=class-1&courseResourceId=resource-1&mode=normal&classId=class-1'
  },
  {
    label: '增加空值参数',
    query: 'classId=class-1&courseResourceId=resource-1&mode=normal&extra='
  },
  {
    label: '同名异值参数的先后顺序改变',
    originalQuery: 'classId=class-1&courseResourceId=resource-1&track=a&track=b&mode=normal',
    query: 'classId=class-1&courseResourceId=resource-1&track=b&mode=normal&track=a'
  },
  {
    label: '含编码的参数名发生换序',
    originalQuery: 'classId=class-1&courseResourceId=resource-1&mode=normal&%6dode=other',
    query: 'classId=class-1&courseResourceId=resource-1&%6dode=other&mode=normal'
  },
  {
    label: '含加号的参数名发生换序',
    originalQuery: 'classId=class-1&courseResourceId=resource-1&mode+label=first&mode%20label=second',
    query: 'classId=class-1&courseResourceId=resource-1&mode%20label=second&mode+label=first'
  },
  {
    label: '实际资源路径改变',
    query: 'classId=class-1&courseResourceId=resource-1&mode=normal',
    resourcePath: 'different-resource'
  }
];

for (const change of routeIdentityChanges) {
  test(`刷新断点路由${change.label}时返回精确原资源，参数排序不能授权变化后的页面`, async () => {
    const originalUrl = change.originalQuery
      ? COURSE.replace('?classId=class-1', `?${change.originalQuery}`)
      : `${COURSE}&courseResourceId=resource-1&mode=normal`;
    const nextUrl = COURSE.replace(
      '/video/resource-1?classId=class-1',
      `/video/${change.resourcePath || 'resource-1'}?${change.query}`
    );
    const c = coordinator();
    const id = c.addTab(originalUrl);
    const first = fixture([
      mediaItem('原断点视频', 'video', 'unStart', '00 分 10 秒'),
      mediaItem('不可擅自点击的下一视频', 'video', 'unStart', '02 分 00 秒')
    ], { url: originalUrl, connect: c.connect(id) });
    let second, recovered;
    try {
      const original = configurePlayer(first);
      await seedCoursePlaybackFixture(first);
      await waitFor(() => !first.media.paused && c.storage.session[KEY]?.candidates[0].currentResource?.stage === 'ready');
      const before = plain(c.storage.session[KEY]);
      const firstKey = first.api.getItemKey(original.items[0]);
      const secondKey = first.api.getItemKey(original.items[1]);
      first.api.state.running = false;
      first.api.state.epoch += 1;
      first.dom.window.close();

      const messages = [];
      let recoveredPlayer;
      c.onNavigation.addListener(destination => {
        assert.equal(destination.id, id);
        assert.equal(destination.url, originalUrl);
        second.api.state.running = false;
        second.api.state.epoch += 1;
        second.dom.window.close();
        recovered = fixture([
          mediaItem('原断点视频', 'video', 'unStart', '00 分 10 秒'),
          mediaItem('不可擅自点击的下一视频', 'video', 'unStart', '02 分 00 秒')
        ], { url: originalUrl, connect: connectWithMessages(c, id, messages) });
        recoveredPlayer = configurePlayer(recovered);
      });
      second = fixture([
        mediaItem('原断点视频', 'video', 'unStart', '00 分 10 秒'),
        mediaItem('不可擅自点击的下一视频', 'video', 'unStart', '02 分 00 秒')
      ], { url: nextUrl, connect: connectWithMessages(c, id, messages) });
      const { clicks } = configurePlayer(second);
      let playClicks = 0;
      second.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { playClicks += 1; });
      await second.media.play();
      second.advanceNaturally(17);
      await second.api.syncSharedJob();
      await waitFor(() => recovered && recoveredPlayer, 5000);
      await observePlayback(recovered, recoveredPlayer.items[0], { position: 0.25, timeout: 5000 });
      const resumed = plain(c.storage.session[KEY]);
      assert.equal(resumed.runId, before.runId);
      assert.equal(resumed.running, true);
      assert.equal(resumed.phase, 'course');
      assert.equal(resumed.interruption.attempts, 1);
      assert.equal(second.media.paused, true);
      assert.equal(playClicks, 0);
      assert.deepEqual(clicks, []);
      assert.equal(resumed.candidates[0].currentResource.key, firstKey);
      assert.equal(resumed.candidates[0].currentResource.routeKey,
        new URL(originalUrl).pathname + new URL(originalUrl).hash);
      assert.notEqual(resumed.candidates[0].records[firstKey].ended, true);
      assert.notEqual(resumed.candidates[0].records[firstKey].confirmed, true);
      assert.equal(resumed.candidates[0].records[secondKey], undefined);
      assert.equal(recovered.api.state.playedCount, 0);
      assert.equal(recoveredPlayer.clicks.includes(secondKey), false);
      assert.equal(messages.some(message => ['start', 'course-result', 'finish', 'open'].includes(message.action)), false);
      assert.equal(c.navigation.filter(entry => entry.url).length, 1);
      assert.equal(c.navigation.at(-1).url, originalUrl);
    } finally {
      first.dom.window.close();
      second?.dom.window.close();
      if (recovered) await closeStoppedFixture(recovered);
    }
  });
}
