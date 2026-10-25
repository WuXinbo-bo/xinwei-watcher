const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, mediaItem, waitFor } = require('./helpers.cjs');

const REPORT = 'https://www.beeline-ai.com/api/learning-service/admin/studentLearning/videoLearnProcessReport';
const recoverable = (f, kind) => error => {
  assert.ok(error instanceof f.api.RecoverableError, 'ordinary playback failures must reach the recovery wrapper');
  if (kind) assert.equal(error.kind, kind);
  return true;
};
const blocked = (f, message) => error => {
  assert.equal(error instanceof f.api.RecoverableError, false, 'platform restrictions must not auto-retry');
  assert.notEqual(error.constructor.name, 'TaskCancelled');
  assert.match(error.message, message);
  return true;
};

// Resource Timing and player behavior are supplied by this fake website.
// No test proves that the real browser grants playback permission or that an
// HTTP 2xx response means the platform has accepted learning progress.
function gatewayFixture(options = {}) {
  const f = fixture([mediaItem('网关测试视频')], { confirmationTimeout: 50, ...options });
  const item = f.api.getMenuItems()[0];
  const key = f.api.getItemKey(item);
  const button = f.window.document.querySelector('.vjs-big-play-button');
  const entries = [];
  const clicks = [];
  let playCalls = 0;
  item.classList.add('is-active');
  f.api.state.running = true;
  Object.assign(f.api.CFG, {
    gatewayPauseGrace: 0,
    gatewayRetryDelayMin: 0,
    gatewayRetryDelayMax: 0,
    gatewayRecoveryTimeout: 40,
    gatewayRetryLimit: 1
  });
  Object.defineProperty(f.window.performance, 'getEntriesByType', {
    value: type => type === 'resource' ? entries.slice() : []
  });
  f.media.play = async () => { playCalls += 1; };
  button.addEventListener('click', () => {
    clicks.push({ at: Date.now(), position: f.media.currentTime });
  });
  const result = {
    ...f, item, key, button, entries, clicks,
    get attempt() { return f.api.state.processedItems.get(key)?.playbackAttempt; },
    get playCalls() { return playCalls; },
    report(status, timing = {}) {
      const now = Date.now();
      const startAt = timing.startAt ?? now - 1;
      const endAt = timing.endAt ?? now;
      const raw = {
        name: timing.name ?? REPORT,
        responseStatus: status,
        initiatorType: timing.initiatorType ?? 'fetch',
        startTime: startAt - f.window.performance.timeOrigin,
        responseEnd: endAt - f.window.performance.timeOrigin
      };
      entries.push(raw);
      return raw;
    },
    pauseFromWebsite() {
      f.media.pause();
      f.media.dispatchEvent(new f.window.Event('pause'));
    },
    async begin({ advance = true } = {}) {
      result.task = f.api.playItemToEnd(item, f.api.state.epoch, f.api.currentCourseKey());
      // Keep negative scenarios from producing an unhandled rejection before
      // their assertion is attached. They still assert the original promise.
      result.task.catch(() => {});
      await waitFor(() => result.attempt && clicks.length === 1 && !f.media.paused);
      if (advance) {
        f.advanceNaturally(10);
        f.media.dispatchEvent(new f.window.Event('playing'));
        await waitFor(() => f.api.state.logBox.textContent.includes('正在正常播放'));
      }
    },
    finishFromWebsite({ confirmed = true } = {}) {
      if (confirmed) item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
      f.advanceNaturally(60, true);
      f.media.dispatchEvent(new f.window.Event('ended'));
    }
  };
  return result;
}

function normalized(f, status, timing) {
  return f.api.getReportTiming(f.report(status, timing));
}

function showDialog(f, attributes = { role: 'dialog' }) {
  const dialog = f.window.document.createElement('div');
  for (const [key, value] of Object.entries(attributes)) dialog.setAttribute(key, value);
  dialog.textContent = '请先处理页面中的问题';
  dialog.getClientRects = () => [{ width: 20, height: 20 }];
  f.window.document.body.append(dialog);
  return dialog;
}

function capturePlayerInputs(f) {
  const callbacks = new Map();
  const document = f.window.document;
  const original = document.addEventListener.bind(document);
  document.addEventListener = (type, callback, options) => {
    if (['pointerdown', 'click', 'keydown'].includes(type) && options?.capture) callbacks.set(type, callback);
    original(type, callback, options);
  };
  return (type, target = f.button) => {
    const callback = callbacks.get(type);
    assert.ok(callback, 'the product must observe this player input');
    // A plain argument exercises the captured listener. It does not manufacture
    // a trusted DOM event, browser activation or an actual player interaction.
    callback({ type, target, isTrusted: true });
  };
}

function respondAfterRetry(f, { advance = true, status = 200 } = {}) {
  f.button.addEventListener('click', () => {
    if (f.clicks.length !== 2) return;
    const startAt = Date.now();
    f.window.setTimeout(() => {
      f.report(status, { startAt, endAt: Date.now() });
      if (advance) f.advanceNaturally(20);
    }, 3);
  });
}

test('仅识别网站自己的精确上报入口和有效 Resource Timing，不保存网址', () => {
  const f = gatewayFixture();
  try {
    const endAt = Date.now();
    const entry = normalized(f, 502, { startAt: endAt - 10, endAt });
    assert.equal(entry.status, 502);
    assert.ok(Math.abs(entry.startAt - (endAt - 10)) < 0.01);
    assert.ok(Math.abs(entry.endAt - endAt) < 0.01);
    assert.equal(Object.hasOwn(entry, 'name'), false);
    assert.equal(Object.hasOwn(entry, 'url'), false);
    for (const timing of [
      { name: REPORT.replace('www.beeline-ai.com', 'other.example') },
      { name: REPORT.replace('https:', 'http:') },
      { name: REPORT.replace('https://', 'https://user:secret@') },
      { name: `${REPORT}/other` },
      { name: REPORT.replace('videoLearnProcessReport', 'videoLearnProcess') },
      { initiatorType: 'img' },
      { startAt: endAt, endAt: endAt }
    ]) {
      assert.equal(normalized(f, 502, timing), null);
    }
    assert.equal(f.api.getReportTiming({ name: 'not an absolute URL' }), null);
  } finally { f.dom.window.close(); }
});

test('失败必须属于当前资源、在原始 pause 前两秒内；最新响应决定是否恢复', () => {
  const f = gatewayFixture();
  try {
    const startedAt = 10000, pauseAt = 20000;
    const failure = { status: 502, startAt: 18000, endAt: 19500 };
    assert.equal(f.api.gatewayFailureForPause([failure], pauseAt, startedAt), failure);
    assert.equal(f.api.gatewayFailureForPause([{ ...failure, status: 503 }], pauseAt, startedAt).status, 503);
    assert.equal(f.api.gatewayFailureForPause([{ ...failure, status: 504 }], pauseAt, startedAt).status, 504);
    for (const entry of [
      { ...failure, startAt: startedAt - 1 },
      { ...failure, endAt: pauseAt - 2001 },
      { ...failure, endAt: pauseAt + 1 },
      ...[200, 403, 500, 0].map(status => ({ ...failure, status }))
    ]) {
      assert.equal(f.api.gatewayFailureForPause([entry], pauseAt, startedAt), null);
    }
    const newerSuccess = { status: 200, startAt: 19510, endAt: 19900 };
    assert.equal(f.api.gatewayFailureForPause([newerSuccess, failure], pauseAt, startedAt), null);
    assert.equal(f.api.gatewayFailureForPause([failure], 0, startedAt), null);
  } finally { f.dom.window.close(); }
});

test('可见网站弹窗、题目和覆盖层阻止恢复；隐藏节点及助手自己的提示不参与', () => {
  const f = gatewayFixture();
  try {
    for (const attributes of [
      { role: 'dialog' }, { 'aria-modal': 'true' }, { class: 'el-overlay' }, { id: 'popupDomId' }
    ]) {
      const element = showDialog(f, attributes);
      assert.equal(f.api.getPlaybackBlockingDialog(), element);
      element.style.display = 'none';
      assert.equal(f.api.getPlaybackBlockingDialog(), null);
      element.remove();
    }
    const own = showDialog(f);
    f.window.document.getElementById('wb-study-ui').append(own);
    assert.equal(f.api.getPlaybackBlockingDialog(), null);
  } finally { f.dom.window.close(); }
});

test('网站保留的零高度空题目容器不构成待处理提示', () => {
  const f = gatewayFixture();
  try {
    const placeholder = f.window.document.createElement('div');
    placeholder.className = 'popup-question-dialog';
    placeholder.id = 'popupDomId';
    placeholder.innerHTML = '<div class="popup-question"><div class="preview-image-container"><!----></div></div>';
    for (const element of [placeholder, ...placeholder.querySelectorAll('*')]) {
      element.getClientRects = () => [{ width: 736, height: 0 }];
    }
    f.window.document.body.append(placeholder);
    assert.equal(placeholder.textContent, '');
    assert.equal(f.api.getPlaybackBlockingDialog(), null);
  } finally { f.dom.window.close(); }
});

test('零高度题目容器中的可见正面积内容仍阻止恢复，隐藏内容不参与', () => {
  const f = gatewayFixture();
  try {
    const placeholder = f.window.document.createElement('div');
    placeholder.className = 'popup-question-dialog';
    placeholder.id = 'popupDomId';
    placeholder.getClientRects = () => [{ width: 736, height: 0 }];
    const question = f.window.document.createElement('div');
    question.className = 'popup-question';
    question.textContent = '请先完成页面验证';
    question.getClientRects = () => [{ width: 736, height: 180 }];
    placeholder.append(question);
    f.window.document.body.append(placeholder);
    assert.equal(f.api.getPlaybackBlockingDialog(), placeholder);
    question.style.display = 'none';
    assert.equal(f.api.getPlaybackBlockingDialog(), null);
    question.style.display = '';
    placeholder.style.visibility = 'hidden';
    assert.equal(f.api.getPlaybackBlockingDialog(), null);
  } finally { f.dom.window.close(); }
});

test('可信播放器点击、指针和键盘操作才算人工介入，脚本自己的合成点击不算', () => {
  const f = gatewayFixture();
  try {
    for (const type of ['pointerdown', 'click', 'keydown']) {
      assert.equal(f.api.trustedPlayerInput({ isTrusted: true, type, target: f.button }, f.media), true);
      assert.equal(f.api.trustedPlayerInput({ isTrusted: false, type, target: f.button }, f.media), false);
    }
    assert.equal(f.api.trustedPlayerInput({
      isTrusted: true, type: 'click', target: f.window.document.body
    }, f.media), false);
    assert.equal(f.api.trustedPlayerInput({ isTrusted: true, type: 'mousemove', target: f.button }, f.media), false);
    f.button.focus();
    assert.equal(f.api.trustedPlayerInput({
      isTrusted: true, type: 'keydown', target: f.window.document.body
    }, f.media), true);
  } finally { f.dom.window.close(); }
});

for (const status of [502, 503, 504]) {
  test(`当前资源上报 ${status} 后原始暂停，只点一次可见按钮；仍需自然结束和页面确认`, async () => {
    const f = gatewayFixture();
    try {
      respondAfterRetry(f);
      await f.begin();
      let resolved = false;
      f.task.then(() => { resolved = true; }).catch(() => {});
      f.report(status);
      f.pauseFromWebsite();
      await waitFor(() => f.attempt?.recoveries[0]?.outcome === 'transport-restored');
      assert.equal(f.clicks.length, 2);
      assert.equal(f.clicks[1].position, 10, 'the recovery click must keep the original position');
      assert.equal(f.playCalls, 0);
      assert.equal(f.attempt.recoveries.length, 1);
      assert.equal(f.attempt.recoveries[0].failure.status, status);
      assert.equal(f.attempt.recoveries[0].transport.status, 200);
      assert.equal(f.api.state.processedItems.get(f.key).ended, false);
      assert.equal(f.api.state.processedItems.get(f.key).confirmed, false);
      f.item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
      assert.equal(resolved, false, 'a page marker does not end media that is still playing');
      f.finishFromWebsite();
      const result = await f.task;
      assert.equal(result.ended, true);
      assert.equal(result.confirmed, true);
      assert.equal(result.playbackAttempt.recoveries[0].outcome, 'transport-restored');
      assert.equal(f.api.state.playedCount, 1);
    } finally { f.dom.window.close(); }
  });
}

for (const [label, status, timing] of [
  ['HTTP200、业务含义未知', 200, {}],
  ['HTTP500', 500, {}],
  ['HTTP403', 403, {}],
  ['状态为零', 0, {}],
  ['状态不可读取', undefined, {}],
  ['其他接口', 502, { name: REPORT.replace('videoLearnProcessReport', 'otherEndpoint') }],
  ['其他网站', 502, { name: REPORT.replace('www.beeline-ai.com', 'other.example') }]
]) {
  test(`${label} 后暂停不套用502专用恢复；仅权限限制阻断其他恢复`, async () => {
    const f = gatewayFixture();
    try {
      await f.begin();
      const rejected = assert.rejects(f.task, status === 403
        ? blocked(f, /登录或权限/) : recoverable(f, 'playback'));
      f.report(status, timing);
      f.pauseFromWebsite();
      await rejected;
      assert.equal(f.clicks.length, 1);
      assert.equal(f.attempt.recoveries.length, 0);
      assert.equal(f.api.state.processedItems.get(f.key).ended, false);
      assert.equal(f.api.state.playedCount, 0);
    } finally { f.dom.window.close(); }
  });
}

test('旧失败和资源开始前发出的请求不得借当前 pause 获得恢复资格', async () => {
  for (const label of ['旧响应', '旧请求']) {
    const f = gatewayFixture();
    try {
      const beforeResource = Date.now() - 100;
      await f.begin();
      const rejected = assert.rejects(f.task, recoverable(f, 'playback'));
      if (label === '旧响应') f.report(502, { startAt: Date.now() - 3000, endAt: Date.now() - 2500 });
      else f.report(502, { startAt: beforeResource, endAt: Date.now() });
      f.pauseFromWebsite();
      await rejected;
      assert.equal(f.clicks.length, 1);
      assert.equal(f.attempt.recoveries.length, 0);
    } finally { f.dom.window.close(); }
  }
});

test('较新的HTTP200使旧502失去关联；普通暂停交给恢复层重新识别', async () => {
  const f = gatewayFixture();
  try {
    await f.begin();
    const now = Date.now();
    f.report(502, { startAt: now - 20, endAt: now - 10 });
    f.report(200, { startAt: now - 9, endAt: now });
    const rejected = assert.rejects(f.task, recoverable(f, 'playback'));
    f.pauseFromWebsite();
    await rejected;
    assert.equal(f.clicks.length, 1);
    assert.equal(f.attempt.recoveries.length, 0);
  } finally { f.dom.window.close(); }
});

test('从未实际推进的媒体不能借502绕过首次播放阻塞', async () => {
  const f = gatewayFixture();
  try {
    await f.begin({ advance: false });
    const rejected = assert.rejects(f.task, recoverable(f, 'playback'));
    f.report(502);
    f.pauseFromWebsite();
    await rejected;
    assert.equal(f.clicks.length, 1);
    assert.equal(f.attempt.recoveries.length, 0);
  } finally { f.dom.window.close(); }
});

for (const missing of ['媒体推进', '后续网站2xx']) {
  test(`恢复点击后缺少${missing}，交给恢复层重试且不伪造完成`, async () => {
    const f = gatewayFixture();
    try {
      if (missing === '媒体推进') respondAfterRetry(f, { advance: false });
      else f.button.addEventListener('click', () => {
        if (f.clicks.length === 2) f.advanceNaturally(20);
      });
      await f.begin();
      const rejected = assert.rejects(f.task, recoverable(f, 'playback'));
      f.report(502);
      f.pauseFromWebsite();
      await rejected;
      assert.equal(f.clicks.length, 2);
      assert.equal(f.attempt.recoveries[0].outcome, 'awaiting-website-report');
      assert.equal(f.api.state.processedItems.get(f.key).ended, false);
      assert.equal(f.api.state.processedItems.get(f.key).confirmed, false);
      assert.equal(f.api.state.playedCount, 0);
    } finally { f.dom.window.close(); }
  });
}

test('恢复后自然结束但网站未恢复上报：保留真实结束记录，超时不返回课程完成结果', async () => {
  const f = gatewayFixture();
  try {
    f.button.addEventListener('click', () => {
      if (f.clicks.length === 2) f.finishFromWebsite();
    });
    await f.begin();
    const rejected = assert.rejects(f.task, recoverable(f, 'playback'));
    f.report(502);
    f.pauseFromWebsite();
    await rejected;
    assert.equal(f.media.ended, true);
    assert.equal(f.api.isPageCompletedItem(f.item), true);
    const record = f.api.state.processedItems.get(f.key);
    assert.equal(record.ended, true, 'network failure must not erase an actual natural end');
    assert.equal(record.confirmed, false, 'a failed recovery must retain the separate platform check');
    assert.equal(record.playbackAttempt.finished.currentTime, 60);
    assert.equal(record.playbackAttempt.recoveries[0].outcome, 'awaiting-website-report');
    assert.equal(f.api.state.playedCount, 1);
  } finally { f.dom.window.close(); }
});

test('专用网关恢复次数保留；预算用完交给外层重识别而非重复套用同一证据', async () => {
  const f = gatewayFixture();
  try {
    f.api.state.processedItems.set(f.key, {
      title: '网关测试视频', started: true, ended: false, confirmed: false,
      playbackAttempt: { recoveries: [{ pauseAt: 1, outcome: 'waiting' }] }
    });
    await f.begin();
    const rejected = assert.rejects(f.task, recoverable(f, 'playback'));
    f.report(502);
    f.pauseFromWebsite();
    await rejected;
    assert.equal(f.clicks.length, 1);
    assert.equal(f.attempt.recoveries.length, 1);
    assert.equal(f.attempt.recoveries[0].pauseAt, 1);
  } finally { f.dom.window.close(); }
});

test('重新进入资源后没有播放按钮，初始记录仍保留已用恢复预算', async () => {
  const f = gatewayFixture();
  try {
    f.api.state.processedItems.set(f.key, {
      title: '网关测试视频', started: true, ended: false, confirmed: false,
      playbackAttempt: { recoveries: [{ pauseAt: 1, outcome: 'waiting' }] }
    });
    f.button.remove();
    await assert.rejects(f.api.playItemToEnd(f.item, 0, f.api.currentCourseKey()), recoverable(f, 'button'));
    assert.equal(f.attempt.recoveries.length, 1);
    assert.equal(f.attempt.recoveries[0].pauseAt, 1);
    assert.equal(f.clicks.length, 0);
    assert.equal(f.api.state.processedItems.get(f.key).ended, false);
  } finally { f.dom.window.close(); }
});

test('第二次网关暂停交给外层重新识别，当前尝试不连续重复点击', async () => {
  const f = gatewayFixture();
  try {
    respondAfterRetry(f);
    await f.begin();
    f.report(502);
    f.pauseFromWebsite();
    await waitFor(() => f.attempt?.recoveries[0]?.outcome === 'transport-restored');
    const rejected = assert.rejects(f.task, recoverable(f, 'playback'));
    f.report(503);
    f.pauseFromWebsite();
    await rejected;
    assert.equal(f.clicks.length, 2);
    assert.equal(f.attempt.recoveries.length, 1);
    assert.equal(f.api.state.processedItems.get(f.key).ended, false);
  } finally { f.dom.window.close(); }
});

for (const intervention of ['pointerdown', 'keydown']) {
  test(`可信${intervention}不会永久暂停任务，同资源普通暂停仍可正常恢复`, async () => {
    const f = gatewayFixture();
    const invokeInput = capturePlayerInputs(f);
    try {
      respondAfterRetry(f);
      await f.begin();
      invokeInput(intervention);
      f.report(502);
      f.pauseFromWebsite();
      await waitFor(() => f.attempt?.recoveries[0]?.outcome === 'transport-restored');
      assert.equal(f.clicks.length, 2);
      assert.equal(f.attempt.recoveries.length, 1);
      assert.equal(f.api.state.processedItems.get(f.key).ended, false);
      f.finishFromWebsite();
      const result = await f.task;
      assert.equal(result.ended, true);
      assert.equal(result.confirmed, true);
    } finally { f.dom.window.close(); }
  });
}

test('网站可见题目提示出现后，即使502关联也停止且保留提示', async () => {
  const f = gatewayFixture();
  try {
    await f.begin();
    const dialog = showDialog(f, { id: 'popupDomId' });
    const rejected = assert.rejects(f.task, blocked(f, /网站显示需要处理的提示/));
    f.report(502);
    f.pauseFromWebsite();
    await rejected;
    assert.equal(f.clicks.length, 1);
    assert.equal(f.attempt.recoveries.length, 0);
    assert.equal(dialog.isConnected, true);
  } finally { f.dom.window.close(); }
});

test('恢复等待中点击暂停取消后续手势与第二次播放点击，预算仍保留', async () => {
  const f = gatewayFixture();
  try {
    f.api.CFG.gatewayRetryDelayMin = f.api.CFG.gatewayRetryDelayMax = 100;
    await f.begin();
    const rejected = assert.rejects(f.task, error => error.constructor.name === 'TaskCancelled');
    f.report(502);
    f.pauseFromWebsite();
    await waitFor(() => f.attempt?.recoveries[0]?.outcome === 'waiting');
    await f.api.stop(false);
    await rejected;
    assert.equal(f.clicks.length, 1);
    assert.equal(f.media.paused, true);
    assert.equal(f.api.state.running, false);
    assert.equal(f.attempt.recoveries.length, 1);
  } finally { f.dom.window.close(); }
});

test('恢复点击手势期间出现弹窗，最后一次检查阻止最终点击', async () => {
  const f = gatewayFixture();
  try {
    await f.begin();
    f.button.addEventListener('mousedown', () => showDialog(f));
    const rejected = assert.rejects(f.task, blocked(f, /网站显示需要处理的提示/));
    f.report(502);
    f.pauseFromWebsite();
    await rejected;
    assert.equal(f.clicks.length, 1);
    assert.equal(f.attempt.recoveries.length, 1);
    assert.equal(f.attempt.recoveries[0].clicked, undefined);
  } finally { f.dom.window.close(); }
});

test('恢复点击手势期间网站自行继续播放，不能再点按钮把它暂停', async () => {
  const f = gatewayFixture();
  try {
    respondAfterRetry(f);
    await f.begin();
    f.button.addEventListener('mousedown', () => {
      // This is the fake website resuming on its own, not the extension calling
      // a media API. Its own play handler supplies the state change.
      f.button.dispatchEvent(new f.window.Event('click'));
    }, { once: true });
    f.report(502);
    f.pauseFromWebsite();
    await waitFor(() => f.attempt?.recoveries[0]?.outcome === 'transport-restored');
    assert.equal(f.clicks.length, 2, 'one initial click plus the fake website resume event');
    assert.equal(f.attempt.recoveries.length, 1);
    assert.equal(f.attempt.recoveries[0].clicked, false, 'the pending extension click must be skipped');
    assert.equal(f.playCalls, 0);
    f.finishFromWebsite();
    const result = await f.task;
    assert.equal(result.ended, true);
    assert.equal(result.confirmed, true);
  } finally { f.dom.window.close(); }
});

for (const status of [403, 500, 0]) {
  test(`恢复等待出现新的上报${status}但无新pause，拒绝按旧502继续点击`, async () => {
    const f = gatewayFixture();
    try {
      f.api.CFG.gatewayRetryDelayMin = f.api.CFG.gatewayRetryDelayMax = 100;
      await f.begin();
      const rejected = assert.rejects(f.task, status === 403
        ? blocked(f, /登录或权限/) : recoverable(f, 'playback'));
      f.report(502);
      f.pauseFromWebsite();
      await waitFor(() => f.attempt?.recoveries[0]?.outcome === 'waiting');
      f.report(status);
      await rejected;
      assert.equal(f.clicks.length, 1);
      assert.equal(f.attempt.recoveries.length, 1);
    } finally { f.dom.window.close(); }
  });
}

test('恢复冷却中403紧接HTTP200，较新成功也不能掩盖错误后继续点击', async () => {
  const f = gatewayFixture();
  try {
    f.api.CFG.gatewayRetryDelayMin = f.api.CFG.gatewayRetryDelayMax = 100;
    await f.begin();
    const rejected = assert.rejects(f.task, blocked(f, /登录或权限/));
    f.report(502);
    f.pauseFromWebsite();
    await waitFor(() => f.attempt?.recoveries[0]?.outcome === 'waiting');
    const now = Date.now();
    // Both responses arrive before the next guard: latest-only logic must not
    // erase the intervening permission failure when it sees the newer success.
    f.report(403, { startAt: now - 2, endAt: now - 1 });
    f.report(200, { startAt: now - 1, endAt: now });
    await rejected;
    assert.equal(f.clicks.length, 1);
    assert.equal(f.attempt.recoveries[0].outcome, 'waiting');
    assert.equal(f.attempt.recoveries[0].clicked, undefined);
    assert.equal(f.api.state.processedItems.get(f.key).ended, false);
  } finally { f.dom.window.close(); }
});

test('恢复点击后500或未知状态紧接HTTP200，同次轮询仍停止且不标记上报恢复', async () => {
  for (const status of [500, 0]) {
    const f = gatewayFixture();
    try {
      f.button.addEventListener('click', () => {
        if (f.clicks.length !== 2) return;
        const startAt = Date.now();
        f.window.setTimeout(() => {
          const now = Date.now();
          // Supply both responses synchronously and advance the fake player:
          // even a newer 200 and actual playback cannot undo this new failure.
          f.report(status, { startAt, endAt: now - 1 });
          f.report(200, { startAt, endAt: now });
          f.advanceNaturally(20);
        }, 3);
      });
      await f.begin();
      const rejected = assert.rejects(f.task, recoverable(f, 'playback'));
      f.report(502);
      f.pauseFromWebsite();
      await rejected;
      assert.equal(f.clicks.length, 2);
      assert.equal(f.attempt.recoveries[0].outcome, 'awaiting-website-report');
      assert.equal(f.attempt.recoveries[0].transport, undefined);
      assert.equal(f.api.state.processedItems.get(f.key).ended, false);
      assert.equal(f.api.state.processedItems.get(f.key).confirmed, false);
    } finally { f.dom.window.close(); }
  }
});

test('恢复等待中又出现新pause，不能把第二次暂停当作原事件继续恢复', async () => {
  const f = gatewayFixture();
  try {
    f.api.CFG.gatewayRetryDelayMin = f.api.CFG.gatewayRetryDelayMax = 100;
    await f.begin();
    const rejected = assert.rejects(f.task, recoverable(f, 'playback'));
    f.report(502);
    f.pauseFromWebsite();
    await waitFor(() => f.attempt?.recoveries[0]?.outcome === 'waiting');
    await new Promise(resolve => setTimeout(resolve, 5));
    f.pauseFromWebsite();
    await rejected;
    assert.equal(f.clicks.length, 1);
    assert.equal(f.attempt.recoveries.length, 1);
  } finally { f.dom.window.close(); }
});

test('网关等待中媒体DOM正在重建时交给恢复层重识别，不操作旧节点', async () => {
  const f = gatewayFixture();
  try {
    f.api.CFG.gatewayRetryDelayMin = f.api.CFG.gatewayRetryDelayMax = 100;
    await f.begin();
    const rejected = assert.rejects(f.task, recoverable(f, 'identity'));
    f.report(502);
    f.pauseFromWebsite();
    await waitFor(() => f.attempt?.recoveries[0]?.outcome === 'waiting');
    f.media.replaceWith(f.window.document.createElement('video'));
    await rejected;
    assert.equal(f.media.isConnected, false);
    assert.equal(f.clicks.length, 1);
    assert.equal(f.attempt.stopped.connected, false);
    assert.equal(f.api.state.processedItems.get(f.key).ended, false);
  } finally { f.dom.window.close(); }
});

test('同一路由和来源的选中样式短暂消失后恢复，不误判真实资源切换', async () => {
  const f = gatewayFixture();
  try {
    respondAfterRetry(f);
    f.api.CFG.gatewayRetryDelayMin = f.api.CFG.gatewayRetryDelayMax = 100;
    await f.begin();
    f.report(502);
    f.pauseFromWebsite();
    await waitFor(() => f.attempt?.recoveries[0]?.outcome === 'waiting');
    f.item.classList.remove('is-active');
    // Let the DOM observer see the departure before the website returns.
    await Promise.resolve();
    f.item.classList.add('is-active');
    await waitFor(() => f.attempt?.recoveries[0]?.outcome === 'transport-restored');
    assert.equal(f.item.classList.contains('is-active'), true);
    assert.equal(f.clicks.length, 2);
    assert.equal(f.attempt.recoveries.length, 1);
    f.finishFromWebsite();
    const result = await f.task;
    assert.equal(result.ended, true);
    assert.equal(result.confirmed, true);
  } finally { f.dom.window.close(); }
});

test('误切资源路由后再返回交给恢复层核对，不能套用旧502恢复或接受新资源', async () => {
  const f = gatewayFixture();
  try {
    f.api.CFG.gatewayRetryDelayMin = f.api.CFG.gatewayRetryDelayMax = 100;
    await f.begin();
    const rejected = assert.rejects(f.task, error => {
      assert.ok(error instanceof f.api.RecoverableError);
      assert.ok(['navigation', 'identity'].includes(error.kind));
      assert.match(error.message, /页面切换了资源/);
      return true;
    });
    f.report(502);
    f.pauseFromWebsite();
    await waitFor(() => f.attempt?.recoveries[0]?.outcome === 'waiting');
    const original = f.window.location.href;
    const changed = original.replace('/video/resource-1?', '/video/resource-other?');
    f.window.dispatchEvent(new f.window.HashChangeEvent('hashchange', { oldURL: original, newURL: changed }));
    f.window.dispatchEvent(new f.window.HashChangeEvent('hashchange', { oldURL: changed, newURL: original }));
    await rejected;
    assert.equal(f.clicks.length, 1);
    assert.equal(f.api.state.processedItems.get(f.key).ended, false);
    assert.equal(f.api.state.processedItems.get(f.key).confirmed, false);
  } finally { f.dom.window.close(); }
});

test('重建后的播放器来源不同交给身份恢复，不能静默当作原资源播放', async () => {
  const f = gatewayFixture();
  try {
    f.api.CFG.gatewayRetryDelayMin = f.api.CFG.gatewayRetryDelayMax = 100;
    await f.begin();
    const rejected = assert.rejects(f.task, error => {
      assert.ok(error instanceof f.api.RecoverableError);
      assert.ok(['source', 'navigation'].includes(error.kind));
      assert.match(error.message, /媒体来源已改变/);
      return true;
    });
    f.report(502);
    f.pauseFromWebsite();
    await waitFor(() => f.attempt?.recoveries[0]?.outcome === 'waiting');
    const otherMedia = f.window.document.createElement('video');
    Object.defineProperty(otherMedia, 'currentSrc', { value: 'https://media.example.test/other-resource' });
    f.media.replaceWith(otherMedia);
    await rejected;
    assert.equal(f.clicks.length, 1);
    assert.equal(f.api.state.processedItems.get(f.key).ended, false);
    assert.equal(f.api.state.processedItems.get(f.key).confirmed, false);
  } finally { f.dom.window.close(); }
});
