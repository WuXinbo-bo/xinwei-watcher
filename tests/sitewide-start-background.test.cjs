const assert = require('node:assert/strict');
const test = require('node:test');
const { coordinator } = require('./coordinator.cjs');

const AGENT = 'https://www.beeline-ai.com/stu/agent';
const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const OTHER = 'https://www.beeline-ai.com/student/#/profile';
const LEARN = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course/video/res?classId=class';
const auth = job => ({ runId: job.runId, generation: job.generation });
const urlNavigations = coordinator => coordinator.navigation.filter(entry => entry.url);

test('网站其他页面的一次开始仅导航原标签至真实首页，新文档接管后等待课表入口', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  const otherTab = c.addTab(AGENT);
  let r = await c.request(id, 'departing', 'start', { scope: 'all' });
  assert.equal(r.ok, true);
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(r.job.scope, 'all');
  assert.equal(r.job.homeTabId, id);
  assert.equal(r.job.ownerTabId, id);
  assert.equal(r.job.candidates.length, 0);
  assert.equal(urlNavigations(c).length, 1);
  assert.deepEqual(urlNavigations(c)[0], { id, url: AGENT, active: true });

  // The browser can show the destination URL before its old page unloads.
  r = await c.request(id, 'departing', 'hello', auth(r.job), OTHER);
  assert.equal(r.job.phase, 'go-agent');
  r = await c.request(otherTab, 'foreign-task', 'hello', {}, AGENT);
  assert.equal(r.job.phase, 'go-agent');
  r = await c.request(otherTab, 'foreign-task', 'start', { scope: 'all' }, AGENT);
  assert.equal(r.job.homeTabId, id);
  assert.equal(urlNavigations(c).length, 1);

  r = await c.request(id, 'agent-new', 'hello', {}, AGENT);
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(r.job.ownerInstance, 'agent-new');
  assert.equal(r.job.homeInstance, 'agent-new');
  assert.equal(r.job.agentDeadline, undefined);
  assert.equal(r.job.agentDepartureInstance, undefined);
  assert.equal(r.job.entryClicked, false);
  assert.ok(r.job.entryDeadline > Date.now());
  assert.equal(urlNavigations(c).length, 1);
});

test('学习页请求全部课程无需课程标题，经首页正常入口承接并进入课表扫描', async () => {
  const c = coordinator();
  const id = c.addTab(LEARN);
  let r = await c.request(id, 'learn-old', 'start', { scope: 'all' });
  assert.equal(r.ok, true);
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(r.job.candidates.length, 0);
  assert.equal(c.tabs.get(id).url, AGENT);
  r = await c.request(id, 'agent-new', 'hello', {}, AGENT);
  assert.equal(r.job.phase, 'entry-home');
  r = await c.request(id, 'agent-new', 'entry-open', auth(r.job), AGENT);
  assert.equal(r.job.entryClicked, true);
  c.tabs.get(id).url = HOME;
  r = await c.request(id, 'agent-new', 'hello', auth(r.job), AGENT);
  assert.equal(r.job.phase, 'scan-home');
  assert.equal(r.job.scope, 'all');
  assert.equal(urlNavigations(c).length, 1);
});

test('伪装旧站点文档无法从已离站的实际标签启动或重置', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  c.tabs.get(id).url = 'https://example.com/';
  const start = await c.request(id, 'old', 'start', { scope: 'all' }, OTHER);
  assert.equal(start.ok, false);
  assert.match(start.error, /离开网站/);
  const reset = await c.request(id, 'old', 'reset', {}, OTHER);
  assert.equal(reset.ok, false);
  assert.match(reset.error, /网站页面/);
  assert.equal(urlNavigations(c).length, 0);
});

test('开始任务落盘广播期间暂停，不能再导航到首页', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  const page = { location: { href: OTHER } };
  c.connect(id)(page);
  let cancellation;
  page.chrome.runtime.onMessage.addListener(message => {
    if (message.job.phase === 'go-agent' && message.job.running && !cancellation) {
      cancellation = c.request(id, 'old', 'pause', {
        reason: '用户暂停', instanceId: 'old', resetEpoch: 0
      }, OTHER);
    }
  });
  const started = await c.request(id, 'old', 'start', { scope: 'all' }, OTHER);
  assert.ok(cancellation);
  await cancellation;
  const latest = await c.request(id, 'old', 'get', {}, OTHER);
  assert.equal(latest.job.running, false);
  assert.equal(latest.job.phase, 'paused');
  assert.equal(latest.job.resumePhase, 'go-agent');
  assert.equal(urlNavigations(c).length, 0);
});

test('导航交接期间旧页面刷新不重发网址，真实首页到达后才进入入口阶段', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  let r = await c.request(id, 'old', 'start', { scope: 'all' });
  const originalDeadline = r.job.agentDeadline;
  // A document refresh before arrival still uses the original bounded attempt.
  c.tabs.get(id).url = OTHER;
  c.restartWorker();
  r = await c.request(id, 'refreshed-old', 'hello', {}, OTHER);
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(r.job.ownerInstance, 'refreshed-old');
  assert.equal(r.job.agentDeadline, originalDeadline);
  assert.equal(urlNavigations(c).length, 1);
  c.tabs.get(id).url = AGENT;
  r = await c.request(id, 'refreshed-old', 'hello', auth(r.job), OTHER);
  assert.equal(r.job.phase, 'go-agent');
  r = await c.request(id, 'agent-new', 'hello', auth(r.job), AGENT);
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(urlNavigations(c).length, 1);
});

test('旧实例最初加载首页后同文档切到学习页，不能借导航中显示的首页网址误接管', async () => {
  const c = coordinator();
  const id = c.addTab(LEARN);
  // A SPA can keep the original sender URL after changing the live tab URL.
  let r = await c.request(id, 'departing', 'start', { scope: 'all' }, AGENT);
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(c.tabs.get(id).url, AGENT);
  r = await c.request(id, 'departing', 'hello', auth(r.job), AGENT);
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(r.job.ownerInstance, null);
  r = await c.request(id, 'arrived', 'hello', auth(r.job), AGENT);
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(r.job.ownerInstance, 'arrived');
  assert.equal(urlNavigations(c).length, 1);
});

test('首页导航阶段暂停后从站内其他页继续，仅重试一次并保留原任务', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  let r = await c.request(id, 'old', 'start', { scope: 'all' });
  const runId = r.job.runId;
  c.tabs.get(id).url = OTHER;
  r = await c.request(id, 'old', 'pause', auth(r.job), OTHER);
  assert.equal(r.job.resumePhase, 'go-agent');
  r = await c.request(id, 'old', 'start', { ...auth(r.job), scope: 'all' }, OTHER);
  assert.equal(r.ok, true);
  assert.equal(r.job.runId, runId);
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(urlNavigations(c).length, 2);
  r = await c.request(id, 'agent-new', 'hello', {}, AGENT);
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(r.job.runId, runId);
  assert.equal(urlNavigations(c).length, 2);
});

test('到达首页前暂停，从首页点继续承接同一任务，不再导航或清空记录', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  let r = await c.request(id, 'old', 'start', { scope: 'all' });
  const runId = r.job.runId;
  r = await c.request(id, 'old', 'pause', auth(r.job), OTHER);
  assert.equal(r.job.resumePhase, 'go-agent');
  r = await c.request(id, 'agent-new', 'start', { ...auth(r.job), scope: 'all' }, AGENT);
  assert.equal(r.ok, true);
  assert.equal(r.job.runId, runId);
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(r.job.ownerInstance, 'agent-new');
  assert.equal(r.job.entryClicked, false);
  assert.equal(r.job.agentDepartureInstance, undefined);
  assert.equal(urlNavigations(c).length, 1);
});

test('首页导航超时保持任务等待接管；站内其他页的重置进入停止核对流程', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  let r = await c.request(id, 'old', 'start', { scope: 'all' });
  c.storage.session['xinwei-job-v3'].agentDeadline = Date.now() - 1;
  r = await c.request(id, 'old', 'get', {}, OTHER);
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(r.job.navigationRecovery.attempts, 1);
  assert.equal(urlNavigations(c).length, 1);
  c.tabs.get(id).url = OTHER;
  r = await c.request(id, 'old', 'reset', { resetEpoch: r.job.resetEpoch }, OTHER);
  // The tab exists but has no receiving content script. Production reset now
  // reloads that stale document, then persists an idle empty marker.
  assert.equal(r.ok, true);
  assert.equal(r.job.reason, undefined);
  assert.equal(r.job.phase, 'idle');
  assert.equal(r.job.candidates.length, 0);
  assert.equal(r.job.logs.length, 0);
});

test('暂停后迟到的旧代数继续或重新开始都不能越过新暂停', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  let r = await c.request(id, 'old', 'start', { scope: 'all' });
  const beforePause = r.job;
  c.tabs.get(id).url = OTHER;
  r = await c.request(id, 'old', 'pause', auth(beforePause), OTHER);
  assert.equal(r.job.phase, 'paused');
  assert.ok(r.job.generation > beforePause.generation);
  const staleContinue = await c.request(id, 'old', 'start', { ...auth(beforePause), scope: 'all' }, OTHER);
  assert.equal(staleContinue.error, 'TASK_CANCELLED');
  const staleRestart = await c.request(id, 'old', 'start', {
    ...auth(beforePause), scope: 'all', restart: true
  }, OTHER);
  assert.equal(staleRestart.error, 'TASK_CANCELLED');
  const current = await c.request(id, 'old', 'get', {}, OTHER);
  assert.equal(current.job.phase, 'paused');
  assert.equal(urlNavigations(c).length, 1);
  const resumed = await c.request(id, 'old', 'start', { ...auth(current.job), scope: 'all' }, OTHER);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.job.runId, beforePause.runId);
  assert.equal(resumed.job.running, true);
  assert.equal(urlNavigations(c).length, 2);
});
