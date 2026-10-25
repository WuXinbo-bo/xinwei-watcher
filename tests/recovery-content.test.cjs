const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { fixture, mediaItem, waitFor } = require('./helpers.cjs');

function recoveryFixture(options = {}) {
  const f = fixture([mediaItem('恢复测试')], { duration: 60, confirmationTimeout: 10, ...options });
  const item = f.api.getMenuItems()[0];
  item.classList.add('is-active');
  f.api.state.running = true;
  Object.assign(f.api.CFG, {
    recoveryWaitMin: 0, recoveryWaitMax: 0, identityStableTime: 0,
    gatewayPauseGrace: 10, stallTimeout: 1000, mediaLoadTimeout: 30,
    resourceRetryDelay: 30, backgroundRetryDelay: 1
  });
  let seeking = false;
  Object.defineProperty(f.media, 'seeking', { get: () => seeking });
  const key = f.api.getItemKey(item);
  return {
    ...f, item, key,
    setSeeking(value) { seeking = value; },
    seek(to) {
      seeking = true;
      f.advanceNaturally(to);
      f.media.dispatchEvent(new f.window.Event('seeking'));
      seeking = false;
      f.media.dispatchEvent(new f.window.Event('seeked'));
    },
    async begin(wrapper = false) {
      this.task = (wrapper ? f.api.playItemWithRecovery : f.api.playItemToEnd)(item, 0, f.api.currentCourseKey());
      this.task.catch(() => {});
      await waitFor(() => !f.media.paused && f.api.state.processedItems.get(key)?.playbackAttempt?.after);
      f.media.dispatchEvent(new f.window.Event('playing'));
      f.advanceNaturally(10);
      await new Promise(resolve => setTimeout(resolve, 15));
    },
    finish() {
      item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
      f.advanceNaturally(60, true);
      f.media.dispatchEvent(new f.window.Event('ended'));
    }
  };
}

test('播放中的小幅位置校准与向后恢复继续观察，不把seek事件本身当人工停止', async () => {
  const f = recoveryFixture();
  try {
    await f.begin();
    f.seek(10.2);
    await new Promise(resolve => setTimeout(resolve, 15));
    f.seek(8);
    f.advanceNaturally(8.2);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(f.api.state.running, true);
    assert.equal(f.api.state.processedItems.get(f.key).progressGap, undefined);
    f.finish();
    const result = await f.task;
    assert.equal(result.ended, true);
    assert.equal(result.confirmed, true);
    assert.equal(result.playbackAttempt.seekAdjustments.length, 2);
    assert.equal(result.playbackAttempt.seekAdjustments.every(entry => !entry.jumpedForward), true);
  } finally { f.dom.window.close(); }
});

test('自然播放的时间推进不依赖测试时钟或稀疏轮询推断为跳进度', async () => {
  const f = recoveryFixture();
  try {
    await f.begin();
    // A background tab can be sampled infrequently. Without a seek event,
    // normal progression is not classified as a user changing the position.
    f.advanceNaturally(35);
    await new Promise(resolve => setTimeout(resolve, 10));
    f.finish();
    const result = await f.task;
    assert.equal(result.ended, true);
    assert.equal(result.progressGap, null);
  } finally { f.dom.window.close(); }
});

test('明显前跳保存缺口；后来ended和页面完成标记不能抹去缺口', async () => {
  const f = recoveryFixture();
  try {
    await f.begin();
    f.seek(40);
    await assert.rejects(f.task, error => error instanceof f.api.RecoverableError && error.kind === 'progress-gap');
    const record = f.api.state.processedItems.get(f.key);
    assert.ok(record.progressGap.from <= 10.1);
    assert.equal(record.progressGap.to, 40);
    assert.equal(record.ended, false);
    f.finish();
    assert.equal(f.api.state.processedItems.get(f.key).ended, false);
    f.api.state.resourceCheckpoint = null;
    const retry = f.api.playItemToEnd(f.item, 0, f.api.currentCourseKey());
    await assert.rejects(retry, /未确认的播放区间/);
    assert.equal(f.api.state.processedItems.get(f.key).progressGap.to, 40);
  } finally { f.dom.window.close(); }
});

test('网站自行回到缺口前并自然覆盖后才允许清除缺口', async () => {
  const f = recoveryFixture({ duration: 1 });
  try {
    f.api.state.processedItems.set(f.key, {
      title: '恢复测试', started: true, ended: false, confirmed: false,
      progressGap: { from: 0.05, to: 0.1 }
    });
    f.api.CFG.seekTolerance = 0.01;
    const task = f.api.playItemToEnd(f.item, 0, f.api.currentCourseKey());
    task.catch(() => {});
    await waitFor(() => !f.media.paused);
    f.media.dispatchEvent(new f.window.Event('playing'));
    for (let i = 1; i <= 6; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      f.advanceNaturally(i * 0.025);
    }
    f.item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
    f.advanceNaturally(1, true);
    f.media.dispatchEvent(new f.window.Event('ended'));
    const result = await task;
    assert.equal(result.progressGap, null);
    assert.equal(result.ended, true);
  } finally { f.dom.window.close(); }
});

test('普通网站暂停无需网关证据也能重新点击可见播放按钮并继续', async () => {
  const f = recoveryFixture();
  try {
    const button = f.window.document.querySelector('.vjs-big-play-button');
    let clicks = 0, apiPlays = 0;
    button.addEventListener('click', () => { clicks += 1; });
    f.media.play = () => { apiPlays += 1; throw new Error('不允许调用媒体play'); };
    await f.begin(true);
    f.media.pause();
    f.media.dispatchEvent(new f.window.Event('pause'));
    await waitFor(() => clicks === 2 && !f.media.paused);
    f.media.dispatchEvent(new f.window.Event('playing'));
    f.advanceNaturally(11);
    f.finish();
    const result = await f.task;
    assert.equal(result.confirmed, true);
    assert.equal(result.recovery.attempts, 1);
    assert.equal(apiPlays, 0);
  } finally { f.dom.window.close(); }
});

test('单页普通播放失败最多三次恢复后报错并保留断点，不再刷新或暂缓', async () => {
  const f = recoveryFixture();
  try {
    f.api.CFG.stallTimeout = 10;
    const button = f.window.document.querySelector('.vjs-big-play-button');
    const inert = button.cloneNode(true);
    inert.getClientRects = () => [{ width: 1, height: 1 }];
    button.replaceWith(inert);
    let clicks = 0;
    inert.addEventListener('click', () => { clicks += 1; });
    const task = f.api.playItemWithRecovery(f.item, 0, f.api.currentCourseKey());
    await assert.rejects(task, error => {
      assert.equal(error instanceof f.api.DeferredResource, false);
      assert.match(error.message, /三次|3次|恢复/);
      return true;
    });
    const record = f.api.state.processedItems.get(f.key);
    assert.equal(record.recovery.attempts, 3);
    assert.equal(record.recovery.nextRetryAt, 0);
    assert.equal(record.recovery.reloads || 0, 0);
    assert.equal(record.ended, false);
    assert.equal(record.confirmed, false);
    assert.equal(clicks, 4, 'initial try plus three recovery tries');
    assert.equal(f.api.state.reloadPending, false);
    assert.equal(f.api.state.resourceCheckpoint.key, f.key);
  } finally { f.dom.window.close(); }
});

test('恢复等待期间用户暂停立即取消后续播放点击', async () => {
  const f = recoveryFixture();
  try {
    f.api.CFG.recoveryWaitMin = 200;
    f.api.CFG.recoveryWaitMax = 200;
    let clicks = 0;
    f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { clicks += 1; });
    await f.begin(true);
    f.media.pause();
    f.media.dispatchEvent(new f.window.Event('pause'));
    await waitFor(() => f.api.state.processedItems.get(f.key)?.recovery?.attempts === 1);
    await f.api.stop();
    await assert.rejects(f.task, error => error.constructor.name === 'TaskCancelled');
    assert.equal(clicks, 1);
    assert.equal(f.media.paused, true);
  } finally { f.dom.window.close(); }
});

test('验证码仍会立即停止，不进入普通恢复', async () => {
  const f = recoveryFixture();
  try {
    await f.begin(true);
    const notice = f.window.document.createElement('div');
    notice.textContent = '请完成安全验证';
    f.window.document.body.append(notice);
    f.media.pause();
    f.media.dispatchEvent(new f.window.Event('pause'));
    await assert.rejects(f.task, error => error.constructor.name === 'TaskCancelled');
    assert.equal(f.api.state.mode, 'manual');
    assert.equal(f.api.state.processedItems.get(f.key)?.recovery?.attempts, undefined);
  } finally { f.dom.window.close(); }
});

test('已扫描的未完成课程仍按剩余媒体项最少优先选择', () => {
  const f = recoveryFixture();
  try {
    const choices = [
      { title: '较长课程', status: 'inspected', remaining: 10 },
      { title: '较短课程', status: 'inspected', remaining: 1 }
    ];
    assert.equal(f.api.chooseLowestRemaining(choices).candidate.title, '较短课程');
    choices[1].status = 'completed';
    assert.equal(f.api.chooseLowestRemaining(choices).candidate.title, '较长课程');
    choices[0].status = 'completed';
    assert.equal(f.api.chooseLowestRemaining(choices), null);
  } finally { f.dom.window.close(); }
});

test('短暂后台读取失败会重连；诊断日志失败不会停止任务', async () => {
  let failGet = false, getTries = 0;
  const f = recoveryFixture({ chrome: { runtime: { sendMessage: async message => {
    if (message.action === 'get' && failGet) {
      getTries += 1;
      if (getTries < 3) throw new Error('message port closed');
    }
    if (message.action === 'log') throw new Error('log not saved');
    return { ok: true, job: null, tabId: 1 };
  } } } });
  try {
    failGet = true;
    await f.api.jobCommand('get');
    assert.equal(getTries, 3);
    assert.equal(f.api.state.storageFailed, false);
  } finally { f.dom.window.close(); }
});

test('实现仍不写进度、不改倍速、不调用媒体播放API、不合成结束', () => {
  const code = fs.readFileSync('content.js', 'utf8');
  assert.doesNotMatch(code, /\.currentTime\s*=(?!=)/);
  assert.doesNotMatch(code, /\.playbackRate\s*=(?!=)/);
  assert.doesNotMatch(code, /\.play\s*\(/);
  assert.doesNotMatch(code, /dispatchEvent\s*\([^;]*(?:ended|seeked)/);
});

for (const status of [401, 403]) {
  test(`精确网站上报返回${status}保留停止，不能按普通暂停自动点击恢复`, async () => {
    const f = recoveryFixture();
    try {
      const entries = [];
      Object.defineProperty(f.window.performance, 'getEntriesByType', { value: () => entries });
      let clicks = 0;
      f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { clicks += 1; });
      await f.begin(true);
      const now = Date.now();
      entries.push({
        name: 'https://www.beeline-ai.com/api/learning-service/admin/studentLearning/videoLearnProcessReport',
        responseStatus: status, initiatorType: 'fetch',
        startTime: now - 2 - f.window.performance.timeOrigin,
        responseEnd: now - f.window.performance.timeOrigin
      });
      f.media.pause();
      f.media.dispatchEvent(new f.window.Event('pause'));
      await assert.rejects(f.task, /登录或权限已受限制/);
      assert.equal(clicks, 1);
      assert.equal(f.api.state.processedItems.get(f.key)?.recovery?.attempts, undefined);
    } finally { f.dom.window.close(); }
  });
}

test('同资源媒体节点重建后重新绑定，保留正常播放，不操作旧播放器', async () => {
  const f = recoveryFixture();
  try {
    let pauses = 0;
    const oldPause = f.media.pause;
    f.media.pause = () => { pauses += 1; oldPause(); };
    await f.begin(true);
    const replacement = f.window.document.createElement('video');
    let current = 10, ended = false;
    Object.defineProperties(replacement, {
      readyState: { get: () => 4 }, duration: { get: () => 60 },
      currentTime: { get: () => current }, paused: { get: () => ended }, ended: { get: () => ended },
      currentSrc: { get: () => f.media.currentSrc }, playbackRate: { get: () => 1 }
    });
    replacement.pause = () => { pauses += 1; };
    f.media.replaceWith(replacement);
    await waitFor(() => f.api.state.processedItems.get(f.key)?.recovery?.attempts === 1);
    await waitFor(() => f.api.state.processedItems.get(f.key)?.playbackAttempt?.before?.currentTime === 10);
    current = 11;
    await new Promise(resolve => setTimeout(resolve, 20));
    replacement.dispatchEvent(new f.window.Event('playing'));
    f.item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
    current = 60; ended = true;
    replacement.dispatchEvent(new f.window.Event('ended'));
    const result = await f.task;
    assert.equal(result.ended, true);
    assert.equal(result.confirmed, true);
    assert.equal(pauses, 0);
  } finally { f.dom.window.close(); }
});

test('播放器重建的长等待不能当作已观看，暂停的新节点前跳仍保留缺口', async () => {
  const f = recoveryFixture();
  try {
    await f.begin(true);
    let offset = 0;
    const originalNow = f.window.Date.now.bind(f.window.Date);
    f.window.Date.now = () => originalNow() + offset;
    f.api.CFG.recoveryWaitMin = 50;
    f.api.CFG.recoveryWaitMax = 50;
    f.api.CFG.mediaLoadTimeout = 20000;
    const player = f.media.parentElement;
    f.media.remove();
    await waitFor(() => f.api.state.processedItems.get(f.key)?.recovery?.attempts === 1);
    offset += 15000;
    const replacement = f.window.document.createElement('video');
    Object.defineProperties(replacement, {
      readyState: { get: () => 4 }, duration: { get: () => 60 },
      currentTime: { get: () => 20 }, paused: { get: () => true }, ended: { get: () => false },
      currentSrc: { get: () => f.media.currentSrc }, playbackRate: { get: () => 1 }
    });
    replacement.pause = () => {};
    player.append(replacement);
    await waitFor(() => f.api.state.processedItems.get(f.key)?.progressGap?.to === 20);
    const record = f.api.state.processedItems.get(f.key);
    assert.ok(record.progressGap.from <= 10.1);
    assert.equal(record.ended, false);
    assert.equal(record.confirmed, false);
    await f.api.stop();
    await assert.rejects(f.task, error => error.constructor.name === 'TaskCancelled');
  } finally { f.dom.window.close(); }
});

test('恢复手势中网站已自行播放时跳过最终点击，避免再次暂停', async () => {
  const f = recoveryFixture();
  try {
    const button = f.window.document.querySelector('.vjs-big-play-button');
    let clicks = 0, presses = 0;
    button.addEventListener('click', () => { clicks += 1; });
    button.addEventListener('mousedown', () => {
      presses += 1;
      if (presses === 2) {
        // This is the fake website restoring normal playback, not extension API use.
        f.media.play();
        f.window.document.querySelector('.video-js').classList.remove('vjs-paused');
        f.media.dispatchEvent(new f.window.Event('playing'));
      }
    });
    await f.begin(true);
    f.media.pause();
    f.media.dispatchEvent(new f.window.Event('pause'));
    await waitFor(() => presses === 2);
    await new Promise(resolve => setTimeout(resolve, 200));
    f.finish();
    await f.task;
    assert.equal(clicks, 1);
  } finally { f.dom.window.close(); }
});

test('暂停消息携带尚未保存的前跳缺口，暂停仍立即生效', async () => {
  const messages = [];
  const f = recoveryFixture({ chrome: { runtime: { sendMessage: async message => {
    messages.push(message);
    return { ok: true, job: null, tabId: 1 };
  } } } });
  try {
    f.api.state.resourceCheckpoint = { key: f.key, routeKey: f.window.location.pathname + f.window.location.hash };
    f.api.state.processedItems.set(f.key, { progressGap: { from: 10, to: 40 } });
    await f.api.jobCommand('pause');
    const pause = messages.find(message => message.action === 'pause');
    assert.deepEqual(JSON.parse(JSON.stringify(pause.gapEvidence)), {
      key: f.key, from: 10, to: 40, round: 0, courseKey: f.api.currentCourseKey()
    });
  } finally { f.dom.window.close(); }
});

for (const completesSeek of [true, false]) {
  test(`seeking等待${completesSeek ? '结束' : '超时'}不计为观看时长，前跳缺口立即保留`, async () => {
    const f = recoveryFixture();
    try {
      await f.begin();
      const realNow = f.window.Date.now;
      let offset = 0;
      f.window.Date.now = () => realNow() + offset;
      f.api.CFG.mediaLoadTimeout = 20000;
      // Start from a normal 10s observation; the website seek jumps to 20s.
      // A long seek wait must not justify this forward jump.
      f.advanceNaturally(20);
      f.setSeeking(true);
      f.media.dispatchEvent(new f.window.Event('seeking'));
      offset = completesSeek ? 10000 : 25000;
      if (completesSeek) {
        f.setSeeking(false);
        f.media.dispatchEvent(new f.window.Event('seeked'));
      }
      await assert.rejects(f.task, error => error instanceof f.api.RecoverableError && error.kind === 'progress-gap');
      const gap = f.api.state.processedItems.get(f.key).progressGap;
      assert.ok(gap.from <= 10.1);
      assert.equal(gap.to, 20);
      assert.equal(f.api.state.processedItems.get(f.key).ended, false);
    } finally { f.dom.window.close(); }
  });
}
