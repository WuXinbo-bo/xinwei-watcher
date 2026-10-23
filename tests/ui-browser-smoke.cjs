const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xinwei-ui-smoke-'));
  const artifacts = process.env.UI_ARTIFACTS_DIR ||
    await fs.mkdtemp(path.join(os.tmpdir(), 'xinwei-ui-results-'));
  await fs.mkdir(artifacts, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    viewport: { width: 1280, height: 900 }
  });
  try {
    const worker = context.serviceWorkers()[0] ||
      await context.waitForEvent('serviceworker', { timeout: 10000 });
    assert.match(worker.url(), /^chrome-extension:\/\/.*\/background\.js$/);
    await context.route('https://www.beeline-ai.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><title>Local UI Fixture</title>' +
        '<style>body{margin:0;background:#f2f5fa;font:14px Arial}' +
        'main{padding:32px;color:#435065}</style><main>Local Course UI Fixture</main>'
    }));
    await context.route('https://88cf.scxai.top/**', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>External Link Fixture</title>'
    }));
    const page = await context.newPage();
    await page.goto('https://www.beeline-ai.com/myBank/courseResearch');
    const button = page.locator('#wb-assistant-button');
    const panel = page.locator('#wb-study-ui');
    const promo = page.locator('#wb-promotion');
    await button.waitFor();
    assert.equal(await panel.isVisible(), false);
    const image = await button.locator('img').evaluate(img => ({
      loaded: img.complete && img.naturalWidth > 0, src: img.src
    }));
    assert.equal(image.loaded, true);
    assert.match(image.src, /^chrome-extension:\/\/.*\/assets\/floating-assistant\.png$/);
    await page.screenshot({ path: path.join(artifacts, 'collapsed.png') });
    await button.click();
    assert.equal(await panel.isVisible(), true);
    assert.equal(await page.locator('#wb-start').textContent(), '开始');
    assert.equal(await page.locator('#wb-playback-target').getAttribute('min'), '80');
    assert.equal(await page.locator('#wb-playback-target').getAttribute('max'), '100');
    assert.deepEqual(await page.locator('textPath tspan.wb-promo-word').allTextContents(),
      ['创世の鑫元', '让灵感接入 AI', 'AI API 中转', 'GPT 会员代充值']);
    const orbit = await page.locator('textPath').evaluate(tp => {
      const path = tp.ownerSVGElement.querySelector('defs path');
      return {
        textLength: tp.getComputedTextLength(),
        loopLength: path.getTotalLength() / 2,
        travel: Number(tp.querySelector('animate').getAttribute('to'))
      };
    });
    assert.ok(orbit.textLength < orbit.loopLength, 'the single message leaves an empty orbit segment');
    assert.ok(Math.abs(orbit.travel - orbit.loopLength) < 2, 'the message travels exactly one lap');
    await page.mouse.move(10, 10);
    const readMotion = () => page.locator('textPath').evaluate(tp => tp.startOffset.animVal.value);
    const initialOffset = await readMotion();
    await page.waitForTimeout(300);
    assert.notEqual(await readMotion(), initialOffset, 'visible text must move');
    const rotations = await page.locator('textPath').evaluate(tp => {
      const svg = tp.ownerSVGElement;
      const duration = Number.parseFloat(tp.querySelector('animate').getAttribute('dur'));
      const sampled = [];
      svg.pauseAnimations();
      for (let frame = 0; frame <= 100; frame += 1) {
        svg.setCurrentTime(duration * frame / 100);
        for (let i = 0; i < tp.getNumberOfChars(); i += 1) {
          sampled.push(tp.getRotationOfChar(i));
        }
      }
      svg.setCurrentTime(0);
      svg.unpauseAnimations();
      return sampled;
    });
    assert.ok(rotations.some(angle => Math.abs(Math.abs(angle) - 90) < 2), 'side glyphs rotate');
    assert.ok(rotations.some(angle => Math.abs(angle) > 5 && Math.abs(angle) < 85),
      'corner glyphs bend along the path');
    const link = page.locator('.wb-promo-link');
    await link.focus();
    await page.waitForTimeout(200);
    const point = await page.locator('textPath').evaluate(() => {
      const link = document.querySelector('.wb-promo-link');
      const rect = document.querySelector('.wb-promo-svg').getBoundingClientRect();
      const probes = [];
      for (let x = rect.left; x <= rect.right; x += 2) {
        probes.push([x, rect.top + 12], [x, rect.bottom - 12]);
      }
      for (let y = rect.top; y <= rect.bottom; y += 2) {
        probes.push([rect.left + 12, y], [rect.right - 12, y]);
      }
      // SVG character extents can include glyphs clipped at the loop seam.
      for (const [x, y] of probes) {
        const hit = document.elementFromPoint(x, y);
        if (hit && link.contains(hit) && hit.closest('.wb-promo-word')) return { x, y };
      }
      return null;
    });
    assert.ok(point, 'find a painted glyph for real pointer verification');
    await page.mouse.move(point.x, point.y);
    await link.evaluate(anchor => anchor.blur());
    await page.waitForTimeout(200);
    assert.equal(await promo.evaluate(el => el.classList.contains('is-paused')), true);
    const hoveredFont = await page.evaluate(({ x, y }) =>
      getComputedStyle(document.elementFromPoint(x, y).closest('.wb-promo-word')).fontSize, point);
    assert.equal(hoveredFont, '13px');
    await page.screenshot({ path: path.join(artifacts, 'hover.png') });
    const popupPromise = context.waitForEvent('page', { timeout: 5000 });
    await page.mouse.click(point.x, point.y);
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), 'https://88cf.scxai.top/');
    await page.bringToFront();
    await page.waitForTimeout(100);
    assert.equal(await promo.evaluate(el => el.classList.contains('is-paused')), false);
    const returnedOffset = await readMotion();
    await page.waitForTimeout(300);
    assert.notEqual(await readMotion(), returnedOffset, 'post-click motion resumes');
    await page.mouse.move(10, 10);
    await page.screenshot({ path: path.join(artifacts, 'desktop.png') });
    await page.locator('#wb-min').click();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await promo.isVisible(), false);
    await button.click();
    await page.setViewportSize({ width: 390, height: 780 });
    await page.waitForFunction(() =>
      document.querySelector('#wb-promotion').dataset.compact === 'true');
    assert.equal(await promo.getAttribute('data-compact'), 'true');
    const compactBox = await page.locator('.wb-promo-compact').boundingBox();
    assert.ok(compactBox.x >= 0 && compactBox.y >= 0);
    assert.ok(compactBox.x + compactBox.width <= 390);
    assert.ok(compactBox.y + compactBox.height <= 780);
    await page.screenshot({ path: path.join(artifacts, 'mobile.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(100);
    const reducedOffset = await readMotion();
    await page.waitForTimeout(300);
    assert.equal(await readMotion(), reducedOffset, 'reduced motion stays static');
    console.log(JSON.stringify({
      passed: true, browser: context.browser()?.version(), image,
      checks: ['local extension image', 'collapsed entry', 'original panel', 'continuous motion',
        'rounded corners', 'hover enlargement', 'explicit click', 'post-click recovery',
        'collapse', 'narrow viewport', 'reduced motion'], artifacts
    }, null, 2));
  } finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
