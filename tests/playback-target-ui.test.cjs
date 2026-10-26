const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, homeFixture, waitFor } = require('./helpers.cjs');

const KEY = 'wb-playback-target';

function settingsChrome(storage) {
  return {
    runtime: { sendMessage: async () => ({ ok: true, job: null, tabId: 1 }) },
    storage: { local: storage }
  };
}

function observedSettings(storage) {
  const listeners = [];
  const chrome = settingsChrome(storage);
  chrome.storage.onChanged = { addListener: listener => listeners.push(listener) };
  return {
    chrome,
    emit: (changes, area = 'local') => listeners.forEach(listener => listener(changes, area))
  };
}

function close(f) {
  f.api.state.running = false;
  f.api.state.epoch += 1;
  f.dom.window.close();
}

test('playback target starts at 100 with an accessible 80-100 percent number input', async () => {
  const f = fixture([]);
  try {
    await f.api.state.playbackTargetReady;
    const input = f.window.document.getElementById('wb-playback-target');
    assert.equal(f.api.getPlaybackTarget(), 100);
    assert.equal(input.type, 'number');
    assert.equal(input.min, '80');
    assert.equal(input.max, '100');
    assert.equal(input.step, '1');
    assert.equal(input.value, '100');
    assert.ok(input.getAttribute('aria-label'));
    assert.ok(f.window.document.querySelector(`label[for="${input.id}"]`));
  } finally { close(f); }
});

test('playback target normalization clamps numeric values and rejects invalid values', () => {
  const f = fixture([]);
  try {
    const normalize = f.api.normalizePlaybackTarget;
    for (const [value, expected] of [
      [0, 80], [79, 80], [80, 80], ['85', 85], [85.6, 86], [100, 100], [101, 100],
      ['', 100], ['bad', 100], [null, 100], [undefined, 100], [true, 100],
      [NaN, 100], [Infinity, 100], [{ valueOf: () => 80 }, 100]
    ]) {
      assert.equal(normalize(value), expected, String(value));
    }
  } finally { close(f); }
});

test('valid saved playback targets load before the ready promise resolves', async () => {
  for (const target of [80, 87, 100]) {
    const f = fixture([], {
      chrome: settingsChrome({ get: async key => {
        assert.equal(key, KEY);
        return { [KEY]: target };
      } })
    });
    try {
      assert.equal(await f.api.state.playbackTargetReady, target);
      assert.equal(f.api.getPlaybackTarget(), target);
      assert.equal(f.window.document.getElementById('wb-playback-target').value, String(target));
    } finally { close(f); }
  }
});

test('missing, invalid, or unreadable saved settings safely fall back to 100', async () => {
  for (const value of [undefined, null, '80', 79, 101, 85.5, true]) {
    const f = fixture([], { chrome: settingsChrome({ get: async () => ({ [KEY]: value }) }) });
    try {
      await f.api.state.playbackTargetReady;
      assert.equal(f.api.getPlaybackTarget(), 100, String(value));
    } finally { close(f); }
  }
  const f = fixture([], { chrome: settingsChrome({ get: async () => {
    throw new Error('storage unavailable');
  } }) });
  try {
    await f.api.state.playbackTargetReady;
    assert.equal(f.api.getPlaybackTarget(), 100);
    assert.equal(f.api.state.storageFailed, false);
  } finally { close(f); }
});

test('input changes persist clamped values without changing playback state', async () => {
  const values = {};
  const f = fixture([], {
    chrome: settingsChrome({
      get: async () => ({}),
      set: async update => Object.assign(values, update)
    })
  });
  try {
    await f.api.state.playbackTargetReady;
    const input = f.window.document.getElementById('wb-playback-target');
    for (const [typed, expected] of [['70', 80], ['120', 100], ['88.7', 89]]) {
      input.value = typed;
      input.dispatchEvent(new f.window.Event('change', { bubbles: true }));
      assert.equal(f.api.getPlaybackTarget(), expected);
      assert.equal(input.value, String(expected));
      await waitFor(() => values[KEY] === expected);
    }
    assert.equal(f.api.state.running, false);
    assert.equal(f.media.paused, true);
  } finally { close(f); }
});

test('saved target survives a new content-script document', async () => {
  const values = {};
  const chrome = settingsChrome({
    get: async () => ({ ...values }),
    set: async update => Object.assign(values, update)
  });
  const first = fixture([], { chrome });
  try {
    await first.api.state.playbackTargetReady;
    await first.api.savePlaybackTarget(83);
  } finally { close(first); }
  const reloaded = fixture([], { chrome });
  try {
    await reloaded.api.state.playbackTargetReady;
    assert.equal(reloaded.api.getPlaybackTarget(), 83);
    assert.equal(reloaded.window.document.getElementById('wb-playback-target').value, '83');
  } finally { close(reloaded); }
});

test('delayed initial storage read cannot overwrite a newer user selection', async () => {
  let release;
  const values = {};
  const f = fixture([], {
    chrome: settingsChrome({
      get: () => new Promise(resolve => { release = resolve; }),
      set: async update => Object.assign(values, update)
    })
  });
  try {
    await f.api.savePlaybackTarget(80);
    release({ [KEY]: 95 });
    await f.api.state.playbackTargetReady;
    assert.equal(f.api.getPlaybackTarget(), 80);
    assert.equal(values[KEY], 80);
    assert.equal(f.window.document.getElementById('wb-playback-target').value, '80');
  } finally {
    release?.({});
    close(f);
  }
});

test('rapid settings writes stay ordered even when the first write is slow', async () => {
  const writes = [];
  const values = {};
  let release;
  const f = fixture([], {
    chrome: settingsChrome({
      get: async () => ({}),
      set: async update => {
        writes.push(update[KEY]);
        if (writes.length === 1) await new Promise(resolve => { release = resolve; });
        Object.assign(values, update);
      }
    })
  });
  try {
    await f.api.state.playbackTargetReady;
    const first = f.api.savePlaybackTarget(80);
    const last = f.api.savePlaybackTarget(90);
    assert.equal(f.api.getPlaybackTarget(), 90);
    await waitFor(() => writes.length === 1);
    assert.deepEqual(writes, [80]);
    release();
    await Promise.all([first, last]);
    assert.deepEqual(writes, [80, 90]);
    assert.equal(values[KEY], 90);
  } finally {
    release?.();
    close(f);
  }
});

test('failed save preserves the current page setting and does not block a later save', async () => {
  let fail = true;
  const values = {};
  const f = fixture([], {
    chrome: settingsChrome({
      get: async () => ({}),
      set: async update => {
        if (fail) throw new Error('write failed');
        Object.assign(values, update);
      }
    })
  });
  try {
    await f.api.state.playbackTargetReady;
    await assert.rejects(f.api.savePlaybackTarget(80), /write failed/);
    assert.equal(f.api.getPlaybackTarget(), 80);
    fail = false;
    await f.api.savePlaybackTarget(90);
    assert.equal(values[KEY], 90);
    assert.equal(f.api.getPlaybackTarget(), 90);
  } finally { close(f); }
});

test('a home-tab setting change reaches an already-open lesson tab', async () => {
  const values = { [KEY]: 100 };
  const bus = observedSettings({
    get: async () => ({ ...values }),
    set: async update => {
      const oldValue = values[KEY];
      Object.assign(values, update);
      bus.emit({ [KEY]: { oldValue, newValue: values[KEY] } });
    }
  });
  const home = homeFixture([], { chrome: bus.chrome });
  const lesson = fixture([], { chrome: bus.chrome });
  try {
    await Promise.all([home.api.state.playbackTargetReady, lesson.api.state.playbackTargetReady]);
    await home.api.savePlaybackTarget(80);
    await waitFor(() => lesson.api.getPlaybackTarget() === 80);
    assert.equal(lesson.window.document.getElementById('wb-playback-target').value, '80');
    assert.equal(home.api.getPlaybackTarget(), 80);
    assert.equal(lesson.api.state.running, false);
    assert.equal(lesson.media.paused, true);
  } finally {
    close(home);
    close(lesson);
  }
});

test('storage changes ignore other keys and other storage areas', async () => {
  let reads = 0;
  const bus = observedSettings({
    get: async () => {
      reads += 1;
      return { [KEY]: 100 };
    }
  });
  const f = fixture([], { chrome: bus.chrome });
  try {
    await f.api.state.playbackTargetReady;
    const initialReads = reads;
    bus.emit({ another: { newValue: 80 } });
    bus.emit({ [KEY]: { newValue: 80 } }, 'session');
    assert.equal(reads, initialReads);
    assert.equal(f.api.getPlaybackTarget(), 100);
  } finally { close(f); }
});

test('a cross-tab event prevents a delayed initial read from restoring an older target', async () => {
  const values = { [KEY]: 100 };
  let reads = 0;
  let release;
  const bus = observedSettings({
    get: () => ++reads === 1
      ? new Promise(resolve => { release = resolve; })
      : Promise.resolve({ ...values })
  });
  const f = fixture([], { chrome: bus.chrome });
  try {
    values[KEY] = 80;
    bus.emit({ [KEY]: { oldValue: 100, newValue: 80 } });
    await waitFor(() => f.api.getPlaybackTarget() === 80);
    release({ [KEY]: 100 });
    await f.api.state.playbackTargetReady;
    assert.equal(f.api.getPlaybackTarget(), 80);
    assert.equal(f.window.document.getElementById('wb-playback-target').value, '80');
  } finally {
    release?.({});
    close(f);
  }
});

test('initial readiness also waits for a newer cross-tab change still being read', async () => {
  let reads = 0;
  let releaseInitial;
  let releaseChange;
  const bus = observedSettings({
    get: () => ++reads === 1
      ? new Promise(resolve => { releaseInitial = resolve; })
      : new Promise(resolve => { releaseChange = resolve; })
  });
  const f = fixture([], { chrome: bus.chrome });
  try {
    let ready = false;
    f.api.state.playbackTargetReady.then(() => { ready = true; });
    bus.emit({ [KEY]: { oldValue: 100, newValue: 80 } });
    releaseInitial({ [KEY]: 100 });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(ready, false);
    releaseChange({ [KEY]: 80 });
    assert.equal(await f.api.state.playbackTargetReady, 80);
    assert.equal(f.api.getPlaybackTarget(), 80);
  } finally {
    releaseInitial?.({});
    releaseChange?.({});
    close(f);
  }
});

test('pending writes and late self-events cannot revert the newest local target', async () => {
  const values = { [KEY]: 100 };
  let writes = 0;
  let release;
  const bus = observedSettings({
    get: async () => ({ ...values }),
    set: async update => {
      writes += 1;
      if (writes === 1) await new Promise(resolve => { release = resolve; });
      const oldValue = values[KEY];
      Object.assign(values, update);
      bus.emit({ [KEY]: { oldValue, newValue: values[KEY] } });
    }
  });
  const f = fixture([], { chrome: bus.chrome });
  try {
    await f.api.state.playbackTargetReady;
    const first = f.api.savePlaybackTarget(80);
    const last = f.api.savePlaybackTarget(90);
    await waitFor(() => writes === 1);
    bus.emit({ [KEY]: { oldValue: 100, newValue: 80 } });
    assert.equal(f.api.getPlaybackTarget(), 90);
    release();
    await Promise.all([first, last]);
    await f.api.state.playbackTargetSync;
    assert.equal(f.api.getPlaybackTarget(), 90);
    bus.emit({ [KEY]: { oldValue: 100, newValue: 80 } });
    await f.api.state.playbackTargetSync;
    assert.equal(f.api.getPlaybackTarget(), 90);
    assert.equal(values[KEY], 90);
  } finally {
    release?.();
    close(f);
  }
});

test('a delayed event read cannot overwrite a newer local edit', async () => {
  const values = { [KEY]: 100 };
  let reads = 0;
  let release;
  const bus = observedSettings({
    get: () => ++reads === 2
      ? new Promise(resolve => { release = resolve; })
      : Promise.resolve({ ...values }),
    set: async update => Object.assign(values, update)
  });
  const f = fixture([], { chrome: bus.chrome });
  try {
    await f.api.state.playbackTargetReady;
    values[KEY] = 80;
    bus.emit({ [KEY]: { oldValue: 100, newValue: 80 } });
    await f.api.savePlaybackTarget(90);
    release({ [KEY]: 80 });
    await f.api.state.playbackTargetSync;
    assert.equal(f.api.getPlaybackTarget(), 90);
    assert.equal(values[KEY], 90);
  } finally {
    release?.({});
    close(f);
  }
});

test('manual warnings are available on demand in the alerts view', () => {
  const f = fixture([]);
  try {
    const list = f.window.document.getElementById('wb-manual-list');
    assert.equal(list.getAttribute('aria-live'), 'polite');
    assert.equal(list.closest('[data-view]').hidden, true);
    f.api.state.manualItems = ['需要确认课程状态'];
    f.api.updateTaskControls();
    const link = f.window.document.getElementById('wb-ui-alert-link');
    assert.equal(link.hidden, false);
    assert.match(link.textContent, /待处理 1/);
    link.click();
    assert.equal(list.closest('[data-view]').hidden, false);
  } finally { close(f); }
});

test('valid input applies before blur; incomplete edits preserve the last applied target', async () => {
  const values={};
  const f=fixture([], {chrome:settingsChrome({get:async()=>({...values}),set:async update=>Object.assign(values,update)})});
  try {
    await f.api.state.playbackTargetReady;
    f.api.state.uiController.navigate('settings');
    const input=f.window.document.getElementById('wb-playback-target');input.focus();
    for(const typed of ['','8','101']){input.value=typed;input.dispatchEvent(new f.window.Event('input'));assert.equal(f.api.getPlaybackTarget(),100);}
    input.value='87';input.dispatchEvent(new f.window.Event('input'));
    assert.equal(f.api.getPlaybackTarget(),87);assert.equal(f.window.document.activeElement,input);
    await f.api.state.playbackTargetWrites;assert.equal(values[KEY],87);
    f.window.document.querySelector('[data-target-preset=80]').click();
    await f.api.state.playbackTargetWrites;assert.equal(values[KEY],80);assert.equal(input.value,'80');
    assert.equal(f.window.document.querySelector('[data-target-preset=80]').getAttribute('aria-pressed'),'true');
    assert.equal(f.media.paused,true);
  } finally {close(f);}
});
