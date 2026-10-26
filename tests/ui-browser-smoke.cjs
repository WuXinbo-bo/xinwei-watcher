/* Real extension rendering on synthetic pages; no real account or course task. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xinwei-ui-smoke-'));
  const artifacts = process.env.UI_ARTIFACTS_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'xinwei-ui-results-'));
  await fs.mkdir(artifacts, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    viewport: { width: 1280, height: 900 }
  });
  const errors = [], checks = [];
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    assert.match(worker.url(), /^chrome-extension:\/\/.*\/background\.js$/);
    await context.route('https://www.beeline-ai.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><title>本地 UI 测试 · 示例数据</title>' +
        '<style>body{margin:0;background:#f2f5fa;font:14px sans-serif;color:#435065}main{padding:32px}</style>' +
        '<main><h1>本地 UI 测试 · 示例数据</h1><p>此页面不连接真实学习数据。</p><div class="course-name">操作系统原理</div>' +
        '<div class="sub-menu-area"><ul class="el-menu"><li class="el-sub-menu is-opened" aria-expanded="true">' +
        '<div class="el-sub-menu__title">第一章 · 基础理论</div><ul>' +
        ['护理学导论', '沟通与关怀', '生命体征评估'].map((name, i) => '<li class="el-menu-item"><span class="lecture-title">' + name +
          '</span><i class="' + (i === 1 ? 'audio' : 'video') + '-icon"></i><div class="video-duration">10 分 00 秒</div><span class="lecture-status"><i class="unStart-icon"></i></span></li>').join('') +
        '</ul></li></ul></div><video></video></main>'
    }));
    await context.route('https://88cf.scxai.top/**', route => route.fulfill({ contentType: 'text/html', body: '<title>赞助链接本地测试</title>' }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page), contexts = [];
    cdp.on('Runtime.executionContextCreated', event => contexts.push(event.context));
    await cdp.send('Runtime.enable');
    await page.goto('https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1');
    const button = page.locator('#wb-assistant-button'), panel = page.locator('#wb-study-ui');
    await button.waitFor();
    const ext = contexts.find(c => c.origin.startsWith('chrome-extension://'));
    assert.ok(ext, 'extension isolated world exists');
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, contextId: ext.id, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const snap = async name => {
      await page.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' });
      if (await panel.isVisible()) await panel.screenshot({ path: path.join(artifacts, `${name}-panel.png`), animations: 'disabled' });
    };
    const navigate = async view => { await evaluate(`__wbStudyTest.state.uiController.navigate(${JSON.stringify(view)})`); };
    assert.equal(await panel.isVisible(), false);
    assert.equal(await button.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), true);
    await snap('00-collapsed'); await button.click();
    assert.equal((await panel.boundingBox()).width, 310);
    assert.equal(await page.locator('#wb-log').isVisible(), false);
    assert.equal(await page.locator('#wb-playback-target').isVisible(), false);
    assert.equal(await panel.getAttribute('aria-label'), '芯位教育助手');
    assert.equal(await page.locator('#wb-drag [aria-label=设置]').getAttribute('title'), '设置');
    const sponsor = page.locator('#wb-sponsor'), sponsorCopy = page.locator('#wb-sponsor-message');
    assert.equal(await sponsor.isVisible(), true);
    assert.equal(await sponsor.evaluate(el => el.previousElementSibling.id), 'wb-drag');
    const sponsorHeight = (await sponsor.boundingBox()).height;
    await snap('01-ready'); checks.push('real extension, corrected brand, gear icon, local image, compact home');
    const initialCopy = await sponsorCopy.textContent();
    await page.mouse.move(10, 10);
    await page.waitForFunction(text => document.getElementById('wb-sponsor-message').textContent !== text, initialCopy, { timeout: 15000 });
    assert.equal((await sponsor.boundingBox()).height, sponsorHeight);
    assert.equal(await page.locator('#wb-sponsor-toggle').count(), 0);
    assert.equal(await page.locator('.wb-sponsor-mark').evaluate(el => getComputedStyle(el, '::after').animationName), 'wb-sponsor-shine');
    await sponsor.hover();
    const pausedCopy = await sponsorCopy.textContent();
    await page.waitForTimeout(10300); assert.equal(await sponsorCopy.textContent(), pausedCopy);
    const popupPromise = context.waitForEvent('page');
    await page.locator('#wb-sponsor-link').click(); const popup = await popupPromise;
    await popup.waitForLoadState(); assert.equal(popup.url(), 'https://88cf.scxai.top/'); await popup.close();
    await page.bringToFront(); await page.mouse.move(10, 10);
    checks.push('sponsor rotation, fixed height, icon shine, hover pause, safe external link');
    // Stop only synthetic-document polling before seeding display states. No task is started.
    await page.waitForTimeout(400);
    await evaluate(`(() => {
      for (let timer = 1; timer < 10000; timer++) clearInterval(timer);
      const api = __wbStudyTest, s = api.state, directory = api.getDirectorySnapshot();
      s.tabId = 1; s.storageFailed = false; s.mode = 'paused';
      const job = { runId: 'visual-fixture', resetEpoch: 0, running: false, phase: 'paused', scope: 'all',
        homeTabId: 1, ownerTabId: 1, workerTabId: 1, targetIndex: 0, targetPurpose: 'play', targetPercent: 90,
        candidates: [{ key: 'clinical', courseKey: api.currentCourseKey(), title: '操作系统原理', status: 'inspected',
          total: 3, remaining: 2, directory, currentResource: {key: directory.items[1].key}, records: {
            [directory.items[0].key]: {title: directory.items[0].title, confirmed: true, ended: true},
            [directory.items[1].key]: {title: directory.items[1].title, started: true, targetReached: true}
          } }, {key:'community', title:'社区护理与健康教育', status:'uninspected'},
          {key:'emergency', courseKey:'saved', title:'急危重症护理', status:'manual', total:1, remaining:1,
            unfinished:['心肺复苏示范'], directory:{items:[{key:'cpr',title:'心肺复苏示范',mediaType:'video',durationSeconds:720,chapterTitle:'急救技能'}]},
            records:{cpr:{title:'心肺复苏示范',error:'播放器加载超时',recovery:{attempts:2}}}}] };
      api.acceptJob(job); api.updateTaskControls();
      const media = document.querySelector('video');
      Object.defineProperties(media, {duration:{configurable:true,get:()=>600}, currentTime:{configurable:true,get:()=>248}});
    })()`);
    await navigate('courses'); await snap('02-courses');
    await page.locator('[data-course="1"]').click();
    assert.match(await page.locator('.wb-view[data-view=course]').textContent(), /尚未读取/); await snap('03-unscanned');
    await navigate('courses'); await page.locator('[data-course="0"]').click(); await snap('04-chapters');
    await page.locator('[data-resource="1"]').click(); await snap('05-resource');
    assert.match(await page.locator('.wb-view[data-view=resource]').textContent(), /平台确认尚未确认/);
    assert.equal(await page.locator('.wb-view[data-view=resource] details').evaluate(el => el.open), false);
    await page.locator('.wb-view[data-view=resource] summary').click(); await snap('05b-resource-explanation');
    await page.locator('.wb-view[data-view=resource] summary').click();
    await navigate('courses'); await page.locator('[data-course="2"]').click(); await page.locator('[data-resource]').click(); await snap('06-resource-error');
    await navigate('alerts'); await snap('07-alerts');
    await navigate('details');
    assert.equal(await page.locator('.wb-metric').count(), 3);
    assert.equal(await page.locator('#wb-overview-more').evaluate(el => el.open), false);
    assert.equal(await page.locator('#wb-count').isVisible(), false);
    await snap('08-details');
    await page.locator('#wb-overview-more summary').click(); await snap('08b-more-statistics');
    await page.locator('#wb-overview-more summary').click();
    await navigate('logs'); await snap('09-logs');
    await navigate('settings'); await snap('10-settings');
    await page.locator('#wb-playback-target').fill('92'); await page.locator('#wb-playback-target').dispatchEvent('change');
    await page.waitForFunction(() => document.getElementById('wb-setting-feedback').textContent === '已保存');
    await page.locator('#wb-reset-menu').click(); await snap('11-reset-confirm');
    await page.locator('#wb-reset-cancel').click();
    assert.equal(await evaluate('__wbStudyTest.state.job.runId'), 'visual-fixture');
    await navigate('about'); await snap('12-about');
    assert.match(await page.locator('.wb-external').getAttribute('rel'), /noopener.*sponsored/);
    checks.push('all nested views, settings save, reset cancel, unknown counts, independent completion labels');
    const scenarios = [
      ['scanning', {phase:'scan-home',running:true}, {}, '正在扫描课程'],
      ['opening', {phase:'opening',running:true,targetPurpose:'play'}, {}, '正在打开课程'],
      ['inspecting', {phase:'course',running:true,targetPurpose:'inspect'}, {}, '正在统计音视频'],
      ['learning', {phase:'course',running:true,targetPurpose:'play'}, {}, '正在学习'],
      ['resource-switching', {phase:'course',running:true}, {legacy:'正在打开：沟通与关怀'}, '正在切换资源'],
      ['waiting', {phase:'course',running:true}, {legacy:'等待播放器加载'}, '等待资源就绪'],
      ['retrying', {phase:'course',running:true}, {retry:true}, '等待稍后重试'],
      ['starting', {phase:'paused',running:false}, {startPending:true}, '正在开始'],
      ['pausing', {phase:'course',running:true}, {pausePending:true}, '正在暂停'],
      ['verifying', {phase:'course',running:true,targetPurpose:'play'}, {legacy:'正在核对平台完成状态'}, '正在核对平台状态'],
      ['recovering', {phase:'course',running:true}, {routeRecoveryPending:true}, '正在自动恢复'],
      ['paused', {phase:'paused',running:false}, {}, '已暂停'],
      ['manual', {phase:'manual',running:false,reason:'网站需要重新登录，请先处理登录提示'}, {}, '需要你处理'],
      ['interrupted', {phase:'interrupted',running:false,reason:'课程页面意外关闭'}, {}, '任务已中断'],
      ['storage-error', {phase:'paused',running:false}, {storageFailed:true}, '保存失败'],
      ['resetting', {phase:'paused',running:false}, {resetPending:true}, '正在重置'],
      ['reset-retry', {phase:'resetting',running:false}, {}, '重置尚未完成'],
      ['other-tab', {phase:'course',running:true}, {tabId:99}, '任务在其他标签页'],
      ['finished-alerts', {phase:'finished',running:false}, {}, '本轮处理结束']
    ];
    await navigate('home');
    assert.match(await page.locator('#wb-home-summary').textContent(), /已完成 0 门.*待完成 3 门/s);
    assert.equal(await page.locator('#wb-home-summary [role=progressbar]').getAttribute('aria-valuenow'), '0');
    assert.equal(await page.locator('#wb-home-course-progress [role=progressbar]').getAttribute('aria-valuenow'), '33');
    await page.locator('#wb-home-summary [data-course-filter=pending]').click();
    assert.equal(await page.locator('[data-course]').count(), 3);
    await page.locator('.wb-view[data-view=courses] [data-course-filter=complete]').click();
    assert.match(await page.locator('.wb-view[data-view=courses]').textContent(), /暂无符合此分类/);
    await navigate('home'); await page.locator('#wb-ui-directory').click();
    assert.equal(await page.locator('.wb-view[data-view=course] h2').textContent(), '操作系统原理');
    await navigate('home');
    assert.equal(await evaluate('__wbStudyTest.state.job.running'), false);
    checks.push('home completion counts, honest percentages, read-only filters and current directory');
    for (const [name, patch, statePatch, expected] of scenarios) {
      await evaluate(`(() => {const s=__wbStudyTest.state; Object.assign(s,{mode:'paused',tabId:1,startPending:false,pausePending:false,routeRecoveryPending:false,storageFailed:false,resetPending:false},${JSON.stringify(statePatch)}); Object.assign(s.job,{reason:'',targetPurpose:'play'},${JSON.stringify(patch)}); s.job.candidates[0].status=${JSON.stringify(statePatch.retry ? 'retry' : 'inspected')}; document.getElementById('wb-current').textContent=${JSON.stringify(statePatch.legacy || '')}; document.getElementById('wb-status').textContent=''; __wbStudyTest.updateTaskControls();})()`);
      assert.equal(await page.locator('#wb-ui-status').textContent(), expected);
      if (name === 'scanning') assert.equal(await page.locator('#wb-home-summary [role=progressbar]').count(), 0);
      await snap(`state-${name}`);
    }
    const savedJob = await evaluate('JSON.parse(JSON.stringify(__wbStudyTest.state.job))');
    await evaluate(`(() => {const s=__wbStudyTest.state;s.job.phase='finished';s.job.running=false;s.job.candidates.forEach(c=>{c.status='complete';c.remaining=0;c.unfinished=[];c.failures=[];Object.values(c.records||{}).forEach(r=>{r.confirmed=true;delete r.error;});});__wbStudyTest.updateTaskControls();})()`);
    assert.equal(await page.locator('#wb-home-summary [role=progressbar]').getAttribute('aria-valuenow'), '100');
    await snap('state-all-completed');
    await evaluate(`(() => {__wbStudyTest.state.job.candidates=[];__wbStudyTest.updateTaskControls();})()`);
    assert.equal(await page.locator('#wb-home-summary [role=progressbar]').count(), 0);
    await snap('state-empty-results');
    await evaluate(`(() => {__wbStudyTest.state.job=${JSON.stringify(savedJob)};__wbStudyTest.updateTaskControls();})()`);
    await evaluate(`(() => {const s=__wbStudyTest.state;s.job.running=true;s.job.phase='course';s.job.reason='';s.tabId=1;__wbStudyTest.updateTaskControls();})()`);
    await page.setViewportSize({ width: 320, height: 460 });
    await navigate('courses'); await page.waitForTimeout(180);
    const bounds = await panel.boundingBox(); assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 460);
    assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await snap('13-narrow');
    await page.setViewportSize({ width: 360, height: 240 }); await navigate('settings'); await page.waitForTimeout(180);
    const short = await panel.boundingBox(); assert.ok(short.y >= 0 && short.y + short.height <= 240);
    await page.locator('#wb-reset-menu').scrollIntoViewIfNeeded(); assert.equal(await page.locator('#wb-reset-menu').isVisible(), true); await snap('14-short');
    await page.setViewportSize({ width: 1280, height: 900 }); await page.emulateMedia({ colorScheme:'dark', reducedMotion:'reduce' }); await navigate('courses');
    assert.equal(await page.locator('.wb-view[data-view=courses]').evaluate(el => getComputedStyle(el).animationName), 'none');
    const reducedCopy = await sponsorCopy.textContent();
    await page.waitForTimeout(7300); assert.equal(await sponsorCopy.textContent(), reducedCopy);
    assert.equal(await page.locator('.wb-sponsor-mark').evaluate(el => getComputedStyle(el, '::after').animationName), 'none');
    await snap('15-dark-reduced-motion'); checks.push('narrow and short viewport, dark mode, reduced motion');
    await navigate('home'); await page.locator('#wb-min').click();
    assert.equal(await evaluate('__wbStudyTest.state.job.running'), true);
    const start = await button.boundingBox(); await page.mouse.move(start.x+25,start.y+25); await page.mouse.down(); await page.mouse.move(30,40,{steps:8}); await page.mouse.up();
    assert.equal(await panel.isVisible(), false); const dragged = await button.boundingBox(); assert.ok(dragged.x >= 8 && dragged.y >= 8);
    await button.focus(); await page.keyboard.press('Enter'); assert.equal(await panel.isVisible(), true);
    checks.push('drag, keyboard expand, collapse preserves running state');
    assert.deepEqual(errors, []);
    const report = {passed:true, browser:context.browser()?.version(), checks, scenarios:scenarios.length, errors, artifacts};
    await fs.writeFile(path.join(artifacts,'report.json'), JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
  } finally { await context.close(); await fs.rm(profile,{recursive:true,force:true}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
