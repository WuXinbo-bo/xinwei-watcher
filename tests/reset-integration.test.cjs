const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, mediaItem, waitFor, seedCoursePlaybackFixture } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');

const KEY = 'xinwei-job-v3';
const COURSE = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';
const AGENT = 'https://www.beeline-ai.com/stu/agent';

test('重置时旧标签页没有扩展接收端会自动刷新并完成清理', async () => {
  const c = coordinator();
  const home = c.addTab(AGENT);
  const worker = c.addTab(COURSE, home);
  c.storage.session[KEY] = {
    version: 3, runId: 'stale-run', generation: 4, revision: 1, resetEpoch: 0,
    running: true, phase: 'course', scope: 'all', homeTabId: home, workerTabId: worker,
    ownerTabId: worker, ownerInstance: 'stale-worker', candidates: [], logs: []
  };

  const result = await c.request(home, 'home', 'reset', { resetEpoch: 0 }, AGENT);
  assert.equal(result.ok, true);
  assert.equal(result.job.phase, 'idle');
  assert.deepEqual(c.reloads.sort((a, b) => a - b), [home, worker]);
  assert.deepEqual(c.storage.session[KEY].candidates, []);
});

test('运行中重置先确认：取消保留任务，确认停止并清空，旧消息不复活，再次开始回首页', async () => {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const messages = [];
  const f = fixture([mediaItem('待重置的视频'), mediaItem('平台已经完成的视频', 'video', 'done')], {
    url: COURSE, connect(window) {
      c.connect(id)(window);
      const send = window.chrome.runtime.sendMessage;
      window.chrome.runtime.sendMessage = message => {
        messages.push(JSON.parse(JSON.stringify(message)));
        return send(message);
      };
    }
  });
  let clicks = 0;
  const [item, completedItem] = f.api.getMenuItems();
  item.classList.add('is-active');
  f.window.confirm = () => { throw new Error('新版重置应使用面板内确认'); };
  f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { clicks += 1; });
  // A website-owned marker must not be changed by an extension data reset.
  item.querySelector('.lecture-status').dataset.platform = 'preserve';
  completedItem.querySelector('.lecture-status').dataset.platform = 'already-completed';
  const completedMarkup = completedItem.querySelector('.lecture-status').outerHTML;
  try {
    await seedCoursePlaybackFixture(f);
    await waitFor(() => !f.media.paused && f.api.state.processedItems.get(f.api.getItemKey(item))?.playbackAttempt?.after);
    f.media.dispatchEvent(new f.window.Event('playing'));
    f.advanceNaturally(10);
    const before = JSON.parse(JSON.stringify(c.storage.session[KEY]));
    const oldInstance = f.api.state.instanceId;
    const oldRecordMessage = messages.find(message => message.action === 'record');
    assert.ok(oldRecordMessage);
    f.api.state.uiController.navigate('settings');
    f.window.document.getElementById('wb-reset-menu').click();
    assert.equal(f.api.state.uiController.view, 'reset');
    assert.match(f.window.document.querySelector('[data-view=reset]').textContent, /清除本地任务、断点、课程统计、日志和错误记录/);
    f.window.document.getElementById('wb-reset-cancel').click();
    assert.equal(f.api.state.uiController.view, 'settings');
    assert.equal(c.storage.session[KEY].runId, before.runId);
    assert.equal(c.storage.session[KEY].running, true);
    assert.equal(f.media.paused, false);
    assert.equal(messages.filter(message => message.action === 'reset').length, 0);

    f.window.document.getElementById('wb-reset-menu').click();
    const pendingExecution = f.api.state.jobPromise;
    f.window.document.getElementById('wb-reset').click();
    await pendingExecution;
    await waitFor(() => f.api.state.mode === 'idle' && !f.api.state.resetPending);
    assert.equal(f.api.state.uiController.view, 'home');
    assert.equal(messages.filter(message => message.action === 'reset').length, 1);
    assert.equal(f.media.paused, true);
    assert.equal(f.media.currentTime, 10);
    assert.equal(item.querySelector('.lecture-status').dataset.platform, 'preserve');
    assert.match(item.querySelector('.lecture-status').innerHTML, /unStart-icon/);
    assert.equal(completedItem.querySelector('.lecture-status').outerHTML, completedMarkup);
    assert.equal(f.api.isPageCompletedItem(completedItem), true);
    const empty = c.storage.session[KEY];
    assert.equal(empty.phase, 'idle');
    assert.equal(empty.running, false);
    assert.equal(empty.resetEpoch, (before.resetEpoch || 0) + 1);
    assert.notEqual(empty.runId, before.runId);
    for (const saved of [empty, c.storage.local[KEY]]) {
      assert.deepEqual(saved.candidates, []);
      assert.deepEqual(saved.logs, []);
      assert.equal(saved.recoveryRecords, undefined);
    }
    assert.equal(f.api.state.processedItems.size, 0);
    assert.equal(f.api.state.resourceCheckpoint, null);
    assert.equal(f.api.state.playedCount, 0);
    assert.equal(f.api.state.logBox.textContent, '');
    const clicksAfterReset = clicks;
    const stale = await c.request(id, oldInstance, 'record', oldRecordMessage);
    assert.equal(stale.ok, false);
    assert.equal(stale.error, 'TASK_CANCELLED');
    await f.api.syncSharedJob();
    assert.equal(clicks, clicksAfterReset);
    assert.equal(c.storage.session[KEY].phase, 'idle');

    f.window.document.getElementById('wb-start').click();
    await waitFor(() => c.navigation.some(n => n.url === AGENT));
    assert.equal(c.storage.session[KEY].scope, 'all');
    assert.equal(c.storage.session[KEY].candidates.length, 0);
    assert.equal(c.storage.session[KEY].resetEpoch, empty.resetEpoch);
    assert.equal(c.navigation.filter(n => n.url === AGENT).length, 1);
  } finally {
    f.api.state.running = false;
    f.api.state.epoch += 1;
    await Promise.allSettled([f.api.state.jobPromise, f.api.state.syncPromise].filter(Boolean));
    f.dom.window.close();
  }
});
