const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, mediaItem, waitFor, seedCoursePlaybackFixture } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');

const KEY = 'xinwei-job-v3';
const COURSE = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';

// Real content/background modules with a simulated website, message bus and
// read-only media time. These are integration simulations, not browser acceptance.
for (const successfulRecovery of [1, 2, 3]) {
  test('同一任务：普通中断第' + successfulRecovery + '次恢复成功后完成短视频和音频，无第二次开始或换课回试',
    { timeout: 45000 }, async () => {
      const c = coordinator();
      const tab = c.addTab(COURSE);
      const messages = [], attempts = [], completionOrder = [];
      let active = 0, position = 0, playClicks = 0, playingAnnounced = false;
      const f = fixture([
        mediaItem('暂时故障的短视频', 'video', 'unStart', '00 分 09 秒'),
        mediaItem('正常长音频', 'audio', 'unStart', '00 分 10 秒')
      ], {
        url: COURSE, title: '恢复整合课程', confirmationTimeout: 30,
        get duration() { return active === 0 ? 9 : 10; },
        connect(window) {
          c.connect(tab)(window);
          const send = window.chrome.runtime.sendMessage;
          window.chrome.runtime.sendMessage = async message => {
            messages.push({ action: message.action, key: message.key, runId: message.runId });
            const response = await send(message);
            if (message.action === 'interruption-attempt') {
              attempts.push(response?.job?.interruption?.attempts);
            }
            return response;
          };
        }
      });
      const items = f.api.getMenuItems();
      items[0].classList.add('is-active');
      Object.assign(f.api.CFG, {
        recoveryWaitMin: 1, recoveryWaitMax: 1, identityStableTime: 1,
        gatewayPauseGrace: 2, mediaLoadTimeout: 1000, directoryLoadTimeout: 1500,
        stallTimeout: 1000
      });
      items.forEach((item, index) => item.addEventListener('click', () => {
        active = index; position = 0; playingAnnounced = false;
        items.forEach(other => other.classList.remove('is-active'));
        item.classList.add('is-active');
        f.advanceNaturally(0);
        f.media.dispatchEvent(new f.window.Event('loadedmetadata'));
      }));
      f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => {
        if (active !== 0) return;
        playClicks += 1;
        if (playClicks <= successfulRecovery) {
          f.media.pause();
          f.media.dispatchEvent(new f.window.Event('pause'));
        }
      });
      // Keep the first recovered resource naturally playing for longer than
      // the production 8-second stable window before giving it an ended event.
      let lastTickAt = Date.now();
      const tick = setInterval(() => {
        const now = Date.now();
        const elapsed = Math.max(0, (now - lastTickAt) / 1000);
        lastTickAt = now;
        if (f.media.paused || f.media.ended) return;
        const key = f.api.getItemKey(items[active]);
        const attempt = f.api.state.processedItems.get(key)?.playbackAttempt;
        if (!attempt?.after) return;
        if (!playingAnnounced) {
          playingAnnounced = true;
          f.media.dispatchEvent(new f.window.Event('playing'));
        }
        position = Math.min(f.media.duration, position + elapsed);
        const ending = position >= f.media.duration;
        if (ending) {
          items[active].querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
          completionOrder.push(active);
          f.advanceNaturally(f.media.duration, true);
          f.media.dispatchEvent(new f.window.Event('ended'));
        } else {
          f.advanceNaturally(position);
          f.media.dispatchEvent(new f.window.Event('timeupdate'));
        }
      }, 20);
      try {
        const initial = await seedCoursePlaybackFixture(f);
        await waitFor(() => c.storage.session[KEY]?.phase === 'finished', 40000);
        const final = c.storage.session[KEY];
        assert.equal(final.runId, initial.runId);
        assert.equal(final.running, false);
        assert.equal(final.candidates[0].status, 'completed');
        assert.equal(final.candidates[0].remaining, 0);
        assert.deepEqual(completionOrder, [0, 1], 'Recovery must not skip the shorter unfinished resource');
        assert.equal(playClicks, successfulRecovery + 1);
        assert.deepEqual(attempts, Array.from({ length: successfulRecovery }, (_, i) => i + 1));
        assert.equal(final.interruption == null, true, 'Stable natural playback clears the interruption budget');
        assert.equal(c.reloads.length, 0);
        assert.equal(c.navigation.length, 0);
        assert.equal(messages.filter(message => message.action === 'start').length, 1);
        assert.equal(messages.filter(message => message.action === 'manual').length, 0);
        assert.equal(messages.filter(message => message.action === 'reload-course').length, 0);
        for (const record of Object.values(final.candidates[0].records)) {
          assert.equal(record.ended, true);
          assert.equal(record.confirmed, true);
          assert.ok(!record.progressGap);
        }
      } catch (error) {
        console.error(JSON.stringify({ job: c.storage.session[KEY], active, playClicks, attempts,
          completionOrder, messages: messages.slice(-15), log: f.api.state.logBox?.textContent }));
        throw error;
      } finally {
        clearInterval(tick);
        await f.api.stop(false);
        await Promise.allSettled([f.api.state.jobPromise, f.api.state.syncPromise]);
        f.dom.window.close();
      }
    });
}
