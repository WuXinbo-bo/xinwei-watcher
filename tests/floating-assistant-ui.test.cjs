const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./helpers.cjs');

function setLayout(f) {
  const { window } = f;
  const panel = window.document.getElementById('wb-study-ui');
  const button = window.document.getElementById('wb-assistant-button');
  panel.getBoundingClientRect = () => {
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const width = Math.min(310, Math.max(0, viewportWidth - 16));
    const shellHeight = 16;
    const height = Math.min(480, Math.max(0, viewportHeight - shellHeight));
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

function pointer(window, target, type, x, y, { pointerId = 1, isPrimary = true } = {}) {
  // jsdom has no PointerEvent, so expose the pointer fields used by the drag logic.
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
    isPrimary: { value: isPrimary },
    pointerId: { value: pointerId }
  });
  target.dispatchEvent(event);
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
    assert.equal(panel.style.left, '496px');
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

test('the six-pixel drag threshold separates taps from intentional movement', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    const button = f.window.document.getElementById('wb-assistant-button');
    const panel = f.window.document.getElementById('wb-study-ui');

    pointer(f.window, button, 'pointerdown', 980, 110);
    pointer(f.window, f.window.document, 'pointermove', 985, 110);
    pointer(f.window, f.window.document, 'pointerup', 985, 110);
    assert.equal(panel.hidden, false);

    f.window.document.getElementById('wb-min').click();
    const buttonLeft = parseFloat(button.style.left);
    const buttonTop = parseFloat(button.style.top);
    const pointerX = buttonLeft + 28;
    const pointerY = buttonTop + 28;
    pointer(f.window, button, 'pointerdown', pointerX, pointerY);
    pointer(f.window, f.window.document, 'pointermove', pointerX + 6, pointerY);
    pointer(f.window, f.window.document, 'pointerup', pointerX + 6, pointerY);
    button.dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, detail: 1 }));

    assert.equal(panel.hidden, true);
    assert.equal(button.hidden, false);
    assert.equal(button.style.left, `${buttonLeft + 6}px`);
  } finally { close(f); }
});

test('pointer identity is honored and pointer cancellation clears the active drag', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    const button = f.window.document.getElementById('wb-assistant-button');
    const panel = f.window.document.getElementById('wb-study-ui');

    pointer(f.window, button, 'pointerdown', 980, 110, { pointerId: 7 });
    pointer(f.window, f.window.document, 'pointermove', 900, 110, { pointerId: 8 });
    pointer(f.window, f.window.document, 'pointerup', 900, 110, { pointerId: 8 });
    assert.equal(button.style.left, '950px');
    assert.equal(panel.hidden, true);

    pointer(f.window, f.window.document, 'pointermove', 990, 110, { pointerId: 7 });
    pointer(f.window, f.window.document, 'pointercancel', 990, 110, { pointerId: 7 });
    pointer(f.window, f.window.document, 'pointerup', 900, 110, { pointerId: 7 });
    assert.equal(panel.hidden, true);
    assert.equal(button.hidden, false);
    assert.equal(button.style.left, '960px');
  } finally { close(f); }
});

test('dragging the collapsed button preserves its vertical position when expanded', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    const button = f.window.document.getElementById('wb-assistant-button');
    const panel = f.window.document.getElementById('wb-study-ui');

    pointer(f.window, button, 'pointerdown', 980, 110);
    pointer(f.window, f.window.document, 'pointermove', 700, 160);
    pointer(f.window, f.window.document, 'pointerup', 700, 160);
    assert.equal(button.style.top, '140px');

    Object.defineProperty(f.window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(f.window, 'innerHeight', { configurable: true, value: 700 });
    f.window.dispatchEvent(new f.window.Event('resize'));
    pointer(f.window, button, 'pointerdown', 700, 160);
    pointer(f.window, f.window.document, 'pointerup', 700, 160);

    assert.equal(panel.hidden, false);
    assert.equal(panel.style.top, '140px');
  } finally { close(f); }
});

test('short viewports constrain the panel and allow its content to scroll', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    Object.defineProperty(f.window, 'innerWidth', { configurable: true, value: 360 });
    Object.defineProperty(f.window, 'innerHeight', { configurable: true, value: 240 });
    f.window.dispatchEvent(new f.window.Event('resize'));

    const button = f.window.document.getElementById('wb-assistant-button');
    const panel = f.window.document.getElementById('wb-study-ui');
    pointer(f.window, button, 'pointerdown', 330, 110);
    pointer(f.window, f.window.document, 'pointerup', 330, 110);

    const panelRect = panel.getBoundingClientRect();
    assert.equal(panel.hidden, false);
    assert.equal(panel.style.top, '8px');
    assert.ok(panelRect.top >= 8);
    assert.ok(panelRect.bottom + 8 <= f.window.innerHeight);
    assert.equal(f.window.document.getElementById('wb-promotion'), null);
    const injectedStyle = [...f.window.document.querySelectorAll('style')]
      .map(style => style.textContent).join('\n');
    assert.match(injectedStyle, /max-height:\s*calc\(var\(--wb-visible-height,100vh\) - 16px\)/);
    assert.match(injectedStyle, /#wb-study-ui \.bd\{[^}]*overflow-y:auto/s);
  } finally { close(f); }
});

test('visual viewport resize and pan keep the floating assistant inside its visible bounds', async () => {
  let viewport;
  const f = fixture([], {
    beforeContent({ window }) {
      viewport = new window.EventTarget();
      Object.defineProperties(viewport, {
        width: { configurable: true, writable: true, value: 300 },
        height: { configurable: true, writable: true, value: 220 },
        offsetLeft: { configurable: true, writable: true, value: 100 },
        offsetTop: { configurable: true, writable: true, value: 80 }
      });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    }
  });
  try {
    setLayout(f);
    const button = f.window.document.getElementById('wb-assistant-button');
    const panel = f.window.document.getElementById('wb-study-ui');
    assert.equal(button.style.left, '336px');

    viewport.width = 280;
    viewport.height = 200;
    viewport.dispatchEvent(new f.window.Event('resize'));
    await new Promise(resolve => f.window.requestAnimationFrame(resolve));
    assert.equal(button.style.left, '316px');
    assert.equal(panel.style.getPropertyValue('--wb-visible-width'), '280px');
    assert.equal(panel.style.getPropertyValue('--wb-visible-height'), '200px');

    viewport.offsetLeft = 500;
    viewport.offsetTop = 200;
    viewport.dispatchEvent(new f.window.Event('scroll'));
    await new Promise(resolve => f.window.requestAnimationFrame(resolve));

    assert.equal(button.style.left, '508px');
    assert.equal(button.style.top, '208px');
    assert.equal(panel.style.getPropertyValue('--wb-visible-width'), '280px');
    assert.equal(panel.style.getPropertyValue('--wb-visible-height'), '200px');

    pointer(f.window, button, 'pointerdown', 520, 220);
    pointer(f.window, f.window.document, 'pointerup', 520, 220);
    const panelRect = panel.getBoundingClientRect();
    assert.equal(panel.hidden, false);
    assert.ok(panelRect.left >= viewport.offsetLeft + 8);
    assert.ok(panelRect.top >= viewport.offsetTop + 8);
    assert.ok(panelRect.right + 8 <= viewport.offsetLeft + viewport.width);
    assert.ok(panelRect.bottom + 8 <= viewport.offsetTop + viewport.height);
  } finally { close(f); }
});

test('the floating button remains clamped at the smallest fitting viewport and recovers after resize', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    const button = f.window.document.getElementById('wb-assistant-button');

    Object.defineProperty(f.window, 'innerWidth', { configurable: true, value: 64 });
    Object.defineProperty(f.window, 'innerHeight', { configurable: true, value: 64 });
    f.window.dispatchEvent(new f.window.Event('resize'));
    assert.equal(button.style.left, '8px');
    assert.equal(button.style.top, '8px');

    Object.defineProperty(f.window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(f.window, 'innerHeight', { configurable: true, value: 768 });
    f.window.dispatchEvent(new f.window.Event('resize'));
    assert.ok(parseFloat(button.style.left) + 56 <= f.window.innerWidth - 8);
    assert.ok(parseFloat(button.style.top) + 56 <= f.window.innerHeight - 8);
  } finally { close(f); }
});

test('non-primary and canceled pointers do not activate the floating assistant', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    const button = f.window.document.getElementById('wb-assistant-button');

    pointer(f.window, button, 'pointerdown', 980, 110, { isPrimary: false });
    pointer(f.window, f.window.document, 'pointerup', 980, 110);
    assert.equal(button.hidden, false);

    pointer(f.window, button, 'pointerdown', 980, 110, { pointerId: 2 });
    pointer(f.window, f.window.document, 'pointercancel', 980, 110, { pointerId: 2 });
    assert.equal(button.hidden, false);
  } finally { close(f); }
});

test('manifest exposes only the local avatar to the existing course-site origin', () => {
  const manifest = JSON.parse(require('node:fs').readFileSync('manifest.json', 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.web_accessible_resources, [{
    resources: ['assets/floating-assistant.png'],
    matches: ['https://www.beeline-ai.com/*']
  }]);
});

test('commercial services appear only after opening About, with an explicit safe link', () => {
  const f = fixture([]);
  try {
    const box = f.window.document.getElementById('wb-study-ui');
    f.window.document.getElementById('wb-assistant-button').click();
    assert.equal(box.querySelector('a'), null);
    assert.equal(box.querySelector('animate'), null);
    f.api.state.uiController.navigate('settings');
    box.querySelector('[data-ui-view="about"]').click();
    const link = box.querySelector('.wb-external');
    assert.equal(link.href, 'https://88cf.scxai.top/');
    assert.equal(link.target, '_blank');
    assert.match(link.rel, /noopener.*noreferrer.*sponsored/);
    assert.match(link.parentElement.textContent, /第三方商业服务/);
    assert.equal(f.api.state.running, false);
    f.api.PROMOTION_CONFIG.enabled = false;
    f.api.updateTaskControls();
    assert.equal(box.querySelector('a'), null);
    assert.equal(box.hidden, false);
  } finally { close(f); }
});
