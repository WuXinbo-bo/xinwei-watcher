const assert = require('node:assert/strict');
const test = require('node:test');
const { coordinator } = require('./coordinator.cjs');

const KEY = 'xinwei-job-v3';
const COURSE = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course/video/res?classId=class';
const PROJECT = 'https://www.beeline-ai.com/student/#/courseInfo/course/project/class';
const routeKey = new URL(COURSE).pathname + new URL(COURSE).hash;
const auth = job => ({ runId: job.runId, generation: job.generation, resetEpoch: job.resetEpoch });
async function ok(c, id, instance, action, payload = {}) {
  const response = await c.request(id, instance, action, payload);
  assert.equal(response.ok, true, `${action}: ${response.error || 'unsuccessful response'}`);
  return response.job;
}
async function setup(options) {
  const c = coordinator(options);
  const id = c.addTab(COURSE);
  const page = { location: { href: COURSE } };
  c.connect(id)(page);
  let job = await ok(c, id, 'owner', 'start', { title: '课程' });
  job = await ok(c, id, 'owner', 'directory-checkpoint', { ...auth(job), snapshot: {
    version: 1, items: [{ key: 'video', title: '视频', mediaType: 'video', durationSeconds: 60 }]
  } });
  job = await ok(c, id, 'owner', 'resource-checkpoint', {
    ...auth(job), key: 'video', title: '视频', stage: 'ready', routeKey
  });
  return { c, id, page, job };
}
async function reload(s, instance = 'owner', extra = {}) {
  return ok(s.c, s.id, instance, 'interruption-attempt', {
    ...auth(s.job), episodeId: s.job.interruption?.id,
    key: 'video', navigate: true, reload: true, reason: '目录重新加载失败', ...extra
  });
}

test('恢复刷新只接受navigate:true及已保存ready资源的当前精确网址', async () => {
  for (const mode of ['no-navigation', 'different-resource', 'opening', 'pending-navigation']) {
    const s = await setup();
    if (mode === 'different-resource') s.c.tabs.get(s.id).url = COURSE.replace('/res?', '/other?');
    if (mode === 'opening') s.c.storage.session[KEY].candidates[0].currentResource.stage = 'opening';
    if (mode === 'pending-navigation') s.c.tabs.get(s.id).pendingUrl = PROJECT;
    const response = await s.c.request(s.id, 'owner', 'interruption-attempt', {
      ...auth(s.job), key: 'video', reload: true, navigate: mode !== 'no-navigation'
    });
    assert.equal(response.ok, false, mode);
    assert.equal(s.c.reloads.length, 0, mode);
    assert.equal(s.c.navigation.length, 0, mode);
    assert.equal(s.c.storage.session[KEY].interruption, undefined, mode);
  }
});

test('精确资源的独立参数名换序允许刷新，参数值和未知参数变化仍拒绝', async () => {
  const observed = `${COURSE}&courseResourceId=resource&tag=first&tag=second`;
  for (const change of ['reorder', 'value', 'extra', 'repeated-order']) {
    const s = await setup();
    s.c.tabs.get(s.id).url = observed;
    delete s.c.storage.session[KEY].candidates[0].currentResource;
    s.job = await ok(s.c, s.id, 'owner', 'resource-checkpoint', {
      ...auth(s.job), key: 'video', title: '视频', stage: 'ready',
      routeKey: new URL(observed).pathname + new URL(observed).hash
    });
    const reordered = COURSE.replace('?classId=class', '?tag=first&tag=second&courseResourceId=resource&classId=class');
    s.c.tabs.get(s.id).url = change === 'reorder' ? reordered
      : change === 'value' ? reordered.replace('courseResourceId=resource', 'courseResourceId=other')
        : change === 'extra' ? `${reordered}&unknown=1`
          : reordered.replace('tag=first&tag=second', 'tag=second&tag=first');
    const response = await s.c.request(s.id, 'owner', 'interruption-attempt', {
      ...auth(s.job), key: 'video', navigate: true, reload: true
    });
    assert.equal(response.ok, change === 'reorder', change);
    assert.equal(s.c.reloads.length, change === 'reorder' ? 1 : 0, change);
    assert.equal(s.c.navigation.length, 0, change);
  }
});

test('导航后目录失败使用同一episode的第二次刷新，必须新文档接回并共用三次上限', async () => {
  const s = await setup();
  s.c.tabs.get(s.id).url = PROJECT;
  s.job = await ok(s.c, s.id, 'owner', 'interruption-attempt', {
    ...auth(s.job), key: 'video', navigate: true, reason: '误触项目页'
  });
  const episodeId = s.job.interruption.id;
  assert.equal(s.job.interruption.attempts, 1);
  assert.equal(s.c.navigation.length, 1);
  // A same-document SPA arrival can claim ordinary navigation, but may not
  // claim the subsequent full-page reload even when its URL/key still match.
  s.job = await ok(s.c, s.id, 'owner', 'hello', {
    ...auth(s.job), title: '课程', documentRouteKey: routeKey, activeResourceKey: 'video'
  });
  assert.equal(s.job.ownerInstance, 'owner');
  s.job = await reload(s);
  assert.equal(s.job.interruption.id, episodeId);
  assert.equal(s.job.interruption.attempts, 2);
  assert.equal(s.job.interruption.requireNewDocument, true);
  assert.deepEqual(s.c.reloads, [s.id]);
  s.c.restartWorker();
  const old = await ok(s.c, s.id, 'owner', 'hello', {
    ...auth(s.job), title: '课程', documentRouteKey: routeKey, activeResourceKey: 'video'
  });
  assert.equal(old.ownerInstance, null);
  assert.equal(old.interruption.status, 'navigating');
  s.job = await ok(s.c, s.id, 'fresh', 'hello', { ...auth(old), title: '课程' });
  assert.equal(s.job.ownerInstance, 'fresh');
  assert.equal(s.job.interruption.attempts, 2);
  assert.equal(s.job.interruption.requireNewDocument, undefined);
  s.job = await reload(s, 'fresh');
  assert.equal(s.job.interruption.attempts, 3);
  assert.equal(s.c.reloads.length, 2);
  s.job = await ok(s.c, s.id, 'fresh-again', 'hello', { ...auth(s.job), title: '课程' });
  s.job = await ok(s.c, s.id, 'fresh-again', 'interruption-failed', {
    ...auth(s.job), episodeId, reason: '目录仍未完整'
  });
  assert.equal(s.job.phase, 'manual');
  assert.equal(s.job.running, false);
  assert.equal(s.job.interruption.attempts, 3);
  assert.equal(s.job.candidates[0].currentResource.key, 'video');
  const late = await s.c.request(s.id, 'fresh-again', 'interruption-attempt', {
    ...auth(s.job), episodeId, key: 'video', navigate: true, reload: true
  });
  assert.equal(late.ok, false);
  assert.equal(s.c.reloads.length, 2);
});

test('普通播放恢复第一次升级为精确页刷新不双扣，落地后再次刷新消耗下一次', async () => {
  const s = await setup();
  s.job = await ok(s.c, s.id, 'owner', 'interruption-attempt', {
    ...auth(s.job), key: 'video', reason: '播放未推进'
  });
  s.job = await reload(s);
  assert.equal(s.job.interruption.attempts, 1);
  s.job = await ok(s.c, s.id, 'fresh', 'hello', { ...auth(s.job), title: '课程' });
  s.job = await reload(s, 'fresh');
  assert.equal(s.job.interruption.attempts, 2);
  assert.equal(s.c.reloads.length, 2);
});

test('浏览器刷新API失败仍持久消耗次数，后台重启和超时最多三次后停止', async () => {
  let attemptedReloads = 0;
  const s = await setup({ beforeReload: async () => {
    attemptedReloads += 1;
    throw new Error('temporary browser error');
  } });
  s.job = await reload(s);
  const episodeId = s.job.interruption.id;
  for (const attempts of [1, 2, 3]) {
    assert.equal(s.job.interruption.attempts, attempts);
    assert.equal(s.job.interruption.id, episodeId);
    assert.equal(attemptedReloads, attempts);
    s.c.restartWorker();
    s.c.storage.session[KEY].interruption.deadline = Date.now() - 1;
    s.job = await ok(s.c, s.id, 'owner', 'get');
  }
  assert.equal(s.job.running, false);
  assert.equal(s.job.phase, 'manual');
  assert.equal(s.job.interruption.attempts, 3);
  assert.equal(attemptedReloads, 3);
  assert.equal(s.c.navigation.length, 0);
  assert.equal(s.c.storage.local[KEY].interruption.attempts, 3);
});

for (const cancellation of ['pause', 'reset', 'blocker']) {
  test(`刷新授权保存期间收到${cancellation}，刷新不能发出且旧页面不能恢复运行`, async () => {
    const s = await setup();
    let stopped;
    s.page.chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message.reset) respond({ resetEpoch: message.job.resetEpoch, stopped: true });
      if (message.job.interruption?.navigationMode === 'reload' && message.job.running && !stopped) {
        stopped = s.c.request(s.id, 'owner', cancellation === 'blocker' ? 'hello' : cancellation, {
          ...auth(s.job), ...(cancellation === 'blocker' ? { pageBlocked: '需要安全验证' } : {})
        });
      }
    });
    s.job = await reload(s);
    assert.ok(stopped);
    await stopped;
    const final = await ok(s.c, s.id, 'owner', 'get');
    assert.equal(final.running, false);
    assert.equal(final.phase, cancellation === 'pause' ? 'paused' : cancellation === 'reset' ? 'idle' : 'manual');
    assert.equal(s.c.reloads.length, 0);
    assert.equal(s.c.navigation.length, 0);
    const late = await s.c.request(s.id, 'owner', 'hello', {
      ...auth(s.job), title: '课程', documentRouteKey: routeKey, activeResourceKey: 'video'
    });
    if (cancellation === 'reset') assert.equal(late.error, 'TASK_CANCELLED');
    else assert.equal(late.job.running, false);
  });
}

test('刷新持久化期间实时网址改变时取消刷新，未确认登录页或待跳登录保留停止', async () => {
  for (const destination of [PROJECT, 'https://www.beeline-ai.com/login', 'pending-login']) {
    const s = await setup();
    s.page.chrome.runtime.onMessage.addListener(message => {
      if (message.job.interruption?.navigationMode === 'reload' && message.job.running) {
        if (destination === 'pending-login') s.c.tabs.get(s.id).pendingUrl = 'https://www.beeline-ai.com/login';
        else s.c.tabs.get(s.id).url = destination;
      }
    });
    s.job = await reload(s);
    assert.equal(s.c.reloads.length, 0);
    assert.equal(s.c.navigation.length, 0);
    assert.equal(s.job.interruption.attempts, 1);
    if (destination.endsWith('/login') || destination === 'pending-login') {
      assert.equal(s.job.running, false);
      assert.equal(s.job.phase, 'manual');
    }
  }
});

test('刷新交接期间再次误触其他课程页，超时用原导航返回而不刷新错误页面', async () => {
  const s = await setup({ beforeReload: async () => { throw new Error('temporary reload failure'); } });
  s.job = await reload(s);
  const episodeId = s.job.interruption.id;
  s.c.tabs.get(s.id).url = PROJECT;
  s.c.storage.session[KEY].interruption.deadline = Date.now() - 1;
  s.job = await ok(s.c, s.id, 'owner', 'get');
  assert.equal(s.job.interruption.id, episodeId);
  assert.equal(s.job.interruption.attempts, 2);
  assert.equal(s.job.interruption.navigationMode, 'navigate');
  assert.equal(s.c.reloads.length, 0);
  assert.equal(s.c.navigation.length, 1);
  assert.equal(s.c.navigation[0].url, COURSE);
});

test('验证提示随刷新请求上报时直接停止，不能耗用恢复预算尝试刷新', async () => {
  const s = await setup();
  s.job = await reload(s, 'owner', { pageBlocked: '请先重新登录' });
  assert.equal(s.job.running, false);
  assert.equal(s.job.phase, 'manual');
  assert.equal(s.job.interruption, undefined);
  assert.equal(s.c.reloads.length, 0);
});
