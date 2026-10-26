const fs = require('node:fs');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const mediaItem = (title, kind = 'video', status = 'unStart', duration = '01 分 00 秒') => `
  <li class="el-menu-item" role="menuitem">
    <div class="lecture-content"><i class="${kind}-icon"></i><span class="lecture-title">${title}</span></div>
    ${duration ? `<div class="video-duration">${duration}</div>` : ''}
    <span class="lecture-status">${status ? `<i class="${status}-icon"></i>` : ''}</span>
  </li>`;

function fixture(items, options = {}) {
  const html = `<div class="course-name">${options.title || '测试课程'}</div><div>考核点已完成：0/5</div>
    <div class="sub-menu-area"><ul class="el-menu">
      <li class="el-sub-menu is-opened" aria-expanded="true">
        <div class="el-sub-menu__title">第一章</div><ul>${items.join('')}</ul>
      </li></ul></div><div class="video-js vjs-paused">
        <button class="vjs-big-play-button" type="button" title="播放视频" aria-disabled="false">播放视频</button>
        <div class="vjs-control-bar" style="display:none">
          <button class="vjs-play-control vjs-control vjs-button" type="button" title="播放" aria-disabled="false">播放</button>
        </div>
        <video></video>
      </div>`;
  const dom = new JSDOM(html, {
    url: options.url || 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1',
    runScripts: 'outside-only', pretendToBeVisual: true
  });
  const { window } = dom;
  window.chrome = options.chrome || { runtime: { sendMessage: async () => ({ ok: true, job: null, tabId: 1 }) } };
  if (options.connect) options.connect(window);
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.console.log = () => {};
  const media = window.document.querySelector('video');
  const player = window.document.querySelector('.video-js');
  let current = 0, paused = true, ended = false;
  Object.defineProperties(media, {
    readyState: { get: () => 4 },
    duration: { get: () => options.duration || 60 },
    currentTime: { get: () => current }, // 不允许扩展写播放进度。
    paused: { get: () => paused },
    ended: { get: () => ended },
    currentSrc: { get: () => 'https://media.example.test/natural-playback' }
  });
  media.play = async () => { paused = false; };
  media.pause = () => { paused = true; player.classList.add('vjs-paused'); };
  for (const button of window.document.querySelectorAll('.vjs-big-play-button, .vjs-play-control')) {
    // jsdom has no layout engine; give the visible large button one layout box
    // and leave the hidden control-bar button without one.
    if (button.matches('.vjs-big-play-button')) button.getClientRects = () => [{ width: 1, height: 1 }];
    button.addEventListener('click', () => {
      paused = false;
      player.classList.remove('vjs-paused');
    });
  }
  const advanceNaturally = (seconds, done = false) => {
    current = seconds;
    ended = done;
    if (!done && seconds === 0) {
      paused = true;
      player.classList.add('vjs-paused');
    }
    if (done) paused = true;
  };
  // A fake website can prepare its initial player state and observers before
  // the content script runs. This does not model browser playback permission.
  if (options.beforeContent) options.beforeContent({ window, media, advanceNaturally });
  const uiStyle = window.document.createElement('style');
  uiStyle.textContent = fs.readFileSync('assistant-ui.css', 'utf8');
  window.document.head.appendChild(uiStyle);
  window.eval(fs.readFileSync('assistant-ui.js', 'utf8'));
  window.eval(fs.readFileSync('content.js', 'utf8'));
  const api = window.__wbStudyTest;
  Object.assign(api.CFG, {
    beforeClickDelayMin: 0, beforeClickDelayMax: 0,
    hoverDelayMin: 0, hoverDelayMax: 0,
    afterExpandDelayMin: 0, afterExpandDelayMax: 0,
    cooldownMin: 0, cooldownMax: 0,
    confirmationTimeout: options.confirmationTimeout ?? 5,
    pollInterval: 2, mediaLoadTimeout: 20,
    directoryStableTime: 5
  });
  return { dom, window, media, api, advanceNaturally };
}

function homeFixture(cards = [], options = {}) {
  const html = `<div class="cards">${cards.join('')}</div>
    <div class="el-pagination">
      <button class="btn-prev" aria-label="上一页"></button>
      <ul class="el-pager"><li class="number is-active">1</li><li class="number">2</li></ul>
      <button class="btn-next" aria-label="下一页"></button>
    </div>`;
  const dom = new JSDOM(html, {
    url: options.url || 'https://www.beeline-ai.com/myBank/courseResearch',
    runScripts: 'outside-only', pretendToBeVisual: true
  });
  const { window } = dom;
  window.chrome = options.chrome || { runtime: { sendMessage: async () => ({ ok: true, job: null, tabId: 1 }) } };
  if (options.connect) options.connect(window);
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.console.log = () => {};
  const uiStyle = window.document.createElement('style');
  uiStyle.textContent = fs.readFileSync('assistant-ui.css', 'utf8');
  window.document.head.appendChild(uiStyle);
  window.eval(fs.readFileSync('assistant-ui.js', 'utf8'));
  window.eval(fs.readFileSync('content.js', 'utf8'));
  Object.assign(window.__wbStudyTest.CFG, {
    beforeClickDelayMin: 0, beforeClickDelayMax: 0,
    hoverDelayMin: 0, hoverDelayMax: 0, directoryStableTime: 5,
    directoryLoadTimeout: options.directoryLoadTimeout || 2000
  });
  return { dom, window, api: window.__wbStudyTest };
}

function homeCardContent(title, status = '正在上课') {
  const statusClass = status === '已结课' ? 'course-status end' : 'course-status';
  return `<div class="course-card-item">
    <div class="top-bg-wrap">
      <div class="item-bg-text"><i>BeeLine</i><p class="sle" title="${title}">${title}</p></div>
      <div class="tag-wrap"><span class="tag course-type">教学班</span></div>
    </div>
    <div class="bottom-info course-info">
      <span class="${statusClass}">${status}</span>
      <div class="course-deadline">2027-01-17 截止</div>
    </div>
  </div>`;
}

function homeCard(title, status = '正在上课') {
  return homeCardContent(title, status);
}

async function waitFor(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Test observation timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function seedCoursePlaybackFixture(f) {
  // Prepare an already selected course through the retained legacy protocol.
  // This is test setup for the media executor, not the public Start button:
  // public Start now requests all courses and first returns to the homepage.
  // Tests of explicit Continue must still use the actual content start handler.
  const title = f.window.document.querySelector('.course-name')?.textContent.trim();
  assert.ok(title, 'The playback fixture must identify its selected course');
  const job = await f.api.jobCommand('start', { title, scope: 'single' });
  assert.equal(job?.phase, 'course', 'Fixture setup must reach the course executor');
  assert.equal(job.scope, 'single', 'Do not silently replace the public all-course Start semantics');
  await f.api.syncSharedJob();
  return job;
}

module.exports = { fixture, mediaItem, waitFor, homeFixture, homeCard, homeCardContent, seedCoursePlaybackFixture };
