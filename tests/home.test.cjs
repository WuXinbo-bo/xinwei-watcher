const assert = require('node:assert/strict');
const test = require('node:test');
const { homeFixture, homeCard, homeCardContent, fixture, mediaItem, waitFor } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');

test('首页只采集正在上的课程，已结课课程不进入自动任务', () => {
  const f = homeFixture([
    homeCard('课程 A', '正在上课'),
    homeCard('课程 B', '已结课')
  ]);
  try {
    const cards = f.api.getHomeCourseCards();
    const candidates = cards.map((card, index) => f.api.getHomeCourseCandidate(card, 1, index)).filter(Boolean);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, '课程 A');
    assert.equal(candidates[0].key, '课程 A');
  } finally { f.dom.window.close(); }
});

test('采集分页课程卡片，忽略隐藏且不随分页更新的课程摘要条目', () => {
  const html = `<div class="left-img-course-item" style="display:none">
      <div class="card-item"><div class="course-name"><p>隐藏摘要课程</p></div>
        <div class="right-course-info"><p class="name">隐藏摘要课程</p><div class="class-name">旧摘要班</div>
          <div class="course-status">正在上课</div></div></div>
    </div>
    <div class="course-page">
      ${homeCardContent('课程 A')}
      ${homeCardContent('课程 B', '已结课')}
    </div>`;
  const f = homeFixture([]);
  try {
    f.window.document.querySelector('.cards').innerHTML = html;
    const cards = f.api.getHomeCourseCards();
    const candidates = cards.map((card, index) => f.api.getHomeCourseCandidate(card, 1, index)).filter(Boolean);
    assert.equal(cards.length, 2);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, '课程 A');
    assert.equal(candidates[0].key, '课程 A');
  } finally { f.dom.window.close(); }
});

test('课程选择按剩余音视频数量最少，已完成和人工项不再竞争', () => {
  const f = homeFixture([homeCard('占位')]);
  try {
    const selected = f.api.chooseLowestRemaining([
      { title: '课程多', status: 'inspected', remaining: 8 },
      { title: '课程少', status: 'inspected', remaining: 2 },
      { title: '已经完成', status: 'complete', remaining: 0 },
      { title: '人工待处理', status: 'manual', remaining: 1 }
    ]);
    assert.equal(selected.candidate.title, '课程少');
    assert.equal(selected.index, 1);
  } finally { f.dom.window.close(); }
});

test('任务存在扩展后台，不使用网站 localStorage 或 sessionStorage', async () => {
  const c = coordinator();
  const id = c.addTab('https://www.beeline-ai.com/myBank/courseResearch');
  const result = await c.request(id, 'home', 'start');
  assert.equal(result.ok, true);
  const saved = JSON.stringify(c.storage);
  assert.match(saved, /scan-home/);
  assert.doesNotMatch(saved, /password|currentTime|token/);
  const fs = require('node:fs');
  assert.doesNotMatch(fs.readFileSync('content.js', 'utf8'), /localStorage|sessionStorage\.get/);
});

test('分页扫描读取更新中的课程卡片，而不是隐藏且保持不变的摘要', async () => {
  const f = homeFixture([homeCard('第1页')]);
  try {
    let page = 1;
    const doc = f.window.document;
    doc.querySelector('.cards').innerHTML = `<div class="left-img-course-item" style="display:none">
      <div class="card-item"><div class="course-name"><p>隐藏摘要课程</p></div>
        <div class="right-course-info"><p class="name">隐藏摘要课程</p><div class="class-name">摘要班</div>
          <div class="course-status">正在上课</div></div></div>
      </div><div class="course-page">${homeCardContent('第1页')}</div>`;
    // Only page 1 is visible. Page 2/3 cannot be reached by numeric buttons.
    doc.querySelectorAll('li.number')[1].remove();
    const next = doc.querySelector('.btn-next');
    next.addEventListener('click', () => {
      page += 1;
      doc.querySelector('li.number').textContent = String(page);
      setTimeout(() => {
        doc.querySelector('.course-page').innerHTML = homeCardContent(`第${page}页`);
        next.disabled = page === 3;
      }, 400);
    });
    f.api.state.running = true;
    const courses = await f.api.scanHomeCourses(f.api.state.epoch);
    assert.equal(courses.map(c => c.title).join(','), '第1页,第2页,第3页');
  } finally { f.dom.window.close(); }
});

test('重复课程名称不能静默去重，避免错选课程', async () => {
  const f = homeFixture([homeCard('重复'), homeCard('重复')]);
  try {
    f.api.state.running = true;
    await assert.rejects(f.api.scanHomeCourses(f.api.state.epoch), /课程名称重复/);
  } finally { f.dom.window.close(); }
});

test('旧任务缺少真实入口时重新统计，并保留未自然结束记录', async () => {
  const c = coordinator();
  const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
  const home = c.addTab(HOME);
  const payload = job => ({ runId: job.runId, generation: job.generation });
  let r = await c.request(home, 'old-home', 'start');
  assert.equal(r.ok, true, r.error);
  r = await c.request(home, 'old-home', 'scan-result', {
    ...payload(r.job), candidates: [{ title: '课程', key: '课程', page: 1, status: 'uninspected' }]
  });
  assert.equal(r.ok, true, r.error);
  r = await c.request(home, 'old-home', 'open', { ...payload(r.job), index: 0, purpose: 'inspect' });
  assert.equal(r.ok, true, r.error);
  const worker = c.addTab('https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course/video/resource?classId=class', home);
  r = await c.request(worker, 'old-worker', 'hello', { title: '课程' });
  assert.equal(r.ok, true, r.error);
  r = await c.request(worker, 'old-worker', 'directory-checkpoint', {
    ...payload(r.job), snapshot: {
      version: 1, courseKey: r.job.candidates[0].courseKey,
      items: [{ key: 'previously-started', title: '尚未结束视频', mediaType: 'video', durationSeconds: 60 }]
    }
  });
  assert.equal(r.ok, true, r.error);
  r = await c.request(worker, 'old-worker', 'record', {
    ...payload(r.job), key: 'previously-started', result: { title: '尚未结束视频', started: true, ended: false }
  });
  assert.equal(r.ok, true, r.error);
  r = await c.request(worker, 'old-worker', 'course-result', { ...payload(r.job), result: { total: 1, remaining: 1 } });
  assert.equal(r.ok, true, r.error);
  const originalRunId = r.job.runId;
  delete c.storage.session['xinwei-job-v3'].candidates[0].learnUrl;
  const h = homeFixture([homeCard('课程')], { connect: c.connect(home) });
  try {
    h.window.document.querySelector('.btn-next').disabled = true;
    let click = null;
    h.window.document.querySelector('.item-bg-text p.sle').addEventListener('click', () => {
      click = { purpose: h.api.state.job.targetPurpose, index: h.api.state.job.targetIndex };
    });
    await h.api.syncSharedJob(); // The replacement homepage continues the same running task.
    assert.equal(h.api.state.job.running, true);
    assert.equal(h.api.state.job.runId, originalRunId);
    await waitFor(() => click);
    assert.deepEqual(click, { purpose: 'inspect', index: 0 });
    assert.equal(h.api.state.job.candidates[0].records['previously-started'].ended, false);
    assert.equal(h.api.state.job.candidates[0].records['previously-started'].started, true);
    assert.equal(c.navigation.some(n => n.url), false);
  } finally { h.dom.window.close(); }
});

test('旧协议回归：新标签统计，零音视频跳过，课程末刷新核对后返回下一门', { timeout: 45000 }, async () => {
  const c = coordinator();
  const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
  const KEY = 'xinwei-job-v3';
  const homeId = c.addTab(HOME);
  const courses = [
    {
      title: '多视频课程',
      url: 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/large/video/site-chosen-entry?classId=class-large',
      items: [mediaItem('长视频', 'video', 'unStart', '02 分 00 秒'), mediaItem('短视频')]
    },
    {
      title: '仅文档课程',
      url: 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/documents/video/document-entry?classId=class-documents',
      items: [mediaItem('课程文档', 'text', '', '')]
    },
    {
      title: '少视频课程',
      url: 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/small/video/audio-entry?classId=class-small',
      items: [mediaItem('短音频', 'audio')]
    }
  ];
  courses.forEach(course => { course.completed = new Set(); });
  const all = [], documents = new Map(), observedUrls = new Set();
  const cardClicks = [], navigatedCourses = [], homeInstances = [], courseInstances = [];
  const playbackEvents = [], confirmationSnapshots = [], pending = [], callbackErrors = [];
  let currentHome, handledReloads = 0;

  const closeDocument = id => {
    const f = documents.get(id);
    if (!f) return;
    clearInterval(f.naturalPlayer);
    for (const timer of f.platformTimers || []) clearTimeout(timer);
    f.dom.window.close();
    documents.delete(id);
  };
  const registerDocument = (id, f) => {
    all.push(f);
    documents.set(id, f);
    pending.push(f.api.syncSharedJob());
    return f;
  };
  const makeCourseDocument = (id, course, purpose) => {
    const f = fixture(course.items.map((item, index) => course.completed.has(index)
      ? item.replace('unStart-icon', 'done-icon') : item), {
      url: course.url, title: course.title, connect: c.connect(id), confirmationTimeout: 1000
    });
    f.api.CFG.directoryLoadTimeout = 2000;
    f.api.CFG.cooldownMin = f.api.CFG.cooldownMax = 150;
    courseInstances.push({ id, purpose, instanceId: f.api.state.instanceId });
    const items = f.api.getMenuItems();
    items[0].classList.add('is-active');
    items.forEach(item => item.addEventListener('click', () => {
      items.forEach(n => n.classList.remove('is-active'));
      item.classList.add('is-active');
      f.advanceNaturally(0);
      f.media.dispatchEvent(new f.window.Event('loadedmetadata'));
    }));
    const started = new Set();
    f.platformTimers = [];
    // Only the separate fake player advances time. The fake website confirms
    // later, so local natural end cannot stand in for the platform's marker.
    // This simulation does not model or prove browser autoplay permission.
    f.naturalPlayer = setInterval(() => {
      if (f.media.paused) return;
      const item = f.window.document.querySelector('li.is-active');
      const key = f.api.getItemKey(item);
      const title = item.querySelector('.lecture-title').textContent;
      if (!started.has(key)) {
        started.add(key);
        playbackEvents.push({ type: 'playing', course: course.title, title, purpose });
      }
      const time = Math.min(f.media.currentTime + 20, f.media.duration);
      const ended = time === f.media.duration;
      f.advanceNaturally(time, ended);
      if (!ended) return;
      playbackEvents.push({ type: 'ended', course: course.title, title, purpose });
      f.platformTimers.push(setTimeout(() => {
        const candidate = c.storage.session[KEY]?.candidates.find(candidate => candidate.title === course.title);
        const record = candidate?.records?.[key];
        confirmationSnapshots.push({ title, ended: record?.ended, confirmed: record?.confirmed });
        course.completed.add(items.findIndex(entry => f.api.getItemKey(entry) === key));
        item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
        playbackEvents.push({ type: 'confirmed', course: course.title, title, purpose });
      }, 100));
    }, 10);
    return registerDocument(id, f);
  };
  const makeHomeDocument = () => {
    const h = homeFixture(courses.map(course => homeCard(course.title)), { connect: c.connect(homeId) });
    h.window.document.querySelector('.btn-next').disabled = true;
    homeInstances.push(h.api.state.instanceId);
    h.window.document.querySelectorAll('.item-bg-text p.sle').forEach(entry => {
      entry.addEventListener('click', () => {
        const purpose = h.api.state.job.targetPurpose;
        cardClicks.push({ purpose, title: entry.textContent });
        const course = courses.find(course => course.title === entry.textContent);
        // This fixture represents the site's normal card handler producing
        // the learning URL. Playback must reuse this observed URL.
        observedUrls.add(course.url);
        const workerId = c.addTab(course.url, homeId);
        makeCourseDocument(workerId, course, purpose);
      });
    });
    currentHome = registerDocument(homeId, h);
    return currentHome;
  };
  c.onTabRemoved.addListener(closeDocument);
  c.onNavigation.addListener(tab => {
    try {
      assert.equal(tab.id, homeId);
      closeDocument(tab.id);
      if (tab.url === HOME) makeHomeDocument();
      else {
        assert.equal(observedUrls.has(tab.url), true, 'must navigate the exact site-observed URL');
        const course = courses.find(course => course.url === tab.url);
        assert.ok(course, 'navigation must identify an inspected course');
        if (c.reloads.length > handledReloads) handledReloads += 1;
        else navigatedCourses.push(course.title);
        makeCourseDocument(tab.id, course, 'play');
      }
    } catch (error) { callbackErrors.push(error); }
  });

  try {
    const legacyHome = makeHomeDocument();
    await legacyHome.api.jobCommand('start', { scope: 'all', singlePass: true });
    await legacyHome.api.syncSharedJob();
    try {
      await waitFor(() => c.storage.session[KEY]?.phase === 'finished' || callbackErrors.length, 20000);
    } catch (error) {
      console.error(JSON.stringify({
        job: c.storage.session[KEY], callbackErrors: callbackErrors.map(e => e.message),
        navigatedCourses, reloads: c.reloads, playbackEvents, confirmationSnapshots,
        currentStatus: currentHome?.window?.document?.getElementById('wb-current')?.textContent,
        pending: pending.length
      }));
      throw error;
    }
    if (callbackErrors.length) throw callbackErrors[0];
    await waitFor(() => currentHome.api.state.job?.phase === 'finished', 1000);
    await Promise.all(pending);
    const job = currentHome.api.state.job;
    assert.deepEqual(cardClicks, courses.map(course => ({ purpose: 'inspect', title: course.title })));
    assert.deepEqual(navigatedCourses, ['少视频课程', '多视频课程']);
    assert.deepEqual(c.navigation.filter(step => step.url).map(step => ({ id: step.id, url: step.url })), [
      { id: homeId, url: courses[2].url }, { id: homeId, url: HOME },
      { id: homeId, url: courses[0].url }, { id: homeId, url: HOME }
    ]);
    assert.equal(homeInstances.length, 3);
    assert.equal(new Set([...homeInstances, ...courseInstances.map(document => document.instanceId)]).size, 10);
    assert.equal(courseInstances.filter(document => document.purpose === 'play').every(document => document.id === homeId), true);
    assert.equal(courseInstances.filter(document => document.purpose === 'inspect').every(document => document.id !== homeId), true);
    assert.equal(job.candidates.find(course => course.title === '仅文档课程').status, 'complete');
    assert.equal(job.candidates.find(course => course.title === '仅文档课程').total, 0);
    assert.equal(job.candidates.filter(course => course.total > 0).every(course => course.status === 'completed'), true);
    assert.deepEqual(playbackEvents.filter(event => event.type === 'playing').map(event => event.title), ['短音频', '短视频', '长视频']);
    assert.equal(playbackEvents.every(event => event.purpose === 'play'), true, 'inspection must not play media');
    assert.equal(confirmationSnapshots.length, 3);
    assert.equal(confirmationSnapshots.every(record => record.ended === true && record.confirmed === false), true);
    for (const title of ['短音频', '短视频', '长视频']) {
      assert.deepEqual(playbackEvents.filter(event => event.title === title).map(event => event.type), ['playing', 'ended', 'confirmed']);
    }
    assert.equal(job.candidates.flatMap(course => Object.values(course.records || {})).every(record => record.ended && record.confirmed), true);
    assert.equal(c.reloads.length, 2, 'each video course gets one course-end platform check');
    assert.equal(job.returningTabId, undefined);
    assert.equal(job.returnDeadline, undefined);
    assert.equal(currentHome.api.state.playedCount, 3);
    assert.equal(c.removed.length, 3, 'only the three inspection tabs are closed');
    assert.deepEqual([...c.tabs.keys()], [homeId]);
    assert.equal(c.tabs.get(homeId).url, HOME);
    assert.match(currentHome.window.document.getElementById('wb-current').textContent, /文档、考试、作业/);
  } finally {
    [...documents.keys()].forEach(closeDocument);
    all.forEach(f => f.dom.window.close());
  }
});
