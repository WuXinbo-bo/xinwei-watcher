const assert = require('node:assert/strict');
const test = require('node:test');
const { homeFixture, homeCard, waitFor } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');

const AGENT = 'https://www.beeline-ai.com/stu/agent';
const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const KEY = 'xinwei-job-v3';

function agentFixture(c, id, options = {}) {
  const f = homeFixture([homeCard('当前课程')], {
    url: AGENT, connect: c.connect(id), directoryLoadTimeout: options.timeout || 100
  });
  const doc = f.window.document;
  doc.querySelector('.btn-next').disabled = true;
  const sidebar = doc.createElement('div');
  sidebar.className = 'my-course-container';
  sidebar.innerHTML = options.missing ? '' : '<a class="timetable">查看所有课表</a>';
  if (options.ambiguous) sidebar.innerHTML += '<a class="timetable">查看所有课表</a>';
  doc.body.append(sidebar);
  for (const entry of sidebar.querySelectorAll('a')) {
    // jsdom has no layout. The fixture describes only actual visible controls.
    entry.getClientRects = () => [{ width: 100, height: 20 }];
  }
  if (options.collapsed) {
    sidebar.style.display = 'none';
    const expand = doc.createElement('button');
    expand.id = 'collapseBtn2';
    expand.getClientRects = () => [{ width: 20, height: 20 }];
    expand.addEventListener('click', () => { sidebar.style.display = ''; });
    doc.body.append(expand);
    f.expand = expand;
  }
  f.sidebar = sidebar;
  f.entry = sidebar.querySelector('a');
  f.courseEntry = doc.querySelector('.item-bg-text p.sle');
  return f;
}

test('首页及其他站内页面默认显示悬浮球，展开后开始和重置可用', () => {
  const c = coordinator();
  const id = c.addTab(AGENT);
  const f = agentFixture(c, id);
  const unsupported = homeFixture([], { url: `${AGENT}-unknown` });
  try {
    for (const page of [f, unsupported]) {
      const panel = page.window.document.getElementById('wb-study-ui');
      const assistant = page.window.document.getElementById('wb-assistant-button');
      assert.equal(panel.hidden, true);
      assert.equal(assistant.hidden, false);
      assistant.click();
      assert.equal(panel.hidden, false);
      assert.equal(page.window.document.getElementById('wb-start').disabled, false);
      assert.equal(page.window.document.getElementById('wb-reset').disabled, false);
    }
  } finally { f.dom.window.close(); unsupported.dom.window.close(); }
});

for (const collapsed of [false, true]) {
  test(`首页一次开始，经真实课表控件同页切换后自动扫描${collapsed ? '（侧栏收起）' : ''}`, async () => {
    const c = coordinator();
    const id = c.addTab(AGENT);
    const f = agentFixture(c, id, { collapsed, timeout: 2000 });
    let entryClicks = 0, expandClicks = 0, courseClicks = 0, persistedBeforeClick;
    try {
      f.expand?.addEventListener('click', () => { expandClicks += 1; });
      f.entry.addEventListener('click', () => {
        entryClicks += 1;
        persistedBeforeClick = c.storage.session[KEY].entryClicked;
        f.window.history.replaceState({}, '', HOME); // site's observed same-tab Vue route
      });
      f.courseEntry.addEventListener('click', () => { courseClicks += 1; });
      f.window.document.getElementById('wb-start').click();
      await waitFor(() => entryClicks === 1);
      await f.api.syncSharedJob();
      await waitFor(() => courseClicks === 1, 5000);
      const job = c.storage.session[KEY];
      assert.equal(persistedBeforeClick, true);
      assert.equal(entryClicks, 1);
      assert.equal(expandClicks, collapsed ? 1 : 0);
      assert.equal(job.scope, 'all');
      assert.equal(job.phase, 'opening');
      assert.equal(job.homeTabId, id);
      assert.equal(job.candidates.length, 1);
      assert.equal(job.candidates[0].title, '当前课程');
      assert.equal(job.targetPurpose, 'inspect');
      assert.equal(c.navigation.some(n => n.url), false);
    } finally { f.dom.window.close(); }
  });
}

test('点击课表入口后页面未跳转，轮询和刷新都不重复点击', async () => {
  const c = coordinator();
  const id = c.addTab(AGENT);
  let f = agentFixture(c, id);
  let clicks = 0;
  try {
    f.entry.addEventListener('click', () => { clicks += 1; });
    await f.api.start();
    await waitFor(() => clicks === 1);
    await f.api.syncSharedJob();
    await f.api.syncSharedJob();
    assert.equal(clicks, 1);
    const runId = f.api.state.job.runId;
    f.dom.window.close();
    f = agentFixture(c, id);
    f.entry.addEventListener('click', () => { clicks += 1; });
    await f.api.syncSharedJob();
    await f.api.syncSharedJob();
    assert.equal(f.api.state.job.runId, runId);
    assert.equal(f.api.state.job.entryClicked, true);
    assert.equal(clicks, 1);
  } finally { f.dom.window.close(); }
});

test('首页入口已等到超时后自动点击第二次，不再额外等到下一次超时', async () => {
  const c = coordinator();
  const id = c.addTab(AGENT);
  const f = agentFixture(c, id);
  let clicks = 0;
  try {
    f.entry.addEventListener('click', () => { clicks += 1; });
    await f.api.start();
    await waitFor(() => clicks === 1 && !f.api.state.jobPromise);
    const runId = f.api.state.job.runId;
    c.storage.session['xinwei-job-v3'].entryDeadline = Date.now() - 1;
    await f.api.syncSharedJob();
    await waitFor(() => clicks === 2);
    assert.equal(f.api.state.job.runId, runId);
    assert.equal(f.api.state.job.running, true);
    assert.equal(f.api.state.job.navigationRecovery.attempts, 1);
    assert.ok(f.api.state.job.entryDeadline > Date.now());
    await f.api.stop();
    await f.api.syncSharedJob();
    assert.equal(clicks, 2);
    assert.equal(f.api.state.job.phase, 'paused');
  } finally { f.dom.window.close(); }
});

for (const options of [{ missing: true }, { ambiguous: true }]) {
  test(`首页入口${options.missing ? '缺失时等待自动重试' : '不唯一会停止并说明原因'}`, async () => {
    const c = coordinator();
    const id = c.addTab(AGENT);
    const f = agentFixture(c, id, options);
    let clicks = 0;
    try {
      f.sidebar.addEventListener('click', () => { clicks += 1; });
      await f.api.start();
      if (options.missing) {
        await waitFor(() => f.api.state.logBox.textContent.includes('稍后自动重试'));
        assert.equal(f.api.state.job.running, true);
        assert.equal(f.api.state.job.phase, 'entry-home');
        await f.api.stop();
        assert.equal(f.api.state.job.phase, 'paused');
      } else {
        await waitFor(() => f.api.state.job?.phase === 'manual');
        assert.match(f.api.state.job.reason, /多个.*查看所有课表/);
      }
      assert.equal(clicks, 0);
      assert.equal(f.api.state.job.entryClicked, false);
      assert.equal(c.navigation.length, 0);
    } finally { f.dom.window.close(); }
  });
}

test('开始后悬停课表入口时点暂停，最终点击必须取消', async () => {
  const c = coordinator();
  const id = c.addTab(AGENT);
  const f = agentFixture(c, id);
  let clicks = 0, pauseRequest;
  try {
    f.entry.addEventListener('click', () => { clicks += 1; });
    f.entry.addEventListener('mouseover', () => { pauseRequest = f.api.stop(); }, { once: true });
    await f.api.start();
    await waitFor(() => pauseRequest);
    await pauseRequest;
    await waitFor(() => !f.api.state.jobPromise);
    assert.equal(f.api.state.job.phase, 'paused');
    assert.equal(f.api.state.running, false);
    assert.equal(clicks, 0);
    assert.equal(c.navigation.length, 0);
  } finally { f.dom.window.close(); }
});

test('最终点击前入口变得不唯一，停止而不是点击旧节点', async () => {
  const c = coordinator();
  const id = c.addTab(AGENT);
  const f = agentFixture(c, id);
  let clicks = 0;
  try {
    f.entry.addEventListener('click', () => { clicks += 1; });
    f.entry.addEventListener('mouseover', () => {
      const extra = f.entry.cloneNode(true);
      extra.getClientRects = () => [{ width: 100, height: 20 }];
      f.sidebar.append(extra);
    }, { once: true });
    await f.api.start();
    await waitFor(() => f.api.state.job?.phase === 'manual');
    assert.match(f.api.state.job.reason, /多个.*查看所有课表/);
    assert.equal(clicks, 0);
  } finally { f.dom.window.close(); }
});
