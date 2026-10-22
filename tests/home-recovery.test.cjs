const assert = require('node:assert/strict');
const test = require('node:test');
const { homeFixture, homeCard, waitFor } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');

const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const KEY = 'xinwei-job-v3';

async function stopFixture(f) {
  if (f.api.state.job?.running) await f.api.stop();
  else {
    f.api.state.running = false;
    f.api.state.epoch += 1;
  }
  if (f.api.state.jobPromise) await f.api.state.jobPromise;
  if (f.api.state.syncPromise) await f.api.state.syncPromise;
  f.dom.window.close();
}

for (const obstruction of ['empty', 'loading']) {
  test(`课表${obstruction === 'empty' ? '暂时为空' : '加载提示持续'}超时后保留同一任务，页面就绪自动恢复扫描`, async () => {
    const c = coordinator();
    const id = c.addTab(HOME);
    const f = homeFixture(obstruction === 'empty' ? [] : [homeCard('待采集课程')], {
      connect: c.connect(id), directoryLoadTimeout: 400
    });
    const doc = f.window.document;
    doc.querySelector('.btn-next').disabled = true;
    let loading;
    if (obstruction === 'loading') {
      loading = doc.createElement('div');
      loading.className = 'el-loading-mask';
      doc.body.append(loading);
    }
    f.api.CFG.resourceRetryDelay = 100;
    try {
      doc.getElementById('wb-start').click();
      await waitFor(() => f.api.state.logBox.textContent.includes('稍后自动重试'));
      const interrupted = c.storage.session[KEY];
      assert.equal(interrupted.running, true);
      assert.equal(interrupted.phase, 'scan-home');
      assert.equal(interrupted.candidates.length, 0, 'A partial/empty list must not be submitted');
      const runId = interrupted.runId;
      if (loading) loading.remove();
      else doc.querySelector('.cards').innerHTML = homeCard('待采集课程');
      await waitFor(() => c.storage.session[KEY]?.phase === 'opening', 6000);
      const resumed = c.storage.session[KEY];
      assert.equal(resumed.runId, runId);
      assert.equal(resumed.running, true);
      assert.deepEqual(resumed.candidates.map(item => item.title), ['待采集课程']);
      assert.equal(resumed.targetPurpose, 'inspect');
    } finally { await stopFixture(f); }
  });
}

test('分页页码先变化但卡片未更新：超时重试不采集旧卡或再次翻页，卡片到达后扫描完整列表', async () => {
  const f = homeFixture([homeCard('第一页课程')], { directoryLoadTimeout: 400 });
  const doc = f.window.document;
  const active = doc.querySelector('li.number.is-active');
  const next = doc.querySelector('.btn-next');
  const prev = doc.querySelector('.btn-prev');
  let nextClicks = 0, prevClicks = 0, delayCards = true;
  const display = page => {
    active.textContent = String(page);
    doc.querySelector('.cards').innerHTML = homeCard(page === 1 ? '第一页课程' : '第二页课程');
    next.disabled = page === 2;
    prev.disabled = page === 1;
  };
  next.addEventListener('click', () => {
    nextClicks += 1;
    active.textContent = '2';
    next.disabled = true;
    if (!delayCards) display(2);
  });
  prev.addEventListener('click', () => { prevClicks += 1; display(1); });
  try {
    await f.api.syncSharedJob();
    f.api.state.running = true;
    await assert.rejects(f.api.scanHomeCourses(f.api.state.epoch), error =>
      error instanceof f.api.RecoverableError && /列表尚未加载/.test(error.message));
    assert.equal(f.api.state.running, true);
    assert.equal(nextClicks, 1);
    assert.equal(prevClicks, 0);

    // A second executor round sees the new page number with the old cards.
    // It must preserve the pending transition instead of navigating backwards
    // and accidentally accepting a late response from the first click.
    await assert.rejects(f.api.scanHomeCourses(f.api.state.epoch), error =>
      error instanceof f.api.RecoverableError);
    assert.equal(nextClicks, 1);
    assert.equal(prevClicks, 0);

    delayCards = false;
    display(2);
    const result = await f.api.scanHomeCourses(f.api.state.epoch);
    assert.deepEqual(Array.from(result, item => [item.title, item.page]), [
      ['第一页课程', 1], ['第二页课程', 2]
    ]);
    assert.equal(prevClicks, 1, 'Only a settled page 2 can be followed by a fresh scan from page 1');
    assert.equal(nextClicks, 2);
  } finally { await stopFixture(f); }
});

test('正常分页点击被暂时忽略后，任务等待再尝试并自动采集全部页，不要求第二次开始', async () => {
  const c = coordinator();
  const id = c.addTab(HOME);
  const f = homeFixture([homeCard('第一页课程')], { connect: c.connect(id), directoryLoadTimeout: 400 });
  const doc = f.window.document;
  const next = doc.querySelector('.btn-next');
  const prev = doc.querySelector('.btn-prev');
  const clickedAt = [];
  let recoveryNoticeAt = 0;
  f.api.CFG.resourceRetryDelay = 120;
  const display = page => {
    doc.querySelector('li.number.is-active').textContent = String(page);
    doc.querySelector('.cards').innerHTML = homeCard(page === 1 ? '第一页课程' : '第二页课程');
    next.disabled = page === 2;
    prev.disabled = page === 1;
  };
  next.addEventListener('click', () => {
    clickedAt.push(Date.now());
    if (clickedAt.length > 1) display(2);
  });
  prev.addEventListener('click', () => display(1));
  try {
    doc.getElementById('wb-start').click();
    await waitFor(() => f.api.state.logBox.textContent.includes('稍后自动重试'));
    recoveryNoticeAt = Date.now();
    const runId = c.storage.session[KEY].runId;
    assert.equal(clickedAt.length, 1);
    assert.equal(c.storage.session[KEY].phase, 'scan-home');
    assert.equal(c.storage.session[KEY].running, true);
    await waitFor(() => c.storage.session[KEY]?.phase === 'opening', 9000);
    assert.equal(c.storage.session[KEY].runId, runId);
    assert.deepEqual(c.storage.session[KEY].candidates.map(item => [item.title, item.page]), [
      ['第一页课程', 1], ['第二页课程', 2]
    ]);
    assert.ok(clickedAt[1] - recoveryNoticeAt >= 100, 'The retry must honor the configured recovery wait');
    // Recovery first settles the old page change; a fresh complete scan then
    // visits both pages again. These are three authorized forward clicks.
    assert.equal(clickedAt.length, 3);
  } finally { await stopFixture(f); }
});

test('用户在分页恢复等待中暂停后，迟到卡片与后台同步不会继续翻页或提交扫描结果', async () => {
  const c = coordinator();
  const id = c.addTab(HOME);
  const f = homeFixture([homeCard('第一页课程')], { connect: c.connect(id), directoryLoadTimeout: 400 });
  const doc = f.window.document;
  let pageClicks = 0;
  f.api.CFG.resourceRetryDelay = 800;
  doc.querySelector('.btn-next').addEventListener('click', () => {
    pageClicks += 1;
    doc.querySelector('li.number.is-active').textContent = '2';
  });
  doc.querySelector('.btn-prev').addEventListener('click', () => { pageClicks += 1; });
  try {
    doc.getElementById('wb-start').click();
    await waitFor(() => f.api.state.logBox.textContent.includes('稍后自动重试'));
    assert.equal(pageClicks, 1);
    doc.getElementById('wb-stop').click();
    await waitFor(() => c.storage.session[KEY]?.phase === 'paused');
    if (f.api.state.jobPromise) await f.api.state.jobPromise;
    doc.querySelector('.cards').innerHTML = homeCard('第二页迟到课程');
    doc.querySelector('.btn-next').disabled = true;
    await f.api.syncSharedJob();
    await new Promise(resolve => setTimeout(resolve, 850));
    await f.api.syncSharedJob();
    assert.equal(c.storage.session[KEY].running, false);
    assert.equal(c.storage.session[KEY].phase, 'paused');
    assert.equal(c.storage.session[KEY].candidates.length, 0);
    assert.equal(pageClicks, 1);
  } finally { await stopFixture(f); }
});

test('分页按下期间当前页卡片更新导致取消最终点击，重新识别后同一任务仍能扫描全部页', async () => {
  const c = coordinator();
  const id = c.addTab(HOME);
  const f = homeFixture([homeCard('第一页课程')], { connect: c.connect(id), directoryLoadTimeout: 400 });
  const doc = f.window.document;
  const next = doc.querySelector('.btn-next');
  const prev = doc.querySelector('.btn-prev');
  let changed = false, nextClicks = 0;
  f.api.CFG.resourceRetryDelay = 120;
  const display = page => {
    doc.querySelector('li.number.is-active').textContent = String(page);
    doc.querySelector('.cards').innerHTML = homeCard(page === 1 ? '第一页课程' : '第二页课程');
    next.disabled = page === 2;
    prev.disabled = page === 1;
  };
  next.addEventListener('mousedown', () => {
    if (changed) return;
    changed = true;
    // The website updates ordinary card text while the humanlike click is
    // in progress. The guarded final click must be cancelled, then retried
    // after a fresh stable-page observation rather than waiting forever.
    doc.querySelector('.course-card-item').append('课程状态刚刚更新');
  });
  next.addEventListener('click', () => { nextClicks += 1; display(2); });
  prev.addEventListener('click', () => display(1));
  try {
    doc.getElementById('wb-start').click();
    await waitFor(() => f.api.state.logBox.textContent.includes('稍后自动重试'));
    const runId = c.storage.session[KEY].runId;
    assert.equal(changed, true);
    assert.equal(nextClicks, 0, 'The stale-page final click must not be issued');
    assert.equal(c.storage.session[KEY].running, true);
    assert.equal(c.storage.session[KEY].phase, 'scan-home');
    assert.equal(c.storage.session[KEY].candidates.length, 0);
    await waitFor(() => c.storage.session[KEY]?.phase === 'opening', 6000);
    assert.equal(c.storage.session[KEY].runId, runId);
    assert.equal(c.storage.session[KEY].running, true);
    assert.deepEqual(c.storage.session[KEY].candidates.map(item => [item.title, item.page]), [
      ['第一页课程', 1], ['第二页课程', 2]
    ]);
    assert.equal(nextClicks, 1);
  } finally { await stopFixture(f); }
});
