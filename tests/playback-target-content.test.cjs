const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, mediaItem, homeFixture, homeCard, waitFor } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');

const KEY = 'xinwei-job-v3';
const TARGET_KEY = 'wb-playback-target';
const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const COURSE = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';

function appendProgress(f, parent, text = '已观看 80%', options = {}) {
  const progress = f.window.document.createElement('div');
  progress.className = options.className || 'video-progress';
  progress.textContent = text;
  progress.getClientRects = () => [{ width: 100, height: 20 }];
  if (options.hidden) progress.style.display = 'none';
  parent.append(progress);
  return progress;
}

function targetFixture(options = {}) {
  const f = fixture(options.items || [mediaItem('目标比例视频', 'video', 'unStart', '01 分 40 秒')], {
    duration: 100, confirmationTimeout: 5, ...options
  });
  const items = f.api.getMenuItems();
  items[0].classList.add('is-active');
  f.api.state.running = true;
  Object.assign(f.api.CFG, {
    recoveryWaitMin: 0, recoveryWaitMax: 0, identityStableTime: 0,
    gatewayPauseGrace: 5, stallTimeout: 2000, mediaLoadTimeout: 30,
    resourceRetryDelay: 1, backgroundRetryDelay: 1
  });
  return { ...f, items, item: items[0], key: f.api.getItemKey(items[0]) };
}

async function begin(f, options = {}) {
  const task = f.api.playItemToEnd(f.item, f.api.state.epoch, f.api.currentCourseKey(), {
    singlePass: true, ...options
  });
  task.catch(() => {});
  await waitFor(() => !f.media.paused && f.api.state.processedItems.get(f.key)?.playbackAttempt?.after);
  f.media.dispatchEvent(new f.window.Event('playing'));
  return { task };
}

function dispose(f) {
  if (!f) return;
  f.api.state.running = false;
  f.api.state.epoch += 1;
  f.dom.window.close();
}

test('播放比例默认100，输入仅允许80至100，越界值归一化后保存', async () => {
  const storage = {};
  const f = targetFixture({ chrome: {
    runtime: { sendMessage: async () => ({ ok: true, job: null, tabId: 1 }) },
    storage: { local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(values) { Object.assign(storage, values); }
    } }
  } });
  try {
    await f.api.state.playbackTargetReady;
    const input = f.window.document.getElementById('wb-playback-target');
    assert.equal(f.api.getPlaybackTarget(), 100);
    assert.equal(input.value, '100');
    assert.equal(input.min, '80');
    assert.equal(input.max, '100');
    assert.equal(input.step, '1');
    for (const value of [undefined, null, '', ' ', NaN, Infinity, 'n/a']) {
      assert.equal(f.api.normalizePlaybackTarget(value), 100);
    }
    assert.equal(f.api.normalizePlaybackTarget(79), 80);
    assert.equal(f.api.normalizePlaybackTarget(101), 100);
    assert.equal(f.api.normalizePlaybackTarget('85'), 85);
    input.value = '75';
    input.dispatchEvent(new f.window.Event('change', { bubbles: true }));
    await f.api.state.playbackTargetWrites;
    assert.equal(f.api.getPlaybackTarget(), 80);
    assert.equal(input.value, '80');
    assert.equal(storage[TARGET_KEY], 80);
  } finally { dispose(f); }
});

test('保存的有效比例跨文档读取，损坏或越界设置恢复默认100', async () => {
  for (const [saved, expected] of [[80, 80], [93, 93], [100, 100], [79, 100], [101, 100], ['80', 100]]) {
    const f = targetFixture({ chrome: {
      runtime: { sendMessage: async () => ({ ok: true, job: null, tabId: 1 }) },
      storage: { local: {
        async get(key) { return { [key]: saved }; },
        async set() {}
      } }
    } });
    try {
      await f.api.state.playbackTargetReady;
      assert.equal(f.api.getPlaybackTarget(), expected);
      assert.equal(f.window.document.getElementById('wb-playback-target').value, String(expected));
    } finally { dispose(f); }
  }
});

test('公开开始发送单遍任务与用户比例，未配置时保留100默认值', async () => {
  for (const target of [undefined, 80, 91]) {
    const c = coordinator();
    const id = c.addTab(HOME);
    const f = homeFixture([homeCard('待学课程')], { connect: c.connect(id) });
    try {
      await f.api.state.playbackTargetReady;
      if (target != null) await f.api.savePlaybackTarget(target);
      f.window.document.getElementById('wb-start').click();
      await waitFor(() => c.storage.session[KEY]?.running);
      assert.equal(c.storage.session[KEY].singlePass, true);
      assert.equal(c.storage.session[KEY].targetPercent, target ?? 100);
      assert.equal(c.storage.session[KEY].scope, 'all');
    } finally { dispose(f); }
  }
});

test('完成百分比只读取当前资源可见的播放器或目录行，不取全页和其他视频', () => {
  const f = targetFixture({ items: [mediaItem('当前视频'), mediaItem('另一个视频')] });
  try {
    appendProgress(f, f.window.document.body, '已观看 100%', { className: 'course-progress' });
    appendProgress(f, f.items[1], '已观看 99%');
    appendProgress(f, f.window.document.getElementById('wb-study-ui'), '已观看 100%');
    const player = f.window.document.querySelector('.video-js');
    const hidden = appendProgress(f, player, '已观看 100%', { hidden: true });
    assert.equal(f.api.parseProgressText(f.item), null);
    assert.equal(f.api.getResourceCompletion(f.item).confirmed, false);
    hidden.remove();
    const progress = appendProgress(f, player, '已观看 81.5%');
    assert.equal(f.api.parseProgressText(f.item), 0.815);
    assert.equal(f.api.getResourceCompletion(f.item).sitePercent, 81.5);
    assert.equal(f.api.getResourceCompletion(f.item).confirmed, true);
    progress.remove();
    appendProgress(f, f.item, '已观看 79%');
    assert.equal(f.api.parseProgressText(f.item), 0.79);
    assert.equal(f.api.getResourceCompletion(f.item).confirmed, false);
  } finally { dispose(f); }
});

test('当前播放器进度不能替另一个目录视频确认完成，隐藏祖先下的进度也不采用', () => {
  const f = targetFixture({ items: [mediaItem('当前视频'), mediaItem('未播放视频')] });
  try {
    const player = f.window.document.querySelector('.video-js');
    appendProgress(f, player, '已观看 97%');
    assert.equal(f.api.parseProgressText(f.items[1]), null);
    assert.equal(f.api.getResourceCompletion(f.items[1]).confirmed, false);
    player.style.display = 'none';
    assert.equal(f.api.parseProgressText(f.item), null);
    assert.equal(f.api.getResourceCompletion(f.item).confirmed, false);
  } finally { dispose(f); }
});

test('比例识别要求已观看标签，拒绝越界和不合法百分比，80边界按平台完成处理', () => {
  const f = targetFixture();
  try {
    const progress = appendProgress(f, f.item, '');
    for (const text of ['97%', '课程完成 97%', '已观看 -1%', '已观看 101%', '已观看 NaN%']) {
      progress.textContent = text;
      assert.equal(f.api.parseProgressText(f.item), null, text);
      assert.equal(f.api.getResourceCompletion(f.item).confirmed, false, text);
    }
    progress.textContent = '已观看 79.9%';
    assert.equal(f.api.getResourceCompletion(f.item).confirmed, false);
    progress.textContent = '已观看 80%';
    const completion = f.api.getResourceCompletion(f.item);
    assert.equal(completion.confirmed, true);
    assert.equal(completion.sitePercent, 80);
    assert.equal(completion.source, 'site-progress');
    progress.remove();
    f.item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
    assert.equal(f.api.getResourceCompletion(f.item).confirmed, true);
    assert.equal(f.api.getResourceCompletion(f.item).source, 'page-marker');
  } finally { dispose(f); }
});

test('选择80目标自然播放到比例就返回，不伪造ended、不写播放器时间', async () => {
  const f = targetFixture();
  try {
    const { task } = await begin(f, { targetPercent: 80 });
    f.advanceNaturally(79);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.notEqual(f.api.state.processedItems.get(f.key)?.targetReached, true);
    assert.equal(f.media.ended, false);
    f.advanceNaturally(80);
    f.media.dispatchEvent(new f.window.Event('timeupdate'));
    const result = await task;
    assert.equal(result.targetReached, true);
    assert.equal(result.effectiveTarget, 80);
    assert.equal(result.ended, false);
    assert.notEqual(result.confirmed, true, 'local playback target is not platform evidence');
    assert.equal(f.media.currentTime, 80);
    assert.equal(f.media.ended, false);
    assert.equal(f.api.state.processedItems.get(f.key).ended, false);
    assert.equal(result.playbackAttempt.events.some(event => event.type === 'ended'), false);
  } finally { dispose(f); }
});

test('单遍默认100即使页面80已完成也继续正常播放，结束后保留真实结束证据', async () => {
  const f = targetFixture();
  try {
    const { task } = await begin(f);
    appendProgress(f, f.item, '已观看 80%');
    let returned = false;
    task.then(() => { returned = true; });
    f.advanceNaturally(80);
    f.media.dispatchEvent(new f.window.Event('timeupdate'));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(returned, false);
    assert.equal(f.api.state.processedItems.get(f.key).ended, false);
    f.item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
    f.advanceNaturally(100, true);
    f.media.dispatchEvent(new f.window.Event('ended'));
    const result = await task;
    assert.equal(result.ended, true);
    assert.equal(result.confirmed, false, 'platform status is checked after the whole course is processed');
    assert.equal(result.effectiveTarget, 100);
  } finally { dispose(f); }
});

test('播放器97百分比同时报错时按页面达标成功，不把媒体错误弹框当用户暂停', async () => {
  const f = targetFixture();
  try {
    const player = f.window.document.querySelector('.video-js');
    appendProgress(f, player, '已观看 97%');
    const dialog = f.window.document.createElement('div');
    dialog.className = 'vjs-modal-dialog vjs-error-display';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.textContent = '无法播放媒体：由于视频文件损坏或是该视频使用了你的浏览器不支持的功能，播放终止。';
    dialog.getClientRects = () => [{ width: 300, height: 100 }];
    player.append(dialog);
    Object.defineProperty(f.media, 'error', { get: () => ({ code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' }) });
    const result = await f.api.playItemToEnd(f.item, f.api.state.epoch, f.api.currentCourseKey(), {
      singlePass: true, targetPercent: 100
    });
    assert.equal(result.confirmed, true);
    assert.equal(result.sitePercent, 97);
    assert.equal(result.ended, false);
    assert.equal(f.media.ended, false);
    assert.equal(f.api.state.running, true);
  } finally { dispose(f); }
});

async function sharedTargetFixture(options = {}) {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const messages = [];
  const f = targetFixture({
    ...options,
    connect(window) {
      c.connect(id)(window);
      const send = window.chrome.runtime.sendMessage;
      window.chrome.runtime.sendMessage = message => {
        messages.push(JSON.parse(JSON.stringify(message)));
        return send(message);
      };
    }
  });
  // A direct resource test owns the executor; automatic initialization must
  // not launch a second runner against the same simulated document.
  f.api.state.jobPromise = Promise.resolve();
  const job = await f.api.jobCommand('start', {
    title: '测试课程', scope: 'single', singlePass: true, targetPercent: 80
  });
  f.api.state.activeGeneration = job.generation;
  f.api.state.running = true;
  f.api.state.processedCourseKey = f.api.currentCourseKey();
  await f.api.jobCommand('directory-checkpoint', { snapshot: f.api.getDirectorySnapshot() });
  return { ...f, c, id, messages };
}

test('当前正常播放从100降到80后立即按新目标收尾并保存有效目标', async () => {
  const f = targetFixture();
  try {
    const { task } = await begin(f, { targetPercent: 100 });
    f.advanceNaturally(85);
    await f.api.savePlaybackTarget(80);
    const result = await task;
    assert.equal(result.effectiveTarget, 80);
    assert.equal(result.targetReached, true);
    assert.equal(result.ended, false);
    assert.equal(result.confirmed, false);
    assert.equal(f.media.currentTime, 85);
    assert.equal(f.api.state.activePlaybackTarget, null);
  } finally { dispose(f); }
});

test('当前正常播放从80提高到95后不会在旧目标结束', async () => {
  const f = targetFixture();
  try {
    const { task } = await begin(f, { targetPercent: 80 });
    let finished = false; task.then(() => { finished = true; });
    await f.api.savePlaybackTarget(95);
    await waitFor(() => f.api.state.processedItems.get(f.key)?.effectiveTarget === 95);
    f.advanceNaturally(85); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(finished, false);
    f.advanceNaturally(95);
    assert.equal((await task).effectiveTarget, 95);
  } finally { dispose(f); }
});

test('强制100重试不随普通目标下降，结束后保留真实100目标', async () => {
  const f = targetFixture();
  try {
    const { task } = await begin(f, { targetPercent: 100, forceTarget: true });
    let finished = false; task.then(() => { finished = true; });
    await f.api.savePlaybackTarget(80);f.advanceNaturally(85);
    await new Promise(resolve => setTimeout(resolve, 20));assert.equal(finished, false);
    assert.equal(f.api.state.activePlaybackTarget.forced, true);
    f.advanceNaturally(100, true);f.media.dispatchEvent(new f.window.Event('ended'));
    const result = await task;assert.equal(result.effectiveTarget,100);assert.equal(result.ended,true);
  } finally { dispose(f); }
});

test('达到目标进入收尾后提高设置不重新打开当前资源', async () => {
  const f = targetFixture();
  try {
    f.api.CFG.cooldownMin = f.api.CFG.cooldownMax = 60;
    const { task } = await begin(f, {targetPercent:80});
    f.advanceNaturally(80);
    await waitFor(() => f.api.state.activePlaybackTarget?.settled);
    await f.api.savePlaybackTarget(95);
    assert.equal((await task).effectiveTarget,80);
    assert.equal(f.api.getPlaybackTarget(),95);
  } finally {dispose(f);}
});

test('共享任务的运行中目标变更写入后台断点且不变更所有者或代次', async () => {
  const f = await sharedTargetFixture();
  try {
    const { task } = await begin(f, {targetPercent:100});
    const generation = f.api.state.job.generation;
    await f.api.savePlaybackTarget(90);
    await waitFor(() => f.c.storage.session[KEY].candidates[0].records[f.key]?.effectiveTarget === 90);
    f.advanceNaturally(90);assert.equal((await task).effectiveTarget,90);
    const job = f.c.storage.session[KEY];
    assert.equal(job.generation,generation);assert.equal(job.ownerTabId,f.id);assert.equal(job.running,true);
    assert.equal(f.c.storage.local[KEY].candidates[0].records[f.key].effectiveTarget,90);
  } finally {dispose(f);}
});

test('跨标签页目标读取延迟时等待新目标，不误按旧80目标收尾', async () => {
  let changed, release, reads=0;
  const f=targetFixture({chrome:{runtime:{sendMessage:async()=>({ok:true,job:null,tabId:1})},storage:{
    local:{get:async key=>key!=='wb-playback-target'?{}:++reads===1?{'wb-playback-target':80}:await new Promise(resolve=>{release=resolve;}),set:async()=>{}},
    onChanged:{addListener:listener=>{changed=listener;}}
  }}});
  try {
    await f.api.state.playbackTargetReady;
    const {task}=await begin(f,{targetPercent:80});
    let finished=false;task.then(()=>{finished=true;});
    changed({'wb-playback-target':{oldValue:80,newValue:95}},'local');
    await waitFor(()=>release);f.advanceNaturally(85);
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(finished,false);
    release({'wb-playback-target':95});
    await waitFor(()=>f.api.state.processedItems.get(f.key)?.effectiveTarget===95);
    assert.equal(finished,false);f.advanceNaturally(95);
    assert.equal((await task).effectiveTarget,95);
  } finally {release?.({'wb-playback-target':95});dispose(f);}
});

test('低于80的坏视频课程收尾最多重试三次后暂缓，不伪报完成或停止整轮', async () => {
  const f = await sharedTargetFixture();
  try {
    appendProgress(f, f.item, '已观看 79%');
    Object.defineProperty(f.media, 'error', { get: () => ({ code: 3, message: 'decode failed' }) });
    f.item.addEventListener('click', () => {
      f.item.classList.add('is-active');
      f.media.dispatchEvent(new f.window.Event('loadedmetadata'));
    });
    await assert.rejects(
      f.api.playSinglePassItem(f.item, f.api.state.epoch, f.api.currentCourseKey(), { phase: 'final' }),
      error => error instanceof f.api.DeferredResource
    );
    const job = f.c.storage.session[KEY];
    const record = job.candidates[0].records[f.key];
    assert.equal(record.finalAttempts, 3);
    assert.equal(record.deferred, true);
    assert.equal(record.ended, false);
    assert.equal(record.confirmed, false);
    assert.equal(job.running, true);
    assert.equal(job.phase, 'course');
    assert.equal(f.messages.filter(message => message.action === 'resource-retry' && message.phase === 'final').length, 3);
  } finally { dispose(f); }
});

test('播放器因加载缓慢始终未出现时保留三次重试和暂缓，只在记录及日志建议人工检查', async () => {
  const f = await sharedTargetFixture();
  try {
    f.media.remove();
    await assert.rejects(
      f.api.playSinglePassItem(f.item, f.api.state.epoch, f.api.currentCourseKey(), { phase: 'final' }),
      error => error instanceof f.api.DeferredResource &&
        /网络缓慢或播放器尚未就绪，建议人工检查/.test(error.message)
    );
    const job = f.c.storage.session[KEY];
    const record = job.candidates[0].records[f.key];
    assert.equal(record.finalAttempts, 3);
    assert.equal(record.deferred, true);
    assert.equal(record.ended, false);
    assert.equal(record.confirmed, false);
    assert.equal(job.running, true);
    assert.equal(job.phase, 'course');
    assert.match(record.error, /网络缓慢或播放器尚未就绪，建议人工检查/);
    assert.match(f.api.state.logBox.textContent, /网络缓慢或播放器尚未就绪，建议人工检查/);
    assert.equal(f.messages.filter(message => message.action === 'resource-retry' && message.phase === 'final').length, 3);
  } finally { dispose(f); }
});

test('课程末重试清除旧待处理状态后才能保存新的播放观察', async () => {
  const f = await sharedTargetFixture();
  try {
    const stale = {
      title: '测试视频', attempted: true, confirmed: false,
      ended: true, targetReached: true, deferred: true, error: '上一轮播放器异常'
    };
    await f.api.jobCommand('record', { key: f.key, result: stale });
    f.api.state.processedItems.set(f.key, stale);
    f.item.addEventListener('click', () => {
      f.item.classList.add('is-active');
      f.advanceNaturally(0);
      f.media.play();
      f.media.dispatchEvent(new f.window.Event('loadedmetadata'));
    });

    const task = f.api.playSinglePassItem(
      f.item, f.api.state.epoch, f.api.currentCourseKey(), { phase: 'final' }
    );
    await waitFor(() => f.c.storage.session[KEY]?.candidates[0]?.currentResource?.stage === 'ready');
    assert.equal(f.c.storage.session[KEY].candidates[0].records[f.key].deferred, false);

    f.item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
    f.advanceNaturally(60);
    f.media.dispatchEvent(new f.window.Event('timeupdate'));
    const result = await task;
    assert.equal(result.confirmed, true);
    assert.equal(result.completionSource, 'page-marker');
    assert.equal(f.c.storage.session[KEY].candidates[0].records[f.key].finalAttempts, 1);
  } finally { dispose(f); }
});

test('用户脚本暂停优先于收尾重试，保存暂停后不再点击播放或消耗下一次预算', async () => {
  const f = await sharedTargetFixture();
  try {
    f.api.CFG.recoveryWaitMin = f.api.CFG.recoveryWaitMax = 200;
    appendProgress(f, f.item, '已观看 79%');
    Object.defineProperty(f.media, 'error', { get: () => ({ code: 3, message: 'decode failed' }) });
    let playClicks = 0;
    f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { playClicks += 1; });
    f.item.addEventListener('click', () => {
      f.item.classList.add('is-active');
      f.media.dispatchEvent(new f.window.Event('loadedmetadata'));
    });
    const task = f.api.playSinglePassItem(f.item, f.api.state.epoch, f.api.currentCourseKey(), { phase: 'final' });
    task.catch(() => {});
    await waitFor(() => f.c.storage.session[KEY]?.candidates[0]?.records[f.key]?.finalAttempts === 1);
    const clicksBeforePause = playClicks;
    await f.api.stop();
    await assert.rejects(task, error => error.constructor.name === 'TaskCancelled');
    assert.equal(f.c.storage.session[KEY].phase, 'paused');
    assert.equal(f.c.storage.session[KEY].running, false);
    assert.equal(f.c.storage.session[KEY].candidates[0].records[f.key].finalAttempts, 1);
    assert.equal(playClicks, clicksBeforePause);
    assert.equal(f.media.paused, true);
  } finally { dispose(f); }
});
