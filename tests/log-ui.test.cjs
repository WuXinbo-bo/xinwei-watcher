const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./helpers.cjs');

const ROW_HEIGHT = 10;
const VIEW_HEIGHT = 10;

function logEntries(count, start = 0) {
  return Array.from({ length: count }, (_, index) => ({
    time: 1_800_000_000_000 + start + index,
    text: `日志 ${start + index}`,
    type: 'info'
  }));
}

function createLogFixture(options = {}) {
  const rowHeight = options.rowHeight ?? ROW_HEIGHT;
  const viewHeight = options.viewHeight ?? VIEW_HEIGHT;
  const clampScroll = options.clampScroll !== false;
  const f = fixture([]);
  const { window } = f;
  const proto = window.HTMLElement.prototype;
  proto.getBoundingClientRect = function () {
    if (this.id === 'wb-log') {
      return { top: 100, bottom: 100 + viewHeight, left: 0, right: 200,
        width: 200, height: viewHeight, x: 0, y: 100, toJSON() {} };
    }
    if (this.classList?.contains('wb-log-entry')) {
      const index = [...this.parentElement.children].indexOf(this);
      const top = 100 + index * rowHeight - this.parentElement.scrollTop;
      return { top, bottom: top + rowHeight, left: 0, right: 200,
        width: 200, height: rowHeight, x: 0, y: top, toJSON() {} };
    }
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0,
      x: 0, y: 0, toJSON() {} };
  };
  const box = f.api.state.logBox;
  Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => viewHeight });
  Object.defineProperty(box, 'clientTop', { configurable: true, get: () => 0 });
  Object.defineProperty(box, 'scrollHeight', {
    configurable: true, get: () => box.children.length * rowHeight
  });
  let scrollTop = 0;
  Object.defineProperty(box, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: value => {
      const max = Math.max(0, box.scrollHeight - box.clientHeight);
      const numeric = Number(value) || 0;
      scrollTop = clampScroll ? Math.max(0, Math.min(max, numeric)) : Math.max(0, numeric);
    }
  });
  f.logRowHeight = rowHeight;
  return f;
}

function setFirstVisibleRow(f, index) {
  f.api.state.logBox.scrollTop = index * f.logRowHeight;
}

function visibleRowTexts(f) {
  const box = f.api.state.logBox;
  const top = box.getBoundingClientRect().top + box.clientTop;
  const bottom = top + box.clientHeight;
  return [...box.children].filter(row => {
    const rect = row.getBoundingClientRect();
    return rect.bottom > top && rect.top < bottom;
  }).map(row => row.textContent);
}

function latestButton(f) {
  return f.window.document.getElementById('wb-log-new');
}

function close(f) {
  f.api.state.running = false;
  f.api.state.epoch += 1;
  f.dom.window.close();
}

test('阅读位置距最新 12 条时，新日志自动跟随到底部', () => {
  const f = createLogFixture();
  try {
    f.api.renderLogEntries(logEntries(20));
    // A single-row viewport makes this exact: latest index 19 is 12 rows
    // after the visible index 7.
    setFirstVisibleRow(f, 7);
    assert.deepEqual(visibleRowTexts(f).map(text => text.match(/日志 \d+/)[0]), ['日志 7']);
    assert.equal(f.api.logIsNearLatest(), true);

    f.api.appendLog('新增日志', 'info', 1_900_000_000_000);

    const box = f.api.state.logBox;
    assert.equal(box.scrollTop, box.scrollHeight - box.clientHeight);
    assert.equal(latestButton(f).hidden, true);
  } finally { close(f); }
});

test('阅读位置距最新超过 12 条时保留锚点并显示新日志数；点击后跳到最新', () => {
  const f = createLogFixture();
  try {
    f.api.renderLogEntries(logEntries(40));
    setFirstVisibleRow(f, 0);
    const anchorBefore = visibleRowTexts(f);
    assert.equal(f.api.logIsNearLatest(), false);

    f.api.appendLog('新增日志', 'info', 1_900_000_000_000);

    assert.deepEqual(visibleRowTexts(f), anchorBefore);
    const button = latestButton(f);
    assert.equal(button.hidden, false);
    assert.match(button.textContent, /1 条新日志/);

    button.click();
    const box = f.api.state.logBox;
    assert.equal(box.scrollTop, box.scrollHeight - box.clientHeight);
    assert.equal(button.hidden, true);
  } finally { close(f); }
});

test('日志达到 80 条上限后保留阅读锚点；锚点被清理时落到下一条保留日志', () => {
  const f = createLogFixture();
  try {
    f.api.renderLogEntries(logEntries(80));
    setFirstVisibleRow(f, 30);
    const retainedAnchor = visibleRowTexts(f)[0];
    const oldTop = [...f.api.state.logBox.children][30].getBoundingClientRect().top;

    f.api.appendLog('日志 80', 'info', 1_900_000_000_000);

    assert.equal(f.api.state.logBox.children.length, 80);
    assert.equal(visibleRowTexts(f)[0], retainedAnchor);
    const retainedNode = [...f.api.state.logBox.children]
      .find(row => row.textContent.includes('日志 30'));
    assert.ok(retainedNode);
    assert.equal(retainedNode.getBoundingClientRect().top, oldTop);

    // Move to the oldest log. When it is trimmed on the next append, its
    // immediate successor should occupy the same reading position.
    setFirstVisibleRow(f, 0);
    assert.match(visibleRowTexts(f)[0], /日志 1$/);
    f.api.appendLog('日志 81', 'info', 1_900_000_000_001);
    assert.equal(f.api.state.logBox.children.length, 80);
    assert.match(visibleRowTexts(f)[0], /日志 2$/);
    assert.ok([...f.api.state.logBox.children].some(row => /日志 2$/.test(row.textContent)));
  } finally { close(f); }
});

test('新页面载入已有任务日志时直接显示最新', () => {
  const f = createLogFixture();
  try {
    const logs = logEntries(30);
    f.api.acceptJob({
      runId: 'reload-run', generation: 1, revision: 1, resetEpoch: 0,
      running: false, phase: 'paused', candidates: [], logs
    });

    const box = f.api.state.logBox;
    assert.equal(box.scrollTop, box.scrollHeight - box.clientHeight);
    assert.equal(visibleRowTexts(f).length, 1);
    assert.match(visibleRowTexts(f)[0], /日志 29$/);
    assert.equal(latestButton(f).hidden, true);
  } finally { close(f); }
});

test('后台 acceptJob 重绘不移动旧日志阅读位置，重复同步不重复计算新日志', () => {
  const f = createLogFixture();
  try {
    const logs = logEntries(40);
    const job = {
      runId: 'sync-run', generation: 1, revision: 1, resetEpoch: 0,
      running: false, phase: 'paused', candidates: [], logs
    };
    f.api.acceptJob(job);
    setFirstVisibleRow(f, 0);
    const before = visibleRowTexts(f);

    f.api.acceptJob({ ...job, revision: 2, logs: [...logs, {
      time: 1_900_000_000_000, text: '同步新增日志', type: 'info'
    }] });
    assert.deepEqual(visibleRowTexts(f), before);
    assert.match(latestButton(f).textContent, /1 条新日志/);

    f.api.acceptJob({ ...job, revision: 3, logs: [...logs, {
      time: 1_900_000_000_000, text: '同步新增日志', type: 'info'
    }] });
    assert.deepEqual(visibleRowTexts(f), before);
    assert.match(latestButton(f).textContent, /1 条新日志/);
  } finally { close(f); }
});



test('多行视口仍按第一条可见日志判断 12 条阈值，而不是按最后一条可见日志', () => {
  const f = createLogFixture({ viewHeight: 180, rowHeight: 10 });
  try {
    f.api.renderLogEntries(logEntries(40));
    // Rows 20..37 are visible, so the last visible row is only two rows
    // before the newest row (39), but the first visible row is 19 rows back.
    setFirstVisibleRow(f, 20);
    assert.equal(visibleRowTexts(f).length, 18);
    assert.match(visibleRowTexts(f)[0], /日志 20$/);
    assert.match(visibleRowTexts(f).at(-1), /日志 37$/);
    assert.equal(f.api.logIsNearLatest(), false);

    f.api.appendLog('多行视口新增', 'info', 1_900_000_000_000);

    assert.match(visibleRowTexts(f)[0], /日志 20$/);
    assert.equal(latestButton(f).hidden, false);
    assert.match(latestButton(f).textContent, /1 条新日志/);
  } finally { close(f); }
});

test('多行视口已滚到底部时新日志仍应自动跟随', () => {
  const f = createLogFixture({ viewHeight: 180, rowHeight: 10 });
  try {
    f.api.renderLogEntries(logEntries(40));
    const box = f.api.state.logBox;
    box.scrollTop = box.scrollHeight;
    assert.equal(box.scrollTop, box.scrollHeight - box.clientHeight);
    assert.match(visibleRowTexts(f).at(-1), /日志 39$/);

    f.api.appendLog('底部新增日志', 'info', 1_900_000_000_000);

    assert.equal(box.scrollTop, box.scrollHeight - box.clientHeight);
    assert.match(visibleRowTexts(f).at(-1), /底部新增日志$/);
    assert.equal(latestButton(f).hidden, true);
  } finally { close(f); }
});

test('无 id 的重复旧日志从前端裁剪后保留正确锚点且不产生虚假未读数', () => {
  const f = createLogFixture();
  try {
    const duplicate = { time: 1_850_000_000_000, text: '重复旧日志', type: 'info' };
    const initialLogs = logEntries(80);
    initialLogs[0] = { ...duplicate };
    initialLogs[1] = { ...duplicate };
    const job = {
      runId: 'legacy-duplicate-run', generation: 1, revision: 1, resetEpoch: 0,
      running: false, phase: 'paused', candidates: [], logs: initialLogs
    };
    f.api.acceptJob(job);
    setFirstVisibleRow(f, 0);
    const survivorKey = f.api.state.logBox.children[1].dataset.logKey;

    const nextLogs = [...initialLogs, {
      time: 1_900_000_000_000, text: '新日志', type: 'info'
    }];
    f.api.acceptJob({ ...job, revision: 2, logs: nextLogs });

    assert.equal(f.api.state.logBox.children.length, 80);
    assert.equal(f.api.state.logBox.children[0].dataset.logKey, survivorKey);
    assert.match(f.api.state.logBox.children[0].textContent, /重复旧日志$/);
    assert.equal(f.api.state.logUnreadCount, 1);
    assert.match(latestButton(f).textContent, /1 条新日志/);
  } finally { close(f); }
});


test('后台快照与待写入日志竞态合并：保留 B，未读数不重复累计并保持锚点', () => {
  const f = createLogFixture();
  try {
    const initial = logEntries(40);
    const baseJob = {
      runId: 'pending-log-race', generation: 1, revision: 1, resetEpoch: 0,
      running: false, phase: 'paused', candidates: [], logs: initial
    };
    f.api.acceptJob(baseJob);
    setFirstVisibleRow(f, 0);

    const a = f.api.appendLog('待写入 A', 'info', 1_900_000_000_000);
    const b = f.api.appendLog('待写入 B', 'info', 1_900_000_000_001);
    f.api.state.pendingLogEntries.set(a.id, a);
    f.api.state.pendingLogEntries.set(b.id, b);
    assert.equal(f.api.state.logUnreadCount, 2);
    const anchorBefore = visibleRowTexts(f);

    // The background has durably saved A, but B is still only local.
    f.api.acceptJob({ ...baseJob, revision: 2, logs: [...initial, a] });
    assert.ok([...f.api.state.logEntries].some(entry => entry.id === b.id));
    assert.equal(f.api.state.logUnreadCount, 2);
    assert.deepEqual(visibleRowTexts(f), anchorBefore);

    // B is now present in the saved snapshot. It must be removed from the
    // pending map without being counted as a second new log.
    f.api.acceptJob({ ...baseJob, revision: 3, logs: [...initial, a, b] });
    assert.equal(f.api.state.pendingLogEntries.size, 0);
    assert.equal(f.api.state.logUnreadCount, 2);
    assert.deepEqual(visibleRowTexts(f), anchorBefore);
    assert.match(latestButton(f).textContent, /2 条新日志/);
  } finally { close(f); }
});

test('后台写入迟迟未确认时，待同步日志最多保留 80 条', () => {
  const f = createLogFixture();
  try {
    f.api.state.running = true;
    f.api.state.job = {
      running: true,
      ownerInstance: f.api.state.instanceId,
      runId: 'pending-log-cap',
      generation: 1
    };

    for (let index = 0; index < 100; index += 1) {
      f.api.log(`待确认日志 ${index}`);
    }

    const pending = [...f.api.state.pendingLogEntries.values()];
    assert.equal(pending.length, 80);
    assert.equal(pending[0].text, '待确认日志 20');
    assert.equal(pending.at(-1).text, '待确认日志 99');
  } finally { close(f); }
});

test('超出阅读范围的新错误或人工提醒显示醒目提示但不抢滚动位置', () => {
  const f = createLogFixture();
  try {
    const logs = logEntries(40);
    const job = {
      runId: 'urgent-run', generation: 1, revision: 1, resetEpoch: 0,
      running: false, phase: 'paused', candidates: [], logs
    };
    f.api.acceptJob(job);
    setFirstVisibleRow(f, 0);
    const before = visibleRowTexts(f);

    f.api.acceptJob({ ...job, revision: 2, phase: 'manual', reason: '登录已退出',
      logs: [...logs, { time: 1_900_000_000_000, text: '登录已退出', type: 'err' }] });

    assert.deepEqual(visibleRowTexts(f), before);
    const button = latestButton(f);
    assert.equal(button.hidden, false);
    assert.equal(button.classList.contains('is-urgent'), true);
    assert.match(button.textContent, /新提醒/);
  } finally { close(f); }
});
