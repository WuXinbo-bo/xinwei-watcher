const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, mediaItem, waitFor, seedCoursePlaybackFixture } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');
const { observePlayback, endPlayback, markPageCompleted } = require('./player-lifecycle.cjs');

const KEY = 'xinwei-job-v3';
const COURSE = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';
const PROJECT = 'https://www.beeline-ai.com/student/#/courseInfo/course-1/project/class-1';
const OBSERVATION = 'xinwei-media-observation-v1';
const clone = value => JSON.parse(JSON.stringify(value));
const auth = job => ({ runId: job.runId, generation: job.generation, resetEpoch: job.resetEpoch });

// Real extension modules communicate through the simulated browser, while the
// fake website owns navigation, player time and completion marks. These tests
// are integration simulations, not real-browser playback acceptance.
function mount(c, id, options = {}) {
  const messages = options.messages || [];
  const f = fixture(options.items || [mediaItem('原计划视频')], {
    url: options.url || COURSE, title: '误触恢复课程', confirmationTimeout: options.confirmationTimeout ?? 100,
    connect(window) {
      c.connect(id)(window);
      if (options.captureListeners) {
        const add = window.chrome.runtime.onMessage.addListener.bind(window.chrome.runtime.onMessage);
        window.chrome.runtime.onMessage.addListener = listener => {
          options.captureListeners.push(listener);
          add(listener);
        };
      }
      const send = window.chrome.runtime.sendMessage;
      window.chrome.runtime.sendMessage = async message => {
        messages.push(clone(message));
        if (options.beforeSend) await options.beforeSend(message, window);
        const response = await send(message);
        if (options.afterSend) await options.afterSend(message, response, window);
        return response;
      };
    },
    beforeContent: options.beforeContent
  });
  const items = f.api.getMenuItems();
  const clicks = [];
  let playClicks = 0;
  items[options.activeIndex || 0]?.classList.add('is-active');
  items.forEach(item => item.addEventListener('click', () => {
    clicks.push(f.api.getItemKey(item));
    items.forEach(other => other.classList.remove('is-active'));
    item.classList.add('is-active');
    f.advanceNaturally(0);
    f.media.dispatchEvent(new f.window.Event('loadedmetadata'));
  }));
  f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { playClicks += 1; });
  Object.assign(f.api.CFG, {
    recoveryWaitMin: 1, recoveryWaitMax: 1, identityStableTime: 1,
    gatewayPauseGrace: 5, mediaLoadTimeout: 1000, directoryLoadTimeout: 1500,
    stallTimeout: 20000, resourceRetryDelay: 1, backgroundRetryDelay: 1
  });
  return { ...f, items, clicks, messages, get playClicks() { return playClicks; } };
}

async function dispose(f) {
  if (!f || f.disposed) return;
  f.disposed = true;
  f.api.state.running = false;
  f.api.state.epoch += 1;
  // Closing the simulated document cancels its timers, like a real unload.
  f.dom.window.close();
}

function leaveForProject(f) {
  const previous = f.window.location.href;
  f.window.history.replaceState(null, '', PROJECT);
  f.window.document.querySelector('.sub-menu-area')?.remove();
  f.window.document.querySelector('.video-js')?.remove();
  const project = f.window.document.createElement('div');
  project.textContent = '我的项目，共0个项目，暂无数据';
  f.window.document.body.append(project);
  f.window.dispatchEvent(new f.window.HashChangeEvent('hashchange', { oldURL: previous, newURL: PROJECT }));
}

function pauseFromWebsite(f) {
  f.media.pause();
  f.media.dispatchEvent(new f.window.Event('pause'));
}

function delayExecutionTimers(f) {
  const original = f.window.setTimeout.bind(f.window);
  let delayed = 0;
  f.window.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds === 100) {
      delayed += 1;
      return original(callback, 2000, ...args);
    }
    return original(callback, milliseconds, ...args);
  };
  return () => delayed;
}

function keepPeriodicSyncBehindRouteObserver({ window }) {
  const original = window.setInterval.bind(window);
  window.setInterval = (callback, milliseconds, ...args) =>
    original(callback, milliseconds === 1000 ? 5000 : milliseconds, ...args);
}

test('课内误触项目页后返回已核对入口，继续原资源自然播放，不重新开始或扫描', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const messages = [], documents = [];
  let current = mount(c, id, { messages });
  documents.push(current);
  c.onNavigation.addListener(destination => {
    assert.equal(destination.id, id);
    assert.equal(destination.url, COURSE);
    dispose(current);
    current = mount(c, id, { messages });
    documents.push(current);
  });
  try {
    const initial = await seedCoursePlaybackFixture(current);
    await observePlayback(current, current.items[0], { position: 10 });
    const originalKey = current.api.getItemKey(current.items[0]);
    leaveForProject(current);
    await waitFor(() => documents.length === 2, 5000);
    await observePlayback(current, current.items[0], { timeout: 5000 });
    const resumed = clone(c.storage.session[KEY]);
    assert.equal(resumed.runId, initial.runId);
    assert.equal(resumed.running, true);
    assert.equal(resumed.phase, 'course');
    assert.equal(resumed.candidates[0].currentResource.key, originalKey);
    assert.equal(resumed.interruption.attempts, 1);
    assert.equal(c.navigation.filter(entry => entry.url).length, 1);
    assert.equal(messages.filter(message => message.action === 'start').length, 1);
    assert.equal(messages.some(message => ['scan-result', 'open'].includes(message.action)), false);
    markPageCompleted(current.items[0]);
    endPlayback(current);
    await waitFor(() => c.storage.session[KEY]?.phase === 'finished', 5000);
    const record = c.storage.session[KEY].candidates[0].records[originalKey];
    assert.equal(record.ended, true);
    assert.equal(record.confirmed, true);
  } finally { for (const f of documents) await dispose(f); }
});

test('媒体轮询慢于路由轮询时，误触项目页也走有界导航恢复，不直接人工停止', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const messages = [], documents = [];
  let current = mount(c, id, { messages, beforeContent: keepPeriodicSyncBehindRouteObserver });
  documents.push(current);
  c.onNavigation.addListener(destination => {
    if (destination.id !== id) return;
    dispose(current);
    current = mount(c, id, { messages });
    documents.push(current);
  });
  try {
    const initial = await seedCoursePlaybackFixture(current);
    await observePlayback(current, current.items[0], { position: 10 });
    current.api.CFG.pollInterval = 2000;
    const delayed = delayExecutionTimers(current);
    await waitFor(() => delayed() > 0);
    leaveForProject(current);
    // updateRoute runs at 1200ms; the media loop is deliberately slower, so
    // this proves the route observer owns the recovery handoff first.
    await waitFor(() => documents.length === 2, 5000);
    await waitFor(() => c.storage.session[KEY]?.interruption?.status === 'attempting', 5000);
    const navAttempts = messages.filter(message =>
      message.action === 'interruption-attempt' && message.navigate === true);
    assert.equal(navAttempts.length, 1);
    assert.equal(messages.some(message => message.action === 'manual'), false);
    assert.equal(c.navigation.filter(entry => entry.url).length, 1);
    assert.equal(c.storage.session[KEY].runId, initial.runId);
    assert.equal(c.storage.session[KEY].running, true);
    assert.equal(c.storage.session[KEY].interruption.attempts, 1);
    assert.equal(c.storage.session[KEY].interruption.status, 'attempting');
  } finally { for (const f of documents) await dispose(f); }
});

test('后台仍授权同一任务、课程执行器尚未重启时误触项目页，也能返回原资源', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const messages = [], documents = [];
  let current = mount(c, id, { messages, beforeContent: keepPeriodicSyncBehindRouteObserver });
  documents.push(current);
  c.onNavigation.addListener(destination => {
    if (destination.id !== id) return;
    dispose(current);
    current = mount(c, id, { messages });
    documents.push(current);
  });
  try {
    const initial = await seedCoursePlaybackFixture(current);
    await observePlayback(current, current.items[0], { position: 10 });
    // Model the brief ownership/executor handoff window, not a user pause:
    // the durable job is running and no local stop generation is installed.
    current.api.state.running = false;
    current.api.state.epoch += 1;
    await Promise.allSettled([current.api.state.jobPromise, current.api.state.syncPromise].filter(Boolean));
    assert.equal(c.storage.session[KEY].running, true);
    assert.equal(current.api.state.localMediaStop, null);
    leaveForProject(current);
    await current.api.syncSharedJob();
    await waitFor(() => documents.length === 2, 5000);
    await observePlayback(current, current.items[0], { timeout: 5000 });
    const resumed = c.storage.session[KEY];
    assert.equal(resumed.runId, initial.runId);
    assert.equal(resumed.running, true);
    assert.equal(resumed.interruption.attempts, 1);
    assert.equal(messages.filter(message => message.action === 'start').length, 1);
    assert.equal(messages.some(message => message.action === 'manual'), false);
    assert.equal(c.navigation.filter(entry => entry.url).length, 1);
  } finally { for (const f of documents) await dispose(f); }
});

test('本地恢复尝试已计数后误触项目页，升级为导航不额外消耗第二次预算', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const messages = [], documents = [];
  let current = mount(c, id, { messages, beforeContent: keepPeriodicSyncBehindRouteObserver });
  current.api.CFG.recoveryWaitMin = current.api.CFG.recoveryWaitMax = 3000;
  documents.push(current);
  c.onNavigation.addListener(destination => {
    if (destination.id !== id) return;
    dispose(current);
    current = mount(c, id, { messages });
    documents.push(current);
  });
  try {
    const initial = await seedCoursePlaybackFixture(current);
    await observePlayback(current, current.items[0], { position: 10 });
    pauseFromWebsite(current);
    await waitFor(() => c.storage.session[KEY]?.interruption?.attempts === 1 &&
      c.storage.session[KEY].interruption.status === 'attempting');
    const delayed = delayExecutionTimers(current);
    await waitFor(() => delayed() > 0);
    leaveForProject(current);
    await waitFor(() => documents.length === 2, 5000);
    await waitFor(() => c.storage.session[KEY]?.interruption?.status === 'attempting', 5000);
    const attempts = messages.filter(message => message.action === 'interruption-attempt');
    assert.equal(attempts.filter(message => message.navigate !== true).length, 1);
    assert.equal(attempts.filter(message => message.navigate === true).length, 1);
    assert.equal(messages.some(message => message.action === 'interruption-failed'), false,
      'Navigation upgrade must reuse the active local episode');
    const job = c.storage.session[KEY];
    assert.equal(job.runId, initial.runId);
    assert.equal(job.running, true);
    assert.equal(job.interruption.attempts, 1);
    assert.equal(job.interruption.status, 'attempting');
    assert.equal(c.navigation.filter(entry => entry.url).length, 1);
  } finally { for (const f of documents) await dispose(f); }
});

test('同文档 SPA 误触后返回原学习路由：释放恢复等待并只启动一个课程执行器',
  { timeout: 12000 }, async () => {
    const c = coordinator();
    const id = c.addTab(COURSE);
    const listeners = [], messages = [];
    const f = mount(c, id, { messages, captureListeners: listeners,
      beforeContent: keepPeriodicSyncBehindRouteObserver });
    const originalSetTimeout = f.window.setTimeout;
    const directory = f.window.document.querySelector('.sub-menu-area');
    const player = f.window.document.querySelector('.video-js');
    let sameDocumentArrivals = 0;
    c.onNavigation.addListener(destination => {
      if (destination.id !== id) return;
      sameDocumentArrivals += 1;
      assert.equal(destination.url, COURSE);
      // The coordinator normally discards its receiver for tabs.update. For
      // this hash-only navigation, keep the same content instance and DOM.
      c.connect(id)(f.window);
      for (const listener of listeners) f.window.chrome.runtime.onMessage.addListener(listener);
      const send = f.window.chrome.runtime.sendMessage;
      f.window.chrome.runtime.sendMessage = async message => {
        messages.push(clone(message));
        return send(message);
      };
      f.window.setTimeout = originalSetTimeout;
      f.api.CFG.pollInterval = 2;
      f.window.document.body.append(directory, player);
      const previous = f.window.location.href;
      f.window.history.replaceState(null, '', destination.url);
      f.window.dispatchEvent(new f.window.HashChangeEvent('hashchange', {
        oldURL: previous, newURL: destination.url
      }));
    });
    try {
      const initial = await seedCoursePlaybackFixture(f);
      await observePlayback(f, f.items[0], { position: 10 });
      const key = f.api.getItemKey(f.items[0]);
      f.api.CFG.pollInterval = 2000;
      const delayed = delayExecutionTimers(f);
      await waitFor(() => delayed() > 0);
      leaveForProject(f);
      await waitFor(() => sameDocumentArrivals === 1, 5000);
      await waitFor(() => f.api.state.routeRecoveryPending === false &&
        c.storage.session[KEY]?.interruption?.status === 'attempting' &&
        c.storage.session[KEY]?.ownerInstance === f.api.state.instanceId, 5000);
      await observePlayback(f, f.items[0], { position: 10.25, timeout: 5000 });
      const job = c.storage.session[KEY];
      assert.equal(job.runId, initial.runId);
      assert.equal(job.running, true);
      assert.equal(job.candidates[0].currentResource.key, key);
      assert.equal(job.interruption.attempts, 1);
      assert.equal(messages.filter(message => message.action === 'start').length, 1);
      assert.equal(messages.filter(message => message.action === 'interruption-position').length, 1,
        'The resumed course has one active executor');
      assert.equal(c.navigation.filter(entry => entry.url).length, 1);
    } finally { f.window.setTimeout = originalSetTimeout; await dispose(f); }
  });

test('误触返回后慢目录仍在核对时保持播放器暂停，说明当前阶段，核对完成后才继续原资源',
  { timeout: 15000 }, async () => {
    const c = coordinator();
    const id = c.addTab(COURSE);
    const listeners = [], messages = [];
    const f = mount(c, id, { messages, captureListeners: listeners,
      beforeContent({ window }) {
        const chapter = window.document.createElement('li');
        chapter.className = 'el-sub-menu is-opened';
        chapter.setAttribute('aria-expanded', 'true');
        chapter.innerHTML = `<div class="el-sub-menu__title">第二章</div><ul>${mediaItem('阅读材料', 'text', 'unStart', '')}</ul>`;
        window.document.querySelector('.sub-menu-area > ul').append(chapter);
      } });
    f.api.CFG.directoryLoadTimeout = 5000;
    const directory = f.window.document.querySelector('.sub-menu-area');
    const player = f.window.document.querySelector('.video-js');
    const slowChapter = directory.querySelectorAll('li.el-sub-menu')[1];
    const slowItems = slowChapter.querySelector('ul');
    const savedItems = slowItems.innerHTML;
    let expansionRequested = false;
    slowChapter.querySelector('.el-sub-menu__title').addEventListener('click', () => {
      expansionRequested = true;
      slowChapter.setAttribute('aria-expanded', 'true');
      // The fake website has accepted the ordinary expansion click, but its
      // chapter entries arrive later. The extension must not play meanwhile.
    });
    c.onNavigation.addListener(destination => {
      assert.equal(destination.id, id);
      assert.equal(destination.url, COURSE);
      c.connect(id)(f.window);
      for (const listener of listeners) f.window.chrome.runtime.onMessage.addListener(listener);
      const send = f.window.chrome.runtime.sendMessage;
      f.window.chrome.runtime.sendMessage = async message => {
        messages.push(clone(message));
        return send(message);
      };
      slowChapter.setAttribute('aria-expanded', 'false');
      slowItems.replaceChildren();
      const previous = f.window.location.href;
      f.window.history.replaceState(null, '', destination.url);
      f.window.document.body.append(directory, player);
      // This is website autoplay after a SPA return, not an extension action.
      f.media.play();
      f.media.dispatchEvent(new f.window.Event('playing'));
      f.window.dispatchEvent(new f.window.HashChangeEvent('hashchange', {
        oldURL: previous, newURL: destination.url
      }));
    });
    try {
      const initial = await seedCoursePlaybackFixture(f);
      await observePlayback(f, f.items[0], { position: 10 });
      const key = f.api.getItemKey(f.items[0]);
      leaveForProject(f);
      await waitFor(() => expansionRequested, 7000);
      assert.equal(c.storage.session[KEY].interruption.status, 'attempting');
      assert.equal(c.storage.session[KEY].ownerInstance, f.api.state.instanceId);
      assert.equal(f.media.paused, true, 'The player stays paused while a saved directory is incomplete');
      // Repeated site autoplay must remain stopped until the owned executor
      // has finished directory checks and installed its playback observers.
      f.media.play();
      f.media.dispatchEvent(new f.window.Event('playing'));
      assert.equal(f.media.paused, true);
      assert.match(f.window.document.getElementById('wb-status').textContent, /恢复|核对/);
      assert.match(f.window.document.getElementById('wb-current').textContent, /核对.*目录/);
      assert.doesNotMatch(f.window.document.getElementById('wb-current').textContent, /另一个页面/);
      assert.notEqual(c.storage.session[KEY].candidates[0].records[key]?.ended, true);
      slowItems.innerHTML = savedItems;
      await observePlayback(f, f.items[0], { position: 10.25, timeout: 5000 });
      assert.equal(c.storage.session[KEY].runId, initial.runId);
      assert.equal(c.storage.session[KEY].running, true);
      assert.equal(c.storage.session[KEY].interruption.attempts, 1);
      assert.equal(c.navigation.filter(entry => entry.url).length, 1);
      assert.equal(messages.some(message => message.action === 'manual'), false);
    } finally { await dispose(f); }
  });

for (const restoresAfterReload of [true, false]) {
  test(restoresAfterReload
    ? '误触返回后的目录结构超时：正常刷新同一资源后接回任务，保留课程和三次预算'
    : '误触返回后的目录持续损坏：返回一次及刷新两次后停止，不无限等待或换资源',
  { timeout: 20000 }, async () => {
    const c = coordinator();
    const id = c.addTab(COURSE);
    const messages = [], listeners = [], documents = [];
    const addChapter = (window, complete = true) => {
      const chapter = window.document.createElement('li');
      chapter.className = 'el-sub-menu is-opened';
      chapter.setAttribute('aria-expanded', 'true');
      chapter.innerHTML = `<div class="el-sub-menu__title">第二章</div><ul>${complete ? mediaItem('阅读材料', 'text', 'unStart', '') : ''}</ul>`;
      chapter.querySelector('.el-sub-menu__title').addEventListener('click', () => {
        chapter.setAttribute('aria-expanded', 'true');
      });
      window.document.querySelector('.sub-menu-area > ul').append(chapter);
      return chapter;
    };
    let current = mount(c, id, { messages, captureListeners: listeners,
      beforeContent({ window }) { addChapter(window); } });
    current.api.CFG.directoryLoadTimeout = 700;
    documents.push(current);
    const first = current;
    const directory = first.window.document.querySelector('.sub-menu-area');
    const player = first.window.document.querySelector('.video-js');
    c.onNavigation.addListener(destination => {
      assert.equal(destination.id, id);
      assert.equal(destination.url, COURSE);
      if (c.reloads.length === 0) {
        // The first saved-entry return is a SPA transition. It retains the
        // owner document but leaves a chapter component unable to load items.
        c.connect(id)(first.window);
        for (const listener of listeners) first.window.chrome.runtime.onMessage.addListener(listener);
        const send = first.window.chrome.runtime.sendMessage;
        first.window.chrome.runtime.sendMessage = async message => {
          messages.push(clone(message));
          return send(message);
        };
        const chapter = directory.querySelectorAll('li.el-sub-menu')[1];
        chapter.setAttribute('aria-expanded', 'false');
        chapter.querySelector('ul').replaceChildren();
        const previous = first.window.location.href;
        first.window.history.replaceState(null, '', destination.url);
        first.window.document.body.append(directory, player);
        first.window.dispatchEvent(new first.window.HashChangeEvent('hashchange', {
          oldURL: previous, newURL: destination.url
        }));
      } else {
        // A normal browser refresh replaces the document; only the fake
        // website decides whether its directory works after that refresh.
        dispose(current);
        current = mount(c, id, { messages, beforeContent({ window, advanceNaturally }) {
          addChapter(window, restoresAfterReload);
          advanceNaturally(10);
        } });
        current.api.CFG.directoryLoadTimeout = 700;
        documents.push(current);
      }
    });
    try {
      const initial = await seedCoursePlaybackFixture(first);
      await observePlayback(first, first.items[0], { position: 10 });
      const key = first.api.getItemKey(first.items[0]);
      leaveForProject(first);
      if (restoresAfterReload) {
        await waitFor(() => c.reloads.length === 1 && current !== first, 10000);
        await observePlayback(current, current.items[0], { position: 10.25, timeout: 5000 });
        assert.equal(c.storage.session[KEY].running, true);
        assert.equal(c.storage.session[KEY].interruption.attempts, 2,
          'The saved-entry return and subsequent refresh use one shared budget');
        assert.equal(c.reloads.length, 1);
        assert.equal(messages.some(message => message.action === 'manual'), false);
      } else {
        await waitFor(() => c.storage.session[KEY]?.phase === 'manual', 15000);
        assert.equal(c.storage.session[KEY].running, false);
        assert.equal(c.storage.session[KEY].interruption.attempts, 3);
        assert.match(c.storage.session[KEY].reason, /三次|3/);
        assert.equal(c.reloads.length, 2,
          'The initial return plus two refreshes exhaust the three attempts');
        assert.equal(current.media.paused, true);
      }
      const job = c.storage.session[KEY];
      assert.equal(job.runId, initial.runId);
      assert.equal(job.candidates[0].currentResource.key, key);
      assert.notEqual(job.candidates[0].records[key]?.ended, true);
      assert.equal(c.navigation.filter(entry => entry.url).length, 1);
      assert.equal(messages.filter(message => message.action === 'start').length, 1);
      assert.equal(messages.some(message => ['scan-result', 'open'].includes(message.action)), false);
      assert.ok(messages.some(message => message.action === 'interruption-attempt' &&
        message.navigate === true && message.reload === true));
    } finally { for (const f of documents) await dispose(f); }
  });
}

test('离开页面前已保存位置与返回位置相差三十秒：保留未观看区间，不确认资源完成',
  { timeout: 12000 }, async () => {
    const c = coordinator();
    const id = c.addTab(COURSE);
    const messages = [];
    const documents = [];
    let current = mount(c, id, { messages });
    documents.push(current);
    c.onNavigation.addListener(destination => {
      if (destination.id !== id) return;
      dispose(current);
      current = mount(c, id, { messages, beforeContent({ advanceNaturally }) {
        // The fake site resumes ahead of the last observed playback point.
        // The extension must preserve the unseen interval, not seek or skip it.
        advanceNaturally(40);
      } });
      documents.push(current);
    });
    try {
      const initial = await seedCoursePlaybackFixture(current);
      await observePlayback(current, current.items[0], { position: 10 });
      const key = current.api.getItemKey(current.items[0]);
      await waitFor(() => c.storage.session[OBSERVATION]?.sample?.position >= 10, 5000);
      const observation = clone(c.storage.session[OBSERVATION]);
      assert.equal(observation.runId, initial.runId);
      assert.equal(observation.key, key);
      const sample = observation.sample;
      assert.equal(sample.position, 10);
      leaveForProject(current);
      await waitFor(() => documents.length === 2, 5000);
      await waitFor(() => c.storage.session[KEY]?.candidates[0]?.records?.[key]
        ?.progressGap?.to === 40, 5000);
      const job = clone(c.storage.session[KEY]);
      const record = job.candidates[0].records[key];
      assert.equal(job.runId, initial.runId);
      assert.equal(record.progressGap.from, sample.position);
      assert.equal(record.progressGap.to, 40);
      assert.notEqual(record.ended, true);
      assert.notEqual(record.confirmed, true);
      assert.equal(job.interruption?.gapDetected, true);
      assert.equal(messages.filter(message => message.action === 'start').length, 1);
      assert.equal(messages.some(message => message.action === 'media-observation'), true);
      assert.equal(messages.some(message => message.action === 'interruption-position'), true);
      const fakeCompletion = await c.request(id, job.ownerInstance, 'record', {
        ...auth(job), key, result: { ended: true, confirmed: true }
      });
      assert.equal(fakeCompletion.ok, false,
        'A platform mark or record cannot turn an unseen interval into natural playback');
      assert.ok(c.storage.session[KEY].candidates[0].records[key].progressGap);
      assert.notEqual(c.storage.session[KEY].phase, 'finished');
    } finally { for (const f of documents) await dispose(f); }
  });

test('返回原资源且位置未前跳：自然稳定播放满八秒后才清零中断次数',
  { timeout: 22000 }, async () => {
    const c = coordinator();
    const id = c.addTab(COURSE);
    const messages = [];
    const documents = [];
    let current = mount(c, id, { messages });
    documents.push(current);
    c.onNavigation.addListener(destination => {
      if (destination.id !== id) return;
      dispose(current);
      current = mount(c, id, { messages, beforeContent({ advanceNaturally }) {
        advanceNaturally(10);
      } });
      documents.push(current);
    });
    try {
      const initial = await seedCoursePlaybackFixture(current);
      await observePlayback(current, current.items[0], { position: 10 });
      const key = current.api.getItemKey(current.items[0]);
      await waitFor(() => c.storage.session[OBSERVATION]?.sample?.position >= 10, 5000);
      leaveForProject(current);
      await waitFor(() => documents.length === 2, 5000);
      await observePlayback(current, current.items[0], { position: 10.25, timeout: 5000 });
      await waitFor(() => c.storage.session[KEY]?.interruption?.continuityChecked === true, 5000);
      const episode = c.storage.session[KEY].interruption;
      assert.equal(episode.attempts, 1);
      assert.equal(episode.gapDetected, undefined);
      assert.equal(c.storage.session[KEY].candidates[0].records[key].progressGap, undefined);
      assert.equal(current.window.document.getElementById('wb-status').textContent, '正在恢复');
      let position = current.media.currentTime;
      for (let i = 0; i < 18; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
        position += 0.5;
        current.advanceNaturally(position);
        current.media.dispatchEvent(new current.window.Event('timeupdate'));
        if (i < 10) assert.equal(c.storage.session[KEY]?.interruption?.id, episode.id,
          'A few seconds of playback do not clear the same interruption episode');
      }
      await waitFor(() => !c.storage.session[KEY]?.interruption, 2500);
      await waitFor(() => current.window.document.getElementById('wb-status').textContent === '运行中', 1000);
      const job = c.storage.session[KEY];
      assert.equal(job.runId, initial.runId);
      assert.equal(job.running, true);
      assert.equal(job.candidates[0].records[key].progressGap, undefined);
      assert.equal(c.navigation.filter(entry => entry.url).length, 1);
      assert.equal(messages.filter(message => message.action === 'start').length, 1,
        'Returning to the same resource is not a second Start');
    } finally { for (const f of documents) await dispose(f); }
  });

test('已确认完成的原资源在误触恢复后不重播，继续当前未完成资源', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const messages = [], documents = [];
  const items = [
    mediaItem('已经完成的视频', 'video', 'unStart', '00 分 10 秒'),
    mediaItem('当前未完成的视频', 'video', 'unStart', '00 分 30 秒')
  ];
  let current = mount(c, id, { messages, items });
  documents.push(current);
  const completedKey = current.api.getItemKey(current.items[0]);
  const pendingKey = current.api.getItemKey(current.items[1]);
  let completedClicks = 0;
  current.items[0].addEventListener('click', () => { completedClicks += 1; });
  c.onNavigation.addListener(destination => {
    if (destination.id !== id) return;
    dispose(current);
    current = mount(c, id, { messages, items });
    documents.push(current);
    current.items[0].addEventListener('click', () => { completedClicks += 1; });
  });
  try {
    const initial = await seedCoursePlaybackFixture(current);
    await observePlayback(current, current.items[0], { position: 3 });
    markPageCompleted(current.items[0]);
    endPlayback(current);
    items[0] = mediaItem('已经完成的视频', 'video', 'done', '00 分 10 秒');
    await waitFor(() => current.items[1].classList.contains('is-active') && !current.media.paused, 5000);
    await observePlayback(current, current.items[1], { position: 3 });
    const clicksBeforeDeparture = completedClicks;
    leaveForProject(current);
    await waitFor(() => documents.length === 2, 5000);
    await observePlayback(current, current.items[1], { timeout: 5000 });
    const job = clone(c.storage.session[KEY]);
    assert.equal(job.runId, initial.runId);
    assert.equal(job.running, true);
    assert.equal(job.candidates[0].records[completedKey].ended, true);
    assert.equal(job.candidates[0].records[completedKey].confirmed, true);
    assert.equal(job.candidates[0].currentResource.key, pendingKey);
    assert.equal(completedClicks, clicksBeforeDeparture);
    assert.equal(current.clicks.filter(key => key === completedKey).length, 0);
  } finally { for (const f of documents) await dispose(f); }
});

test('原资源未自然结束时即使网页提前显示完成，也继续该资源直到自然结束', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const messages = [], documents = [];
  let completedOnPage = false;
  const items = () => [mediaItem('未自然结束的视频', 'video',
    completedOnPage ? 'done' : 'unStart', '01 分 00 秒')];
  let current = mount(c, id, { messages, items: items() });
  documents.push(current);
  c.onNavigation.addListener(destination => {
    if (destination.id !== id) return;
    dispose(current);
    current = mount(c, id, { messages, items: items() });
    documents.push(current);
  });
  try {
    const initial = await seedCoursePlaybackFixture(current);
    await observePlayback(current, current.items[0], { position: 10 });
    const key = current.api.getItemKey(current.items[0]);
    completedOnPage = true;
    leaveForProject(current);
    await waitFor(() => documents.length === 2, 5000);
    await observePlayback(current, current.items[0], { timeout: 5000 });
    const resumed = c.storage.session[KEY];
    assert.equal(resumed.runId, initial.runId);
    assert.equal(resumed.running, true);
    assert.notEqual(resumed.candidates[0].records[key]?.ended, true);
    assert.ok(current.playClicks >= 1);
    endPlayback(current);
    await waitFor(() => c.storage.session[KEY]?.phase === 'finished', 5000);
    const result = c.storage.session[KEY].candidates[0].records[key];
    assert.equal(result.ended, true);
    assert.equal(result.confirmed, true);
  } finally { for (const f of documents) await dispose(f); }
});

test('恢复后自然稳定推进八秒才清除本次预算，下一次普通暂停从第一次重试开始',
  { timeout: 22000 }, async () => {
    const c = coordinator();
    const id = c.addTab(COURSE);
    const f = mount(c, id);
    try {
      await seedCoursePlaybackFixture(f);
      await observePlayback(f, f.items[0], { position: 1 });
      pauseFromWebsite(f);
      await waitFor(() => c.storage.session[KEY]?.interruption?.attempts === 1 && !f.media.paused, 5000);
      f.media.dispatchEvent(new f.window.Event('playing'));
      const episodeId = c.storage.session[KEY].interruption.id;
      let position = f.media.currentTime;
      for (let i = 0; i < 18; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
        position += 0.5;
        f.advanceNaturally(position);
        f.media.dispatchEvent(new f.window.Event('timeupdate'));
        if (i < 10) assert.equal(c.storage.session[KEY]?.interruption?.id, episodeId,
          'A successful click or only a few seconds must not reset the failure budget');
      }
      await waitFor(() => !c.storage.session[KEY]?.interruption, 2000);
      pauseFromWebsite(f);
      await waitFor(() => c.storage.session[KEY]?.interruption?.attempts === 1 && !f.media.paused, 5000);
      assert.notEqual(c.storage.session[KEY].interruption.id, episodeId);
      assert.equal(c.storage.session[KEY].running, true);
      await f.api.stop();
      assert.equal(c.storage.session[KEY].phase, 'paused');
    } finally { await dispose(f); }
  });

test('中断音视频在八秒前自然结束、页面标记稍后到达：两种证据齐全后清除预算并继续下一项',
  { timeout: 15000 }, async () => {
    const c = coordinator();
    const id = c.addTab(COURSE);
    const f = mount(c, id, {
      items: [mediaItem('短时音频', 'audio', 'unStart', '00 分 05 秒'),
        mediaItem('后续视频', 'video', 'unStart', '00 分 30 秒')],
      confirmationTimeout: 20
    });
    try {
      await seedCoursePlaybackFixture(f);
      const [shortAudio, nextVideo] = f.items;
      const audioKey = f.api.getItemKey(shortAudio);
      const nextKey = f.api.getItemKey(nextVideo);
      await observePlayback(f, shortAudio, { position: 0.25 });
      pauseFromWebsite(f);
      await waitFor(() => c.storage.session[KEY]?.interruption?.attempts === 1 && !f.media.paused, 5000);
      f.media.dispatchEvent(new f.window.Event('playing'));
      const episodeId = c.storage.session[KEY].interruption.id;
      const episodeStartedAt = c.storage.session[KEY].interruption.startedAt;
      endPlayback(f);
      await waitFor(() => c.storage.session[KEY]?.candidates[0]?.records?.[audioKey]?.ended === true, 5000);
      const firstRecord = c.storage.session[KEY].candidates[0].records[audioKey];
      assert.equal(firstRecord.ended, true);
      assert.equal(firstRecord.confirmed, false,
        'The first confirmation timeout expires before the fake site posts its delayed mark');
      assert.equal(c.storage.session[KEY].interruption.id, episodeId);
      assert.notEqual(nextVideo.classList.contains('is-active'), true,
        'A completed resource still needs its platform mark before moving on');
      assert.ok(Date.now() - episodeStartedAt < 8000,
        'This resource ended before the stable-playback reset threshold');
      const audioDirectoryClicksBeforeLateMark = f.clicks.filter(key => key === audioKey).length;

      // The site marks the interrupted audio after its first confirmation
      // timeout. The runner waits for that mark before selecting a new item.
      markPageCompleted(shortAudio);
      await waitFor(() => !c.storage.session[KEY]?.interruption &&
        nextVideo.classList.contains('is-active') && !f.media.paused, 5000);
      await observePlayback(f, nextVideo, { position: 1 });
      markPageCompleted(nextVideo);
      endPlayback(f);
      await waitFor(() => c.storage.session[KEY]?.phase === 'finished', 5000);
      const final = c.storage.session[KEY];
      assert.equal(final.candidates[0].records[audioKey].ended, true);
      assert.equal(final.candidates[0].records[audioKey].confirmed, true);
      assert.equal(final.candidates[0].records[nextKey].ended, true);
      assert.equal(final.candidates[0].records[nextKey].confirmed, true);
      assert.equal(final.interruption, undefined,
        'Natural end plus the later platform mark clears the retry budget');
      assert.equal(f.clicks.filter(key => key === audioKey).length, audioDirectoryClicksBeforeLateMark,
        'The completed audio is not replayed when its late mark is observed');
      assert.equal(c.reloads.length, 0, 'Waiting for a platform completion mark must not refresh the page');
      assert.equal(c.navigation.filter(entry => entry.url).length, 0);
    } finally { await dispose(f); }
  });

test('同一次播放故障连续三次恢复失败后停止整轮，不能刷新或转去下一项暗中回试', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const f = mount(c, id, {
    items: [mediaItem('始终无法开始的视频', 'video', 'unStart', '00 分 30 秒'),
      mediaItem('不能在停止后偷偷播放的音频', 'audio', 'unStart', '02 分 00 秒')],
    beforeContent({ window }) {
      const button = window.document.querySelector('.vjs-big-play-button');
      const inert = button.cloneNode(true);
      inert.getClientRects = () => [{ width: 1, height: 1 }];
      button.replaceWith(inert);
    }
  });
  Object.assign(f.api.CFG, { mediaLoadTimeout: 30, stallTimeout: 30 });
  try {
    const initial = await seedCoursePlaybackFixture(f);
    await waitFor(() => c.storage.session[KEY]?.phase === 'manual', 5000);
    const stopped = clone(c.storage.session[KEY]);
    assert.equal(stopped.runId, initial.runId);
    assert.equal(stopped.running, false);
    assert.equal(stopped.interruption.attempts, 3);
    assert.equal(f.messages.filter(message => message.action === 'interruption-attempt').length, 3);
    assert.ok(f.playClicks >= 1, 'The initial visible play action was attempted');
    assert.equal(c.reloads.length, 0);
    assert.equal(c.navigation.filter(entry => entry.url).length, 0);
    assert.equal(stopped.candidates[0].records[f.api.getItemKey(f.items[1])], undefined);
    const clickCount = f.playClicks;
    await new Promise(resolve => setTimeout(resolve, 100));
    await f.api.syncSharedJob();
    assert.equal(f.playClicks, clickCount);
    assert.equal(c.storage.session[KEY].phase, 'manual');
    assert.equal(f.messages.some(message => ['reload-course', 'course-result', 'finish'].includes(message.action)), false);
  } finally { await dispose(f); }
});

for (const control of ['pause', 'reset']) {
  test(`恢复授权消息尚未发送时用户${control === 'pause' ? '暂停' : '重置'}，迟到授权不能复活播放`, async () => {
    const c = coordinator();
    const id = c.addTab(COURSE);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let waiting = false;
    const f = mount(c, id, { beforeSend: async message => {
      if (message.action === 'interruption-attempt' && !waiting) {
        waiting = true;
        await gate;
      }
    } });
    try {
      await seedCoursePlaybackFixture(f);
      await observePlayback(f, f.items[0], { position: 1 });
      pauseFromWebsite(f);
      await waitFor(() => waiting, 5000);
      const before = clone(c.storage.session[KEY]);
      const clickCount = f.playClicks;
      if (control === 'pause') await f.api.stop();
      else {
        f.window.confirm = () => true;
        await f.api.resetPlugin();
      }
      release();
      await waitFor(() => !f.api.state.jobPromise, 5000);
      await f.api.syncSharedJob();
      const stopped = c.storage.session[KEY];
      assert.equal(stopped.running, false);
      assert.equal(stopped.phase, control === 'pause' ? 'paused' : 'idle');
      assert.equal(f.media.paused, true);
      assert.equal(f.playClicks, clickCount);
      assert.equal(c.navigation.filter(entry => entry.url).length, 0);
      if (control === 'reset') {
        assert.notEqual(stopped.runId, before.runId);
        assert.deepEqual(stopped.candidates, []);
      }
    } finally { release(); await dispose(f); }
  });
}

test('恢复导航到期后的新文档首次握手已显示验证码：先停任务，不再次导航', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const first = mount(c, id);
  let blockedPage;
  try {
    await seedCoursePlaybackFixture(first);
    await observePlayback(first, first.items[0], { position: 1 });
    const job = c.storage.session[KEY];
    const key = first.api.getItemKey(first.items[0]);
    const navigation = await c.request(id, first.api.state.instanceId, 'interruption-attempt', {
      ...auth(job), key, navigate: true, reason: '模拟资源页面误触'
    });
    assert.equal(navigation.ok, true);
    const issuedBeforeVerification = c.navigation.filter(entry => entry.url).length;
    await dispose(first);
    // Simulate the saved navigation deadline expiring before the replacement
    // page's initial get. Its visible verification message must win that race.
    c.storage.session[KEY].interruption.deadline = Date.now() - 1;
    blockedPage = mount(c, id, { url: PROJECT, beforeContent({ window }) {
      const notice = window.document.createElement('div');
      notice.textContent = '请完成安全验证';
      window.document.body.append(notice);
    } });
    await waitFor(() => c.storage.session[KEY]?.phase === 'manual', 5000);
    const handshake = blockedPage.messages.find(message => message.action === 'get');
    assert.match(handshake?.pageBlocked || '', /安全验证/);
    assert.equal(c.storage.session[KEY].running, false);
    assert.equal(c.storage.session[KEY].interruption.attempts, 1);
    assert.equal(c.navigation.filter(entry => entry.url).length, issuedBeforeVerification);
    assert.equal(blockedPage.playClicks, 0);
    assert.equal(blockedPage.media.paused, true);
  } finally { await dispose(first); await dispose(blockedPage); }
});

test('恢复等待期间出现验证码，保留平台停止并取消后续恢复点击', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const f = mount(c, id);
  f.api.CFG.recoveryWaitMin = f.api.CFG.recoveryWaitMax = 150;
  try {
    await seedCoursePlaybackFixture(f);
    await observePlayback(f, f.items[0], { position: 1 });
    pauseFromWebsite(f);
    await waitFor(() => c.storage.session[KEY]?.interruption?.attempts === 1, 5000);
    const clickCount = f.playClicks;
    const notice = f.window.document.createElement('div');
    notice.textContent = '请完成安全验证';
    f.window.document.body.append(notice);
    await waitFor(() => c.storage.session[KEY]?.phase === 'manual', 5000);
    assert.equal(c.storage.session[KEY].running, false);
    assert.match(c.storage.session[KEY].reason, /安全验证|页面提示/);
    assert.equal(f.playClicks, clickCount);
    assert.equal(f.media.paused, true);
    assert.equal(c.navigation.filter(entry => entry.url).length, 0);
  } finally { await dispose(f); }
});

test('恢复等待期间登录失效保留人工停止，不把登录页当作可恢复学习页', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const f = mount(c, id);
  f.api.CFG.recoveryWaitMin = f.api.CFG.recoveryWaitMax = 150;
  try {
    await seedCoursePlaybackFixture(f);
    await observePlayback(f, f.items[0], { position: 1 });
    pauseFromWebsite(f);
    await waitFor(() => c.storage.session[KEY]?.interruption?.attempts === 1, 5000);
    const login = f.window.document.createElement('div');
    login.textContent = '登录已过期，请先登录';
    f.window.document.body.append(login);
    await waitFor(() => c.storage.session[KEY]?.phase === 'manual', 5000);
    assert.equal(c.storage.session[KEY].running, false);
    assert.match(c.storage.session[KEY].reason, /登录|过期/);
    assert.equal(f.media.paused, true);
    assert.equal(c.navigation.filter(entry => entry.url).length, 0);
  } finally { await dispose(f); }
});

test('任务标签实际跳到站内登录路由时不强行拉回课程', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const f = mount(c, id);
  try {
    await seedCoursePlaybackFixture(f);
    await observePlayback(f, f.items[0], { position: 2 });
    const key = f.api.getItemKey(f.items[0]);
    const oldUrl = f.window.location.href;
    f.window.history.replaceState(null, '', 'https://www.beeline-ai.com/login');
    f.window.document.querySelector('.video-js')?.remove();
    f.window.document.querySelector('.sub-menu-area')?.remove();
    f.window.dispatchEvent(new f.window.HashChangeEvent('hashchange', {
      oldURL: oldUrl, newURL: f.window.location.href
    }));
    await waitFor(() => c.storage.session[KEY]?.phase === 'manual', 5000);
    assert.equal(c.storage.session[KEY].running, false);
    assert.equal(c.navigation.filter(entry => entry.url).length, 0);
    assert.notEqual(c.storage.session[KEY].candidates[0].records[key]?.ended, true);
  } finally { await dispose(f); }
});
