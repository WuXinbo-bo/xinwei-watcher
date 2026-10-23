const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./helpers.cjs');

function setLayout(f) {
  const { window } = f;
  const panel = window.document.getElementById('wb-study-ui');
  const button = window.document.getElementById('wb-assistant-button');
  panel.getBoundingClientRect = () => {
    const width = 342, height = 480;
    const left = panel.style.left ? parseFloat(panel.style.left) : window.innerWidth - width - 18;
    const top = panel.style.top ? parseFloat(panel.style.top) : 90;
    return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON() {} };
  };
  button.getBoundingClientRect = () => {
    const width = 56, height = 56;
    const left = button.style.left ? parseFloat(button.style.left) : window.innerWidth - width - 18;
    const top = button.style.top ? parseFloat(button.style.top) : 90;
    return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON() {} };
  };
}

function pointer(window, target, type, x, y) {
  target.dispatchEvent(new window.MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y
  }));
}

function close(f) {
  f.api.state.running = false;
  f.api.state.epoch += 1;
  f.dom.window.close();
}

test('assistant starts as the supplied-image button and keeps the original panel collapsed', () => {
  const f = fixture([], {
    chrome: {
      runtime: {
        getURL: path => `chrome-extension://test/${path}`,
        sendMessage: async () => ({ ok: true, job: null, tabId: 1 })
      }
    }
  });
  try {
    setLayout(f);
    const panel = f.window.document.getElementById('wb-study-ui');
    const button = f.window.document.getElementById('wb-assistant-button');
    const image = button.querySelector('img');

    assert.equal(panel.hidden, true);
    assert.equal(button.hidden, false);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(image.alt, '');
    assert.match(image.src, /assets\/floating-assistant\.png$/);
    assert.ok(f.window.document.getElementById('wb-start'));
    assert.ok(f.window.document.getElementById('wb-playback-target'));
    assert.ok(f.window.document.getElementById('wb-video-list'));
    assert.ok(f.window.document.getElementById('wb-manual-list'));
    assert.ok(f.window.document.getElementById('wb-log'));
  } finally { close(f); }
});

test('a click expands the original panel and its close control restores the button', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    const panel = f.window.document.getElementById('wb-study-ui');
    const button = f.window.document.getElementById('wb-assistant-button');

    pointer(f.window, button, 'pointerdown', 980, 110);
    pointer(f.window, f.window.document, 'pointerup', 980, 110);
    assert.equal(panel.hidden, false);
    assert.equal(button.hidden, true);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(f.window.document.getElementById('wb-body').style.display, '');
    assert.equal(f.window.document.getElementById('wb-start').textContent, '开始');

    f.window.document.getElementById('wb-min').click();
    assert.equal(panel.hidden, true);
    assert.equal(button.hidden, false);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
  } finally { close(f); }
});

test('dragging the button clamps it to the viewport without expanding the panel', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    const panel = f.window.document.getElementById('wb-study-ui');
    const button = f.window.document.getElementById('wb-assistant-button');

    pointer(f.window, button, 'pointerdown', 980, 110);
    pointer(f.window, f.window.document, 'pointermove', -500, -500);
    pointer(f.window, f.window.document, 'pointerup', -500, -500);
    button.dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, detail: 1 }));

    assert.equal(panel.hidden, true);
    assert.equal(button.hidden, false);
    assert.equal(button.style.left, '8px');
    assert.equal(button.style.top, '8px');
  } finally { close(f); }
});

test('dragging the expanded header moves the panel and ignores its close button', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    const panel = f.window.document.getElementById('wb-study-ui');
    const button = f.window.document.getElementById('wb-assistant-button');
    pointer(f.window, button, 'pointerdown', 980, 110);
    pointer(f.window, f.window.document, 'pointerup', 980, 110);

    const header = f.window.document.getElementById('wb-drag');
    pointer(f.window, header, 'pointerdown', 900, 110);
    pointer(f.window, f.window.document, 'pointermove', 700, 220);
    pointer(f.window, f.window.document, 'pointerup', 700, 220);

    assert.equal(panel.hidden, false);
    assert.equal(panel.style.left, '464px');
    assert.equal(panel.style.top, '200px');
    assert.equal(button.hidden, true);
  } finally { close(f); }
});

test('collapse and expand only change UI visibility, not running-task state', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    f.api.state.running = true;
    f.api.state.mode = 'running';
    const button = f.window.document.getElementById('wb-assistant-button');
    pointer(f.window, button, 'pointerdown', 980, 110);
    pointer(f.window, f.window.document, 'pointerup', 980, 110);
    f.window.document.getElementById('wb-min').click();

    assert.equal(f.api.state.running, true);
    assert.equal(f.api.state.mode, 'running');
    assert.equal(f.window.document.getElementById('wb-start').textContent, '开始');
  } finally { close(f); }
});

test('resizing the viewport keeps the collapsed button visible', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    const button = f.window.document.getElementById('wb-assistant-button');
    Object.defineProperty(f.window, 'innerWidth', { configurable: true, value: 180 });
    Object.defineProperty(f.window, 'innerHeight', { configurable: true, value: 90 });
    f.window.dispatchEvent(new f.window.Event('resize'));

    assert.equal(button.hidden, false);
    assert.ok(parseFloat(button.style.left) >= 8);
    assert.ok(parseFloat(button.style.left) + 56 <= f.window.innerWidth - 8);
    assert.ok(parseFloat(button.style.top) + 56 <= f.window.innerHeight - 8);
  } finally { close(f); }
});
