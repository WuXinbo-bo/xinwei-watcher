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
    const width = Math.min(342, Math.max(0, viewportWidth - 30));
    const shellHeight = parseFloat(panel.style.getPropertyValue('--wb-shell-height')) || 28;
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
    assert.equal(panel.style.left, '450px');
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

test('short viewports constrain the panel and keep the compact promotion link in view', () => {
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
    assert.ok(panelRect.bottom + 48 <= f.window.innerHeight);
    assert.equal(f.window.document.getElementById('wb-promotion').dataset.compact, 'true');
    assert.equal(f.window.document.querySelector('.wb-promo-compact').hidden, false);
    assert.equal(f.window.document.getElementById('wb-body').style.overflowY, '');

    const injectedStyle = [...f.window.document.querySelectorAll('style')]
      .map(style => style.textContent).join('\n');
    assert.match(injectedStyle, /max-height:\s*calc\(var\(--wb-visible-height,100vh\) - var\(--wb-shell-height,28px\)\)/);
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
    assert.ok(panelRect.left >= viewport.offsetLeft + 13);
    assert.ok(panelRect.top >= viewport.offsetTop + 8);
    assert.ok(panelRect.right + 12 <= viewport.offsetLeft + viewport.width);
    assert.ok(panelRect.bottom + 48 <= viewport.offsetTop + viewport.height);
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

test('promotion uses one continuous SVG text path and opens only its external link', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    const promo = f.window.document.getElementById('wb-promotion');
    const button = f.window.document.getElementById('wb-assistant-button');
    assert.ok(promo);
    assert.equal(promo.hidden, true);
    assert.equal(promo.querySelectorAll('.wb-promo-edge').length, 0);
    assert.equal(promo.querySelectorAll('.wb-promo-link').length, 1);
    assert.equal(promo.querySelectorAll('.wb-promo-compact').length, 1);

    pointer(f.window, button, 'pointerdown', 980, 110);
    pointer(f.window, f.window.document, 'pointerup', 980, 110);

    assert.equal(promo.hidden, false);
    assert.match(promo.textContent, /创世の鑫元/);
    assert.match(promo.textContent, /让灵感接入 AI/);
    assert.match(promo.textContent, /AI API 中转/);
    assert.match(promo.textContent, /GPT 会员代充值/);
    assert.doesNotMatch(promo.textContent, /推广|了解更多/);
    assert.match(promo.getAttribute('aria-label'), /非课程平台服务/);
    const link = promo.querySelector('.wb-promo-link');
    assert.equal(link.getAttribute('href'), 'https://88cf.scxai.top/');
    assert.equal(link.getAttribute('target'), '_blank');
    assert.match(link.getAttribute('rel'), /noopener.*sponsored/);
    assert.match(link.getAttribute('aria-label'), /外部商业服务/);
    const path = promo.querySelector('defs path');
    const textPath = promo.querySelector('textPath');
    const motion = promo.querySelector('.wb-promo-motion');
    assert.match(path.getAttribute('d'), /^M .* A .* Z$/);
    assert.match(textPath.getAttribute('href'), /^#wb-promo-path-/);
    assert.ok(textPath.querySelectorAll('tspan.wb-promo-word').length >= 8);
    assert.equal(textPath.getAttribute('lengthAdjust'), 'spacingAndGlyphs');
    assert.equal(motion.getAttribute('attributeName'), 'startOffset');
    assert.equal(motion.getAttribute('repeatCount'), 'indefinite');
    assert.ok(Number(motion.getAttribute('to')) < 0);
    assert.equal(promo.dataset.compact, 'false');

    const injectedStyle = [...f.window.document.querySelectorAll('style')]
      .map(style => style.textContent).join('\n');
    assert.match(injectedStyle, /prefers-reduced-motion:\s*reduce/);
    assert.match(injectedStyle, /#wb-promotion\s*\{[^}]*pointer-events:none/s);
    assert.match(injectedStyle, /wb-promo-svg/);
    assert.match(injectedStyle, /font-size:13px/);
    assert.doesNotMatch(injectedStyle, /offset-rotate/);
  } finally { close(f); }
});

test('hovering and keyboard focus pause the whole orbit and resume without resetting it', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    f.window.document.getElementById('wb-assistant-button').click();
    const promo = f.window.document.getElementById('wb-promotion');
    const links = promo.querySelectorAll('a');
    const path = promo.querySelector('defs path').getAttribute('d');
    links[0].dispatchEvent(new f.window.MouseEvent('pointerover', { bubbles: true }));
    assert.equal(promo.classList.contains('is-paused'), true);
    links[0].dispatchEvent(new f.window.MouseEvent('pointerout', {
      bubbles: true, relatedTarget: links[1]
    }));
    assert.equal(promo.classList.contains('is-paused'), true);
    links[1].dispatchEvent(new f.window.MouseEvent('pointerout', { bubbles: true }));
    assert.equal(promo.classList.contains('is-paused'), false);
    links[0].focus();
    assert.equal(promo.classList.contains('is-paused'), true);
    links[0].dispatchEvent(new f.window.MouseEvent('pointerout', { bubbles: true }));
    assert.equal(promo.classList.contains('is-paused'), true);
    links[0].blur();
    assert.equal(promo.classList.contains('is-paused'), false);
    assert.equal(promo.querySelector('defs path').getAttribute('d'), path);

    links[0].focus();
    assert.equal(promo.classList.contains('is-paused'), true);
    const move = x => {
      const event = new f.window.MouseEvent('pointermove', { bubbles: true });
      Object.defineProperty(event, 'clientX', { value: x });
      Object.defineProperty(event, 'clientY', { value: 20 });
      f.window.document.dispatchEvent(event);
    };
    move(10);
    f.window.dispatchEvent(new f.window.Event('blur'));
    f.window.dispatchEvent(new f.window.Event('focus'));
    assert.equal(promo.classList.contains('is-paused'), false);
    assert.notEqual(f.window.document.activeElement, links[0]);
    links[0].dispatchEvent(new f.window.MouseEvent('pointerover', { bubbles: true }));
    assert.equal(promo.classList.contains('is-paused'), false);
    move(11);
    assert.equal(promo.classList.contains('is-paused'), false);
    move(12);
    assert.equal(promo.classList.contains('is-paused'), false);
    move(13);
    links[0].dispatchEvent(new f.window.MouseEvent('pointerover', { bubbles: true }));
    assert.equal(promo.classList.contains('is-paused'), true);
  } finally { close(f); }
});

test('activating a promotion link clears retained focus even without browser leave events', async () => {
  const f = fixture([]);
  try {
    setLayout(f);
    f.window.document.getElementById('wb-assistant-button').click();
    const promo = f.window.document.getElementById('wb-promotion');
    const link = promo.querySelector('.wb-promo-link');
    const text = link.querySelector('.wb-promo-word');
    link.focus();
    text.dispatchEvent(new f.window.MouseEvent('pointerover', { bubbles: true }));
    assert.equal(promo.classList.contains('is-paused'), true);
    // Avoid jsdom's unsupported navigation; test only the post-activation cleanup.
    link.addEventListener('click', event => event.preventDefault());
    text.dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise(resolve => f.window.setTimeout(resolve, 5));
    assert.equal(promo.classList.contains('is-paused'), false);
    assert.equal(link.contains(f.window.document.activeElement), false);
    assert.equal(f.api.state.running, false);
  } finally { close(f); }
});

test('visibility and BFCache return resume SVG motion, while reduced motion stays static', async () => {
  let preference;
  let hidden = false;
  let pauses = 0;
  let resumes = 0;
  const f = fixture([], {
    beforeContent({ window }) {
      preference = new window.EventTarget();
      preference.matches = false;
      window.matchMedia = () => preference;
      window.SVGElement.prototype.pauseAnimations = () => { pauses++; };
      window.SVGElement.prototype.unpauseAnimations = () => { resumes++; };
      Object.defineProperty(window.document, 'hidden', { get: () => hidden });
    }
  });
  try {
    setLayout(f);
    f.window.document.getElementById('wb-assistant-button').click();
    await Promise.resolve();
    const promo = f.window.document.getElementById('wb-promotion');
    const link = promo.querySelector('.wb-promo-link');
    assert.ok(resumes > 0);
    link.focus();
    hidden = true;
    f.window.document.dispatchEvent(new f.window.Event('visibilitychange'));
    assert.equal(promo.classList.contains('is-paused'), true);
    hidden = false;
    f.window.document.dispatchEvent(new f.window.Event('visibilitychange'));
    assert.equal(promo.classList.contains('is-paused'), false);
    assert.equal(link.contains(f.window.document.activeElement), false);
    link.focus();
    const restored = new f.window.Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    f.window.dispatchEvent(restored);
    assert.equal(promo.classList.contains('is-paused'), false);

    preference.matches = true;
    preference.dispatchEvent(new f.window.Event('change'));
    assert.equal(promo.classList.contains('is-paused'), true);
    f.window.dispatchEvent(new f.window.Event('blur'));
    f.window.dispatchEvent(new f.window.Event('focus'));
    assert.equal(promo.classList.contains('is-paused'), true);
    preference.matches = false;
    preference.dispatchEvent(new f.window.Event('change'));
    assert.equal(promo.classList.contains('is-paused'), false);
    f.window.document.getElementById('wb-min').click();
    assert.equal(promo.hidden, true);
    assert.equal(promo.classList.contains('is-paused'), true);
    assert.ok(pauses > 0);
  } finally { close(f); }
});

test('narrow viewports use a compact external brand link and recover the orbit on resize', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    const promo = f.window.document.getElementById('wb-promotion');
    const button = f.window.document.getElementById('wb-assistant-button');
    Object.defineProperty(f.window, 'innerWidth', { configurable: true, value: 390 });
    f.window.dispatchEvent(new f.window.Event('resize'));
    button.click();
    assert.equal(promo.dataset.compact, 'true');
    assert.equal(promo.hidden, false);
    assert.equal(f.window.document.getElementById('wb-study-ui').hidden, false);
    Object.defineProperty(f.window, 'innerWidth', { configurable: true, value: 1200 });
    f.window.dispatchEvent(new f.window.Event('resize'));
    assert.equal(promo.dataset.compact, 'false');
    assert.match(promo.querySelector('defs path').getAttribute('d'), / Z$/);
    assert.equal(promo.querySelector('.wb-promo-compact').hidden, true);
  } finally { close(f); }
});

test('disabling the promotion hides only its layer and leaves the panel usable', () => {
  const f = fixture([]);
  try {
    setLayout(f);
    const button = f.window.document.getElementById('wb-assistant-button');
    pointer(f.window, button, 'pointerdown', 980, 110);
    pointer(f.window, f.window.document, 'pointerup', 980, 110);
    f.api.state.running = true;
    f.api.PROMOTION_CONFIG.enabled = false;
    f.api.updateTaskControls();

    assert.equal(f.window.document.getElementById('wb-promotion').hidden, true);
    assert.equal(f.window.document.getElementById('wb-study-ui').hidden, false);
    assert.equal(f.window.document.getElementById('wb-assistant-button').hidden, true);
    assert.ok(f.window.document.getElementById('wb-start'));
    assert.equal(f.api.state.running, true);
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
