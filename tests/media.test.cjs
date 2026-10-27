const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { fixture, mediaItem, waitFor, seedCoursePlaybackFixture } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');
const { observePlayback, endPlayback, markPageCompleted } = require('./player-lifecycle.cjs');

const JOB_KEY = 'xinwei-job-v3';
const COURSE_URL = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';

function isolatedCourseFixture(items, options = {}) {
  const c = coordinator();
  const tab = c.addTab(options.url || COURSE_URL);
  const f = fixture(items, { ...options, url: options.url || COURSE_URL, connect: c.connect(tab) });
  // Reserve the direct runCourse slot before the initial sync timer fires.
  f.api.state.jobPromise = Promise.resolve();
  return { ...f, coordinator: c, tab };
}

async function prepareIsolatedCourse(f) {
  const job = await f.api.jobCommand('start', {
    title: f.window.document.querySelector('.course-name').textContent.trim(), scope: 'single'
  });
  assert.equal(job.phase, 'course');
  assert.equal(job.running, true);
  assert.equal(job.ownerInstance, f.api.state.instanceId);
  const snapshot = f.api.getDirectorySnapshot();
  await f.api.jobCommand('directory-checkpoint', { snapshot });
  assert.equal(f.api.directorySignature(f.api.state.job.candidates[0].directory),
    f.api.directorySignature(snapshot));
  f.api.state.activeGeneration = job.generation;
  f.api.state.running = true;
  return f.coordinator;
}

test('只把音视频作为任务；没有状态图标也不算已完成', () => {
  const f = fixture([
    mediaItem('视频', 'video', 'unStart'),
    mediaItem('音频', 'audio', 'inProgress'),
    mediaItem('无状态视频', 'video', ''),
    mediaItem('已完成音频', 'audio', 'done'),
    mediaItem('文档', 'text', 'unStart', ''),
    mediaItem('作业', 'text', 'unStart', ''),
    mediaItem('考试', 'text', 'unStart', '')
  ]);
  try {
    const result = f.api.refreshDirectories({ logSummary: false });
    assert.equal(result.videoItems.length, 4);
    assert.equal(result.pendingItems.length, 3);
    assert.ok(result.pendingItems.some(n => n.textContent.includes('无状态视频')));
    assert.equal(f.window.document.getElementById('wb-confirmed').textContent, '1');
  } finally { f.dom.window.close(); }
});

test('课程内继续使用短时长优先，已完成资源不重播', () => {
  const f = fixture([
    mediaItem('长视频', 'video', 'unStart', '09 分 10 秒'),
    mediaItem('已完成短音频', 'audio', 'done', '00 分 05 秒'),
    mediaItem('短音频', 'audio', 'unStart', '00 分 30 秒')
  ]);
  try {
    const { pendingItems } = f.api.refreshDirectories({ logSummary: false });
    assert.equal(pendingItems[0].querySelector('.lecture-title').textContent, '短音频');
    assert.equal(pendingItems.length, 2);
  } finally { f.dom.window.close(); }
});

test('使用网站可见的 Video.js 大播放按钮开始，不调用媒体播放 API', async () => {
  const f = fixture([mediaItem('视频')]);
  try {
    const item = f.api.getMenuItems()[0];
    item.classList.add('is-active');
    f.api.state.running = true;
    const bigPlay = f.window.document.querySelector('.vjs-big-play-button');
    const hiddenControl = f.window.document.querySelector('.vjs-control-bar .vjs-play-control');
    let bigPlayClicks = 0;
    let hiddenControlClicks = 0;
    let playCalls = 0;
    Object.defineProperty(f.window.navigator, 'userActivation', {
      value: { isActive: false, hasBeenActive: false }
    });
    bigPlay.addEventListener('click', () => { bigPlayClicks += 1; });
    hiddenControl.addEventListener('click', () => { hiddenControlClicks += 1; });
    f.media.play = async () => { playCalls += 1; };

    const task = f.api.playItemToEnd(item, 0, f.api.currentCourseKey());
    await waitFor(() => !f.media.paused);
    await waitFor(() => f.api.state.processedItems.get(f.api.getItemKey(item))?.playbackAttempt?.after);
    assert.equal(bigPlayClicks, 1);
    assert.equal(hiddenControlClicks, 0);
    assert.equal(playCalls, 0);
    const attempt = f.api.state.processedItems.get(f.api.getItemKey(item)).playbackAttempt;
    assert.equal(attempt.before.pageHasBeenActive, false);
    assert.equal(attempt.click.isTrusted, false);
    assert.equal(attempt.after.paused, false);
    assert.equal(f.window.navigator.userActivation.hasBeenActive, false);

    f.media.dispatchEvent(new f.window.Event('playing'));
    f.advanceNaturally(60, true);
    f.media.dispatchEvent(new f.window.Event('ended'));
    const result = await task;
    assert.equal(result.ended, true);
    assert.equal(result.playbackAttempt.events.map(e => e.type).join(','), 'playing,ended');
    assert.equal(result.playbackAttempt.finished.currentTime, 60);
    f.media.dispatchEvent(new f.window.Event('pause'));
    assert.equal(result.playbackAttempt.events.length, 2);
  } finally { f.dom.window.close(); }
});

for (const beginsPlaying of [false, true]) {
  test(`停止时保留${beginsPlaying ? '播放后暂停' : '从未开始'}的事件证据，并移除观察监听`, async () => {
    const f = fixture([mediaItem('视频')]);
    try {
      const item = f.api.getMenuItems()[0];
      item.classList.add('is-active');
      f.api.state.running = true;
      f.api.CFG.stallTimeout = 40;
      const button = f.window.document.querySelector('.vjs-big-play-button');
      if (!beginsPlaying) {
        const inertButton = button.cloneNode(true);
        inertButton.getClientRects = () => [{ width: 1, height: 1 }];
        button.replaceWith(inertButton);
      }
      const task = f.api.playItemToEnd(item, 0, f.api.currentCourseKey());
      const rejected = assert.rejects(task, /没有播放进展/);
      // The initial checkpoint now exists before the play gesture. These
      // scenarios exercise the state after that gesture has finished.
      await waitFor(() => f.api.state.processedItems.get(f.api.getItemKey(item))?.playbackAttempt?.after);
      if (beginsPlaying) {
        f.media.dispatchEvent(new f.window.Event('play'));
        f.media.dispatchEvent(new f.window.Event('playing'));
        f.media.pause();
        f.media.dispatchEvent(new f.window.Event('pause'));
      }
      await rejected;
      const attempt = f.api.state.processedItems.get(f.api.getItemKey(item)).playbackAttempt;
      assert.equal(attempt.events.map(e => e.type).join(','), beginsPlaying ? 'play,playing,pause' : '');
      assert.equal(attempt.stopped.paused, true);
      assert.equal(attempt.stopped.ended, false);
      const count = attempt.events.length;
      f.media.dispatchEvent(new f.window.Event('playing'));
      assert.equal(attempt.events.length, count);
    } finally { f.dom.window.close(); }
  });
}

test('隐藏控制栏且没有可见大播放按钮时不启动播放', () => {
  const f = fixture([mediaItem('视频')]);
  try {
    f.window.document.querySelector('.vjs-big-play-button').remove();
    const hiddenControl = f.window.document.querySelector('.vjs-control-bar .vjs-play-control');
    assert.equal(f.api.getPlaybackStartButton(f.media), null);
    assert.equal(hiddenControl.getClientRects().length, 0);
  } finally { f.dom.window.close(); }
});

test('平台在80%标记完成时仍继续播放，到自然结束才允许返回', async () => {
  const f = fixture([mediaItem('视频')], { confirmationTimeout: 100 });
  try {
    const item = f.api.getMenuItems()[0];
    item.classList.add('is-active');
    f.api.state.running = true;
    let resolved = false;
    const task = f.api.playItemToEnd(item, 0, f.api.currentCourseKey())
      .then(result => { resolved = true; return result; });
    await observePlayback(f, item, { position: 49 });
    markPageCompleted(item);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(resolved, false);
    endPlayback(f);
    const result = await task;
    assert.equal(result.ended, true);
    assert.equal(result.confirmed, true);
    assert.equal(f.api.state.playedCount, 1);
  } finally { f.dom.window.close(); }
});

test('自然结束和平台确认分开；无完成标记不得伪装平台已完成', async () => {
  const f = fixture([mediaItem('无状态音频', 'audio', '')]);
  try {
    const item = f.api.getMenuItems()[0];
    item.classList.add('is-active');
    f.api.state.running = true;
    const task = f.api.playItemToEnd(item, 0, f.api.currentCourseKey());
    await observePlayback(f, item);
    endPlayback(f);
    const result = await task;
    assert.equal(result.ended, true);
    assert.equal(result.confirmed, false);
    assert.equal(f.api.isPageCompletedItem(item), false);
  } finally { f.dom.window.close(); }
});

for (const failure of ['停滞', '媒体报错']) {
  test('80%页面完成标记后' + failure + '连续三次恢复失败则停止，保留未完成义务', async () => {
    const c = coordinator();
    const tab = c.addTab(COURSE_URL);
    const documents = [], messages = [], callbackErrors = [];
    let current, failing = false, pageCompleted = false;
    let directoryClicks = 0, playClicks = 0, apiPlays = 0;
    const mount = () => {
      current?.dom.window.close();
      const f = fixture([mediaItem('中断视频', 'video', pageCompleted ? 'done' : 'unStart')], {
        url: COURSE_URL,
        connect(window) {
          c.connect(tab)(window);
          const send = window.chrome.runtime.sendMessage;
          window.chrome.runtime.sendMessage = message => {
            messages.push({ action: message.action, runId: message.runId });
            return send(message);
          };
        }
      });
      documents.push(f);
      current = f;
      Object.assign(f.api.CFG, {
        stallTimeout: 75, recoveryWaitMin: 1, recoveryWaitMax: 1,
        identityStableTime: 1, mediaLoadTimeout: 1000
      });
      const item = f.api.getMenuItems()[0];
      item.classList.add('is-active');
      Object.defineProperty(f.media, 'error', {
        get: () => failing && failure === '媒体报错' ? { code: 2 } : null
      });
      item.addEventListener('click', () => {
        directoryClicks += 1;
        f.advanceNaturally(0);
        f.media.dispatchEvent(new f.window.Event('loadedmetadata'));
      });
      f.window.document.querySelector('.vjs-big-play-button')
        .addEventListener('click', () => { playClicks += 1; });
      f.media.play = async () => { apiPlays += 1; };
      return f;
    };
    c.onNavigation.addListener(destination => {
      try {
        assert.equal(destination.id, tab);
        assert.equal(destination.url, COURSE_URL);
        mount();
      } catch (error) { callbackErrors.push(error); }
    });
    try {
      const f = mount();
      const item = f.api.getMenuItems()[0];
      const initial = await seedCoursePlaybackFixture(f);
      await observePlayback(f, item, { position: 49 });
      pageCompleted = true;
      markPageCompleted(item);
      failing = true;
      await waitFor(() => c.storage.session[JOB_KEY]?.phase === 'manual', 10000);
      const job = c.storage.session[JOB_KEY];
      const candidate = job.candidates[0];
      const record = Object.values(candidate.records)[0];
      assert.equal(callbackErrors.length, 0, callbackErrors[0]?.stack);
      assert.equal(job.runId, initial.runId);
      assert.equal(job.running, false);
      assert.notEqual(job.phase, 'finished');
      assert.equal(current.api.isPageCompletedItem(current.api.getMenuItems()[0]), true);
      assert.equal(current.media.ended, false);
      assert.equal(record.started, true);
      assert.equal(record.ended, false);
      assert.equal(record.confirmed, false);
      assert.equal(job.interruption.attempts, 3);
      assert.equal(record.recovery.attempts, 3);
      assert.equal(record.recovery.reloads, 0);
      assert.equal(c.reloads.length, 0);
      assert.equal(documents.length, 1, 'The interrupted course remains in the same document');
      assert.ok(directoryClicks <= 3, 'Recovery must not reopen the entry beyond its three attempts');
      assert.ok(playClicks >= 1, 'The visible play button was used before the interruption');
      assert.equal(apiPlays, 0);
      assert.equal(messages.filter(message => message.action === 'start').length, 1);
      assert.ok(messages.some(message => message.action === 'interruption-attempt'));
      assert.equal(current.api.refreshDirectories({ logSummary: false }).pendingItems.length, 1);
      await waitFor(() => !current.api.state.jobPromise);
    } finally {
      if (current?.api.state.job?.running) await current.api.stop();
      for (const f of documents) f.dom.window.close();
    }
  });
}

test('先前已开始但未结束的资源无法在目录确认时停止，不能把缺失资源当作完成', async () => {
  const f = fixture([mediaItem('目录现有视频', 'video', 'done')]);
  try {
    f.api.state.running = true;
    f.api.state.processedCourseKey = f.api.currentCourseKey();
    f.api.state.processedItems.set('missing-resource', {
      title: '先前中断的视频', started: true, ended: false, confirmed: false
    });
    await assert.rejects(f.api.runCourse(f.api.state.epoch), /先前待完成的资源.*无法确认/);
    assert.equal(f.api.state.playedCount, 0);
    assert.equal(f.media.paused, true);
  } finally { f.dom.window.close(); }
});

test('自然结束后目录暂时消失会等待重新识别，恢复后只核对标记且不重播', async () => {
  const f = isolatedCourseFixture([mediaItem('消失视频')], { confirmationTimeout: 100 });
  const tasks = [];
  try {
    const item = f.api.getMenuItems()[0];
    const parent = item.parentElement;
    item.classList.add('is-active');
    await prepareIsolatedCourse(f);
    let playClicks = 0;
    f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { playClicks += 1; });
    const task = f.api.runCourse(f.api.state.epoch);
    tasks.push(task);
    const rejected = assert.rejects(task,
      error => error instanceof f.api.RecoverableError && error.kind === 'directory');
    rejected.catch(() => {});
    tasks.push(rejected);
    await observePlayback(f, item);
    endPlayback(f);
    await waitFor(() => f.api.state.processedItems.get(f.api.getItemKey(item))?.ended);
    item.remove();
    await rejected;
    assert.equal(f.api.state.playedCount, 1);
    const candidate = f.coordinator.storage.session[JOB_KEY].candidates[0];
    assert.equal(candidate.directory.items.length, 1);
    assert.equal(Object.values(candidate.records)[0].ended, true);
    assert.equal(Object.values(candidate.records)[0].confirmed, false);
    assert.notEqual(candidate.status, 'completed');
    parent.append(item);
    markPageCompleted(item);
    const resumed = f.api.runCourse(f.api.state.epoch);
    tasks.push(resumed);
    const result = await resumed;
    assert.equal(result.complete, true);
    assert.equal(f.api.state.processedItems.get(f.api.getItemKey(item)).confirmed, true);
    assert.equal(playClicks, 1);
    assert.equal(f.api.state.playedCount, 1);
  } finally {
    await f.api.stop();
    await Promise.allSettled(tasks);
    f.dom.window.close();
  }
});

test('自然结束后迟到的页面完成标记更新保存记录，不把已确认资源留作人工项', async () => {
  const f = isolatedCourseFixture([
    mediaItem('迟到标记视频', 'video', 'unStart', '00 分 30 秒'),
    mediaItem('下一视频')
  ]);
  let task;
  try {
    const [first, second] = f.api.getMenuItems();
    first.classList.add('is-active');
    second.addEventListener('click', () => {
      first.classList.remove('is-active');
      second.classList.add('is-active');
      f.advanceNaturally(0);
      f.media.dispatchEvent(new f.window.Event('loadedmetadata'));
    });
    await prepareIsolatedCourse(f);
    const key = f.api.getItemKey(first);
    task = f.api.runCourse(f.api.state.epoch);
    task.catch(() => {});
    await observePlayback(f, first);
    endPlayback(f);
    await waitFor(() => second.classList.contains('is-active'));
    await observePlayback(f, second);
    assert.equal(f.api.state.processedItems.get(key).confirmed, false);
    // The website confirms the first resource while the next one is playing.
    markPageCompleted(first);
    markPageCompleted(second);
    endPlayback(f);
    const result = await task;
    assert.equal(result.complete, true);
    assert.equal(f.api.state.processedItems.get(key).confirmed, true);
    assert.equal(f.media.paused, true);
  } finally {
    await f.api.stop();
    if (task) await Promise.allSettled([task]);
    f.dom.window.close();
  }
});

test('暂停取消尚在等待的点击，并暂停媒体', async () => {
  const f = fixture([mediaItem('视频')]);
  try {
    let clicks = 0;
    const item = f.api.getMenuItems()[0];
    item.addEventListener('click', () => { clicks += 1; });
    f.api.state.running = true;
    await f.media.play();
    const task = f.api.humanClick(item, 0);
    f.api.stop();
    await assert.rejects(task);
    assert.equal(clicks, 0);
    assert.equal(f.media.paused, true);
  } finally { f.dom.window.close(); }
});

test('学习状态异常会在点击前终止，不会尝试继续', async () => {
  const f = fixture([mediaItem('视频')]);
  try {
    const item = f.api.getMenuItems()[0];
    let clicks = 0;
    item.addEventListener('click', () => { clicks += 1; });
    const warning = f.window.document.createElement('div');
    warning.textContent = '系统检测到你的学习状态异常，请刷新后继续学习';
    f.window.document.body.append(warning);
    f.api.state.running = true;
    await assert.rejects(f.api.humanClick(item, 0));
    assert.equal(clicks, 0);
    assert.equal(f.api.state.running, false);
  } finally { f.dom.window.close(); }
});

test('源代码不写进度、不改倍速、不合成播放器完成事件', () => {
  const source = fs.readFileSync('content.js', 'utf8');
  assert.doesNotMatch(source, /\.currentTime\s*=|playbackRate\s*=|targetThreshold|new\s+(?:Event|CustomEvent)\(['"]ended/);
});

test('文档课程可确认零音视频，但空章节不能冒充零音视频', async () => {
  const f = fixture([mediaItem('课程文档', 'text', '', '')]);
  try {
    f.api.state.running = true;
    const directory = await f.api.waitForDirectory(f.api.state.epoch);
    assert.equal(directory.videoItems.length, 0);
    f.window.document.querySelector('li.el-sub-menu > ul').innerHTML = '';
    f.api.CFG.directoryLoadTimeout = 10;
    await assert.rejects(f.api.waitForDirectory(f.api.state.epoch),
      error => error instanceof f.api.RecoverableError && error.kind === 'directory-load');
  } finally { f.dom.window.close(); }
});

test('折叠章节需要正常点击展开，延迟加载的媒体纳入总数', async () => {
  const f = fixture([mediaItem('课程文档', 'text', '', '')]);
  try {
    const chapter = f.window.document.querySelector('li.el-sub-menu');
    chapter.setAttribute('aria-expanded', 'false');
    let clicks = 0;
    chapter.querySelector('.el-sub-menu__title').addEventListener('click', () => {
      clicks += 1;
      setTimeout(() => {
        chapter.setAttribute('aria-expanded', 'true');
        chapter.querySelector('ul').insertAdjacentHTML('beforeend', mediaItem('晚到视频'));
      }, 200);
    });
    f.api.state.running = true;
    const directory = await f.api.waitForDirectory(f.api.state.epoch);
    assert.equal(clicks, 1);
    assert.equal(directory.videoItems.length, 1);
  } finally { f.dom.window.close(); }
});

test('Beeline 章节统计识别 section-content 条目并忽略隐藏的响应式目录副本', async () => {
  const f = fixture([]);
  try {
    const doc = f.window.document;
    Object.defineProperty(f.window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { return this.textContent; },
      set(value) { this.textContent = value; }
    });
    const oldRoot = doc.querySelector('.sub-menu-area');
    const visibleRoot = doc.createElement('ul');
    visibleRoot.className = 'el-menu el-menu--vertical el-menu-class';
    visibleRoot.getClientRects = () => [{ width: 338, height: 947 }];
    oldRoot.replaceWith(visibleRoot);

    const section = (title, duration, status = 'unStart') => `
      <li class="el-menu-item-group">
        <div class="el-menu-item-group__title">
          <div class="section-area">
            <div class="section-content">
              <span class="section-icon-type"><i class="video-icon"></i></span>
              <span class="section-title"><span class="title">${title}</span></span>
            </div><div class="duration-wrap"><div class="video-duration">${duration}</div></div>
            <div class="section-status"><i class="${status}-icon"></i></div>
          </div>
        </div><ul></ul>
      </li>`;
    const addChapter = (title, content, expanded) => {
      const area = doc.createElement('div');
      area.className = 'sub-menu-area';
      area.innerHTML = `<li class="el-sub-menu${expanded ? ' is-opened' : ''}" aria-expanded="${expanded}">
        <div class="el-sub-menu__title">${title}</div>
        <ul class="el-menu el-menu--inline">${content}</ul>
      </li>`;
      visibleRoot.append(area);
      return area.querySelector('li.el-sub-menu');
    };

    addChapter('第一章', section('第一节视频', '10 分 00 秒', 'done'), true);
    const secondChapter = addChapter('第二章', '', false);
    let visibleExpansionClicks = 0;
    secondChapter.querySelector('.el-sub-menu__title').addEventListener('click', () => {
      visibleExpansionClicks += 1;
      secondChapter.setAttribute('aria-expanded', 'true');
      secondChapter.classList.add('is-opened');
      secondChapter.querySelector(':scope > ul').innerHTML = section('第二节视频', '12 分 00 秒');
    });

    const hiddenRoot = doc.createElement('ul');
    hiddenRoot.className = 'el-menu el-menu--vertical el-menu-class';
    hiddenRoot.style.display = 'none';
    hiddenRoot.innerHTML = `<li class="el-sub-menu chapter-class" aria-expanded="false">
      <div class="el-sub-menu__title">隐藏响应式副本</div>
      <ul class="el-menu el-menu--inline">
        <li class="el-sub-menu section-class" aria-expanded="false">
          <div class="el-sub-menu__title">隐藏小节</div><ul></ul>
        </li>
      </ul>
    </li>`;
    let hiddenExpansionClicks = 0;
    hiddenRoot.querySelector('.el-sub-menu__title')
      .addEventListener('click', () => { hiddenExpansionClicks += 1; });
    doc.body.append(hiddenRoot);

    assert.equal(doc.querySelectorAll('li.el-menu-item').length, 0);
    assert.equal(f.api.getMenuItems().length, 1,
      'The section row is recognized before its chapter-load guard runs');
    f.api.state.running = true;
    const directory = await f.api.waitForDirectory(f.api.state.epoch);
    assert.equal(visibleExpansionClicks, 1);
    assert.equal(hiddenExpansionClicks, 0, 'The hidden responsive menu is outside the active directory tree');
    assert.deepEqual(Array.from(directory.videoItems, item => item.querySelector('.title').textContent), [
      '第一节视频', '第二节视频'
    ]);
    assert.deepEqual(Array.from(f.api.getDirectorySnapshot(directory.videoItems).items,
      item => item.durationSeconds), [
      600, 720
    ], 'Duration text is read from the row container beside section-content');
    assert.equal(f.api.getMenuItems().length, 2);
    assert.equal(f.api.knownChaptersHaveItems(), true);
    assert.equal(directory.pendingItems.length, 1, 'Sibling completion markers are read from section-area');
    assert.equal(f.media.paused, true);
  } finally { f.dom.window.close(); }
});

test('shortCourse 使用 el-menu-component 根节点时仍识别视频目录', async () => {
  const f = fixture([], {
    url: 'https://www.beeline-ai.com/student/#/shortCourse/learn/courseWare/course-1/video/resource-1?classId=class-1'
  });
  try {
    const doc = f.window.document;
    const oldRoot = doc.querySelector('.sub-menu-area');
    const root = doc.createElement('div');
    root.className = 'el-menu-component';
    root.innerHTML = `<ul class="el-menu">
      <li class="el-sub-menu is-opened" aria-expanded="true">
        <div class="el-sub-menu__title">第一章导论</div>
        <ul class="el-menu el-menu--inline">
          <li class="el-menu-item-group"><div class="el-menu-item-group__title">
            <div class="section-area"><div class="section-content"><span class="section-title">理性思维</span></div></div>
          </div><ul>
            <li class="el-menu-item" role="menuitem"><div class="lecture-content"><i class="video-icon"></i><span class="lecture-title">理性思维与非理性思维</span></div><span class="lecture-status"><i class="inProgress-icon"></i></span></li>
          </ul></li>
        </ul>
      </li></ul>`;
    oldRoot.replaceWith(root);
    const result = f.api.refreshDirectories({ logSummary: false });
    assert.equal(result.videoItems.length, 1);
    assert.equal(result.pendingItems.length, 1);
    assert.match(result.videoItems[0].textContent, /理性思维与非理性思维/);
  } finally { f.dom.window.close(); }
});

test('shortCourse 使用 short-distance-elMenu 与 lecture-class 时识别并读取进度完成', async () => {
  const f = fixture([], {
    url: 'https://www.beeline-ai.com/student/#/shortCourse/learn/courseWare/course-1/video/resource-1?classId=class-1'
  });
  try {
    const doc = f.window.document;
    const oldRoot = doc.querySelector('.sub-menu-area');
    const root = doc.createElement('div');
    root.className = 'short-distance-elMenu';
    root.innerHTML = `<ul class="el-menu-class">
      <li class="el-sub-menu chapter-class" aria-expanded="true"><div class="el-sub-menu__title">第一章导论</div><ul>
        <li class="el-sub-menu section-class" aria-expanded="true"><div class="el-sub-menu__title"><span class="section-title">理性思维</span></div><ul>
          <li class="el-menu-item lecture-class" role="menuitem"><div class="lecture-content"><span class="lecture-title">已完成视频</span></div><span class="lecture-status"><div class="el-progress-bar__inner" style="width: 100%;"></div></span></li>
          <li class="el-menu-item lecture-class" role="menuitem"><div class="lecture-content"><span class="lecture-title">待完成视频</span></div><span class="lecture-status"><i class="unStart-icon"></i></span></li>
        </ul></li>
      </ul></li></ul>`;
    oldRoot.replaceWith(root);
    const result = f.api.refreshDirectories({ logSummary: false });
    assert.equal(result.videoItems.length, 2);
    assert.equal(result.pendingItems.length, 1);
    assert.equal(f.api.getDirectorySnapshot(result.videoItems).items.length, 2);
  } finally { f.dom.window.close(); }
});

test('同一章节的同名媒体不会被去重丢失', () => {
  const f = fixture([mediaItem('同名视频'), mediaItem('同名视频')]);
  try {
    const result = f.api.refreshDirectories({ logSummary: false });
    assert.equal(result.videoItems.length, 2);
    assert.notEqual(f.api.getItemKey(result.videoItems[0]), f.api.getItemKey(result.videoItems[1]));
  } finally { f.dom.window.close(); }
});

test('切换目录条目后，旧播放器的 ended 不得冒充新资源已播放结束', async () => {
  const f = fixture([mediaItem('前一视频'), mediaItem('新视频')]);
  try {
    const [old, next] = f.api.getMenuItems();
    old.classList.add('is-active');
    f.advanceNaturally(60, true);
    next.addEventListener('click', () => {
      old.classList.remove('is-active');
      next.classList.add('is-active');
      // Label changes first; the old source remains ended and no new metadata arrives.
    });
    f.api.CFG.mediaLoadTimeout = 5;
    f.api.state.running = true;
    await assert.rejects(
      f.api.playItemToEnd(next, f.api.state.epoch, f.api.currentCourseKey()),
      /网络缓慢或播放器尚未就绪，建议人工检查/
    );
    assert.equal(f.api.state.playedCount, 0);
    assert.equal(f.api.state.processedItems.has(f.api.getItemKey(next)), false);
  } finally { f.dom.window.close(); }
});

test('继续前已显示完成标记的资源会在课程末核对时确认，不重复播放', async () => {
  const c = coordinator();
  const url = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/res?classId=class-1';
  const id = c.addTab(url);
  const f = fixture([mediaItem('视频')], { url, connect: c.connect(id), confirmationTimeout: 100 });
  try {
    const item = f.api.getMenuItems()[0];
    item.classList.add('is-active');
    let playClicks = 0;
    f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { playClicks += 1; });
    await seedCoursePlaybackFixture(f);
    await observePlayback(f, item, { position: 49 });
    markPageCompleted(item);
    const playClicksBeforeResume = playClicks;
    await f.api.stop();
    assert.equal(f.media.paused, true);
    assert.equal(f.api.state.job.running, false);
    await waitFor(() => !f.api.state.jobPromise);
    await f.api.start();
    await waitFor(() => c.storage.session[JOB_KEY]?.candidates[0]?.records?.[f.api.getItemKey(item)]?.confirmed === true);
    assert.equal(c.storage.session[JOB_KEY].candidates[0].records[f.api.getItemKey(item)].completionSource, 'page-marker');
    assert.equal(playClicks, playClicksBeforeResume);
    assert.equal(c.reloads.length, 1);
  } finally {
    if (f.api.state.job?.running) await f.api.stop();
    if (f.api.state.jobPromise) await f.api.state.jobPromise;
    f.dom.window.close();
  }
});

test('自然结束待确认记录在课程末刷新后复核，迟到标记可确认且不重播', { timeout: 45000 }, async () => {
  const c = coordinator();
  const url = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/res?classId=class-1';
  const id = c.addTab(url);
  const first = fixture([mediaItem('视频')], { url, connect: c.connect(id), confirmationTimeout: 5000 });
  let second, plays = 0, apiPlays = 0, refreshCount = 0;
  const observeClicks = f => {
    for (const button of f.window.document.querySelectorAll('.vjs-big-play-button, .vjs-play-control')) {
      button.addEventListener('click', () => { plays += 1; });
    }
    f.media.play = async () => { apiPlays += 1; };
  };
  c.onNavigation.addListener(tab => {
    if (tab.id !== id || !c.reloads.length || refreshCount >= c.reloads.length) return;
    refreshCount += 1;
    second?.dom.window.close();
    second = fixture([mediaItem('视频')], { url, connect: c.connect(id), confirmationTimeout: 5 });
    second.api.getMenuItems()[0].classList.add('is-active');
    observeClicks(second);
    markPageCompleted(second.api.getMenuItems()[0]);
  });
  try {
    const firstItem = first.api.getMenuItems()[0];
    firstItem.classList.add('is-active');
    await seedCoursePlaybackFixture(first);
    await observePlayback(first, firstItem);
    endPlayback(first);
    await waitFor(() => Object.values(first.api.state.job.candidates[0].records || {}).some(r => r.ended));
    const runId = first.api.state.job.runId;
    await first.api.stop();
    await waitFor(() => !first.api.state.jobPromise);
    first.dom.window.close();
    second = fixture([mediaItem('视频')], { url, connect: c.connect(id), confirmationTimeout: 5 });
    const secondItem = second.api.getMenuItems()[0];
    secondItem.classList.add('is-active');
    observeClicks(second);
    await second.api.syncSharedJob();
    await second.api.start();
    await waitFor(() => refreshCount === 1);
    await waitFor(() => second.api.state.job?.phase === 'finished', 35000);
    assert.equal(second.api.state.job.runId, runId);
    assert.equal(second.api.state.job.running, false);
    assert.equal(plays, 0);
    assert.equal(second.api.state.job.candidates[0].status, 'completed');
    assert.equal(second.api.state.playedCount, 1);
    assert.equal(Object.values(second.api.state.job.candidates[0].records)[0].ended, true);
    assert.equal(Object.values(second.api.state.job.candidates[0].records)[0].confirmed, true);
    assert.equal(second.api.state.job.runId, runId);
    assert.equal(second.api.state.playedCount, 1);
    assert.equal(plays, 0);
    assert.equal(apiPlays, 0);
    assert.equal(c.reloads.length, 1);
  } finally {
    const current = second || first;
    if (current.api.state.job?.running) await current.api.stop();
    if (current.api.state.jobPromise) await current.api.state.jobPromise;
    first.dom.window.close();
    second?.dom.window.close();
  }
});

test('旧单课程协议兼容：浏览器重启后显式恢复未自然结束义务，不能跳过已有80%完成标记的资源', async () => {
  const c = coordinator();
  const url = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/res?classId=class-1';
  const id = c.addTab(url);
  const first = fixture([mediaItem('续看视频')], { url, connect: c.connect(id) });
  let second;
  try {
    const firstItem = first.api.getMenuItems()[0];
    firstItem.classList.add('is-active');
    await seedCoursePlaybackFixture(first);
    await observePlayback(first, firstItem, { position: 49 });
    markPageCompleted(firstItem);
    await first.api.stop();
    await waitFor(() => !first.api.state.jobPromise);
    first.dom.window.close();
    c.restartBrowser();
    c.restartWorker();
    second = fixture([mediaItem('续看视频', 'video', 'done')], { url, connect: c.connect(id) });
    second.api.getMenuItems()[0].classList.add('is-active');
    await second.api.syncSharedJob();
    assert.equal(second.api.state.job.running, false);
    // Exercise retained single-course recovery directly. The public Start
    // now returns to the homepage for all courses (sitewide-start tests).
    await seedCoursePlaybackFixture(second);
    await observePlayback(second, second.api.getMenuItems()[0]);
    assert.equal(second.api.state.job.running, true);
    assert.equal(second.api.refreshDirectories({ logSummary: false }).pendingItems.length, 1);
    endPlayback(second);
    await waitFor(() => second.api.state.job?.phase === 'finished');
    assert.equal(second.api.state.job.candidates[0].status, 'completed');
    assert.equal(second.api.state.playedCount, 1);
  } finally {
    const current = second || first;
    if (current.api.state.job?.running) await current.api.stop();
    if (current.api.state.jobPromise) await current.api.state.jobPromise;
    first.dom.window.close();
    second?.dom.window.close();
  }
});
