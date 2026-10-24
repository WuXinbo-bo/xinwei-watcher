const assert = require('node:assert/strict');
const test = require('node:test');
const { coordinator } = require('./coordinator.cjs');
const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const AGENT = 'https://www.beeline-ai.com/stu/agent';
const learnUrl = (id = 'course', classId = 'class') =>
  `https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/${id}/video/res?classId=${classId}`;
const auth = job => ({ runId: job.runId, generation: job.generation });
const plain = value => JSON.parse(JSON.stringify(value));
const directorySnapshot = (items = [
  { key: 'video', title: '视频', mediaType: 'video', durationSeconds: 60 },
  { key: 'audio', title: '音频', mediaType: 'audio', durationSeconds: 30 },
  { key: 'document', title: '文档', mediaType: 'document', durationSeconds: null }
]) => ({ version: 1, items });
const singleMediaDirectory = (key = 'video', title = '视频', mediaType = 'video') => directorySnapshot([
  { key, title, mediaType, durationSeconds: 60 }
]);
const documentOnlyDirectory = () => directorySnapshot([
  { key: 'document', title: '文档', mediaType: 'document', durationSeconds: null }
]);
async function requestOk(c, id, instance, action, payload = {}, documentUrl) {
  const response = await c.request(id, instance, action, payload, documentUrl);
  assert.equal(response.ok, true, `${action} failed: ${response.error || 'missing successful response'}`);
  return response;
}
async function checkpointDirectory(c, id, instance, job, snapshot = directorySnapshot()) {
  return requestOk(c, id, instance, 'directory-checkpoint', { ...auth(job), snapshot });
}
const routeKey = url => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.hash}`;
};

test('实际首页开始仅登记一次课表入口任务，不直接导航或接受另一个任务', async () => {
  const c = coordinator();
  const id = c.addTab(AGENT);
  const started = await c.request(id, 'agent', 'start');
  assert.equal(started.ok, true);
  assert.equal(started.job.phase, 'entry-home');
  assert.equal(started.job.scope, 'all');
  assert.equal(started.job.entryClicked, false);
  assert.ok(started.job.entryDeadline > Date.now());
  assert.equal(started.job.ownerTabId, id);
  assert.equal(started.job.ownerInstance, 'agent');
  assert.equal(started.job.candidates.length, 0);
  const other = c.addTab(AGENT);
  const duplicate = await c.request(other, 'other', 'start');
  assert.equal(duplicate.job.runId, started.job.runId);
  assert.equal(duplicate.job.ownerTabId, id);
  const forbidden = await c.request(other, 'other', 'entry-open', auth(started.job));
  assert.equal(forbidden.error, 'TASK_CANCELLED');
  assert.equal(c.navigation.length, 0);
});

test('实际首页入口只允许原标签接管；SPA和整页导航均承接同一任务', async () => {
  for (const spa of [true, false]) {
    const c = coordinator();
    const id = c.addTab(AGENT);
    let r = await c.request(id, 'agent', 'start');
    const initialGeneration = r.job.generation;
    r = await c.request(id, 'agent', 'entry-open', auth(r.job));
    assert.equal(r.job.entryClicked, true);
    assert.equal(r.job.generation, initialGeneration);
    const wrong = c.addTab(HOME);
    const otherHello = await c.request(wrong, 'wrong', 'hello');
    assert.equal(otherHello.job.phase, 'entry-home');
    assert.equal(otherHello.job.ownerTabId, id);
    c.tabs.get(id).url = HOME;
    const instance = spa ? 'agent' : 'home';
    const arrival = await c.request(id, instance, 'hello', auth(r.job), spa ? AGENT : HOME);
    assert.equal(arrival.job.runId, r.job.runId);
    assert.equal(arrival.job.phase, 'scan-home');
    assert.equal(arrival.job.ownerInstance, instance);
    assert.equal(arrival.job.homeInstance, instance);
    assert.equal(arrival.job.entryClicked, undefined);
    assert.equal(arrival.job.entryDeadline, undefined);
    assert.equal(arrival.job.generation, initialGeneration + 1);
    const late = await c.request(id, 'agent', 'entry-open', auth(r.job));
    assert.equal(late.error, 'TASK_CANCELLED');
    assert.equal(c.navigation.length, 0);
  }
});

test('入口刷新保留已点击标记，超时后安排有间隔的自动重试', async () => {
  const c = coordinator();
  const id = c.addTab(AGENT);
  let r = await c.request(id, 'agent', 'start');
  r = await c.request(id, 'agent', 'entry-open', auth(r.job));
  const deadline = r.job.entryDeadline;
  const originalGeneration = r.job.generation;
  c.restartWorker();
  r = await c.request(id, 'agent-refreshed', 'hello');
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(r.job.ownerInstance, 'agent-refreshed');
  assert.equal(r.job.entryClicked, true);
  assert.equal(r.job.entryDeadline, deadline);
  assert.equal(r.job.generation, originalGeneration + 1);
  const repeated = await c.request(id, 'agent-refreshed', 'entry-open', auth(r.job));
  assert.equal(repeated.error, 'TASK_CANCELLED');
  c.storage.session['xinwei-job-v3'].entryDeadline = Date.now() - 1;
  r = await c.request(id, 'agent-refreshed', 'get');
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(r.job.entryClicked, false);
  assert.equal(r.job.navigationRecovery.attempts, 1);
  assert.ok(r.job.entryDeadline > Date.now());
  assert.equal(c.navigation.some(item => item.url), false);
});

test('实际首页SPA进入课表后暂停再继续，旧sender网址不导致重复入口或新任务', async () => {
  const c = coordinator();
  const id = c.addTab(AGENT);
  let r = await c.request(id, 'agent', 'start');
  r = await c.request(id, 'agent', 'entry-open', auth(r.job));
  c.tabs.get(id).url = HOME;
  r = await c.request(id, 'agent', 'hello', auth(r.job), AGENT);
  const runId = r.job.runId;
  r = await c.request(id, 'agent', 'pause', auth(r.job), AGENT);
  r = await c.request(id, 'agent', 'start', auth(r.job), AGENT);
  assert.equal(r.ok, true);
  assert.equal(r.job.runId, runId);
  assert.equal(r.job.phase, 'scan-home');
  assert.equal(r.job.running, true);
  assert.equal(r.job.entryClicked, undefined);
  assert.equal(c.navigation.some(item => item.url), false);
});

test('入口暂停后迟到的点击和到达消息都不能续跑，用户在课表继续才开始扫描', async () => {
  const c = coordinator();
  const id = c.addTab(AGENT);
  let r = await c.request(id, 'agent', 'start');
  r = await c.request(id, 'agent', 'entry-open', auth(r.job));
  const beforePause = r.job;
  r = await c.request(id, 'agent', 'pause', auth(r.job));
  const lateClick = await c.request(id, 'agent', 'entry-open', auth(beforePause));
  assert.equal(lateClick.error, 'TASK_CANCELLED');
  c.tabs.get(id).url = HOME;
  r = await c.request(id, 'home', 'hello');
  assert.equal(r.job.running, false);
  assert.equal(r.job.phase, 'paused');
  r = await c.request(id, 'home', 'start');
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'scan-home');
  assert.equal(r.job.entryClicked, undefined);
  assert.equal(r.job.entryDeadline, undefined);
  assert.equal(r.job.ownerInstance, 'home');
  assert.equal(c.navigation.some(item => item.url), false);
});

test('入口点击落盘广播期间暂停，最终点击前能核对到停止状态', async () => {
  const c = coordinator();
  const id = c.addTab(AGENT);
  const page = { location: { href: AGENT } };
  c.connect(id)(page);
  const started = await c.request(id, 'agent', 'start');
  let cancellation;
  page.chrome.runtime.onMessage.addListener(message => {
    if (message.job.entryClicked && message.job.running && !cancellation) {
      cancellation = c.request(id, 'agent', 'pause', { ...auth(started.job), reason: '用户暂停入口' });
    }
  });
  const opened = await c.request(id, 'agent', 'entry-open', auth(started.job));
  assert.ok(cancellation);
  await cancellation;
  // The content final-click guard reads authoritative state after the save.
  const latest = await c.request(id, 'agent', 'get');
  assert.equal(latest.job.running, false);
  assert.equal(latest.job.phase, 'paused');
  assert.equal(opened.job.entryClicked, true);
  assert.equal(c.navigation.length, 0);
});

test('进入课表接管保存期间的旧代数停止仍生效，不因SPA交接丢失暂停', async () => {
  for (const action of ['pause', 'manual']) {
    const c = coordinator();
    const id = c.addTab(AGENT);
    let r = await c.request(id, 'agent', 'start');
    r = await c.request(id, 'agent', 'entry-open', auth(r.job));
    const beforeArrival = r.job;
    c.tabs.get(id).url = HOME;
    const page = { location: { href: HOME } };
    c.connect(id)(page);
    let cancellation;
    page.chrome.runtime.onMessage.addListener(message => {
      if (message.job.phase === 'scan-home' && message.job.running && !cancellation) {
        cancellation = c.request(id, 'agent', action, { ...auth(beforeArrival), reason: '入口交接时停止' });
      }
    });
    const arrived = await c.request(id, 'agent', 'hello', auth(beforeArrival), AGENT);
    assert.ok(cancellation);
    await cancellation;
    assert.equal(arrived.job.running, false);
    assert.equal(arrived.job.phase, action === 'pause' ? 'paused' : 'manual');
    assert.equal(arrived.job.reason, '入口交接时停止');
    assert.equal(c.navigation.length, 0);
  }
});

test('入口缺失可保留人工停止，未点击或跳到无关页面不能冒充已进入课表', async () => {
  for (const destination of [HOME, 'https://www.beeline-ai.com/account', 'https://example.org/myBank/courseResearch']) {
    const c = coordinator();
    const id = c.addTab(AGENT);
    let r = await c.request(id, 'agent', 'start');
    c.tabs.get(id).url = destination;
    r = await c.request(id, 'agent', 'hello', {}, AGENT);
    assert.equal(r.job.running, false);
    assert.equal(r.job.phase, 'manual');
    assert.match(r.job.reason, /课表入口任务不符/);
    assert.equal(c.navigation.length, 0);
  }
  const c = coordinator();
  const id = c.addTab(AGENT);
  let r = await c.request(id, 'agent', 'start');
  r = await c.request(id, 'agent', 'manual', { ...auth(r.job), reason: '未找到唯一的“查看所有课表”入口' });
  assert.equal(r.job.resumePhase, 'entry-home');
  const nextPoll = await c.request(id, 'agent', 'hello');
  assert.equal(nextPoll.job.running, false);
  assert.equal(nextPoll.job.entryClicked, false);
});

test('已暂停学习页回到实际首页后重新开始，保存未结束记录且重新扫描', async () => {
  const c = coordinator();
  const id = c.addTab(learnUrl());
  let r = await c.request(id, 'learn', 'start', { title: '课程' });
  r = await c.request(id, 'learn', 'record', {
    ...auth(r.job), key: 'unfinished', result: { title: '视频', started: true, ended: false, confirmed: false }
  });
  r = await c.request(id, 'learn', 'pause', auth(r.job));
  const originalRun = r.job.runId;
  c.tabs.get(id).url = AGENT;
  r = await c.request(id, 'agent', 'start');
  assert.equal(r.job.phase, 'entry-home');
  assert.notEqual(r.job.runId, originalRun);
  assert.equal(r.job.candidates.length, 0);
  assert.equal(r.job.recoveryRecords['course::class'].unfinished.started, true);
  assert.equal(c.navigation.length, 0);
});

test('已清空插件从实际首页开始仍点击正常课表入口，保留当前实例用于取消', async () => {
  const c = coordinator();
  const id = c.addTab(AGENT);
  c.storage.session['xinwei-job-v3'] = {
    version: 3, runId: 'reset', generation: 1, resetEpoch: 2,
    running: false, phase: 'idle', candidates: [], logs: [], resetHoldTabIds: [id]
  };
  const r = await c.request(id, 'agent', 'start', { resetEpoch: 2 });
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(r.job.homeInstance, 'agent');
  assert.equal(r.job.ownerInstance, 'agent');
  assert.equal(r.job.returningTabId, undefined);
  assert.equal(r.job.resetEpoch, 2);
  assert.equal(c.navigation.length, 0);
});

async function openCourse(c, snapshot = directorySnapshot()) {
  const home = c.addTab(HOME);
  let r = await requestOk(c, home, 'home', 'start');
  r = await requestOk(c, home, 'home', 'scan-result', {
    ...auth(r.job), candidates: [{ key: '课程::班级', title: '课程', className: '班级', status: 'uninspected', records: {} }]
  });
  r = await requestOk(c, home, 'home', 'open', { ...auth(r.job), index: 0, purpose: 'inspect' });
  const worker = c.addTab(learnUrl(), home);
  r = await requestOk(c, worker, 'worker', 'hello', { title: '课程' });
  assert.equal(r.job.phase, 'course');
  r = await checkpointDirectory(c, worker, 'worker', r.job, snapshot);
  return { home, worker, job: r.job };
}

test('已有同名学习页不能接管新任务；只能承接本次从首页打开的标签', async () => {
  const c = coordinator();
  const old = c.addTab(learnUrl());
  const { worker, job } = await openCourse(c);
  const r = await c.request(old, 'old', 'hello', { title: '课程' });
  assert.equal(r.job.ownerTabId, worker);
  assert.equal(r.job.ownerInstance, 'worker');
  assert.equal(job.candidates[0].courseKey, 'course::class');
});

test('首页暂停可以停止学习页，迟到的统计结果不得复活任务或触发返回', async () => {
  const c = coordinator();
  const { home, worker, job } = await openCourse(c, directorySnapshot([
    { key: 'video', title: '视频', mediaType: 'video', durationSeconds: 60 },
    { key: 'audio', title: '音频', mediaType: 'audio', durationSeconds: 30 },
    { key: 'another-video', title: '第二视频', mediaType: 'video', durationSeconds: 90 }
  ]));
  const paused = await c.request(home, 'home', 'pause', auth(job));
  assert.equal(paused.job.running, false);
  const late = await c.request(worker, 'worker', 'course-result', {
    ...auth(job), result: { total: 3, remaining: 3 }
  });
  assert.equal(late.ok, false);
  assert.equal(late.error, 'TASK_CANCELLED');
  assert.equal(c.navigation.length, 0);
  const resumed = await c.request(home, 'home', 'start');
  const bound = await c.request(worker, 'worker-new', 'hello', { title: '课程' });
  assert.equal(bound.job.running, true);
  assert.equal(bound.job.phase, 'course');
  assert.equal(bound.job.ownerInstance, 'worker-new');
  assert.ok(resumed.job.generation > job.generation);
});

test('已绑定课程的另一个教学班不能接管，且模糊名称不能匹配', async () => {
  const c = coordinator();
  const { home, worker, job } = await openCourse(c);
  const counted = await requestOk(c, worker, 'worker', 'course-result', {
    ...auth(job), result: { total: 2, remaining: 2 }
  });
  let r = await c.request(home, 'home', 'open', { ...auth(counted.job), index: 0, purpose: 'play' });
  c.tabs.get(home).url = learnUrl('course', 'different-class');
  r = await c.request(home, 'wrong', 'hello', { title: '课程' });
  assert.equal(r.job.phase, 'manual');
  assert.equal(r.job.running, false);
  assert.match(r.job.reason, /教学班/);
});

test('统计零音视频无需播放；未确认资源保持运行并安排自动重试，用户暂停仍取消', async () => {
  const c = coordinator();
  const { home, worker, job } = await openCourse(c, documentOnlyDirectory());
  let r = await requestOk(c, worker, 'worker', 'course-result', { ...auth(job), result: { total: 0, remaining: 0 } });
  r = await requestOk(c, home, 'home', 'finish', auth(r.job));
  assert.equal(r.job.candidates[0].status, 'complete');
  assert.equal(r.job.phase, 'finished');
  assert.equal(r.job.logs.some(l => l.text.includes('整门课程')), true);

  const single = c.addTab(learnUrl('other'));
  r = await requestOk(c, single, 'single', 'start', { title: '另一课程' });
  r = await checkpointDirectory(c, single, 'single', r.job, singleMediaDirectory('audio', '已结束音频', 'audio'));
  r = await requestOk(c, single, 'single', 'record', {
    ...auth(r.job), key: 'audio', result: { title: '已结束音频', ended: true, confirmed: false }
  });
  const scheduledAt = Date.now();
  r = await requestOk(c, single, 'single', 'course-result', {
    ...auth(r.job), result: { total: 1, remaining: 1, unconfirmed: ['已结束音频'], failures: [] }
  });
  const candidate = r.job.candidates[0];
  assert.equal(candidate.status, 'retry');
  assert.equal(candidate.remaining, 1);
  assert.deepEqual(plain(candidate.unconfirmed), ['已结束音频']);
  assert.equal(candidate.records.audio.ended, true);
  assert.equal(candidate.records.audio.confirmed, false);
  assert.equal(candidate.retryRounds, 1);
  assert.ok(candidate.retryAt >= scheduledAt + 30000);
  assert.ok(candidate.retryAt <= Date.now() + 30000);
  assert.match(r.job.logs.at(-1).text, /待重试.*自动继续/);
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'course');

  const beforeRestart = plain(r.job);
  const navigations = c.navigation.length;
  c.restartWorker();
  r = await requestOk(c, single, 'single', 'get');
  assert.equal(r.job.runId, beforeRestart.runId);
  assert.equal(r.job.generation, beforeRestart.generation);
  assert.equal(r.job.running, true);
  assert.deepEqual(plain(r.job.candidates), beforeRestart.candidates);
  assert.deepEqual(c.storage.local['xinwei-job-v3'].candidates, beforeRestart.candidates);
  const early = await c.request(single, 'single', 'open', { ...auth(r.job), index: 0, purpose: 'play' });
  assert.equal(early.ok, false);
  assert.match(early.error, /等待自动重试/);

  const beforePause = r.job;
  r = await requestOk(c, single, 'single', 'pause', auth(r.job));
  c.storage.session['xinwei-job-v3'].candidates[0].retryAt = Date.now() - 1;
  const late = await c.request(single, 'single', 'open', { ...auth(beforePause), index: 0, purpose: 'play' });
  assert.equal(late.error, 'TASK_CANCELLED');
  r = await requestOk(c, single, 'single', 'get');
  assert.equal(r.job.running, false);
  assert.equal(r.job.phase, 'paused');
  assert.equal(r.job.candidates[0].records.audio.ended, true);
  assert.equal(r.job.candidates[0].records.audio.confirmed, false);
  assert.equal(c.navigation.length, navigations);
});

test('同一页面重复开始不产生多个任务；后台重启保留任务，浏览器重启不自动续播', async () => {
  const c = coordinator();
  const home = c.addTab(HOME);
  const r = await c.request(home, 'home', 'start');
  const repeated = await c.request(home, 'different', 'start');
  assert.equal(repeated.job.runId, r.job.runId);
  assert.equal(repeated.job.ownerInstance, 'home');
  c.restartWorker();
  const workerRestart = await c.request(home, 'home', 'get');
  assert.equal(workerRestart.job.running, true);
  c.restartBrowser();
  const browserRestart = await c.request(home, 'home', 'get');
  assert.equal(browserRestart.job.running, false);
  assert.equal(browserRestart.job.phase, 'interrupted');
});

test('任务状态保存失败时停止，不能继续返回页面或宣布完成', async () => {
  const c = coordinator();
  const { worker, job } = await openCourse(c, documentOnlyDirectory());
  c.failStorage();
  const r = await c.request(worker, 'worker', 'course-result', {
    ...auth(job), result: { total: 0, remaining: 0 }
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /无法读取任务状态/);
  assert.equal(c.navigation.length, 0);
  const stopped = await c.request(worker, 'worker', 'get');
  assert.equal(stopped.job.running, false);
  assert.equal(stopped.job.phase, 'manual');
});

test('资源播放记录按课程保存，同名资源不会污染下一课程', async () => {
  const c = coordinator();
  const first = c.addTab(learnUrl('first'));
  let r = await c.request(first, 'first', 'start', { title: '第一课' });
  r = await c.request(first, 'first', 'record', {
    ...auth(r.job), key: '相同标题', result: { title: '相同标题', ended: true, confirmed: false }
  });
  await c.request(first, 'first', 'pause', auth(r.job));
  const second = c.addTab(learnUrl('second'));
  r = await c.request(second, 'second', 'start', { title: '第二课' });
  assert.equal(Object.keys(r.job.candidates[0].records).length, 0);
});

test('统计新标签未创建时最多重试两次，最终提示允许弹窗且不宣称零课程完成', async () => {
  const c = coordinator();
  const home = c.addTab(HOME);
  let r = await c.request(home, 'home', 'start');
  r = await c.request(home, 'home', 'scan-result', {
    ...auth(r.job), candidates: [{ title: '课程', key: '课程::班级', status: 'uninspected' }]
  });
  r = await c.request(home, 'home', 'open', { ...auth(r.job), index: 0, purpose: 'inspect' });
  c.storage.session['xinwei-job-v3'].openDeadline = Date.now() - 1;
  r = await c.request(home, 'home', 'get');
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'opening');
  assert.equal(r.job.navigationRecovery.attempts, 1);
  assert.equal(r.job.workerTabId, null);
  assert.equal(c.navigation.length, 0);
  assert.match(r.job.logs.at(-1).text, /30 秒后第 1 次重试/);
  c.storage.session['xinwei-job-v3'].openDeadline = Date.now() - 1;
  c.storage.session['xinwei-job-v3'].navigationRecovery.nextRetryAt = Date.now() - 1;
  r = await c.request(home, 'home', 'get');
  assert.equal(r.job.running, true);
  assert.equal(r.job.navigationRecovery.attempts, 2);
  assert.equal(r.job.workerTabId, null);
  c.storage.session['xinwei-job-v3'].openDeadline = Date.now() - 1;
  c.storage.session['xinwei-job-v3'].navigationRecovery.nextRetryAt = Date.now() - 1;
  r = await c.request(home, 'home', 'get');
  assert.equal(r.job.running, false);
  assert.equal(r.job.phase, 'manual');
  assert.match(r.job.reason, /允许本站弹出窗口或新标签页/);
});

test('统计标签曾创建后被用户关闭，不计入弹窗拦截重试', async () => {
  const c = coordinator();
  const home = c.addTab(HOME);
  let r = await c.request(home, 'home', 'start');
  r = await c.request(home, 'home', 'scan-result', {
    ...auth(r.job), candidates: [{ title: '课程', key: '课程::班级', status: 'uninspected' }]
  });
  r = await c.request(home, 'home', 'open', { ...auth(r.job), index: 0, purpose: 'inspect' });
  const worker = c.addTab(learnUrl('course', 'class'), home);
  await new Promise(resolve => setImmediate(resolve));
  await c.closeTab(worker);
  r = await c.request(home, 'home', 'get');
  assert.equal(r.job.running, false);
  assert.equal(r.job.phase, 'manual');
  assert.match(r.job.reason, /任务页面已关闭/);
  assert.doesNotMatch(r.job.reason, /弹出窗口|新标签页/);
});

test('学习页运行时刷新首页，返回后由新首页实例继续选课', async () => {
  const c = coordinator();
  const { home, worker, job } = await openCourse(c);
  let r = await c.request(home, 'home-refreshed', 'hello');
  assert.equal(r.job.running, true);
  assert.equal(r.job.homeInstance, 'home-refreshed');
  assert.equal(r.job.ownerInstance, 'worker');
  r = await c.request(worker, 'worker', 'course-result', {
    ...auth(job), result: { total: 2, remaining: 2 }
  });
  assert.equal(r.job.ownerInstance, 'home-refreshed');
  r = await c.request(home, 'home-refreshed', 'open', { ...auth(r.job), index: 0, purpose: 'play' });
  assert.equal(r.ok, true);
  assert.equal(r.job.phase, 'opening');
});

test('首页自己执行任务时刷新接回原任务，旧实例扫描结果仍不能操作', async () => {
  const c = coordinator();
  const home = c.addTab(HOME);
  const started = await c.request(home, 'home', 'start');
  const refreshed = await c.request(home, 'home-refreshed', 'hello');
  assert.equal(refreshed.job.running, true);
  assert.equal(refreshed.job.phase, 'scan-home');
  assert.equal(refreshed.job.runId, started.job.runId);
  assert.equal(refreshed.job.ownerInstance, 'home-refreshed');
  assert.equal(refreshed.job.generation, started.job.generation + 1);
  assert.match(refreshed.job.logs.at(-1).text, /刷新后已接回/);
  const late = await c.request(home, 'home', 'scan-result', { ...auth(started.job), candidates: [] });
  assert.equal(late.error, 'TASK_CANCELLED');
  assert.equal(c.navigation.length, 0);
});

test('返回首页的广播期间暂停，立即取消激活首页和关闭学习页；继续可完成返回', async () => {
  const c = coordinator();
  const { home, worker, job } = await openCourse(c, singleMediaDirectory());
  const page = { location: { href: HOME } };
  c.connect(home)(page);
  let pauseRequest;
  page.chrome.runtime.onMessage.addListener(message => {
    if (message.job.phase === 'home' && message.job.running && !pauseRequest) {
      pauseRequest = c.request(home, 'home', 'pause', auth(message.job));
    }
  });
  const returned = await requestOk(c, worker, 'worker', 'course-result', {
    ...auth(job), result: { total: 1, remaining: 1 }
  });
  assert.equal(returned.ok, true);
  const paused = await pauseRequest;
  assert.equal(paused.job.running, false);
  assert.equal(c.navigation.length, 0);
  assert.equal(c.removed.length, 0);
  assert.equal(c.tabs.has(worker), true);
  assert.equal(paused.job.returningTabId, worker);
  const resumed = await c.request(home, 'home', 'start');
  assert.equal(resumed.job.running, true);
  assert.equal(resumed.job.returningTabId, undefined);
  assert.equal(c.removed.includes(worker), true);
});

test('首页激活后学习页请求暂停，立即取消随后关闭学习页', async () => {
  const c = coordinator();
  const { home, worker, job } = await openCourse(c, singleMediaDirectory());
  let pauseRequest;
  const tab = c.tabs.get(home);
  let active;
  Object.defineProperty(tab, 'active', {
    configurable: true,
    enumerable: true,
    get: () => active,
    set: value => {
      active = value;
      if (value && !pauseRequest) pauseRequest = c.request(worker, 'worker', 'pause', auth(job));
    }
  });
  await requestOk(c, worker, 'worker', 'course-result', {
    ...auth(job), result: { total: 1, remaining: 1 }
  });
  const paused = await pauseRequest;
  assert.equal(paused.job.phase, 'paused');
  assert.equal(c.navigation.length, 1);
  assert.equal(c.removed.length, 0);
  assert.equal(c.tabs.has(worker), true);
});

test('返回期间旧任务或非任务标签的暂停不能取消当前导航', async () => {
  const c = coordinator();
  const { home, worker, job } = await openCourse(c, singleMediaDirectory());
  const unrelated = c.addTab(HOME);
  const page = { location: { href: HOME } };
  c.connect(home)(page);
  let sent = false;
  const ignored = [];
  page.chrome.runtime.onMessage.addListener(message => {
    if (message.job.phase === 'home' && message.job.running && !sent) {
      sent = true;
      ignored.push(c.request(home, 'home', 'pause', { runId: 'old-task', generation: job.generation }));
      ignored.push(c.request(unrelated, 'other', 'pause', auth(job)));
    }
  });
  const returned = await requestOk(c, worker, 'worker', 'course-result', {
    ...auth(job), result: { total: 1, remaining: 1 }
  });
  await Promise.all(ignored);
  assert.equal(returned.job.running, true);
  assert.equal(c.navigation.length, 1);
  assert.equal(c.removed.includes(worker), true);
});

test('后台重启后的第一个处理尚在读取时收到暂停，课程结果不得导航', async () => {
  const c = coordinator();
  const { home, worker, job } = await openCourse(c, singleMediaDirectory());
  c.restartWorker();
  const returning = c.request(worker, 'worker', 'course-result', {
    ...auth(job), result: { total: 1, remaining: 1 }
  });
  const pausing = c.request(home, 'home', 'pause', auth(job));
  const lateResult = await returning;
  const paused = await pausing;
  assert.equal(lateResult.error, 'TASK_CANCELLED');
  assert.equal(paused.job.phase, 'paused');
  assert.equal(c.navigation.length, 0);
  assert.equal(c.removed.length, 0);
});

test('remaining 为零也不能覆盖已开始未结束记录或错误、待确认和未结束结果', async () => {
  const cases = [
    { result: {}, record: { title: '未结束视频', started: true, ended: false, confirmed: false } },
    { result: {}, record: { title: '尝试打开失败视频', attempted: true, ended: false, confirmed: false } },
    { result: {}, record: { title: '待确认视频', started: true, ended: true, confirmed: false } },
    { result: {}, record: { title: '打开失败视频', ended: false, confirmed: false, error: '打开失败' } },
    { result: { failures: ['音频加载失败'] } },
    { result: { unconfirmed: ['音频平台未确认'] } },
    { result: { unfinished: ['视频尚未自然结束'] } }
  ];
  for (const { result, record } of cases) {
    const c = coordinator();
    const worker = c.addTab(learnUrl());
    let r = await requestOk(c, worker, 'worker', 'start', { title: '课程' });
    r = await checkpointDirectory(c, worker, 'worker', r.job, singleMediaDirectory('resource', record?.title || '视频'));
    if (record) r = await requestOk(c, worker, 'worker', 'record', { ...auth(r.job), key: 'resource', result: record });
    r = await requestOk(c, worker, 'worker', 'course-result', {
      ...auth(r.job), result: { total: 1, remaining: 0, ...result }
    });
    assert.equal(r.ok, true);
    assert.equal(r.job.candidates[0].status, 'retry');
    assert.equal(r.job.candidates[0].remaining, 1);
    assert.equal(r.job.running, true);
    assert.equal(r.job.phase, 'course');
    assert.equal(r.job.candidates[0].retryRounds, 1);
    assert.match(r.job.logs.at(-1).text, /待重试.*自动继续/);
    if (record) {
      const saved = r.job.candidates[0].records.resource;
      for (const [key, value] of Object.entries(record)) assert.equal(saved[key], value);
      if (record.started || record.attempted) {
        assert.deepEqual(plain(r.job.candidates[0][record.ended ? 'unconfirmed' : 'unfinished']), [record.title]);
      }
      if (record.error) assert.deepEqual(plain(r.job.candidates[0].failures), [`${record.title}：${record.error}`]);
    }
    for (const [key, values] of Object.entries(result)) {
      assert.deepEqual(plain(r.job.candidates[0][key]), values);
    }
    assert.equal(c.navigation.length, 0);
  }
});

test('错误记录不得抹掉已开始义务，明确继续时允许重试且清理旧失败结果', async () => {
  const c = coordinator();
  const worker = c.addTab(learnUrl());
  let r = await c.request(worker, 'worker', 'start', { title: '课程' });
  r = await c.request(worker, 'worker', 'record', {
    ...auth(r.job), key: 'started', result: { title: '视频', started: true, ended: false, confirmed: false }
  });
  r = await c.request(worker, 'worker', 'record', {
    ...auth(r.job), key: 'started', result: { title: '视频', ended: false, confirmed: false, error: '播放停滞' }
  });
  assert.equal(r.job.candidates[0].records.started.started, true);
  r = await c.request(worker, 'worker', 'record', {
    ...auth(r.job), key: 'not-opened', result: { title: '未打开音频', ended: false, confirmed: false, error: '打开失败' }
  });
  const saved = c.storage.session['xinwei-job-v3'].candidates[0];
  saved.failures = ['旧错误'];
  saved.unconfirmed = ['旧待确认'];
  saved.unfinished = ['旧未结束'];
  r = await c.request(worker, 'worker', 'pause', auth(r.job));
  r = await c.request(worker, 'worker-new', 'start', { title: '课程' });
  const candidate = r.job.candidates[0];
  assert.equal(candidate.records.started.started, true);
  assert.equal(candidate.records.started.error, undefined);
  assert.equal(candidate.records['not-opened'].error, undefined);
  assert.equal(candidate.failures.length, 0);
  assert.equal(candidate.unconfirmed.length, 0);
  assert.equal(candidate.unfinished.length, 0);
});

test('重启后显式开始恢复精确课程的未结束和结束待确认记录，不自动续播', async () => {
  const c = coordinator();
  const worker = c.addTab(learnUrl());
  const snapshot = directorySnapshot([
    { key: 'unfinished', title: '视频', mediaType: 'video', durationSeconds: 60 },
    { key: 'unconfirmed', title: '音频', mediaType: 'audio', durationSeconds: 30 }
  ]);
  let r = await requestOk(c, worker, 'worker', 'start', { title: '课程' });
  r = await checkpointDirectory(c, worker, 'worker', r.job, snapshot);
  r = await requestOk(c, worker, 'worker', 'record', {
    ...auth(r.job), key: 'unfinished',
    result: { title: '视频', started: true, ended: false, confirmed: false, error: '停滞' }
  });
  r = await requestOk(c, worker, 'worker', 'record', {
    ...auth(r.job), key: 'unconfirmed', result: { title: '音频', ended: true, confirmed: false }
  });
  const oldRun = r.job.runId;
  c.restartBrowser();
  r = await requestOk(c, worker, 'worker-new', 'get');
  assert.equal(r.job.running, false);
  assert.equal(r.job.phase, 'interrupted');
  r = await requestOk(c, worker, 'worker-new', 'start', { title: '课程' });
  assert.notEqual(r.job.runId, oldRun);
  assert.equal(r.job.candidates[0].records.unfinished.started, true);
  assert.equal(r.job.candidates[0].records.unfinished.error, undefined);
  assert.equal(r.job.candidates[0].records.unconfirmed.ended, true);
  r = await checkpointDirectory(c, worker, 'worker-new', r.job, snapshot);
  r = await requestOk(c, worker, 'worker-new', 'course-result', {
    ...auth(r.job), result: { total: 2, remaining: 0 }
  });
  assert.equal(r.job.candidates[0].status, 'retry');
  assert.equal(r.job.candidates[0].remaining, 2);
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'course');
  assert.deepEqual(plain(r.job.candidates[0].unfinished), ['视频']);
  assert.deepEqual(plain(r.job.candidates[0].unconfirmed), ['音频']);
  assert.equal(r.job.candidates[0].records.unfinished.started, true);
  assert.equal(r.job.candidates[0].records.unfinished.ended, false);
  assert.equal(r.job.candidates[0].records.unconfirmed.ended, true);
  assert.equal(r.job.candidates[0].records.unconfirmed.confirmed, false);
});

test('学习页关闭后重新扫描，必须等课程和教学班身份确认才能恢复未结束记录', async () => {
  const c = coordinator();
  const snapshot = singleMediaDirectory('unfinished', '视频');
  const { home, worker, job } = await openCourse(c, snapshot);
  let r = await requestOk(c, worker, 'worker', 'record', {
    ...auth(job), key: 'unfinished', result: { title: '视频', started: true, ended: false, confirmed: false }
  });
  await c.closeTab(worker);
  r = await requestOk(c, home, 'home', 'start');
  assert.notEqual(r.job.runId, job.runId);
  assert.equal(r.job.phase, 'scan-home');
  r = await requestOk(c, home, 'home', 'scan-result', {
    ...auth(r.job),
    candidates: [{ title: '课程', key: '课程', status: 'uninspected', courseKey: 'course::class', records: { fake: { ended: true } } }]
  });
  assert.equal(Object.keys(r.job.candidates[0].records).length, 0);
  assert.equal(r.job.candidates[0].courseKey, undefined);
  r = await requestOk(c, home, 'home', 'open', { ...auth(r.job), index: 0, purpose: 'inspect' });
  const reopened = c.addTab(learnUrl(), home);
  r = await requestOk(c, reopened, 'new-worker', 'hello', { title: '课程' });
  assert.equal(r.job.candidates[0].records.unfinished.started, true);
  r = await checkpointDirectory(c, reopened, 'new-worker', r.job, snapshot);
  r = await requestOk(c, reopened, 'new-worker', 'course-result', {
    ...auth(r.job), result: { total: 1, remaining: 0 }
  });
  assert.equal(r.job.candidates[0].status, 'inspected');
  assert.equal(r.job.candidates[0].remaining, 1);
});

test('同标题但不同教学班不能继承重启前的播放记录', async () => {
  const c = coordinator();
  const original = c.addTab(learnUrl());
  let r = await c.request(original, 'old', 'start', { title: '课程' });
  await c.request(original, 'old', 'record', {
    ...auth(r.job), key: 'unfinished', result: { title: '视频', started: true, ended: false, confirmed: false }
  });
  c.restartBrowser();
  const differentClass = c.addTab(learnUrl('course', 'different-class'));
  r = await c.request(differentClass, 'new', 'start', { title: '课程' });
  assert.equal(Object.keys(r.job.candidates[0].records).length, 0);
  assert.equal(r.job.recoveryRecords['course::class'].unfinished.started, true);
});

test('明确恢复播放并自然结束、平台确认后，可以完成，不被上次错误留住', async () => {
  const c = coordinator();
  const worker = c.addTab(learnUrl());
  let r = await requestOk(c, worker, 'worker', 'start', { title: '课程' });
  r = await checkpointDirectory(c, worker, 'worker', r.job, singleMediaDirectory());
  r = await requestOk(c, worker, 'worker', 'record', {
    ...auth(r.job), key: 'video', result: { title: '视频', started: true, ended: false, confirmed: false, error: '停滞' }
  });
  r = await requestOk(c, worker, 'worker', 'pause', auth(r.job));
  r = await requestOk(c, worker, 'worker', 'start', { title: '课程' });
  r = await requestOk(c, worker, 'worker', 'record', {
    ...auth(r.job), key: 'video', result: { title: '视频', ended: true, confirmed: true }
  });
  r = await requestOk(c, worker, 'worker', 'course-result', {
    ...auth(r.job), result: { total: 1, remaining: 0, unconfirmed: [], unfinished: [], failures: [] }
  });
  assert.equal(r.job.candidates[0].status, 'completed');
  assert.equal(r.job.candidates[0].remaining, 0);
});

test('尝试打开失败不能冒充已打开，但重启后仍保留未结束义务和可重试状态', async () => {
  const c = coordinator();
  const worker = c.addTab(learnUrl());
  let r = await requestOk(c, worker, 'worker', 'start', { title: '课程' });
  r = await checkpointDirectory(c, worker, 'worker', r.job, singleMediaDirectory());
  r = await requestOk(c, worker, 'worker', 'record', {
    ...auth(r.job), key: 'video',
    result: { title: '视频', attempted: true, ended: false, confirmed: false, error: '加载失败' }
  });
  r = await requestOk(c, worker, 'worker', 'record', {
    ...auth(r.job), key: 'video', result: { title: '视频', ended: false, confirmed: false, error: '仍加载失败' }
  });
  assert.equal(r.job.candidates[0].records.video.attempted, true);
  assert.equal(r.job.candidates[0].records.video.started, undefined);
  c.restartBrowser();
  r = await requestOk(c, worker, 'new-worker', 'start', { title: '课程' });
  const record = r.job.candidates[0].records.video;
  assert.equal(record.attempted, true);
  assert.equal(record.started, undefined);
  assert.equal(record.error, undefined);
  r = await checkpointDirectory(c, worker, 'new-worker', r.job, singleMediaDirectory());
  r = await requestOk(c, worker, 'new-worker', 'course-result', {
    ...auth(r.job), result: { total: 1, remaining: 0 }
  });
  assert.equal(r.job.candidates[0].status, 'retry');
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'course');
  assert.equal(r.job.candidates[0].remaining, 1);
  assert.equal(r.job.candidates[0].unfinished[0], '视频');
  assert.equal(r.job.candidates[0].records.video.attempted, true);
  assert.equal(r.job.candidates[0].records.video.started, undefined);
  assert.notEqual(r.job.candidates[0].records.video.ended, true);
});

test('兼容 1.3.3 没有开始或尝试标记的错误记录，重启恢复后仍不得跳过', async () => {
  const c = coordinator();
  const worker = c.addTab(learnUrl());
  const snapshot = singleMediaDirectory('legacy-error', '旧版未结束视频');
  let r = await requestOk(c, worker, 'worker', 'start', { title: '课程' });
  r = await checkpointDirectory(c, worker, 'worker', r.job, snapshot);
  r = await requestOk(c, worker, 'worker', 'record', {
    ...auth(r.job), key: 'legacy-error',
    result: { title: '旧版未结束视频', ended: false, confirmed: false, error: '音视频长时间没有播放进展' }
  });
  assert.equal(r.job.candidates[0].records['legacy-error'].started, undefined);
  assert.equal(r.job.candidates[0].records['legacy-error'].attempted, undefined);
  c.restartBrowser();
  r = await requestOk(c, worker, 'new-worker', 'start', { title: '课程' });
  const record = r.job.candidates[0].records['legacy-error'];
  assert.equal(record.started, undefined);
  assert.equal(record.attempted, true);
  assert.equal(record.error, undefined);
  r = await checkpointDirectory(c, worker, 'new-worker', r.job, snapshot);
  r = await requestOk(c, worker, 'new-worker', 'course-result', {
    ...auth(r.job), result: { total: 1, remaining: 0 }
  });
  assert.equal(r.job.candidates[0].status, 'retry');
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'course');
  assert.equal(r.job.candidates[0].remaining, 1);
  assert.equal(r.job.candidates[0].unfinished[0], '旧版未结束视频');
  assert.equal(r.job.candidates[0].records['legacy-error'].attempted, true);
  assert.equal(r.job.candidates[0].records['legacy-error'].started, undefined);
  assert.equal(r.job.candidates[0].records['legacy-error'].ended, false);
});

async function countedCourse(c) {
  const opened = await openCourse(c);
  const r = await requestOk(c, opened.worker, 'worker', 'course-result', {
    ...auth(opened.job), result: { total: 2, remaining: 2 }
  });
  return { ...opened, job: r.job };
}

test('只保存实际学习页核对成功的入口，首页字段不能自称可信入口', async () => {
  const c = coordinator();
  const home = c.addTab(HOME);
  let r = await c.request(home, 'home', 'start');
  r = await c.request(home, 'home', 'scan-result', {
    ...auth(r.job), candidates: [{
      title: '课程', key: '课程', status: 'uninspected',
      courseKey: 'made-up', learnUrl: 'https://other.example/student/#/courseInfo/learn/courseWare/made-up'
    }]
  });
  assert.equal(r.job.candidates[0].learnUrl, undefined);
  assert.equal(r.job.candidates[0].courseKey, undefined);
  r = await c.request(home, 'home', 'open', { ...auth(r.job), index: 0, purpose: 'inspect' });
  const worker = c.addTab(learnUrl(), home);
  const loading = await c.request(worker, 'worker', 'hello', { title: '' });
  assert.equal(loading.job.candidates[0].learnUrl, undefined);
  r = await c.request(worker, 'worker', 'hello', { title: '课程' });
  assert.equal(r.job.candidates[0].learnUrl, learnUrl());
});

test('播放在原首页标签导航，新学习文档接管后刷新继续原课程计划', async () => {
  const c = coordinator();
  const { home, job } = await countedCourse(c);
  const before = c.navigation.length;
  let r = await c.request(home, 'home', 'open', { ...auth(job), index: 0, purpose: 'play' });
  assert.equal(c.navigation.length, before + 1);
  assert.equal(c.navigation.at(-1).id, home);
  assert.equal(c.navigation.at(-1).url, learnUrl());
  assert.equal(r.job.ownerInstance, null);
  assert.equal(r.job.workerTabId, home);
  // The old homepage cannot reclaim ownership during the navigation.
  c.tabs.get(home).url = HOME;
  const old = await c.request(home, 'home', 'hello');
  assert.equal(old.job.ownerInstance, null);
  assert.equal(old.job.phase, 'opening');
  c.tabs.get(home).url = learnUrl();
  r = await c.request(home, 'learn-document', 'hello', { title: '课程' });
  assert.equal(r.job.phase, 'course');
  assert.equal(r.job.ownerInstance, 'learn-document');
  const generation = r.job.generation;
  r = await c.request(home, 'refreshed-document', 'hello', { title: '课程' });
  assert.equal(r.job.running, true);
  assert.equal(r.job.scope, 'all');
  assert.equal(r.job.runId, job.runId);
  assert.equal(r.job.ownerInstance, 'refreshed-document');
  assert.equal(r.job.generation, generation + 1);
  assert.equal(r.job.candidates[0].remaining, 2);
  assert.equal(r.job.inspectIndex, 1);
});

test('同标签导航前暂停阻止发出导航，明确继续后只发一次', async () => {
  const c = coordinator();
  const { home, job } = await countedCourse(c);
  const page = { location: { href: HOME } };
  c.connect(home)(page);
  let pauseRequest;
  page.chrome.runtime.onMessage.addListener(message => {
    if (message.job.phase === 'opening' && message.job.running && !pauseRequest) {
      pauseRequest = c.request(home, 'home', 'pause', auth(message.job));
    }
  });
  const before = c.navigation.length;
  await c.request(home, 'home', 'open', { ...auth(job), index: 0, purpose: 'play' });
  const paused = await pauseRequest;
  assert.equal(paused.job.running, false);
  assert.equal(c.navigation.length, before);
  const resumed = await c.request(home, 'home', 'start');
  assert.equal(resumed.job.running, true);
  assert.equal(resumed.job.phase, 'opening');
  assert.equal(resumed.job.ownerInstance, null);
  assert.equal(c.navigation.length, before + 1);
  assert.equal(c.navigation.at(-1).url, learnUrl());
});

test('导航发出后暂停，落地文档不能自动播放，继续不重复发出网址导航', async () => {
  const c = coordinator();
  const { home, job } = await countedCourse(c);
  let r = await c.request(home, 'home', 'open', { ...auth(job), index: 0, purpose: 'play' });
  const before = c.navigation.filter(n => n.url).length;
  r = await c.request(home, 'home', 'pause', auth(r.job));
  r = await c.request(home, 'learn-document', 'hello', { title: '课程' });
  assert.equal(r.job.running, false);
  assert.equal(r.job.ownerInstance, null);
  r = await c.request(home, 'learn-document', 'start', { title: '课程' });
  assert.equal(r.job.phase, 'opening');
  r = await c.request(home, 'learn-document', 'hello', { title: '课程' });
  assert.equal(r.job.phase, 'course');
  assert.equal(r.job.running, true);
  assert.equal(c.navigation.filter(n => n.url).length, before);
});

test('同标签返回等新首页确认，旧学习实例不能选课，随后首页刷新自动接回', async () => {
  const c = coordinator();
  const { home, job } = await countedCourse(c);
  let r = await c.request(home, 'home', 'open', { ...auth(job), index: 0, purpose: 'play' });
  r = await c.request(home, 'learn-document', 'hello', { title: '课程' });
  r = await c.request(home, 'learn-document', 'course-result', {
    ...auth(r.job), result: { total: 2, remaining: 0 }
  });
  assert.equal(r.job.returningTabId, home);
  assert.equal(r.job.ownerInstance, null);
  assert.equal(c.navigation.at(-1).url, HOME);
  c.tabs.get(home).url = learnUrl();
  const old = await c.request(home, 'learn-document', 'hello', { title: '课程' });
  assert.equal(old.job.ownerInstance, null);
  assert.equal(old.job.returningTabId, home);
  const late = await c.request(home, 'learn-document', 'finish', auth(old.job));
  assert.equal(late.error, 'TASK_CANCELLED');
  c.tabs.get(home).url = HOME;
  r = await c.request(home, 'new-home', 'hello');
  assert.equal(r.job.ownerInstance, 'new-home');
  assert.equal(r.job.returningTabId, undefined);
  assert.equal(r.job.returnDeadline, undefined);
  const generation = r.job.generation;
  r = await c.request(home, 'refreshed-home', 'hello');
  assert.equal(r.job.running, true);
  assert.equal(r.job.ownerInstance, 'refreshed-home');
  assert.equal(r.job.generation, generation + 1);
});

test('返回同标签导航前暂停，继续完成返回；落地仍停止直到明确继续', async () => {
  const c = coordinator();
  const { home, job } = await countedCourse(c);
  let r = await c.request(home, 'home', 'open', { ...auth(job), index: 0, purpose: 'play' });
  r = await c.request(home, 'learn-document', 'hello', { title: '课程' });
  const page = { location: { href: learnUrl() } };
  c.connect(home)(page);
  let pauseRequest;
  page.chrome.runtime.onMessage.addListener(message => {
    if (message.job.returningTabId === home && message.job.running && !pauseRequest) {
      pauseRequest = c.request(home, 'learn-document', 'pause', auth(message.job));
    }
  });
  const before = c.navigation.filter(n => n.url).length;
  await c.request(home, 'learn-document', 'course-result', {
    ...auth(r.job), result: { total: 2, remaining: 0 }
  });
  const paused = await pauseRequest;
  assert.equal(paused.job.returningTabId, home);
  assert.equal(c.navigation.filter(n => n.url).length, before);
  r = await c.request(home, 'learn-document', 'start', { title: '课程' });
  assert.equal(c.navigation.at(-1).url, HOME);
  r = await c.request(home, 'learn-document', 'pause', auth(r.job));
  r = await c.request(home, 'new-home', 'hello');
  assert.equal(r.job.running, false);
  assert.equal(r.job.returningTabId, home);
  r = await c.request(home, 'new-home', 'start');
  assert.equal(r.job.running, true);
  assert.equal(r.job.returningTabId, undefined);
  assert.equal(r.job.ownerInstance, 'new-home');
});

test('返回首页未落地接管时保持任务并退避，接管前不能宣称完成且暂停可取消', async () => {
  const c = coordinator();
  const { home, job } = await countedCourse(c);
  let r = await requestOk(c, home, 'home', 'open', { ...auth(job), index: 0, purpose: 'play' });
  r = await requestOk(c, home, 'learn-document', 'hello', { title: '课程' });
  r = await requestOk(c, home, 'learn-document', 'course-result', {
    ...auth(r.job), result: { total: 2, remaining: 0 }
  });
  c.storage.session['xinwei-job-v3'].returnDeadline = Date.now() - 1;
  const before = c.navigation.length;
  r = await requestOk(c, home, 'learn-document', 'get');
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'home');
  assert.equal(r.job.returningTabId, home);
  assert.equal(r.job.ownerInstance, null);
  assert.equal(r.job.navigationRecovery.attempts, 1);
  assert.equal(r.job.returnDeadline, r.job.navigationRecovery.nextRetryAt);
  assert.ok(r.job.returnDeadline > Date.now());
  const persisted = plain(r.job.navigationRecovery);
  c.restartWorker();
  r = await requestOk(c, home, 'learn-document', 'get');
  assert.deepEqual(plain(r.job.navigationRecovery), persisted);
  assert.equal(r.job.ownerInstance, null);
  assert.equal(r.job.running, true);
  assert.equal(c.navigation.length, before);
  const prematureFinish = await c.request(home, 'learn-document', 'finish', auth(r.job));
  assert.equal(prematureFinish.error, 'TASK_CANCELLED');

  for (const attempts of [2, 3, 4]) {
    c.storage.session['xinwei-job-v3'].returnDeadline = Date.now() - 1;
    c.storage.session['xinwei-job-v3'].navigationRecovery.nextRetryAt = Date.now() - 1;
    const checkedAt = Date.now();
    r = await requestOk(c, home, 'learn-document', 'get');
    const delay = attempts === 4 ? 300000 : 45000;
    assert.equal(r.job.navigationRecovery.attempts, attempts);
    assert.ok(r.job.navigationRecovery.nextRetryAt >= checkedAt + delay);
    assert.ok(r.job.navigationRecovery.nextRetryAt <= Date.now() + delay);
    assert.equal(r.job.running, true);
    assert.equal(r.job.ownerInstance, null);
    assert.equal(c.navigation.length, before);
  }
  const beforePause = r.job;
  r = await requestOk(c, home, 'learn-document', 'pause', auth(r.job));
  c.storage.session['xinwei-job-v3'].returnDeadline = Date.now() - 1;
  c.storage.session['xinwei-job-v3'].navigationRecovery.nextRetryAt = Date.now() - 1;
  c.restartWorker();
  r = await requestOk(c, home, 'learn-document', 'get');
  assert.equal(r.job.running, false);
  assert.equal(r.job.phase, 'paused');
  assert.equal(r.job.navigationRecovery.attempts, 4);
  r = await requestOk(c, home, 'new-home', 'hello');
  assert.equal(r.job.running, false);
  assert.equal(r.job.ownerInstance, null);
  const late = await c.request(home, 'learn-document', 'finish', auth(beforePause));
  assert.equal(late.error, 'TASK_CANCELLED');
  assert.equal(c.navigation.length, before);
});

test('已返回首页时旧学习文档迟到的继续不能冒充新首页实例', async () => {
  const c = coordinator();
  const { home, job } = await countedCourse(c);
  let r = await c.request(home, 'home', 'open', { ...auth(job), index: 0, purpose: 'play' });
  r = await c.request(home, 'learn-document', 'hello', { title: '课程' });
  r = await c.request(home, 'learn-document', 'course-result', {
    ...auth(r.job), result: { total: 2, remaining: 0 }
  });
  r = await c.request(home, 'learn-document', 'pause', auth(r.job), learnUrl());
  r = await c.request(home, 'learn-document', 'start', { title: '课程' }, learnUrl());
  assert.equal(r.job.ownerInstance, null);
  assert.equal(r.job.homeInstance, null);
  assert.equal(r.job.returningTabId, home);
  r = await c.request(home, 'new-home', 'hello');
  assert.equal(r.job.ownerInstance, 'new-home');
  assert.equal(r.job.returningTabId, undefined);
  assert.equal(r.job.running, true);
});

test('未验证或身份不符的入口不能导航，包括外站和其他教学班', async () => {
  for (const url of [
    undefined, 'https://other.example/student/#/courseInfo/learn/courseWare/course/video/res?classId=class',
    learnUrl('course', 'wrong-class'), 'https://www.beeline-ai.com/wrong/#/courseInfo/learn/courseWare/course/video/res?classId=class'
  ]) {
    const c = coordinator();
    const { home, job } = await countedCourse(c);
    c.storage.session['xinwei-job-v3'].candidates[0].learnUrl = url;
    const before = c.navigation.length;
    const r = await c.request(home, 'home', 'open', { ...auth(job), index: 0, purpose: 'play' });
    assert.equal(r.ok, false);
    assert.match(r.error, /入口尚未核对/);
    assert.equal(c.navigation.length, before);
  }
});

test('目录和当前资源检查点落盘，刷新保留首轮统计及未结束断点', async () => {
  const c = coordinator();
  const { home, job } = await countedCourse(c);
  let r = await c.request(home, 'home', 'open', { ...auth(job), index: 0, purpose: 'play' });
  r = await c.request(home, 'learn', 'hello', { title: '课程' });
  const snapshot = directorySnapshot();
  snapshot.courseKey = 'course::class';
  snapshot.signature = 'complete-directory';
  snapshot.confirmed = true;
  snapshot.items[0].ended = true;
  r = await c.request(home, 'learn', 'directory-checkpoint', { ...auth(r.job), snapshot });
  assert.equal(r.ok, true);
  assert.equal(r.job.candidates[0].directory.items.length, 3);
  assert.equal(r.job.candidates[0].directory.confirmed, undefined);
  assert.equal(r.job.candidates[0].directory.items[0].ended, undefined);
  assert.equal(r.job.candidates[0].total, 2);
  assert.equal(r.job.candidates[0].remaining, 2);
  r = await c.request(home, 'learn', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'opening', routeKey: ''
  });
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.job.candidates[0].currentResource), {
    key: 'video', title: '视频', stage: 'opening', routeKey: ''
  });
  assert.equal(r.job.candidates[0].records.video.attempted, true);
  assert.equal(r.job.candidates[0].records.video.started, undefined);
  assert.equal(r.job.candidates[0].records.video.ended, false);
  assert.equal(r.job.candidates[0].records.video.confirmed, false);
  r = await c.request(home, 'learn', 'record', {
    ...auth(r.job), key: 'video', result: { title: '视频', started: true, ended: false, confirmed: false }
  });
  const before = r.job;
  r = await c.request(home, 'refreshed', 'hello', { title: '课程' });
  assert.equal(r.job.runId, before.runId);
  assert.equal(r.job.scope, before.scope);
  assert.equal(r.job.inspectIndex, before.inspectIndex);
  assert.equal(r.job.targetIndex, before.targetIndex);
  assert.equal(r.job.targetPurpose, before.targetPurpose);
  assert.deepEqual(plain(r.job.candidates), plain(before.candidates));
  assert.equal(c.storage.local['xinwei-job-v3'].running, false);
  assert.deepEqual(c.storage.local['xinwei-job-v3'].candidates, plain(r.job.candidates));
  const navigations = c.navigation.length;
  const staleResult = await c.request(home, 'learn', 'course-result', {
    ...auth(before), result: { total: 0, remaining: 0 }
  });
  assert.equal(staleResult.error, 'TASK_CANCELLED');
  assert.equal(c.navigation.length, navigations);
});

test('目录检查点整体校验，不接受伪造身份、重复key、类型或非法时长', async () => {
  const invalidSnapshots = [
    { version: 2, items: [] },
    { version: 1, courseKey: 'course::another-class', items: [] },
    { version: 1, items: 'not-an-array' },
    directorySnapshot([{ key: '', title: '视频', mediaType: 'video', durationSeconds: 1 }]),
    directorySnapshot([{ key: 'x', title: '', mediaType: 'video', durationSeconds: 1 }]),
    directorySnapshot([{ key: 'x', title: '视频', mediaType: 'unknown', durationSeconds: 1 }]),
    directorySnapshot([{ key: 'x', title: '视频', mediaType: 'video', durationSeconds: -1 }]),
    directorySnapshot([{ key: 'x', title: '视频', mediaType: 'video', durationSeconds: '60' }]),
    directorySnapshot([{ key: 'x', title: '视频', mediaType: 'video' }]),
    directorySnapshot([
      { key: 'same', title: '一', mediaType: 'video', durationSeconds: 1 },
      { key: 'same', title: '二', mediaType: 'audio', durationSeconds: 2 }
    ])
  ];
  const c = coordinator();
  const id = c.addTab(learnUrl());
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  r = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot: directorySnapshot() });
  const saved = plain(r.job.candidates[0].directory);
  for (const snapshot of invalidSnapshots) {
    const rejected = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /目录/);
    assert.deepEqual(c.storage.session['xinwei-job-v3'].candidates[0].directory, saved);
  }
});

for (const { name, snapshot, total } of [
  { name: '缺少目录', total: 0 },
  { name: '空目录', snapshot: directorySnapshot([]), total: 0 },
  { name: '音视频数量不符', snapshot: singleMediaDirectory(), total: 2 }
]) {
  test(`课程结果在${name}时拒绝完成，保留当前任务且不导航`, async () => {
    const c = coordinator();
    const id = c.addTab(learnUrl());
    let r = await requestOk(c, id, 'owner', 'start', { title: '课程' });
    if (snapshot) r = await checkpointDirectory(c, id, 'owner', r.job, snapshot);
    const before = plain(r.job);
    const rejected = await c.request(id, 'owner', 'course-result', {
      ...auth(r.job), result: { total, remaining: 0 }
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /已保存的完整目录不符/);
    const current = await requestOk(c, id, 'owner', 'get');
    assert.equal(current.job.running, true);
    assert.equal(current.job.phase, 'course');
    assert.deepEqual(plain(current.job.candidates), before.candidates);
    assert.equal(c.navigation.length, 0);
  });
}

test('资源断点必须指向目录中的唯一播放项，不能把文档或已结束项当作续播', async () => {
  const c = coordinator();
  const id = c.addTab(learnUrl());
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  const checkpoint = { key: 'video', title: '视频', stage: 'opening', routeKey: '' };
  let rejected = await c.request(id, 'owner', 'resource-checkpoint', { ...auth(r.job), ...checkpoint });
  assert.equal(rejected.ok, false);
  r = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot: directorySnapshot() });
  for (const invalid of [
    { key: 'missing' }, { title: '另一个标题' }, { key: 'document', title: '文档' },
    { stage: 'ended' }, { routeKey: '/student/#/made-up' }
  ]) {
    rejected = await c.request(id, 'owner', 'resource-checkpoint', {
      ...auth(r.job), ...checkpoint, ...invalid
    });
    assert.equal(rejected.ok, false);
  }
  r = await c.request(id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), ...checkpoint, stage: 'ready', routeKey: routeKey(learnUrl())
  });
  assert.equal(r.ok, true);
  r = await c.request(id, 'owner', 'record', {
    ...auth(r.job), key: 'audio', result: { title: '音频', ended: true, confirmed: true }
  });
  assert.equal(r.job.candidates[0].currentResource.key, 'video');
  r = await c.request(id, 'owner', 'record', {
    ...auth(r.job), key: 'video', result: {
      title: '视频', ended: true, confirmed: false,
      playbackAttempt: { events: [{ type: 'ended', ended: true }], finished: { ended: true, currentTime: 60 } }
    }
  });
  assert.equal(r.job.candidates[0].currentResource, undefined);
  r = await c.request(id, 'owner', 'record', {
    ...auth(r.job), key: 'video', result: { title: '视频', ended: true, confirmed: true }
  });
  r = await c.request(id, 'owner', 'record', {
    ...auth(r.job), key: 'video', result: {
      title: '视频', ended: false, confirmed: false, error: '迟到错误',
      playbackAttempt: { events: [], before: { ended: false, currentTime: 0 } }
    }
  });
  assert.equal(r.job.candidates[0].records.video.ended, true);
  assert.equal(r.job.candidates[0].records.video.confirmed, true);
  assert.equal(r.job.candidates[0].records.video.error, undefined);
  assert.equal(r.job.candidates[0].records.video.playbackAttempt.finished.ended, true);
  assert.equal(r.job.candidates[0].records.video.playbackAttempt.events[0].type, 'ended');
  rejected = await c.request(id, 'owner', 'resource-checkpoint', { ...auth(r.job), ...checkpoint });
  assert.equal(rejected.ok, false);
});

test('刷新回到同课默认资源时先返回原入口，接管后opening和ready仍精确核对', async () => {
  const c = coordinator();
  const id = c.addTab(learnUrl());
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  r = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot: directorySnapshot() });
  const targetRoute = routeKey(learnUrl());
  r = await c.request(id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: targetRoute
  });
  const defaultUrl = learnUrl().replace('/video/res?', '/video/default?');
  c.tabs.get(id).url = defaultUrl;
  r = await c.request(id, 'refreshed', 'hello', { title: '课程' });
  assert.equal(r.job.running, true);
  assert.equal(r.job.interruption.attempts, 1);
  assert.equal(r.job.ownerInstance, null);
  assert.equal(c.navigation.at(-1).url, learnUrl());
  const premature = await c.request(id, 'refreshed', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'opening', routeKey: targetRoute
  });
  assert.equal(premature.ok, false, 'The departed default page cannot claim the saved resource');
  r = await c.request(id, 'returned', 'hello', { title: '课程' });
  r = await c.request(id, 'returned', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'opening', routeKey: targetRoute
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.candidates[0].currentResource.routeKey, targetRoute);
  assert.equal(r.job.candidates[0].records.video.attempted, true);
  assert.equal(r.job.candidates[0].records.video.started, undefined);
  const wrongReady = await c.request(id, 'returned', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(defaultUrl)
  });
  assert.equal(wrongReady.ok, false);
  const arbitrary = await c.request(id, 'returned', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'opening',
    routeKey: targetRoute.replace('/video/res?', '/video/made-up?')
  });
  assert.equal(arbitrary.ok, false);
  for (const downgradedRoute of ['', routeKey(defaultUrl)]) {
    const downgraded = await c.request(id, 'returned', 'resource-checkpoint', {
      ...auth(r.job), key: 'video', title: '视频', stage: 'opening', routeKey: downgradedRoute
    });
    assert.equal(downgraded.ok, false);
    assert.equal(c.storage.session['xinwei-job-v3'].candidates[0].currentResource.routeKey, targetRoute);
  }
  c.tabs.get(id).url = learnUrl();
  r = await c.request(id, 'returned', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: targetRoute
  });
  assert.equal(r.ok, true);
});

test('首页扫描字段不能自称可信目录或当前资源断点', async () => {
  const c = coordinator();
  const id = c.addTab(HOME);
  let r = await c.request(id, 'home', 'start');
  r = await c.request(id, 'home', 'scan-result', {
    ...auth(r.job), candidates: [{
      title: '课程', key: '课程', status: 'uninspected',
      directory: directorySnapshot(), currentResource: { key: 'video', title: '视频' }
    }]
  });
  assert.equal(r.job.candidates[0].directory, undefined);
  assert.equal(r.job.candidates[0].currentResource, undefined);
});

test('刷新标题尚空只等待，完整标题就绪后接管；退役文档不能再次夺回', async () => {
  const c = coordinator();
  const id = c.addTab(learnUrl());
  const initial = await c.request(id, 'first', 'start', { title: '课程' });
  let r = await c.request(id, 'second', 'hello', { title: '' });
  assert.equal(r.job.running, true);
  assert.equal(r.job.ownerInstance, 'first');
  assert.equal(r.job.generation, initial.job.generation);
  r = await c.request(id, 'second', 'hello', { title: '课程' });
  assert.equal(r.job.ownerInstance, 'second');
  assert.equal(r.job.generation, initial.job.generation + 1);
  c.restartWorker();
  const lateHello = await c.request(id, 'first', 'hello', { title: '课程' });
  assert.equal(lateHello.job.ownerInstance, 'second');
  assert.equal(lateHello.job.generation, r.job.generation);
  const staleGeneration = await c.request(id, 'second', 'record', {
    ...auth(initial.job), key: 'video', result: { title: '视频', ended: true, confirmed: true }
  });
  assert.equal(staleGeneration.error, 'TASK_CANCELLED');
  const staleInstance = await c.request(id, 'first', 'record', {
    ...auth(r.job), key: 'video', result: { title: '视频', ended: true, confirmed: true }
  });
  assert.equal(staleInstance.error, 'TASK_CANCELLED');
  const valid = await c.request(id, 'second', 'record', {
    ...auth(r.job), key: 'video', result: { title: '视频', started: true, ended: false, confirmed: false }
  });
  assert.equal(valid.ok, true);
});

test('已退休首页不能覆盖新的非执行首页接力实例', async () => {
  const c = coordinator();
  const { home, worker, job } = await openCourse(c, singleMediaDirectory());
  let r = await c.request(home, 'new-home', 'hello');
  assert.equal(r.job.homeInstance, 'new-home');
  r = await c.request(home, 'home', 'hello');
  assert.equal(r.job.homeInstance, 'new-home');
  r = await requestOk(c, worker, 'worker', 'course-result', {
    ...auth(job), result: { total: 1, remaining: 1 }
  });
  assert.equal(r.job.ownerInstance, 'new-home');
});

test('刷新或误触进入同源课程页、课表后，仅重试已保存的课程入口', async () => {
  for (const url of [learnUrl('different-course'), learnUrl('course', 'different-class'), HOME]) {
    const c = coordinator();
    const id = c.addTab(learnUrl());
    await c.request(id, 'owner', 'start', { title: '课程' });
    c.tabs.get(id).url = url;
    const recovered = await c.request(id, 'refreshed', 'hello', { title: '课程' });
    assert.equal(recovered.job.running, true);
    assert.equal(recovered.job.phase, 'course');
    assert.equal(recovered.job.ownerInstance, null);
    assert.equal(recovered.job.interruption.attempts, 1);
    assert.equal(c.navigation.at(-1).url, learnUrl());
  }
  for (const url of ['https://www.beeline-ai.com/login', 'https://www.beeline-ai.com/account']) {
    const c = coordinator();
    const id = c.addTab(learnUrl());
    await c.request(id, 'owner', 'start', { title: '课程' });
    c.tabs.get(id).url = url;
    const blocked = await c.request(id, 'refreshed', 'hello', { title: '课程' });
    assert.equal(blocked.job.running, false);
    assert.equal(blocked.job.phase, 'manual');
    assert.equal(blocked.job.ownerInstance, 'owner');
    assert.equal(c.navigation.length, 0);
  }
});

test('误触后的站内导航升级仍算同一次尝试，连续三次失败才停止整轮', async () => {
  const c = coordinator();
  const id = c.addTab(learnUrl());
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  r = await checkpointDirectory(c, id, 'owner', r.job, singleMediaDirectory());
  r = await requestOk(c, id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(learnUrl())
  });
  r = await requestOk(c, id, 'owner', 'interruption-attempt', {
    ...auth(r.job), key: 'video', reason: '播放器停止'
  });
  const episodeId = r.job.interruption.id;
  assert.equal(r.job.interruption.attempts, 1);
  c.tabs.get(id).url = 'https://www.beeline-ai.com/student/#/courseInfo/course/project/class';
  r = await requestOk(c, id, 'owner', 'interruption-attempt', {
    ...auth(r.job), episodeId, key: 'video', navigate: true, reason: '误触项目页'
  });
  assert.equal(r.job.interruption.attempts, 1);
  assert.equal(c.navigation.at(-1).url, learnUrl());
  r = await requestOk(c, id, 'replacement', 'hello', { title: '课程' });
  assert.equal(r.job.interruption.attempts, 1);
  for (const attempt of [1, 2, 3]) {
    r = await requestOk(c, id, 'replacement', 'interruption-failed', {
      ...auth(r.job), episodeId, reason: '未持续播放'
    });
    if (attempt === 3) {
      assert.equal(r.job.running, false);
      assert.equal(r.job.phase, 'manual');
      assert.equal(r.job.interruption.attempts, 3);
      break;
    }
    assert.equal(r.job.running, true);
    r = await requestOk(c, id, 'replacement', 'interruption-attempt', {
      ...auth(r.job), episodeId, key: 'video', reason: '再次尝试'
    });
    assert.equal(r.job.interruption.attempts, attempt + 1);
  }
});

test('误触项目页后回到已保存的精确音视频路由，不落在课程默认资源', async () => {
  const c = coordinator();
  const entry = learnUrl();
  const target = entry.replace('/video/res?', '/video/second?');
  const id = c.addTab(entry);
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  r = await checkpointDirectory(c, id, 'owner', r.job, singleMediaDirectory());
  r = await requestOk(c, id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'opening', routeKey: ''
  });
  c.tabs.get(id).url = target;
  r = await requestOk(c, id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(target)
  });
  c.tabs.get(id).url = 'https://www.beeline-ai.com/student/#/courseInfo/course/project/class';
  r = await requestOk(c, id, 'owner', 'hello', { title: '课程' });
  assert.equal(r.job.running, true);
  assert.equal(r.job.interruption.attempts, 1);
  assert.equal(c.navigation.at(-1).url, target);
  assert.notEqual(c.navigation.at(-1).url, entry);
});

test('返回资源导航授权保存时收到插件暂停，取消导航并拒绝旧文档复活', async () => {
  const c = coordinator();
  const id = c.addTab(learnUrl());
  const page = { location: { href: learnUrl() } };
  c.connect(id)(page);
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  r = await checkpointDirectory(c, id, 'owner', r.job, singleMediaDirectory());
  r = await requestOk(c, id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(learnUrl())
  });
  const before = r.job;
  let cancellation;
  page.chrome.runtime.onMessage.addListener(message => {
    if (message.job.interruption?.status === 'navigating' && message.job.running && !cancellation) {
      cancellation = c.request(id, 'owner', 'pause', { ...auth(before), reason: '用户点击插件暂停' });
    }
  });
  c.tabs.get(id).url = 'https://www.beeline-ai.com/student/#/courseInfo/course/project/class';
  r = await c.request(id, 'owner', 'interruption-attempt', {
    ...auth(before), key: 'video', navigate: true, reason: '误触项目页'
  });
  assert.ok(cancellation);
  await cancellation;
  const stopped = await c.request(id, 'owner', 'get');
  assert.equal(stopped.job.running, false);
  assert.equal(stopped.job.phase, 'paused');
  assert.equal(c.navigation.filter(entry => entry.url).length, 0);
  const late = await c.request(id, 'owner', 'interruption-success', {
    ...auth(before), episodeId: r.job.interruption?.id, key: 'video'
  });
  assert.equal(late.ok, false);
});

test('恢复预算只有目标音视频持续自然播放后清零，平台完成单独记账', async () => {
  const c = coordinator();
  const id = c.addTab(learnUrl());
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  r = await checkpointDirectory(c, id, 'owner', r.job, singleMediaDirectory());
  r = await requestOk(c, id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(learnUrl())
  });
  r = await requestOk(c, id, 'owner', 'interruption-attempt', {
    ...auth(r.job), key: 'video', reason: '播放中断'
  });
  const first = r.job.interruption.id;
  let premature = await c.request(id, 'owner', 'interruption-success', {
    ...auth(r.job), episodeId: first, key: 'video',
    evidence: { courseKey: 'course::class', key: 'video', routeKey: routeKey(learnUrl()),
      from: 20, to: 21, elapsedMs: 1000 }
  });
  assert.equal(premature.ok, false);
  assert.equal(c.storage.session['xinwei-job-v3'].interruption.attempts, 1);
  r = await requestOk(c, id, 'owner', 'interruption-success', {
    ...auth(r.job), episodeId: first, key: 'video',
    evidence: { courseKey: 'course::class', key: 'video', routeKey: routeKey(learnUrl()),
      from: 20, to: 26, elapsedMs: 9000 }
  });
  assert.equal(r.job.interruption, undefined);
  r = await requestOk(c, id, 'owner', 'interruption-attempt', {
    ...auth(r.job), key: 'video', reason: '另一轮中断'
  });
  assert.equal(r.job.interruption.attempts, 1);
  const second = r.job.interruption.id;
  const pageOnly = await c.request(id, 'owner', 'interruption-success', {
    ...auth(r.job), episodeId: second, key: 'video', pageConfirmed: true
  });
  assert.equal(pageOnly.ok, false);
  assert.match(pageOnly.error, /自然播放结束/);
  r = await requestOk(c, id, 'owner', 'record', {
    ...auth(r.job), key: 'video', result: { ended: true, confirmed: true }
  });
  r = await requestOk(c, id, 'owner', 'interruption-success', {
    ...auth(r.job), episodeId: second, key: 'video', pageConfirmed: true
  });
  assert.equal(r.job.interruption, undefined);
  assert.equal(r.job.candidates[0].records.video.ended, true);
  assert.equal(r.job.candidates[0].records.video.confirmed, true);
});

test('暂停和人工停止后的刷新hello不能自动恢复，退役实例也不能点击继续', async () => {
  for (const action of ['pause', 'manual']) {
    const c = coordinator();
    const id = c.addTab(learnUrl());
    let r = await c.request(id, 'old', 'start', { title: '课程' });
    r = await c.request(id, 'current', 'hello', { title: '课程' });
    r = await c.request(id, 'current', action, { ...auth(r.job), reason: '用户要求停止' });
    const generation = r.job.generation;
    r = await c.request(id, 'new', 'hello', { title: '课程' });
    assert.equal(r.job.running, false);
    assert.equal(r.job.generation, generation);
    r = await c.request(id, 'old', 'start', { title: '课程' });
    assert.equal(r.job.running, false);
    assert.equal(r.job.generation, generation);
  }
});

test('后台读取接管时先收到旧代数暂停或人工停止，不因刷新增加代数逃过取消', async () => {
  for (const action of ['pause', 'manual']) {
    const c = coordinator();
    const id = c.addTab(learnUrl());
    const initial = await c.request(id, 'owner', 'start', { title: '课程' });
    c.restartWorker();
    const takeover = c.request(id, 'new', 'hello', { title: '课程' });
    const cancellation = c.request(id, 'owner', action, { ...auth(initial.job), reason: '立即停止' });
    const resumed = await takeover;
    const stopped = await cancellation;
    assert.equal(resumed.job.ownerInstance, 'owner');
    assert.equal(resumed.job.generation, initial.job.generation);
    assert.equal(stopped.job.running, false);
    assert.equal(stopped.job.phase, action === 'manual' ? 'manual' : 'paused');
    assert.equal(c.navigation.length, 0);
  }
});

test('刷新接管保存广播期间旧代数取消生效，不能授权新文档后继续操作', async () => {
  for (const action of ['pause', 'manual']) {
    const c = coordinator();
    const id = c.addTab(learnUrl());
    const initial = await c.request(id, 'owner', 'start', { title: '课程' });
    const page = { location: { href: learnUrl() } };
    c.connect(id)(page);
    let cancelRequest;
    page.chrome.runtime.onMessage.addListener(message => {
      if (message.job.ownerInstance === 'new' && message.job.running && !cancelRequest) {
        cancelRequest = c.request(id, 'owner', action, { ...auth(initial.job), reason: '接管时停止' });
      }
    });
    const refreshed = await c.request(id, 'new', 'hello', { title: '课程' });
    assert.ok(cancelRequest);
    await cancelRequest;
    assert.equal(refreshed.job.running, false);
    assert.equal(refreshed.job.phase, action === 'manual' ? 'manual' : 'paused');
    assert.equal(refreshed.job.reason, '接管时停止');
    const rejected = await c.request(id, 'new', 'record', {
      ...auth(refreshed.job), key: 'video', result: { title: '视频', ended: true, confirmed: true }
    });
    assert.equal(rejected.error, 'TASK_CANCELLED');
    assert.equal(c.navigation.length, 0);
  }
});

test('落盘重启的interrupted任务不接受普通hello自动运行', async () => {
  const c = coordinator();
  const id = c.addTab(learnUrl());
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  r = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot: directorySnapshot() });
  r = await c.request(id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'opening', routeKey: ''
  });
  c.restartBrowser();
  c.restartWorker();
  r = await c.request(id, 'new', 'hello', { title: '课程' });
  assert.equal(r.job.running, false);
  assert.equal(r.job.phase, 'interrupted');
  assert.equal(r.job.candidates[0].currentResource.key, 'video');
  assert.equal(r.job.candidates[0].directory.items.length, 3);
  assert.equal(c.navigation.length, 0);
});

test('同文档SPA的sender仍是入口路由，ready使用浏览器标签当前资源路由', async () => {
  const c = coordinator();
  const entryUrl = learnUrl();
  const id = c.addTab(entryUrl);
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  r = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot: directorySnapshot() });
  r = await c.request(id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'opening', routeKey: ''
  }, entryUrl);
  const nextUrl = entryUrl.replace('/video/res?', '/video/next-resource?');
  c.tabs.get(id).url = nextUrl;
  const staleReady = await c.request(id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(entryUrl)
  }, entryUrl);
  assert.equal(staleReady.ok, false);
  assert.match(staleReady.error, /断点路由/);
  assert.equal(c.storage.session['xinwei-job-v3'].candidates[0].currentResource.stage, 'opening');
  r = await c.request(id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(nextUrl)
  }, entryUrl);
  assert.equal(r.ok, true);
  assert.equal(r.job.candidates[0].currentResource.stage, 'ready');
  assert.equal(r.job.candidates[0].currentResource.routeKey, routeKey(nextUrl));
  assert.equal(c.storage.local['xinwei-job-v3'].candidates[0].currentResource.routeKey, routeKey(nextUrl));
  const arbitraryReady = await c.request(id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready',
    routeKey: routeKey(nextUrl.replace('/video/next-resource?', '/video/arbitrary?'))
  }, entryUrl);
  assert.equal(arbitraryReady.ok, false);
  assert.match(arbitraryReady.error, /断点路由/);
  assert.equal(c.navigation.length, 0);
});

test('入口sender身份仍精确核对，当前标签离开课程或同源时不接受ready', async () => {
  const entryUrl = learnUrl();
  for (const currentUrl of [
    HOME, learnUrl('another-course'), learnUrl('course', 'another-class'),
    'https://other.example/student/#/courseInfo/learn/courseWare/course/video/res?classId=class',
    'https://www.beeline-ai.com/another/#/courseInfo/learn/courseWare/course/video/res?classId=class'
  ]) {
    const c = coordinator();
    const id = c.addTab(entryUrl);
    let r = await c.request(id, 'owner', 'start', { title: '课程' });
    r = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot: directorySnapshot() });
    c.tabs.get(id).url = currentUrl;
    const rejected = await c.request(id, 'owner', 'resource-checkpoint', {
      ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(currentUrl)
    }, entryUrl);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /标签页课程或教学班已改变/);
    assert.equal(c.storage.session['xinwei-job-v3'].candidates[0].currentResource, undefined);
  }
  const c = coordinator();
  const id = c.addTab(entryUrl);
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  r = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot: directorySnapshot() });
  const rejectedSender = await c.request(id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(entryUrl)
  }, learnUrl('course', 'wrong-sender-class'));
  assert.equal(rejectedSender.ok, false);
  assert.match(rejectedSender.error, /课程身份已改变/);
});

test('读取当前标签网址期间用户暂停或人工停止，断点不能保存或复活', async () => {
  for (const action of ['pause', 'manual']) {
    const c = coordinator();
    const entryUrl = learnUrl();
    const id = c.addTab(entryUrl);
    let r = await c.request(id, 'owner', 'start', { title: '课程' });
    r = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot: directorySnapshot() });
    const authorization = auth(r.job);
    const nextUrl = entryUrl.replace('/video/res?', '/video/next-resource?');
    let cancelRequest;
    const tab = c.tabs.get(id);
    Object.defineProperty(tab, 'url', {
      configurable: true, enumerable: true,
      get() {
        if (!cancelRequest) cancelRequest = c.request(id, 'owner', action, {
          ...authorization, reason: '读取标签期间停止'
        }, entryUrl);
        return nextUrl;
      }
    });
    const checkpoint = await c.request(id, 'owner', 'resource-checkpoint', {
      ...authorization, key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(nextUrl)
    }, entryUrl);
    assert.ok(cancelRequest);
    assert.equal(checkpoint.error, 'TASK_CANCELLED');
    const stopped = await cancelRequest;
    assert.equal(stopped.job.running, false);
    assert.equal(stopped.job.phase, action === 'manual' ? 'manual' : 'paused');
    assert.equal(stopped.job.candidates[0].currentResource, undefined);
    assert.equal(c.storage.local['xinwei-job-v3'].candidates[0].currentResource, undefined);
    assert.equal(c.navigation.length, 0);
  }
});

test('音视频断点错误分别说明数据、目录目标和路由，不记录网址', async () => {
  const c = coordinator();
  const id = c.addTab(learnUrl());
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  r = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot: directorySnapshot() });
  for (const [change, pattern] of [
    [{ stage: 'playing' }, /数据格式/],
    [{ key: 'missing' }, /目录无法确认/],
    [{ routeKey: '/student/#/unverified' }, /断点路由/]
  ]) {
    const rejected = await c.request(id, 'owner', 'resource-checkpoint', {
      ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(learnUrl()), ...change
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, pattern);
    assert.equal(rejected.error.includes('https://'), false);
  }
});

test('断点路由只调整不同参数名的顺序，opening和ready保留原始路由', async () => {
  const c = coordinator();
  const observedUrl = `${learnUrl()}&courseResourceId=resource&unknown=one%2Btwo&tag=first&tag=second&flag&blank=&`;
  const equivalentUrl = learnUrl().replace('?classId=class',
    '?courseResourceId=resource&tag=first&tag=second&blank=&classId=class&unknown=one%2Btwo&&flag');
  const id = c.addTab(observedUrl);
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  r = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot: directorySnapshot() });
  r = await c.request(id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'opening', routeKey: routeKey(equivalentUrl)
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.candidates[0].currentResource.routeKey, routeKey(equivalentUrl));
  r = await c.request(id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(observedUrl)
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.candidates[0].currentResource.routeKey, routeKey(observedUrl));

  const defaultUrl = learnUrl().replace('/video/res?', '/video/default?');
  c.tabs.get(id).url = defaultUrl;
  r = await c.request(id, 'refreshed', 'hello', { title: '课程' });
  assert.equal(r.ok, true);
  assert.equal(r.job.interruption.attempts, 1);
  assert.equal(r.job.ownerInstance, null);
  assert.equal(c.navigation.at(-1).url, observedUrl);
  r = await c.request(id, 'returned', 'hello', { title: '课程' });
  r = await c.request(id, 'returned', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'opening', routeKey: routeKey(equivalentUrl)
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.candidates[0].currentResource.routeKey, routeKey(equivalentUrl));
  c.tabs.get(id).url = observedUrl;
  r = await c.request(id, 'returned', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(observedUrl)
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.candidates[0].currentResource.routeKey, routeKey(observedUrl));
  assert.equal(c.navigation.filter(entry => entry.url).length, 1);
});

test('断点参数换序不能掩盖路径、资源、原始值、未知参数或重复参数变化', async () => {
  const c = coordinator();
  const observedUrl = `${learnUrl()}&courseResourceId=resource&unknown=one%2Btwo&tag=first&tag=second&flag&blank=&`;
  const id = c.addTab(observedUrl);
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  r = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot: directorySnapshot() });
  r = await c.request(id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(observedUrl)
  });
  assert.equal(r.ok, true);
  const saved = plain(r.job.candidates[0].currentResource);
  const changedRoutes = [
    observedUrl.replace('/student/', '/student/other/'),
    observedUrl.replace('/courseWare/course/', '/courseWare/another-course/'),
    observedUrl.replace('/video/res?', '/video/another-resource?'),
    observedUrl.replace('/video/res?', '/audio/res?'),
    observedUrl.replace('classId=class', 'classId=another-class'),
    observedUrl.replace('courseResourceId=resource', 'courseResourceId=another-resource'),
    observedUrl.replace('&courseResourceId=resource', ''),
    observedUrl.replace('&unknown=one%2Btwo', ''),
    observedUrl.replace('unknown=one%2Btwo', 'unknown=one%2Bthree'),
    observedUrl.replace('unknown=one%2Btwo', 'unknown=one%2btwo'),
    observedUrl.replace('&tag=second', ''),
    observedUrl.replace('&tag=second', '&tag=second&tag=second'),
    observedUrl.replace('tag=first&tag=second', 'tag=second&tag=first'),
    observedUrl.replace('&flag&', '&flag=&'),
    observedUrl.replace('&blank=', ''),
    observedUrl.slice(0, -1)
  ];
  for (const stage of ['opening', 'ready']) {
    for (const changedUrl of changedRoutes) {
      const rejected = await c.request(id, 'owner', 'resource-checkpoint', {
        ...auth(r.job), key: 'video', title: '视频', stage, routeKey: routeKey(changedUrl)
      });
      assert.equal(rejected.ok, false, `${stage} accepted ${changedUrl}`);
      assert.match(rejected.error, /断点路由/);
      assert.deepEqual(c.storage.session['xinwei-job-v3'].candidates[0].currentResource, saved);
    }
  }
  assert.equal(c.navigation.length, 0);
});

test('当前标签和消息一起换到不同资源，已有断点仍拒绝重绑定', async () => {
  const c = coordinator();
  const observedUrl = `${learnUrl()}&courseResourceId=resource&tag=first&tag=second`;
  const id = c.addTab(observedUrl);
  let r = await c.request(id, 'owner', 'start', { title: '课程' });
  r = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot: directorySnapshot() });
  r = await c.request(id, 'owner', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(observedUrl)
  });
  assert.equal(r.ok, true);
  const saved = plain(r.job.candidates[0].currentResource);
  for (const changedUrl of [
    observedUrl.replace('/video/res?', '/video/another-resource?'),
    observedUrl.replace('courseResourceId=resource', 'courseResourceId=another-resource'),
    observedUrl.replace('tag=first&tag=second', 'tag=second&tag=first')
  ]) {
    c.tabs.get(id).url = changedUrl;
    const rejected = await c.request(id, 'owner', 'resource-checkpoint', {
      ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(changedUrl)
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /断点路由/);
    assert.deepEqual(c.storage.session['xinwei-job-v3'].candidates[0].currentResource, saved);
  }
  assert.equal(c.navigation.length, 0);
});

test('参数名含编码或加号时严格比较原路由，解码同名换序不能改变首值', async () => {
  for (const [suffix, reorderedSuffix] of [
    ['courseResourceId=first&%63ourseResourceId=second', '%63ourseResourceId=second&courseResourceId=first'],
    ['courseResourceId=resource&tag+name=first', 'tag+name=first&courseResourceId=resource']
  ]) {
    const c = coordinator();
    const observedUrl = `${learnUrl()}&${suffix}`;
    const reorderedUrl = `${learnUrl()}&${reorderedSuffix}`;
    const id = c.addTab(observedUrl);
    let r = await c.request(id, 'owner', 'start', { title: '课程' });
    r = await c.request(id, 'owner', 'directory-checkpoint', { ...auth(r.job), snapshot: directorySnapshot() });
    r = await c.request(id, 'owner', 'resource-checkpoint', {
      ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(observedUrl)
    });
    assert.equal(r.ok, true);
    const saved = plain(r.job.candidates[0].currentResource);
    for (const stage of ['opening', 'ready']) {
      const rejected = await c.request(id, 'owner', 'resource-checkpoint', {
        ...auth(r.job), key: 'video', title: '视频', stage, routeKey: routeKey(reorderedUrl)
      });
      assert.equal(rejected.ok, false);
      assert.match(rejected.error, /断点路由/);
      assert.deepEqual(c.storage.session['xinwei-job-v3'].candidates[0].currentResource, saved);
    }
    c.tabs.get(id).url = reorderedUrl;
    const changedBoth = await c.request(id, 'owner', 'resource-checkpoint', {
      ...auth(r.job), key: 'video', title: '视频', stage: 'ready', routeKey: routeKey(reorderedUrl)
    });
    assert.equal(changedBoth.ok, false);
    assert.match(changedBoth.error, /断点路由/);
    assert.deepEqual(c.storage.session['xinwei-job-v3'].candidates[0].currentResource, saved);
    assert.equal(c.navigation.length, 0);
  }
});
