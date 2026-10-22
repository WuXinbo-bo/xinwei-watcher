const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const LEARN = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course/video/resource?classId=class';
const KEY = 'xinwei-job-v3';
const routeKey = value => { const url = new URL(value); return `${url.pathname}${url.hash}`; };
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const auth = job => ({ runId: job.runId, generation: job.generation, resetEpoch: job.resetEpoch });

// This harness exposes storage/reload boundaries to test cancellation and
// persistence failures without contacting the learning site.
function harness() {
  let listener;
  const tabs = new Map([[1, { id: 1, url: LEARN }]]);
  const storage = { session: {}, local: {} };
  const reloads = [];
  const removals = [];
  const navigation = [];
  const hooks = {};
  const event = () => {
    let listener;
    return { addListener(fn) { listener = fn; }, fire(...args) { listener?.(...args); } };
  };
  const onCreated = event();
  const onRemoved = event();
  const area = name => ({
    async get(key) {
      if (hooks.read) await hooks.read(name, key);
      return { [key]: clone(storage[name][key]) };
    },
    async set(values) {
      if (hooks.write) await hooks.write(name, clone(values));
      Object.assign(storage[name], clone(values));
    }
  });
  const chrome = {
    storage: { local: area('local'), session: area('session') },
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    tabs: {
      onCreated, onRemoved,
      async get(id) {
        if (hooks.getTab) await hooks.getTab(id);
        if (!tabs.has(id)) throw new Error('Tab closed');
        return clone(tabs.get(id));
      },
      async update(id, values) {
        if (hooks.update) await hooks.update(id, clone(values));
        Object.assign(tabs.get(id), values);
        navigation.push({ id, ...values });
        return clone(tabs.get(id));
      },
      async reload(id) {
        reloads.push(id);
        if (hooks.reload) await hooks.reload(id);
      },
      async query() { return [...tabs.values()].map(clone); },
      async sendMessage(id, message) {
        if (hooks.broadcast) await hooks.broadcast(id, clone(message));
        if (message.reset) return { resetEpoch: message.job.resetEpoch, stopped: true };
      },
      async remove(id) {
        if (hooks.remove) await hooks.remove(id);
        removals.push(id);
        tabs.delete(id);
        onRemoved.fire(id);
      }
    }
  };
  const boot = () => vm.runInNewContext(fs.readFileSync('background.js', 'utf8'),
    { chrome, crypto, URL, URLSearchParams, Date, console, setTimeout, clearTimeout });
  boot();
  const request = (action, payload = {}, instanceId = 'page', id = 1) => new Promise(resolve => {
    listener({ channel: 'xinwei-job', action, instanceId, ...clone(payload) },
      { tab: { id }, frameId: 0, url: tabs.get(id)?.url || LEARN }, resolve);
  });
  return { request, storage, reloads, navigation, hooks, tabs, boot, removals, onCreated };
}

async function prepared() {
  const c = harness();
  let r = await c.request('start', { title: '课程' });
  r = await c.request('directory-checkpoint', {
    ...auth(r.job), snapshot: { version: 1, items: [
      { key: 'video', title: '视频', mediaType: 'video', durationSeconds: 60 },
      { key: 'audio', title: '音频', mediaType: 'audio', durationSeconds: 30 }
    ] }
  });
  r = await c.request('resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(LEARN)
  });
  r = await c.request('record', {
    ...auth(r.job), key: 'video', result: {
      title: '视频', started: true, ended: false, confirmed: false,
      progressGap: { from: 15, to: 35 },
      recovery: { attempts: 2, reloads: 0, nextRetryAt: 0, lastReason: '缓冲', round: 0 }
    }
  });
  assert.equal(r.ok, true);
  return { c, job: r.job };
}

const reloadPayload = job => ({ ...auth(job), key: 'video', routeKey: routeKey(LEARN), reason: '无法正常续播', round: 0 });

test('普通刷新先保存同课资源预算，重启后台及刷新接管均不能重复花费', async () => {
  const { c, job } = await prepared();
  const r = await c.request('reload-course', reloadPayload(job));
  assert.equal(r.ok, true);
  assert.deepEqual(c.reloads, [1]);
  assert.equal(r.job.candidates[0].records.video.recovery.reloads, 1);
  assert.equal(c.storage.local[KEY].candidates[0].records.video.recovery.reloads, 1);
  assert.equal(r.job.candidates[0].currentResource.key, 'video');
  c.boot();
  const hello = await c.request('hello', { title: '课程' }, 'refreshed');
  assert.equal(hello.job.generation, job.generation + 1);
  const repeat = await c.request('reload-course', reloadPayload(hello.job), 'refreshed');
  assert.equal(repeat.ok, false);
  assert.match(repeat.error, /本轮已刷新/);
  assert.deepEqual(c.reloads, [1]);
});

test('旧记录及伪造新round不能清空后台已用刷新预算', async () => {
  const { c, job } = await prepared();
  let r = await c.request('reload-course', reloadPayload(job));
  for (const round of [0, 55]) {
    r = await c.request('record', { ...auth(r.job), key: 'video', result: {
      recovery: { attempts: 0, reloads: 0, round }
    } });
    assert.equal(r.job.candidates[0].records.video.recovery.reloads, 1);
    assert.equal(r.job.candidates[0].records.video.recovery.round, 0);
  }
  const forged = await c.request('reload-course', { ...reloadPayload(r.job), round: 55 });
  assert.equal(forged.ok, false);
  assert.deepEqual(c.reloads, [1]);
});

test('保存刷新预算期间用户暂停会取消刷新，旧owner无法恢复', async () => {
  const { c, job } = await prepared();
  let cancellation;
  c.hooks.write = async (name, values) => {
    if (name === 'local' && values[KEY].candidates[0].records.video.recovery.reloads === 1 && !cancellation) {
      cancellation = c.request('pause', auth(job));
    }
  };
  const r = await c.request('reload-course', reloadPayload(job));
  await cancellation;
  assert.equal(r.job.running, false);
  assert.equal(r.job.phase, 'paused');
  assert.equal(c.reloads.length, 0);
  assert.equal((await c.request('reload-course', reloadPayload(job))).error, 'TASK_CANCELLED');
});

test('刷新检查点无法保存或实际资源已变更，均不刷新', async () => {
  for (const mode of ['storage', 'route', 'class']) {
    const { c, job } = await prepared();
    if (mode === 'storage') c.hooks.write = async () => { throw new Error('write failed'); };
    if (mode === 'route') c.tabs.get(1).url = LEARN.replace('/resource?', '/another?');
    if (mode === 'class') c.tabs.get(1).url = LEARN.replace('classId=class', 'classId=other');
    const r = await c.request('reload-course', reloadPayload(job));
    assert.equal(r.ok, false);
    assert.equal(c.reloads.length, 0);
  }
});

test('单课未完成保持运行并退避，到期重试保留目录、缺口及完成记录', async () => {
  const { c, job } = await prepared();
  let r = await c.request('record', { ...auth(job), key: 'audio', result: {
    title: '音频', started: true, ended: true, confirmed: true
  } });
  r = await c.request('reload-course', reloadPayload(r.job));
  const beforeResult = r.job;
  r = await c.request('course-result', { ...auth(r.job), result: { total: 2, remaining: 1 } });
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'course');
  assert.equal(r.job.candidates[0].status, 'retry');
  assert.equal(r.job.candidates[0].retryRounds, 1);
  assert.ok(r.job.candidates[0].retryAt >= Date.now() + 29000);
  assert.ok(r.job.generation > beforeResult.generation);
  const early = await c.request('open', { ...auth(r.job), index: 0, purpose: 'play' });
  assert.equal(early.ok, false);
  c.storage.session[KEY].candidates[0].retryAt = Date.now() - 1;
  r = await c.request('open', { ...auth(r.job), index: 0, purpose: 'play' });
  assert.equal(r.ok, true);
  const candidate = r.job.candidates[0];
  assert.equal(candidate.status, 'inspected');
  assert.equal(candidate.retryRounds, 1);
  assert.equal(candidate.records.video.recovery.round, 1);
  assert.equal(candidate.records.video.recovery.reloads, 0);
  assert.deepEqual(clone(candidate.records.video.progressGap), { from: 15, to: 35 });
  assert.equal(candidate.records.audio.ended, true);
  assert.equal(candidate.records.audio.confirmed, true);
  assert.equal(candidate.directory.items.length, 2);
  assert.equal(candidate.currentResource.key, 'video');
  assert.equal(candidate.total, 2);
  assert.equal(candidate.remaining, 1);
});

test('重试退避持久化递增并封顶300秒，后台重启不丢待重试任务', async () => {
  const { c, job } = await prepared();
  let current = job;
  for (const expectedDelay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    const started = Date.now();
    let r = await c.request('course-result', { ...auth(current), result: { total: 2, remaining: 1 } });
    assert.equal(r.ok, true);
    assert.ok(r.job.candidates[0].retryAt >= started + expectedDelay);
    assert.ok(r.job.candidates[0].retryAt <= Date.now() + expectedDelay);
    c.boot();
    r = await c.request('get');
    assert.equal(r.job.running, true);
    assert.equal(r.job.candidates[0].status, 'retry');
    c.storage.session[KEY].candidates[0].retryAt = Date.now() - 1;
    r = await c.request('open', { ...auth(r.job), index: 0, purpose: 'play' });
    current = r.job;
  }
});

test('多课失败返回首页，待重试课程不能finish且到期可重新打开', async () => {
  const { c, job } = await prepared();
  Object.assign(c.storage.session[KEY], { scope: 'all', inspectIndex: 1 });
  c.storage.session[KEY].candidates[0].learnUrl = LEARN;
  let r = await c.request('course-result', { ...auth(job), result: { total: 2, remaining: 1 } });
  assert.equal(r.job.running, true);
  assert.equal(c.tabs.get(1).url, HOME);
  r = await c.request('hello', {}, 'home');
  const finish = await c.request('finish', auth(r.job), 'home');
  assert.equal(finish.ok, false);
  assert.match(finish.error, /尚未处理/);
  c.storage.session[KEY].candidates[0].retryAt = Date.now() - 1;
  r = await c.request('open', { ...auth(r.job), index: 0, purpose: 'play' }, 'home');
  assert.equal(r.ok, true);
  assert.equal(r.job.phase, 'opening');
  assert.equal(c.tabs.get(1).url, LEARN);
  assert.equal(r.job.candidates[0].records.video.recovery.round, 1);
});

test('日志只写session，日志写失败不改变运行状态或执行代数', async () => {
  for (const nameToFail of ['local', 'session']) {
    const { c, job } = await prepared();
    c.hooks.write = async name => { if (name === nameToFail) throw new Error('diagnostic storage failed'); };
    const r = await c.request('log', { ...auth(job), text: '正在恢复' });
    assert.equal(r.ok, true);
    assert.equal(r.job.running, true);
    assert.equal(r.job.generation, job.generation);
    assert.equal(r.job.phase, 'course');
  }
});

test('读任务状态失败仍停止，不能因日志隔离绕过未知任务状态', async () => {
  const { c, job } = await prepared();
  c.hooks.read = async () => { throw new Error('unknown checkpoint'); };
  const r = await c.request('log', { ...auth(job), text: '正在恢复' });
  assert.equal(r.ok, false);
  assert.match(r.error, /无法读取任务状态/);
  assert.equal(c.reloads.length, 0);
});

function expire(c, field) {
  c.storage.session[KEY][field] = Date.now() - 1;
  if (c.storage.session[KEY].navigationRecovery) c.storage.session[KEY].navigationRecovery.nextRetryAt = Date.now() - 1;
}

test('入口超时自动重新识别但不自动导航，前三轮后低频等待且旧代数不可点击', async () => {
  const c = harness();
  c.tabs.get(1).url = 'https://www.beeline-ai.com/stu/agent';
  let r = await c.request('start');
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    r = await c.request('entry-open', auth(r.job));
    const before = r.job;
    expire(c, 'entryDeadline');
    r = await c.request('get');
    assert.equal(r.job.running, true);
    assert.equal(r.job.phase, 'entry-home');
    assert.equal(r.job.entryClicked, false);
    assert.equal(r.job.navigationRecovery.attempts, attempt);
    assert.equal(r.job.generation, before.generation + 1);
    const delay = attempt <= 3 ? 45000 : 300000;
    assert.ok(r.job.navigationRecovery.nextRetryAt >= Date.now() + delay - 1000);
    assert.equal((await c.request('entry-open', auth(before))).error, 'TASK_CANCELLED');
    const unchanged = await c.request('get');
    assert.equal(unchanged.job.generation, r.job.generation);
  }
  assert.equal(c.navigation.length, 0);
});

test('入口恢复保存期间用户暂停或平台manual仍优先，不能以换代逃过取消', async () => {
  for (const action of ['pause', 'manual']) {
    const c = harness();
    c.tabs.get(1).url = 'https://www.beeline-ai.com/stu/agent';
    let r = await c.request('start');
    r = await c.request('entry-open', auth(r.job));
    const before = r.job;
    expire(c, 'entryDeadline');
    let cancelled;
    c.hooks.broadcast = async (id, message) => {
      if (message.job.navigationRecovery && !cancelled) {
        cancelled = c.request(action, { ...auth(before), reason: '用户或平台停止' });
      }
    };
    r = await c.request('get');
    await cancelled;
    assert.equal(r.job.running, false);
    assert.equal(r.job.phase, action === 'pause' ? 'paused' : 'manual');
    assert.equal(c.navigation.length, 0);
  }
});

test('已到课表但hello尚未到达时只保留等待，不替新文档接管', async () => {
  const c = harness();
  c.tabs.get(1).url = 'https://www.beeline-ai.com/stu/agent';
  let r = await c.request('start');
  r = await c.request('entry-open', auth(r.job));
  c.tabs.get(1).url = HOME;
  expire(c, 'entryDeadline');
  r = await c.request('get');
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(r.job.entryClicked, true);
  assert.equal(r.job.ownerInstance, 'page');
  assert.equal(c.navigation.length, 0);
  r = await c.request('hello', {}, 'arrived');
  assert.equal(r.job.phase, 'scan-home');
  assert.equal(r.job.ownerInstance, 'arrived');
  assert.equal(r.job.navigationRecovery, undefined);
});

test('入口点击迟到恰逢超时重试重置时仍能确认正常到达，避免误停', async () => {
  const c = harness();
  c.tabs.get(1).url = 'https://www.beeline-ai.com/stu/agent';
  let r = await c.request('start');
  r = await c.request('entry-open', auth(r.job));
  expire(c, 'entryDeadline');
  r = await c.request('get');
  assert.equal(r.job.entryClicked, false);
  c.tabs.get(1).url = HOME;
  r = await c.request('hello', {}, 'late-home');
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'scan-home');
  assert.equal(r.job.entryAttempted, undefined);
});

test('返回已知首页导航瞬时失败保留任务，到期仅重新导航同课tab', async () => {
  const { c, job } = await prepared();
  c.storage.session[KEY].scope = 'all';
  c.storage.session[KEY].inspectIndex = 1;
  c.hooks.update = async () => { throw new Error('temporary navigation failure'); };
  let r = await c.request('course-result', { ...auth(job), result: { total: 2, remaining: 1 } });
  assert.equal(r.job.running, true);
  assert.equal(r.job.returnCourseKey, 'course::class');
  delete c.hooks.update;
  expire(c, 'returnDeadline');
  r = await c.request('get');
  assert.equal(r.job.running, true);
  assert.equal(c.navigation.at(-1).url, HOME);
  assert.equal(r.job.ownerInstance, null);
  const count = c.navigation.length;
  await c.request('get');
  assert.equal(c.navigation.length, count);
  r = await c.request('hello', {}, 'home');
  assert.equal(r.job.returnDeadline, undefined);
  assert.equal(r.job.navigationRecovery, undefined);
});

test('已验证课程导航失败可重试，导航保存期间暂停则不重新打开', async () => {
  for (const cancel of [false, true]) {
    const { c, job } = await prepared();
    Object.assign(c.storage.session[KEY], {
      scope: 'all', phase: 'home', targetIndex: null, targetPurpose: '', workerTabId: null,
      candidates: [{ ...job.candidates[0], learnUrl: LEARN, total: 2, remaining: 2, status: 'inspected' }]
    });
    c.tabs.get(1).url = HOME;
    c.hooks.update = async () => { throw new Error('temporary navigation failure'); };
    let r = await c.request('open', { ...auth(job), index: 0, purpose: 'play' });
    assert.equal(r.job.running, true);
    assert.equal(r.job.phase, 'opening');
    delete c.hooks.update;
    expire(c, 'openDeadline');
    let cancelled;
    if (cancel) c.hooks.write = async (name, values) => {
      if (name === 'local' && values[KEY].navigationRecovery && !cancelled) cancelled = c.request('pause', auth(r.job));
    };
    r = await c.request('get');
    if (cancel) {
      await cancelled;
      assert.equal(c.navigation.length, 0);
      assert.equal(r.job.running, false);
    } else {
      assert.equal(c.navigation.at(-1).url, LEARN);
      assert.equal(r.job.ownerInstance, null);
      expire(c, 'openDeadline');
      r = await c.request('get');
      assert.equal(c.navigation.length, 1);
      assert.equal(r.job.phase, 'opening');
    }
  }
});

test('未确认登录或跨站重定向保持阻断，导航恢复不强行拉回', async () => {
  for (const url of ['https://www.beeline-ai.com/login', 'https://login.example/sign-in']) {
    const c = harness();
    c.tabs.get(1).url = 'https://www.beeline-ai.com/stu/agent';
    let r = await c.request('start');
    r = await c.request('entry-open', auth(r.job));
    c.tabs.get(1).url = url;
    expire(c, 'entryDeadline');
    // A different site cannot query the job; use a still-valid task document's
    // sender while the browser's actual tab reports the redirect.
    c.tabs.set(2, { id: 2, url: HOME });
    r = await c.request('get', {}, 'observer', 2);
    assert.equal(r.job.running, false);
    assert.equal(r.job.phase, 'manual');
    assert.equal(c.navigation.length, 0);
  }
});

test('统计新标签尚未出现只低频等待，不重复点击或声明完成', async () => {
  const c = harness();
  c.tabs.get(1).url = HOME;
  let r = await c.request('start');
  r = await c.request('scan-result', { ...auth(r.job), candidates: [
    { key: 'course', title: '课程', status: 'uninspected' }
  ] });
  r = await c.request('open', { ...auth(r.job), index: 0, purpose: 'inspect' });
  expire(c, 'openDeadline');
  r = await c.request('get');
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'opening');
  assert.equal(r.job.workerTabId, null);
  assert.equal(c.navigation.length, 0);
  assert.match(r.job.logs.at(-1).text, /弹窗/);
});

test('任意站内开始的已观察出发页导航失败可重试，实际首页仍需新文档hello', async () => {
  const c = harness();
  const departure = 'https://www.beeline-ai.com/student/profile';
  c.tabs.get(1).url = departure;
  c.hooks.update = async () => { throw new Error('temporary navigation failure'); };
  let r = await c.request('start', { scope: 'all' });
  assert.equal(r.job.running, true);
  assert.equal(r.job.agentDepartureUrl, departure);
  delete c.hooks.update;
  expire(c, 'agentDeadline');
  r = await c.request('get');
  assert.equal(c.navigation.at(-1).url, 'https://www.beeline-ai.com/stu/agent');
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(r.job.ownerInstance, null);
  r = await c.request('hello');
  assert.equal(r.job.phase, 'go-agent');
  r = await c.request('hello', {}, 'new-home');
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(r.job.ownerInstance, 'new-home');
  assert.equal(r.job.agentDepartureUrl, undefined);
});

test('单课失败换代和到期重试换代期间平台停止仍优先', async () => {
  for (const stage of ['result', 'retry']) {
    const { c, job } = await prepared();
    let current = job;
    if (stage === 'retry') {
      current = (await c.request('course-result', {
        ...auth(current), result: { total: 2, remaining: 1 }
      })).job;
      c.storage.session[KEY].candidates[0].retryAt = Date.now() - 1;
    }
    let cancelled;
    c.hooks.broadcast = async (id, message) => {
      if (message.job.generation > current.generation && !cancelled) {
        cancelled = c.request('manual', { ...auth(current), reason: '平台登录提示' });
      }
    };
    const r = stage === 'result'
      ? await c.request('course-result', { ...auth(current), result: { total: 2, remaining: 1 } })
      : await c.request('open', { ...auth(current), index: 0, purpose: 'play' });
    await cancelled;
    assert.equal(r.job.running, false);
    assert.equal(r.job.phase, 'manual');
    assert.match(r.job.reason, /平台登录/);
  }
});

test('seek缺口记录被暂停栅栏取消时，暂停附带证据仍落盘且刷新后保留', async () => {
  for (const action of ['pause', 'manual']) {
    const { c, job } = await prepared();
    delete c.storage.session[KEY].candidates[0].records.video.progressGap;
    let cancellation;
    c.hooks.read = async name => {
      if (name === 'session' && !cancellation) cancellation = c.request(action, {
        ...auth(job), reason: '停止',
        gapEvidence: { key: 'video', from: 10, to: 30, round: 0, courseKey: 'course::class' }
      });
    };
    const raced = await c.request('record', { ...auth(job), key: 'video', result: {
      progressGap: { from: 10, to: 30 }
    } });
    assert.equal(raced.error, 'TASK_CANCELLED');
    const stopped = await cancellation;
    assert.equal(stopped.job.running, false);
    assert.deepEqual(clone(stopped.job.candidates[0].records.video.progressGap), { from: 10, to: 30 });
    delete c.hooks.read;
    c.boot();
    let r = await c.request('get');
    assert.deepEqual(clone(r.job.candidates[0].records.video.progressGap), { from: 10, to: 30 });
    r = await c.request('start', auth(r.job));
    const ended = await c.request('record', { ...auth(r.job), key: 'video', result: {
      ended: true, confirmed: true
    } });
    assert.equal(ended.ok, false);
    assert.match(ended.error, /未观看/);
  }
});

test('暂停缺口证据只能保守扩大当前已观察资源，错误round或资源不会污染', async () => {
  const { c, job } = await prepared();
  let r = await c.request('pause', { ...auth(job), gapEvidence: {
    key: 'video', from: 5, to: 40, round: 0
  } });
  assert.deepEqual(clone(r.job.candidates[0].records.video.progressGap), { from: 5, to: 40 });
  for (const evidence of [
    { key: 'video', from: 20, to: 25, round: 0 },
    { key: 'audio', from: 0, to: 100, round: 0 },
    { key: 'video', from: 0, to: 100, round: 7 }
  ]) {
    r = await c.request('pause', { ...auth(r.job), gapEvidence: evidence });
    assert.deepEqual(clone(r.job.candidates[0].records.video.progressGap), { from: 5, to: 40 });
    assert.equal(r.job.running, false);
  }
});

test('浏览器刷新暂时拒绝保留本轮预算和断点，下一轮自动回试才重置预算', async () => {
  const { c, job } = await prepared();
  c.hooks.reload = async () => { throw new Error('temporary browser operation failure'); };
  let r = await c.request('reload-course', reloadPayload(job));
  assert.equal(r.ok, true);
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'course');
  assert.equal(r.job.candidates[0].records.video.recovery.reloadFailed, true);
  assert.equal(r.job.candidates[0].records.video.recovery.reloads, 1);
  assert.equal(c.storage.local[KEY].candidates[0].records.video.recovery.reloadFailed, true);
  assert.equal(r.job.candidates[0].currentResource.key, 'video');
  r = await c.request('record', { ...auth(r.job), key: 'video', result: {
    recovery: { round: 0, reloads: 0, reloadFailed: false }
  } });
  assert.equal(r.job.candidates[0].records.video.recovery.reloadFailed, true);
  c.boot();
  r = await c.request('get');
  assert.equal(r.job.running, true);
  assert.equal(r.job.candidates[0].records.video.recovery.reloadFailed, true);
  const repeat = await c.request('reload-course', reloadPayload(r.job));
  assert.equal(repeat.ok, false);
  assert.match(repeat.error, /本轮已刷新/);
  assert.equal(c.reloads.length, 1);
  r = await c.request('course-result', { ...auth(r.job), result: { total: 2, remaining: 1 } });
  assert.equal(r.job.candidates[0].status, 'retry');
  c.storage.session[KEY].candidates[0].retryAt = Date.now() - 1;
  r = await c.request('open', { ...auth(r.job), index: 0, purpose: 'play' });
  assert.equal(r.job.candidates[0].records.video.recovery.reloadFailed, false);
  assert.equal(r.job.candidates[0].records.video.recovery.reloads, 0);
  delete c.hooks.reload;
  r = await c.request('reload-course', { ...reloadPayload(r.job), round: 1 });
  assert.equal(r.ok, true);
  assert.equal(c.reloads.length, 2);
});

test('刷新拒绝后页面关闭或资源改变不能授予可恢复失败，关键保存失败仍停止', async () => {
  for (const mode of ['closed', 'route', 'storage']) {
    const { c, job } = await prepared();
    c.hooks.reload = async () => {
      if (mode === 'closed') c.tabs.delete(1);
      if (mode === 'route') c.tabs.get(1).url = LEARN.replace('/resource?', '/other?');
      if (mode === 'storage') c.hooks.write = async () => { throw new Error('disk unavailable'); };
      throw new Error('reload failed');
    };
    const r = await c.request('reload-course', reloadPayload(job));
    assert.equal(r.ok, false);
    assert.match(r.error, mode === 'closed' ? /页面已关闭|学习页已关闭/ : mode === 'route' ? /资源已改变/ : /状态无法保存/);
    assert.equal(c.reloads.length, 1);
    if (mode === 'storage') {
      const stopped = await c.request('get');
      assert.equal(stopped.job.running, false);
      assert.equal(stopped.job.phase, 'manual');
    } else assert.notEqual(c.storage.session[KEY].candidates[0].records.video.recovery.reloadFailed, true);
  }
});

test('刷新拒绝期间用户暂停或重置取消恢复授权', async () => {
  for (const action of ['pause', 'reset']) {
    const { c, job } = await prepared();
    let cancelled;
    c.hooks.reload = async () => {
      cancelled = c.request(action, auth(job));
      throw new Error('reload failed');
    };
    const r = await c.request('reload-course', reloadPayload(job));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'TASK_CANCELLED');
    const stopped = await cancelled;
    assert.equal(stopped.ok, true);
    assert.equal(stopped.job.running, false);
    assert.equal(stopped.job.phase, action === 'reset' ? 'idle' : 'paused');
    assert.equal(c.reloads.length, 1);
  }
});

async function preparedInspectionReturn() {
  const c = harness();
  c.tabs.get(1).url = HOME;
  let r = await c.request('start', {}, 'home');
  r = await c.request('scan-result', { ...auth(r.job), candidates: [
    { key: 'first', title: '课程', status: 'uninspected' },
    { key: 'second', title: '下一门课程', status: 'uninspected' }
  ] }, 'home');
  r = await c.request('open', { ...auth(r.job), index: 0, purpose: 'inspect' }, 'home');
  c.tabs.set(2, { id: 2, url: LEARN, openerTabId: 1 });
  c.onCreated.fire(clone(c.tabs.get(2)));
  r = await c.request('hello', { title: '课程' }, 'worker', 2);
  assert.equal(r.ok, true);
  assert.equal(r.job.ownerTabId, 2);
  r = await c.request('directory-checkpoint', { ...auth(r.job), snapshot: {
    version: 1, items: [{ key: 'video', title: '视频', mediaType: 'video', durationSeconds: 60 }]
  } }, 'worker', 2);
  assert.equal(r.ok, true);
  return { c, job: r.job };
}

test('统计页激活或关闭暂时失败保持等待，恢复后只关闭原统计页并交还首页', async () => {
  for (const operation of ['update', 'remove']) {
    const { c, job } = await preparedInspectionReturn();
    c.hooks[operation] = async () => { throw new Error('temporary browser operation failure'); };
    let r = await c.request('course-result', { ...auth(job), result: { total: 1, remaining: 1 } }, 'worker', 2);
    assert.equal(r.ok, true);
    assert.equal(r.job.running, true);
    assert.equal(r.job.returningTabId, 2);
    assert.equal(r.job.ownerInstance, null);
    assert.equal(r.job.inspectIndex, 1);
    assert.equal(r.job.candidates[0].remaining, 1);
    assert.ok(r.job.returnDeadline > Date.now());
    assert.equal(c.removals.length, 0);
    const originalDeadline = r.job.returnDeadline;
    r = await c.request('hello', {}, 'refreshed-home');
    assert.equal(r.job.homeInstance, 'refreshed-home');
    assert.equal(r.job.ownerInstance, null);
    const open = await c.request('open', { ...auth(r.job), index: 1, purpose: 'inspect' }, 'refreshed-home');
    assert.equal(open.error, 'TASK_CANCELLED');
    await c.request('get');
    assert.equal(c.storage.session[KEY].returnDeadline, originalDeadline);
    delete c.hooks[operation];
    c.boot();
    expire(c, 'returnDeadline');
    r = await c.request('get');
    assert.equal(r.job.running, true);
    assert.equal(r.job.ownerInstance, 'refreshed-home');
    assert.equal(r.job.returnDeadline, undefined);
    assert.equal(r.job.returningTabId, undefined);
    assert.equal(r.job.navigationRecovery, undefined);
    assert.deepEqual(c.removals, [2]);
    const next = await c.request('open', { ...auth(r.job), index: 1, purpose: 'inspect' }, 'refreshed-home');
    assert.equal(next.ok, true);
    assert.equal(next.job.targetIndex, 1);
  }
});

test('统计页返回持续失败有持久化退避，未到期限不重复操作', async () => {
  const { c, job } = await preparedInspectionReturn();
  let attempts = 0;
  c.hooks.remove = async () => { attempts += 1; throw new Error('temporary close failure'); };
  let r = await c.request('course-result', { ...auth(job), result: { total: 1, remaining: 1 } }, 'worker', 2);
  for (let round = 1; round <= 4; round += 1) {
    expire(c, 'returnDeadline');
    r = await c.request('get');
    assert.equal(r.job.running, true);
    assert.equal(r.job.navigationRecovery.attempts, round);
    assert.ok(r.job.returnDeadline >= Date.now() + (round <= 3 ? 45000 : 300000) - 1000);
    const before = attempts;
    await c.request('get');
    assert.equal(attempts, before);
    c.boot();
  }
  assert.equal(attempts, 5);
  assert.equal(c.removals.length, 0);
});

test('统计页返回重试保存期间暂停或重置阻止迟到激活和关闭', async () => {
  for (const action of ['pause', 'reset']) {
    const { c, job } = await preparedInspectionReturn();
    c.hooks.update = async () => { throw new Error('temporary activation failure'); };
    let r = await c.request('course-result', { ...auth(job), result: { total: 1, remaining: 1 } }, 'worker', 2);
    delete c.hooks.update;
    expire(c, 'returnDeadline');
    let cancelled;
    c.hooks.write = async (area, values) => {
      if (area === 'local' && values[KEY].navigationRecovery && !cancelled) {
        cancelled = c.request(action, auth(r.job), 'home');
      }
    };
    r = await c.request('get');
    const stopped = await cancelled;
    assert.equal(stopped.job.running, false);
    assert.equal(stopped.job.phase, action === 'reset' ? 'idle' : 'paused');
    assert.equal(c.navigation.length, 0);
    assert.equal(c.removals.length, 0);
    assert.equal(c.tabs.has(2), true);
  }
});

test('统计页关闭前再次检查身份和暂停，真实页面变化不自动关闭', async () => {
  for (const mode of ['worker-route', 'home-route', 'closed', 'not-created', 'pause']) {
    const { c, job } = await preparedInspectionReturn();
    let cancelled;
    if (mode === 'not-created') c.storage.session[KEY].createdTabIds = [];
    c.hooks.update = async () => {
      if (mode === 'worker-route') c.tabs.get(2).url = LEARN.replace('classId=class', 'classId=other');
      if (mode === 'home-route') c.tabs.get(1).url = 'https://www.beeline-ai.com/login';
      if (mode === 'closed') c.tabs.delete(2);
      if (mode === 'pause') cancelled = c.request('pause', auth(job), 'worker', 2);
    };
    const r = await c.request('course-result', { ...auth(job), result: { total: 1, remaining: 1 } }, 'worker', 2);
    if (cancelled) await cancelled;
    const stopped = await c.request('get');
    assert.equal(stopped.job.running, false);
    assert.equal(stopped.job.phase, mode === 'pause' ? 'paused' : 'manual');
    assert.equal(c.removals.length, 0);
    assert.equal(r.ok, true);
  }
});

test('统计页关闭已发出时暂停保留已完成清理事实，继续不会等待不存在的旧页', async () => {
  const { c, job } = await preparedInspectionReturn();
  let cancelled;
  c.hooks.remove = async () => { cancelled = c.request('pause', auth(job), 'worker', 2); };
  const result = await c.request('course-result', { ...auth(job), result: { total: 1, remaining: 1 } }, 'worker', 2);
  await cancelled;
  assert.equal(result.job.running, false);
  assert.equal(result.job.phase, 'paused');
  assert.equal(result.job.returningTabId, undefined);
  assert.equal(c.storage.session[KEY].returningTabId, undefined);
  assert.deepEqual(c.removals, [2]);
  const resumed = await c.request('start', auth(result.job), 'home');
  assert.equal(resumed.ok, true);
  assert.equal(resumed.job.running, true);
  assert.equal(resumed.job.ownerInstance, 'home');
  const next = await c.request('open', { ...auth(resumed.job), index: 1, purpose: 'inspect' }, 'home');
  assert.equal(next.ok, true);
  assert.equal(next.job.targetIndex, 1);
});
