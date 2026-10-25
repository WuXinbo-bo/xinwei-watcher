const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, mediaItem, waitFor, seedCoursePlaybackFixture } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');

const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const COURSE = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';
const KEY = 'xinwei-job-v3';
const auth = job => ({ runId: job.runId, generation: job.generation });
const plain = value => JSON.parse(JSON.stringify(value));

function latePlayerFixture(c, id, items, options = {}) {
  let site;
  const messages = [];
  const f = fixture(items, {
    title: options.title || '测试课程',
    url: COURSE,
    connect: window => {
      c.connect(id)(window);
      const send = window.chrome.runtime.sendMessage;
      window.chrome.runtime.sendMessage = message => {
        messages.push(plain(message));
        return send(message);
      };
    },
    beforeContent: ({ window, media }) => {
      // The fake website has a directory, but has not created its media yet.
      // This reproduces the real initial guard observing media=null.
      media.remove();
      window.document.querySelector('li.el-menu-item').classList.add('is-active');
      const loading = window.document.createElement('div');
      loading.className = 'el-loading-mask';
      window.document.body.append(loading);
      const player = window.document.querySelector('.video-js');
      const late = window.document.createElement(options.kind || 'video');
      let paused = true, time = 0, ended = false, source = 'https://media.example.test/default';
      let pauseCalls = 0, playClicks = 0;
      const itemClicks = [];
      Object.defineProperties(late, {
        readyState: { get: () => 4 },
        duration: { get: () => 120 },
        currentTime: { get: () => time }, // The extension cannot set position.
        currentSrc: { get: () => source },
        paused: { get: () => paused },
        ended: { get: () => ended }
      });
      // These are the fake website's media implementation and events. No
      // browser autoplay permission is modeled or proven by this fixture.
      late.play = async () => {
        paused = false;
        player.classList.remove('vjs-paused');
      };
      late.pause = () => {
        pauseCalls += 1;
        paused = true;
        player.classList.add('vjs-paused');
        late.dispatchEvent(new window.Event('pause'));
      };
      const sourceLoaded = value => {
        source = value;
        late.setAttribute('src', value);
        time = 0;
        ended = false;
        late.dispatchEvent(new window.Event('loadstart'));
        late.dispatchEvent(new window.Event('loadedmetadata'));
      };
      const autoplay = async position => {
        if (position != null) time = position;
        await late.play();
        late.dispatchEvent(new window.Event('play'));
        late.dispatchEvent(new window.Event('playing'));
      };
      for (const item of window.document.querySelectorAll('li.el-menu-item')) {
        item.addEventListener('click', () => {
          itemClicks.push(item.querySelector('.lecture-title').textContent);
          for (const other of window.document.querySelectorAll('li.el-menu-item')) {
            other.classList.remove('is-active');
          }
          item.classList.add('is-active');
          paused = true;
          player.classList.add('vjs-paused');
          sourceLoaded(`https://media.example.test/${itemClicks.length}-selected`);
        });
      }
      window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => {
        playClicks += 1;
        // A normal site's existing visible button starts its current media.
        late.play();
        late.dispatchEvent(new window.Event('play'));
        late.dispatchEvent(new window.Event('playing'));
      });
      // Delay polling so a test cannot pass because a later get happened to
      // pause the media. Initial get/hello still run normally.
      const setInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) =>
        setInterval(callback, Math.max(delay, 60000), ...args);
      site = {
        media: late, loading, autoplay, sourceLoaded,
        attach: () => player.append(late),
        pauseCalls: () => pauseCalls,
        playClicks: () => playClicks,
        itemClicks
      };
    }
  });
  f.api.CFG.directoryLoadTimeout = 3000;
  return { ...f, site, messages };
}

async function seedInspection(c) {
  const home = c.addTab(HOME);
  let response = await c.request(home, 'homepage', 'start');
  response = await c.request(home, 'homepage', 'scan-result', {
    ...auth(response.job),
    candidates: [{ title: '测试课程', key: '测试课程', page: 1, order: 0, status: 'uninspected' }]
  });
  response = await c.request(home, 'homepage', 'open', {
    ...auth(response.job), index: 0, purpose: 'inspect'
  });
  assert.equal(response.ok, true);
  return c.addTab(COURSE, home);
}

for (const kind of ['video', 'audio']) {
  test(`统计时晚到的${kind}自动播放立即暂停，同一节点重新加载来源仍不能播放`, async () => {
    const c = coordinator();
    const id = await seedInspection(c);
    const f = latePlayerFixture(c, id, [mediaItem('待统计媒体', kind)], { kind });
    try {
      await waitFor(() => f.api.state.jobPromise &&
        f.api.state.playbackDiagnostics.guards.some(guard => guard.decision === 'pause-inspection'));
      assert.equal(f.api.state.playbackDiagnostics.guards[0].media, null);
      assert.equal(f.api.state.job.targetPurpose, 'inspect');
      assert.equal(f.site.pauseCalls(), 0);
      f.site.attach();
      await new Promise(resolve => setTimeout(resolve, 0));
      f.site.sourceLoaded('https://media.example.test/initial-inspection');
      await f.site.autoplay(7);
      assert.equal(f.site.media.paused, true, 'late play events must pause before another background poll');
      assert.equal(f.site.media.currentTime, 7, 'pausing does not reset the website position');
      assert.equal(f.site.pauseCalls(), 1);

      f.site.sourceLoaded('https://media.example.test/reloaded-inspection');
      await f.site.autoplay(3);
      assert.equal(f.site.media.paused, true, 'the pause must survive a source reload on the same node');
      assert.equal(f.site.media.currentSrc, 'https://media.example.test/reloaded-inspection');
      assert.equal(f.site.pauseCalls(), 2);
      assert.equal(f.site.playClicks(), 0);
      assert.deepEqual(f.site.itemClicks, []);
      assert.deepEqual(c.storage.session[KEY].candidates[0].records, {});
      assert.equal(f.messages.some(message => message.action === 'resource-checkpoint'), false);

      f.site.loading.remove();
      await waitFor(() => c.storage.session[KEY]?.inspectIndex === 1);
      const result = c.storage.session[KEY].candidates[0];
      assert.equal(result.total, 1);
      assert.equal(result.remaining, 1);
      assert.deepEqual(result.records, {});
      assert.equal(f.site.media.paused, true);
      assert.equal(f.site.playClicks(), 0);
      assert.equal(c.removed.includes(id), true);
    } finally { f.dom.window.close(); }
  });
}

test('首次课程的默认媒体晚到时保持暂停，目录确认后只放行选定的最短资源', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const f = latePlayerFixture(c, id, [
    mediaItem('默认长视频', 'video', 'unStart', '02 分 00 秒'),
    mediaItem('选中的短视频', 'video', 'unStart', '00 分 10 秒')
  ]);
  try {
    await seedCoursePlaybackFixture(f);
    await waitFor(() => f.api.state.jobPromise &&
      f.api.state.playbackDiagnostics.guards.some(guard => guard.decision === 'pause-initial'));
    assert.equal(f.api.state.playbackDiagnostics.guards[0].media, null);
    f.site.attach();
    await new Promise(resolve => setTimeout(resolve, 0));
    await f.site.autoplay(8);
    assert.equal(f.site.media.paused, true);
    assert.equal(f.site.pauseCalls(), 1);
    assert.equal(f.site.playClicks(), 0);
    assert.deepEqual(f.site.itemClicks, []);
    assert.deepEqual(c.storage.session[KEY].candidates[0].records, {});

    f.site.loading.remove();
    await waitFor(() => !f.site.media.paused &&
      c.storage.session[KEY]?.candidates[0].currentResource?.stage === 'ready');
    const items = f.api.getMenuItems();
    const key = f.api.getItemKey(items[1]);
    const candidate = c.storage.session[KEY].candidates[0];
    assert.deepEqual(f.site.itemClicks, ['选中的短视频']);
    assert.equal(f.site.playClicks(), 1);
    assert.equal(f.site.pauseCalls(), 1, 'the released hold must not pause the selected resource');
    assert.equal(candidate.currentResource.key, key);
    assert.equal(candidate.records[key].started, true);
    assert.notEqual(candidate.records[key].ended, true);
    assert.equal(candidate.records[f.api.getItemKey(items[0])], undefined);
    assert.equal(f.api.state.playedCount, 0);
    await f.api.stop(false);
    assert.equal(f.site.media.paused, true);
  } finally { f.dom.window.close(); }
});

test('精确已观察断点刷新后媒体晚到并自行续播，核对目录期间零额外暂停或播放点击', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const items = [mediaItem('刷新保留视频', 'video', 'unStart', '02 分 00 秒')];
  const first = fixture(items, { url: COURSE, connect: c.connect(id) });
  let fresh;
  try {
    first.api.getMenuItems()[0].classList.add('is-active');
    await seedCoursePlaybackFixture(first);
    await waitFor(() => !first.media.paused &&
      c.storage.session[KEY]?.candidates[0].currentResource?.stage === 'ready' &&
      Object.values(c.storage.session[KEY].candidates[0].records).some(record => record.started));
    const before = plain(c.storage.session[KEY]);
    const checkpoint = before.candidates[0].currentResource;
    first.dom.window.close();

    fresh = latePlayerFixture(c, id, items);
    await waitFor(() => fresh.api.state.jobPromise &&
      fresh.api.state.job.ownerInstance === fresh.api.state.instanceId &&
      fresh.api.state.playbackDiagnostics.guards.some(guard => guard.decision === 'retain-current'));
    assert.equal(fresh.api.state.playbackDiagnostics.guards[0].media, null);
    fresh.site.attach();
    fresh.site.sourceLoaded('https://media.example.test/restored-checkpoint');
    await fresh.site.autoplay(17);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(fresh.site.media.paused, false);
    assert.equal(fresh.site.media.currentTime, 17);
    assert.equal(fresh.site.pauseCalls(), 0);
    assert.equal(fresh.site.playClicks(), 0);
    assert.deepEqual(fresh.site.itemClicks, []);
    assert.equal(fresh.api.state.job.runId, before.runId);
    assert.ok(fresh.api.state.job.generation > before.generation);

    fresh.site.loading.remove();
    await waitFor(() => c.storage.session[KEY]?.candidates[0].records[checkpoint.key]
      ?.playbackAttempt?.before?.currentTime === 17);
    assert.equal(fresh.site.media.paused, false);
    assert.equal(fresh.site.pauseCalls(), 0);
    assert.equal(fresh.site.playClicks(), 0);
    assert.deepEqual(fresh.site.itemClicks, []);
    assert.equal(fresh.messages.some(message =>
      ['start', 'open', 'scan-result', 'course-result', 'finish'].includes(message.action)), false);
    assert.notEqual(c.storage.session[KEY].candidates[0].records[checkpoint.key].ended, true);
    await fresh.api.stop(false);
    assert.equal(fresh.site.media.paused, true);
  } finally {
    first.dom.window.close();
    fresh?.dom.window.close();
  }
});

for (const action of ['pause', 'manual']) {
  test(`${action}任务刷新后晚到媒体尝试自动播放，立即保持停止且无点击`, async () => {
    const c = coordinator();
    const id = c.addTab(COURSE);
    const started = await c.request(id, 'previous-document', 'start', { title: '测试课程' });
    const stopped = await c.request(id, 'previous-document', action, {
      ...auth(started.job), reason: '刷新前已明确停止'
    });
    assert.equal(stopped.ok, true);
    const f = latePlayerFixture(c, id, [mediaItem('不能自动恢复的视频')]);
    try {
      await waitFor(() => f.api.state.tabId === id && f.api.state.job?.running === false &&
        !f.api.state.syncPromise);
      assert.equal(f.api.state.job.phase, action === 'pause' ? 'paused' : 'manual');
      assert.equal(f.api.state.jobPromise, null);
      assert.equal(f.api.state.running, false);
      f.site.attach();
      await new Promise(resolve => setTimeout(resolve, 0));
      await f.site.autoplay(19);
      assert.equal(f.site.media.paused, true, 'explicit stop must apply synchronously to a late play event');
      assert.equal(f.site.media.currentTime, 19);
      assert.equal(f.site.pauseCalls(), 1);
      f.site.sourceLoaded('https://media.example.test/reloaded-stopped');
      await f.site.autoplay(4);
      assert.equal(f.site.media.paused, true);
      assert.equal(f.site.pauseCalls(), 2);
      assert.equal(f.site.playClicks(), 0);
      assert.deepEqual(f.site.itemClicks, []);
      assert.deepEqual(c.storage.session[KEY].candidates[0].records, {});
      assert.equal(c.storage.session[KEY].runId, started.job.runId);
      assert.equal(c.storage.session[KEY].running, false);
      assert.equal(f.messages.some(message =>
        ['hello', 'start', 'open', 'record', 'resource-checkpoint', 'course-result'].includes(message.action)), false);
      assert.deepEqual(c.navigation, []);
    } finally { f.dom.window.close(); }
  });
}

for (const isTaskTab of [true, false]) {
  test(`扩展重启的interrupted任务${isTaskTab ? '阻止原任务页' : '不接管其他标签页'}晚到媒体的自动播放`, async () => {
    const c = coordinator();
    const taskId = c.addTab(COURSE);
    const started = await c.request(taskId, 'previous-document', 'start', { title: '测试课程' });
    const id = isTaskTab ? taskId : c.addTab(COURSE);
    // Reloading the extension loses session storage. The real background must
    // derive interrupted from its disk checkpoint; do not inject that phase.
    c.restartBrowser();
    c.restartWorker();
    const f = latePlayerFixture(c, id, [mediaItem('重启后晚到的媒体')]);
    try {
      await waitFor(() => f.api.state.tabId === id && f.api.state.job?.phase === 'interrupted' &&
        !f.api.state.syncPromise);
      assert.equal(f.api.state.job.runId, started.job.runId);
      assert.equal(f.api.state.job.running, false);
      assert.equal(f.api.state.running, false);
      assert.equal(f.api.state.jobPromise, null);
      f.site.attach();
      await new Promise(resolve => setTimeout(resolve, 0));
      await f.site.autoplay(19);
      assert.equal(f.site.media.paused, isTaskTab,
        'the event guard must stop only the existing task tab, before another poll');
      assert.equal(f.site.media.currentTime, 19, 'the website position is not changed');
      assert.equal(f.site.pauseCalls(), isTaskTab ? 1 : 0);
      f.site.sourceLoaded('https://media.example.test/reloaded-after-extension-restart');
      await f.site.autoplay(4);
      assert.equal(f.site.media.paused, isTaskTab, 'the same scope applies after a source reload');
      assert.equal(f.site.media.currentTime, 4);
      assert.equal(f.site.pauseCalls(), isTaskTab ? 2 : 0);
      assert.equal(f.site.playClicks(), 0);
      assert.deepEqual(f.site.itemClicks, []);
      assert.deepEqual(f.api.state.job.candidates[0].records, {});
      assert.equal(f.messages.some(message =>
        ['hello', 'start', 'open', 'record', 'resource-checkpoint', 'course-result'].includes(message.action)), false);
      assert.deepEqual(c.navigation, []);
    } finally { f.dom.window.close(); }
  });
}

test('已暂停刷新页插入已经在播放的媒体时，通过DOM观察暂停，不依赖播放事件或下一轮轮询', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const started = await c.request(id, 'previous-document', 'start', { title: '测试课程' });
  await c.request(id, 'previous-document', 'pause', auth(started.job));
  const f = latePlayerFixture(c, id, [mediaItem('晚到的播放节点')]);
  try {
    await waitFor(() => f.api.state.tabId === id && f.api.state.job?.phase === 'paused' &&
      !f.api.state.syncPromise);
    await f.site.media.play(); // The detached fake site media has no document event.
    assert.equal(f.site.media.paused, false);
    assert.equal(f.api.state.playbackDiagnostics.mediaEvents.length, 0);
    f.site.attach();
    await waitFor(() => f.site.media.paused, 500);
    assert.equal(f.site.pauseCalls(), 1);
    assert.equal(f.site.playClicks(), 0);
    assert.deepEqual(f.site.itemClicks, []);
    assert.equal(f.api.state.running, false);
    assert.equal(f.api.state.jobPromise, null);
    assert.equal(f.api.state.playbackDiagnostics.mediaEvents.some(event =>
      ['play', 'playing'].includes(event.type)), false);
    assert.deepEqual(c.storage.session[KEY].candidates[0].records, {});
  } finally { f.dom.window.close(); }
});

test('本地暂停后迟到的运行中get先返回也不能重新执行，仅显式继续的新generation可恢复', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  let getToDelay = false, staleResponse, pauseToDelay = false, pauseWasDelayed = false;
  let releaseGet, releasePause;
  const getGate = new Promise(resolve => { releaseGet = resolve; });
  const pauseGate = new Promise(resolve => { releasePause = resolve; });
  const f = latePlayerFixture(c, id, [mediaItem('不能被旧响应重新启动的视频')]);
  const originalSend = f.window.chrome.runtime.sendMessage;
  f.window.chrome.runtime.sendMessage = async message => {
    if (message.action === 'pause' && pauseToDelay) {
      pauseToDelay = false;
      pauseWasDelayed = true;
      // Delay delivery, not just its response: the background must still
      // legitimately report running while the user's local stop is active.
      await pauseGate;
    }
    const response = await originalSend(message);
    if (message.action === 'get' && getToDelay) {
      getToDelay = false;
      staleResponse = plain(response);
      await getGate;
    }
    return response;
  };
  let getRequest, pauseRequest;
  try {
    await seedCoursePlaybackFixture(f);
    await waitFor(() => f.api.state.jobPromise &&
      f.api.state.playbackDiagnostics.guards.some(guard => guard.decision === 'pause-initial'));
    f.site.attach();
    await new Promise(resolve => setTimeout(resolve, 0));
    f.site.loading.remove();
    await waitFor(() => !f.site.media.paused &&
      c.storage.session[KEY]?.candidates[0].currentResource?.stage === 'ready');
    const before = plain(c.storage.session[KEY]);
    const clicksBeforeStop = f.site.playClicks();
    getToDelay = true;
    getRequest = f.api.syncSharedJob();
    await waitFor(() => staleResponse);
    assert.equal(staleResponse.job.running, true);
    assert.equal(staleResponse.job.generation, before.generation);

    pauseToDelay = true;
    pauseRequest = f.api.stop(false);
    await waitFor(() => pauseWasDelayed && f.api.state.jobPromise === null);
    assert.equal(f.api.state.running, false);
    assert.equal(f.site.media.paused, true);
    assert.equal(c.storage.session[KEY].running, true, 'background has not received the delayed pause yet');
    releaseGet();
    await getRequest;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.api.state.running, false);
    assert.equal(f.api.state.jobPromise, null, 'stale get must not create another executor');
    assert.equal(f.site.playClicks(), clicksBeforeStop);
    await f.site.autoplay(23);
    assert.equal(f.site.media.paused, true);
    assert.equal(f.site.media.currentTime, 23);
    assert.equal(f.site.playClicks(), clicksBeforeStop);
    assert.deepEqual(f.site.itemClicks, []);

    releasePause();
    await pauseRequest;
    assert.equal(c.storage.session[KEY].phase, 'paused');
    assert.equal(c.storage.session[KEY].running, false);
    assert.equal(f.api.state.running, false);
    assert.equal(f.api.state.jobPromise, null);
    await f.api.start(); // The actual user-visible Continue path.
    await waitFor(() => f.api.state.running && !f.site.media.paused &&
      f.site.playClicks() === clicksBeforeStop + 1);
    assert.equal(f.api.state.job.runId, before.runId);
    assert.ok(f.api.state.job.generation > before.generation);
    assert.equal(f.api.state.localMediaStop, null);
    assert.equal(f.api.state.job.phase, 'course');
    await f.api.stop(false);
    assert.equal(f.site.media.paused, true);
  } finally {
    releaseGet();
    releasePause();
    await getRequest?.catch(() => {});
    await pauseRequest?.catch(() => {});
    f.dom.window.close();
  }
});

test('统计结果移交首页后旧课程尚未关闭时仍禁止重新播放', async () => {
  const c = coordinator();
  const id = await seedInspection(c);
  const f = latePlayerFixture(c, id, [mediaItem('统计移交期间的媒体')]);
  let duringReturn;
  f.window.chrome.runtime.onMessage.addListener(message => {
    if (message?.channel !== 'xinwei-job' || message.job?.phase !== 'home' ||
      message.job.returningTabId !== id || duringReturn) return;
    // The real background broadcasts its home handoff before tabs.remove.
    // Inspect the media in this interval without changing coordinator logic.
    f.site.media.play();
    f.site.media.dispatchEvent(new f.window.Event('play'));
    f.site.media.dispatchEvent(new f.window.Event('playing'));
    duringReturn = {
      paused: f.site.media.paused,
      removed: c.removed.includes(id),
      localRunning: f.api.state.running,
      phase: f.api.state.job.phase
    };
  });
  try {
    await waitFor(() => f.api.state.jobPromise &&
      f.api.state.playbackDiagnostics.guards.some(guard => guard.decision === 'pause-inspection'));
    f.site.attach();
    await new Promise(resolve => setTimeout(resolve, 0));
    f.site.loading.remove();
    await waitFor(() => duringReturn && c.removed.includes(id));
    assert.equal(duringReturn.removed, false, 'observe the departing page before it is closed');
    assert.equal(duringReturn.phase, 'home');
    assert.equal(duringReturn.localRunning, false);
    assert.equal(duringReturn.paused, true, 'inspection handoff must not release the old page');
    assert.equal(f.site.media.paused, true);
    assert.equal(f.site.playClicks(), 0);
    assert.deepEqual(f.site.itemClicks, []);
    assert.deepEqual(c.storage.session[KEY].candidates[0].records, {});
    assert.equal(c.storage.session[KEY].candidates[0].status, 'inspected');
    assert.equal(c.storage.session[KEY].candidates[0].remaining, 1);
  } finally { f.dom.window.close(); }
});

test('无可见播放按钮时保存失败记录并保持暂停，自动恢复等待仍可由用户立即暂停', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const f = latePlayerFixture(c, id, [mediaItem('找不到播放按钮的视频')]);
  let blockedFailure, releaseFailure;
  const failureGate = new Promise(resolve => { releaseFailure = resolve; });
  const originalSend = f.window.chrome.runtime.sendMessage;
  f.window.chrome.runtime.sendMessage = async message => {
    const response = await originalSend(message);
    // Let the ready/start record persist. Hold the distinct failure evidence
    // response while the executor has not yet entered ordinary recovery.
    if (message.action === 'record' && message.result?.playbackAttempt?.stopped && !blockedFailure) {
      blockedFailure = plain(message);
      await failureGate;
    }
    return response;
  };
  try {
    await seedCoursePlaybackFixture(f);
    await waitFor(() => f.api.state.jobPromise &&
      f.api.state.playbackDiagnostics.guards.some(guard => guard.decision === 'pause-initial'));
    f.site.attach();
    await new Promise(resolve => setTimeout(resolve, 0));
    f.window.document.querySelector('.vjs-big-play-button').remove();
    f.site.loading.remove();
    await waitFor(() => blockedFailure);
    assert.equal(c.storage.session[KEY].running, true);
    assert.equal(f.api.state.running, true);
    assert.ok(f.api.state.jobPromise);
    assert.equal(f.site.playClicks(), 0);
    assert.equal(blockedFailure.result.playbackAttempt.stopped.paused, true);
    await f.site.autoplay(13);
    assert.equal(f.site.media.paused, true, 'missing button must not release the loading guard');
    assert.equal(f.site.media.currentTime, 13);
    assert.equal(f.site.pauseCalls(), 1);
    assert.equal(f.site.playClicks(), 0);

    releaseFailure();
    await waitFor(() => Object.values(c.storage.session[KEY]?.candidates[0].records || {})
      .some(record => record.recovery?.attempts === 1));
    assert.equal(c.storage.session[KEY].running, true);
    assert.equal(c.storage.session[KEY].phase, 'course');
    assert.match(f.window.document.getElementById('wb-status').textContent, /恢复/);
    await f.api.stop(false);
    await waitFor(() => c.storage.session[KEY]?.phase === 'paused' && f.api.state.jobPromise === null);
    assert.equal(f.api.state.running, false);
    assert.equal(c.storage.session[KEY].reason, '');
    await f.site.autoplay(18);
    assert.equal(f.site.media.paused, true);
    assert.equal(f.site.pauseCalls(), 2);
    assert.equal(f.site.playClicks(), 0);
    assert.deepEqual(f.site.itemClicks, []);
    const record = Object.values(c.storage.session[KEY].candidates[0].records)[0];
    assert.equal(record.started, true);
    assert.equal(record.ended, false);
    assert.equal(record.confirmed, false);
    assert.equal(f.messages.some(message => ['course-result', 'finish'].includes(message.action)), false);
  } finally {
    releaseFailure();
    f.dom.window.close();
  }
});

test('继续响应尚未返回时再次暂停，迟到的成功响应与广播都不能授权播放，下一次显式继续才恢复', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const seeded = await c.request(id, 'previous-document', 'start', { title: '测试课程' });
  const paused = await c.request(id, 'previous-document', 'pause', auth(seeded.job));
  const f = latePlayerFixture(c, id, [mediaItem('继续与暂停同时操作的视频')]);
  let holdStart = false, delayedStart, delayedBroadcast, releaseStart;
  const responseGate = new Promise(resolve => { releaseStart = resolve; });
  const originalSend = f.window.chrome.runtime.sendMessage;
  const originalMessage = f.window.chrome.runtime.onMessage.message;
  f.window.chrome.runtime.onMessage.message = async message => {
    // The transport can deliver the start broadcast late as well as its
    // response. Keep the old paused state until the user clicks Pause.
    if (holdStart && message?.job?.running && !delayedBroadcast) {
      delayedBroadcast = plain(message);
      return;
    }
    return originalMessage(message);
  };
  f.window.chrome.runtime.sendMessage = async message => {
    const response = await originalSend(message);
    if (message.action === 'start' && holdStart && !delayedStart) {
      delayedStart = plain(response);
      await responseGate;
    }
    return response;
  };
  let continuing;
  try {
    await waitFor(() => f.api.state.tabId === id && f.api.state.job?.phase === 'paused' &&
      !f.api.state.syncPromise);
    f.site.attach();
    await new Promise(resolve => setTimeout(resolve, 0));
    f.site.loading.remove();
    holdStart = true;
    continuing = f.api.start(); // First user Continue.
    await waitFor(() => delayedStart && delayedBroadcast);
    assert.equal(delayedStart.job.running, true);
    assert.ok(delayedStart.job.generation > paused.job.generation);
    assert.equal(c.storage.session[KEY].running, true);
    assert.equal(f.api.state.job.running, false, 'the old stopped state is still displayed');
    assert.equal(f.api.state.startPending, true);
    assert.equal(f.api.state.running, false);
    assert.equal(f.api.state.jobPromise, null);
    assert.equal(f.site.playClicks(), 0);

    await f.api.stop(false); // User Pause while Continue is in flight.
    assert.equal(c.storage.session[KEY].running, false);
    assert.equal(c.storage.session[KEY].phase, 'paused');
    assert.equal(f.api.state.running, false);
    const stopRevision = c.storage.session[KEY].revision;
    releaseStart();
    await continuing;
    await originalMessage(delayedBroadcast);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.api.state.startPending, false);
    assert.equal(f.api.state.job.running, false);
    assert.equal(f.api.state.job.phase, 'paused');
    assert.ok(f.api.state.job.revision >= stopRevision);
    assert.equal(f.api.state.jobPromise, null);
    assert.equal(f.api.state.running, false);
    assert.equal(f.site.playClicks(), 0);
    await f.site.autoplay(11);
    assert.equal(f.site.media.paused, true);
    assert.equal(f.site.media.currentTime, 11);
    assert.equal(f.site.playClicks(), 0);
    assert.deepEqual(f.site.itemClicks, []);
    assert.deepEqual(c.storage.session[KEY].candidates[0].records, {});
    assert.equal(f.messages.some(message =>
      ['resource-checkpoint', 'record', 'course-result'].includes(message.action)), false);

    holdStart = false;
    const stoppedGeneration = c.storage.session[KEY].generation;
    await f.api.start(); // A distinct, newer user Continue is authorized.
    await waitFor(() => f.api.state.running && !f.site.media.paused && f.site.playClicks() === 1);
    assert.equal(f.api.state.job.runId, seeded.job.runId);
    assert.ok(f.api.state.job.generation > stoppedGeneration);
    assert.equal(f.api.state.startPending, false);
    assert.equal(f.api.state.localMediaStop, null);
    assert.equal(f.api.state.job.phase, 'course');
    await f.api.stop(false);
    assert.equal(f.site.media.paused, true);
  } finally {
    releaseStart();
    await continuing?.catch(() => {});
    await f.api.stop(false);
    await Promise.allSettled([f.api.state.jobPromise, f.api.state.syncPromise].filter(Boolean));
    f.dom.window.close();
  }
});
