const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, mediaItem, waitFor, seedCoursePlaybackFixture } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');

const KEY = 'xinwei-job-v3';
const URL = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';

function failingCourse() {
  let reloadAttempts = 0;
  const c = coordinator({ beforeReload: async () => {
    reloadAttempts += 1;
    throw new Error('Refresh should no longer be part of ordinary recovery');
  } });
  const tab = c.addTab(URL);
  const f = fixture([
    mediaItem('始终无法播放的短视频', 'video', 'unStart', '00 分 30 秒'),
    mediaItem('尚未尝试的长音频', 'audio', 'unStart', '01 分 00 秒')
  ], { url: URL, connect: c.connect(tab) });
  const items = f.api.getMenuItems();
  const keys = items.map(item => f.api.getItemKey(item));
  let clicks = 0, otherOpened = 0;
  items[0].classList.add('is-active');
  items[1].addEventListener('click', () => { otherOpened += 1; });
  f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => {
    clicks += 1;
    f.media.pause();
    f.media.dispatchEvent(new f.window.Event('pause'));
  });
  Object.assign(f.api.CFG, {
    recoveryWaitMin: 1, recoveryWaitMax: 1, identityStableTime: 1,
    gatewayPauseGrace: 2, mediaLoadTimeout: 1000, directoryLoadTimeout: 1500,
    stallTimeout: 1000
  });
  return { c, f, keys, get clicks() { return clicks; }, get otherOpened() { return otherOpened; },
    get reloadAttempts() { return reloadAttempts; },
    async close() {
      await f.api.stop(false);
      await Promise.allSettled([f.api.state.jobPromise, f.api.state.syncPromise]);
      f.dom.window.close();
    }
  };
}

test('同一中断连续三次失败后本轮人工停止，保留资源断点且不刷新、不换项',
  { timeout: 12000 }, async () => {
    const s = failingCourse();
    try {
      const initial = await seedCoursePlaybackFixture(s.f);
      await waitFor(() => s.c.storage.session[KEY]?.phase === 'manual', 10000);
      const job = s.c.storage.session[KEY];
      const records = job.candidates[0].records;
      assert.equal(job.runId, initial.runId);
      assert.equal(job.running, false);
      assert.equal(job.interruption?.attempts, 3);
      assert.equal(job.interruption?.status, 'failed');
      assert.equal(s.reloadAttempts, 0);
      assert.equal(s.c.reloads.length, 0);
      assert.equal(s.c.navigation.length, 0);
      assert.equal(s.otherOpened, 0, 'A failed resource cannot silently move to another media item');
      assert.equal(records[s.keys[0]]?.ended, false);
      assert.equal(records[s.keys[0]]?.confirmed, false);
      assert.equal(records[s.keys[1]]?.ended, undefined);
      assert.equal(job.candidates[0].currentResource.key, s.keys[0]);
      const clicksAtStop = s.clicks;
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(s.clicks, clicksAtStop, 'No hidden course retry after the third failure');
    } finally { await s.close(); }
  });

test('用户在恢复等待中暂停，立即取消后续点击且不再自动重试',
  { timeout: 12000 }, async () => {
    const s = failingCourse();
    try {
      s.f.api.CFG.recoveryWaitMin = 300;
      s.f.api.CFG.recoveryWaitMax = 300;
      const initial = await seedCoursePlaybackFixture(s.f);
      await waitFor(() => s.c.storage.session[KEY]?.interruption?.attempts === 1, 9000);
      const clicksAtPause = s.clicks;
      await s.f.api.stop();
      await Promise.allSettled([s.f.api.state.jobPromise, s.f.api.state.syncPromise]);
      await new Promise(resolve => setTimeout(resolve, 350));
      const job = s.c.storage.session[KEY];
      assert.equal(job.runId, initial.runId);
      assert.equal(job.phase, 'paused');
      assert.equal(job.running, false);
      assert.equal(s.clicks, clicksAtPause);
      assert.equal(s.reloadAttempts, 0);
      assert.equal(s.otherOpened, 0);
    } finally { await s.close(); }
  });
