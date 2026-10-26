const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./helpers.cjs');

function sponsorFixture() {
  let now = 0, nextId = -1, preference, hidden = false;
  const timers = new Map();
  const f = fixture([], { beforeContent({ window }) {
    preference = new window.EventTarget(); preference.matches = false;
    window.matchMedia = () => preference;
    Object.defineProperty(window.document, 'hidden', { get: () => hidden });
    const nativeSet = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) => {
      if (delay !== 7000 && delay !== 140) return nativeSet(fn, delay, ...args);
      const id = nextId--; timers.set(id, { time: now + delay, fn: () => fn(...args) }); return id;
    };
    window.clearTimeout = id => { if (!timers.delete(id)) nativeClear(id); };
  } });
  f.window.document.getElementById('wb-assistant-button').click();
  return Object.assign(f, {
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.time <= end).sort((a, b) => a[1].time - b[1].time)[0];
        if (!next) break; now = next[1].time; timers.delete(next[0]); next[1].fn();
      }
      now = end;
    },
    reduced(value) { preference.matches = value; preference.dispatchEvent(new f.window.Event('change')); },
    visibility(value) { hidden = value; f.window.document.dispatchEvent(new f.window.Event('visibilitychange')); },
    message: () => f.window.document.getElementById('wb-sponsor-message').textContent,
    timerCount: () => timers.size
  });
}

test('sponsor copy rotates without task commands or layout replacement and can be explicitly paused', () => {
  const f = sponsorFixture();
  try {
    const box = f.window.document.getElementById('wb-study-ui');
    assert.equal(box.getAttribute('aria-label'), '芯位教育课堂助手');
    assert.equal(box.querySelector('#wb-drag [aria-label=设置]').title, '设置');
    const first = f.message(), link = box.querySelector('#wb-sponsor-link');
    let commands = 0; f.window.chrome.runtime.sendMessage = async () => { commands++; };
    f.advance(7140); assert.notEqual(f.message(), first); assert.equal(box.querySelector('#wb-sponsor-link'), link);
    const toggle = box.querySelector('#wb-sponsor-toggle'); toggle.click();
    const paused = f.message(); f.advance(30000); assert.equal(f.message(), paused);
    assert.equal(toggle.getAttribute('aria-pressed'), 'true'); assert.equal(toggle.getAttribute('aria-label'), '继续赞助轮播');
    toggle.click(); f.advance(7140); assert.notEqual(f.message(), paused);
    assert.equal(commands, 0); assert.equal(f.api.state.running, false);
  } finally { f.window.close(); }
});

test('hover, keyboard focus, hidden documents and collapsed panels all suspend rotation', () => {
  const f = sponsorFixture();
  try {
    const sponsor = f.window.document.getElementById('wb-sponsor'), first = f.message();
    sponsor.dispatchEvent(new f.window.Event('pointerenter')); f.advance(20000); assert.equal(f.message(), first);
    sponsor.dispatchEvent(new f.window.Event('pointerleave'));
    f.window.document.getElementById('wb-sponsor-link').focus(); f.advance(20000); assert.equal(f.message(), first);
    f.window.document.getElementById('wb-sponsor-link').blur();
    f.visibility(true); f.advance(20000); assert.equal(f.message(), first);
    f.visibility(false); f.advance(7140); assert.notEqual(f.message(), first);
    const beforeCollapse = f.message(); f.window.document.getElementById('wb-min').click();
    assert.equal(f.timerCount(), 0); f.advance(20000); assert.equal(f.message(), beforeCollapse);
    f.window.document.getElementById('wb-assistant-button').click(); f.advance(7140); assert.notEqual(f.message(), beforeCollapse);
  } finally { f.window.close(); }
});

test('reduced motion and one sponsor message remain static; unsafe or disabled sponsors are hidden', () => {
  const f = sponsorFixture();
  try {
    f.reduced(true); const first = f.message(); f.advance(30000); assert.equal(f.message(), first);
    assert.equal(f.timerCount(), 0); assert.equal(f.window.document.getElementById('wb-sponsor-toggle').hidden, true);
    f.reduced(false); f.advance(7140); assert.notEqual(f.message(), first);
    f.api.PROMOTION_CONFIG.services = ['单条服务']; f.api.updateTaskControls();
    assert.equal(f.timerCount(), 0);
    f.api.PROMOTION_CONFIG.brand = '<img src=x onerror=alert(1)>'; f.api.updateTaskControls();
    assert.match(f.message(), /<img/); assert.equal(f.window.document.querySelector('#wb-sponsor img'), null);
    f.api.PROMOTION_CONFIG.url = 'javascript:alert(1)'; f.api.updateTaskControls();
    assert.equal(f.window.document.getElementById('wb-sponsor').hidden, true); assert.equal(f.timerCount(), 0);
    f.api.PROMOTION_CONFIG.url = 'https://example.test/'; f.api.PROMOTION_CONFIG.enabled = false; f.api.updateTaskControls();
    assert.equal(f.window.document.getElementById('wb-sponsor').hidden, true);
  } finally { f.window.close(); }
});
