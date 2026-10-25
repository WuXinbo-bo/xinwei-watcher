const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, mediaItem, homeFixture, homeCard, waitFor } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');

const SITE = 'https://www.beeline-ai.com';
const AGENT = `${SITE}/stu/agent`;
const HOME = `${SITE}/myBank/courseResearch`;
const KEY = 'xinwei-job-v3';

// Public UI start, real extension modules, simulated website and browser.
// Sorting uses the website's directory durations. Playback failures are
// revisited only after the course-end refresh, before the next course opens.
test('公开开始一次：回首页扫描、少媒体课第二次恢复、自然完成并跨课至全部确认',
  { timeout: 60000 }, async () => {
    const c = coordinator();
    const id = c.addTab(`${SITE}/ordinary-page`);
    const courses = [
      { title: '故障后可恢复课程', slug: 'retry', items: [{ title: '暂时故障视频', kind: 'video', duration: '00 分 09 秒', seconds: 9 }] },
      { title: '正常课程', slug: 'normal', items: [
        { title: '正常长视频', kind: 'video', duration: '00 分 04 秒', seconds: 4 },
        { title: '正常短音频', kind: 'audio', duration: '00 分 02 秒', seconds: 2 }
      ] },
      { title: '仅文档课程', slug: 'documents', items: [{ title: '阅读材料', kind: 'text', duration: '' }] }
    ];
    courses.forEach(course => {
      course.url = `${SITE}/student/#/courseInfo/learn/courseWare/${course.slug}/video/site-entry?classId=class-${course.slug}`;
      course.completed = new Set();
    });
    const documents = new Map(), all = [], requests = [], errors = [];
    const inspection = [], playbackVisits = [], endings = [], markEvidence = [];
    let entryClicks = 0, allowedRetry = false, recoveryClicks = 0, currentHome, finishing = false;
    const connect = tabId => window => {
      c.connect(tabId)(window);
      const send = window.chrome.runtime.sendMessage;
      window.chrome.runtime.sendMessage = message => {
        requests.push({ action: message.action, runId: message.runId, scope: message.scope });
        return send(message);
      };
    };
    const close = tabId => {
      const old = documents.get(tabId);
      if (!old) return;
      clearInterval(old.tick);
      old.dom.window.close();
      documents.delete(tabId);
    };
    const register = (tabId, f) => {
      documents.set(tabId, f);
      all.push(f);
      return f;
    };
    const renderCourse = (tabId, course, purpose) => {
      let active = 0, position = 0, attempt = null, mediaError = null, lastTickAt = Date.now();
      const f = fixture(course.items.map((item, index) => mediaItem(item.title, item.kind,
        course.completed.has(index) ? 'done' : 'unStart', item.duration)), {
        url: course.url, title: course.title, connect: connect(tabId), confirmationTimeout: 1000,
        get duration() { return course.items[active].seconds || 60; }
      });
      register(tabId, f);
      Object.assign(f.api.CFG, {
        recoveryWaitMin: 1, recoveryWaitMax: 1, identityStableTime: 1,
        mediaLoadTimeout: 500, directoryLoadTimeout: 2000, gatewayPauseGrace: 5,
        stallTimeout: 500, resourceRetryDelay: 1, backgroundRetryDelay: 1
      });
      const items = f.api.getMenuItems();
      const endedKeys = new Set();
      items[0].classList.add('is-active');
      Object.defineProperty(f.media, 'error', { get: () => mediaError });
      f.media.play = () => { throw new Error('Extension must use the visible play button'); };
      items.forEach((item, index) => item.addEventListener('click', () => {
        active = index; position = 0; attempt = null;
        // The simulated site replaces its failed media source when the visible
        // directory entry is reopened during an ordinary recovery attempt.
        if (course === courses[0] && recoveryClicks >= 1) mediaError = null;
        items.forEach(other => other.classList.remove('is-active'));
        item.classList.add('is-active');
        f.advanceNaturally(0);
        f.media.dispatchEvent(new f.window.Event('loadedmetadata'));
      }));
      f.tick = setInterval(() => {
        try {
          const now = Date.now();
          const elapsed = Math.max(0, (now - lastTickAt) / 1000);
          lastTickAt = now;
          if (finishing || documents.get(tabId) !== f) return;
          const job = c.storage.session[KEY];
          const candidate = job?.candidates.find(candidate => candidate.title === course.title);
          for (const key of endedKeys) {
            const record = candidate?.records[key];
            const index = items.findIndex(item => f.api.getItemKey(item) === key);
            if (!record?.ended || course.completed.has(index)) continue;
            markEvidence.push({ title: course.items[index].title, ended: record.ended, confirmed: record.confirmed });
            course.completed.add(index);
            items[index].querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
          }
          if (f.media.paused || f.media.ended || purpose !== 'play') return;
          const item = items[active], key = f.api.getItemKey(item);
          const observed = f.api.state.processedItems.get(key)?.playbackAttempt;
          if (!observed?.after) return;
          if (attempt !== observed) {
            attempt = observed;
            f.media.dispatchEvent(new f.window.Event('playing'));
          }
          if (course === courses[0] && !allowedRetry) {
            mediaError = { code: 2 };
            return;
          }
          // The fake media follows wall time at 1x; directory durations are
          // short synthetic resources, not shortcuts through real coursework.
          position = Math.min(position + elapsed, f.media.duration);
          f.advanceNaturally(position, position === f.media.duration);
          f.media.dispatchEvent(new f.window.Event('timeupdate'));
          if (f.media.ended) {
            endedKeys.add(key);
            endings.push(course.items[active].title);
            f.media.dispatchEvent(new f.window.Event('ended'));
          }
        } catch (error) { errors.push(error); }
      }, 10);
      f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => {
        if (course !== courses[0] || purpose !== 'play') return;
        recoveryClicks += 1;
        if (recoveryClicks === 2) {
          allowedRetry = true;
          mediaError = null;
        }
      });
      return f;
    };
    const renderHome = (url = HOME) => {
      const f = homeFixture(courses.map(course => homeCard(course.title)), { url, connect: connect(id) });
      register(id, f);
      currentHome = f;
      f.window.document.querySelector('.btn-next').disabled = true;
      f.window.document.querySelectorAll('.item-bg-text p.sle').forEach((entry, index) => {
        entry.addEventListener('click', () => {
          try {
            assert.equal(f.api.state.job.targetPurpose, 'inspect');
            inspection.push(courses[index].title);
            renderCourse(c.addTab(courses[index].url, id), courses[index], 'inspect');
          } catch (error) { errors.push(error); }
        });
      });
      if (url === AGENT) {
        const sidebar = f.window.document.createElement('div');
        sidebar.className = 'my-course-container';
        sidebar.innerHTML = '<a class="timetable">查看所有课表</a>';
        f.window.document.body.append(sidebar);
        const entry = sidebar.querySelector('a');
        entry.getClientRects = () => [{ width: 100, height: 20 }];
        entry.addEventListener('click', () => {
          entryClicks += 1;
          f.window.history.replaceState({}, '', HOME);
        });
      }
      return f;
    };
    c.onTabRemoved.addListener(close);
    c.onNavigation.addListener(tab => {
      if (finishing) return;
      try {
        assert.equal(tab.id, id);
        close(id);
        if (tab.url === AGENT || tab.url === HOME) renderHome(tab.url);
        else {
          const course = courses.find(course => course.url === tab.url);
          assert.ok(course);
          const job = c.storage.session[KEY];
          assert.equal(job.candidates[job.targetIndex].learnUrl, tab.url);
          playbackVisits.push({ title: course.title, at: Date.now(), retryAt: job.candidates[job.targetIndex].retryAt });
          renderCourse(id, course, 'play');
        }
      } catch (error) { errors.push(error); }
    });
    try {
      const first = register(id, homeFixture([], { url: `${SITE}/ordinary-page`, connect: connect(id) }));
      first.window.document.getElementById('wb-start').click();
      await waitFor(() => c.storage.session[KEY]?.phase === 'finished' || errors.length, 55000);
      if (errors.length) throw errors[0];
      await waitFor(() => currentHome.api.state.job?.phase === 'finished');
      const job = c.storage.session[KEY];
      assert.equal(requests.filter(message => message.action === 'start').length, 1);
      assert.equal(requests.find(message => message.action === 'start').scope, 'all');
      assert.equal(entryClicks, 1);
      assert.deepEqual(inspection, courses.map(course => course.title));
      assert.equal(requests.filter(message => message.action === 'manual').length, 0);
      assert.equal(requests.filter(message => message.action === 'scan-result').length, 1);
      assert.equal(recoveryClicks, 2);
      assert.equal(c.reloads.length, 2, 'each media course is refreshed once after its first pass');
      assert.equal(requests.filter(message => message.action === 'reload-course').length, 0);
      assert.deepEqual(playbackVisits.map(visit => visit.title), [
        courses[0].title, courses[0].title, courses[1].title, courses[1].title
      ]);
      assert.deepEqual(endings, ['暂时故障视频', '正常短音频', '正常长视频']);
      assert.equal(markEvidence.length, 3);
      assert.equal(markEvidence.every(record => record.ended && record.confirmed === false), true);
      assert.equal(job.running, false);
      assert.equal(job.candidates.every(candidate => candidate.remaining === 0), true);
      assert.equal(job.candidates[2].total, 0);
      assert.equal(job.interruption == null, true);
      assert.deepEqual(job.candidates.map(candidate => Object.keys(candidate.records || {}).length), [1, 2, 0]);
      for (const [index, candidate] of job.candidates.entries()) {
        const records = Object.values(candidate.records || {});
        const media = candidate.directory.items.filter(item => ['video', 'audio', 'media'].includes(item.mediaType));
        assert.deepEqual(Object.keys(candidate.records || {}).sort(), media.map(item => item.key).sort());
        assert.deepEqual(records.map(record => record.title).sort(), courses[index].items
          .filter(item => ['video', 'audio'].includes(item.kind)).map(item => item.title).sort());
        assert.equal(records.every(record => record.ended && record.confirmed && !record.progressGap), true);
      }
      assert.equal(c.tabs.get(id).url, HOME);
      assert.deepEqual([...c.tabs.keys()], [id]);
      assert.match(currentHome.window.document.getElementById('wb-current').textContent, /文档、考试、作业/);
    } catch (error) {
      console.error(JSON.stringify({ job: c.storage.session[KEY], inspection, playbackVisits,
        endings, recoveryClicks, errors: errors.map(e => e.message), requests: requests.slice(-12) }));
      throw error;
    } finally {
      finishing = true;
      for (const f of documents.values()) {
        clearInterval(f.tick);
        f.api.state.running = false;
        f.api.state.epoch += 1;
      }
      await Promise.allSettled([...documents.values()].flatMap(f => [f.api.state.jobPromise, f.api.state.syncPromise]).filter(Boolean));
      [...documents.keys()].forEach(close);
      all.forEach(f => f.dom.window.close());
    }
  });
