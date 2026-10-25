const assert = require('node:assert/strict');
const { waitFor } = require('./helpers.cjs');

// These are fake-website events, not extension APIs or real-browser evidence.
// Keep media lifecycle and the platform's completion mark independently driven.
async function observePlayback(f, item, { position, timeout = 3000 } = {}) {
  const key = f.api.getItemKey(item);
  const activeKey = () => {
    const active = f.window.document.querySelector('li.el-menu-item.is-active');
    return active && f.api.getItemKey(active);
  };
  await waitFor(() => {
    const attempt = f.api.state.processedItems.get(key)?.playbackAttempt;
    return activeKey() === key && f.media.isConnected &&
      !f.media.paused && !f.media.ended && attempt &&
      (attempt.after || attempt.before?.paused === false);
  }, timeout);
  const attempt = f.api.state.processedItems.get(key).playbackAttempt;
  const beforePlaying = attempt.events.filter(event => event.type === 'playing').length;
  f.media.dispatchEvent(new f.window.Event('playing'));
  const next = position ?? Math.min(f.media.duration - 0.01, f.media.currentTime + 0.25);
  assert.ok(next > f.media.currentTime && next < f.media.duration,
    'Observed playback must advance normally before its natural end');
  f.advanceNaturally(next);
  f.media.dispatchEvent(new f.window.Event('timeupdate'));
  await waitFor(() => activeKey() === key &&
    f.api.state.processedItems.get(key)?.playbackAttempt === attempt &&
    attempt.events.filter(event => event.type === 'playing' && event.paused === false).length > beforePlaying,
  timeout);
  // Let the ordinary media poll observe the intermediate position as well.
  await new Promise(resolve => setTimeout(resolve, Math.max(10, f.api.CFG.pollInterval * 2)));
  return f.api.state.processedItems.get(key).playbackAttempt;
}

function endPlayback(f) {
  assert.equal(f.media.paused, false, 'A paused player cannot naturally end');
  assert.equal(f.media.ended, false, 'The test must not reuse an old ended player');
  f.advanceNaturally(f.media.duration, true);
  f.media.dispatchEvent(new f.window.Event('timeupdate'));
  f.media.dispatchEvent(new f.window.Event('ended'));
}

function markPageCompleted(item) {
  item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
}

module.exports = { observePlayback, endPlayback, markPageCompleted };
