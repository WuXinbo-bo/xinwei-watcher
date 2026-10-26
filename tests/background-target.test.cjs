const assert = require('node:assert/strict');
const test = require('node:test');
const { coordinator } = require('./coordinator.cjs');

const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const LEARN = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course/video/resource?classId=class';
const KEY = 'xinwei-job-v3';
const routeKey = value => { const url = new URL(value); return `${url.pathname}${url.hash}`; };
const auth = job => ({ runId: job.runId, generation: job.generation, resetEpoch: job.resetEpoch });
const directory = {
  version: 1, items: [
    { key: 'video', title: 'video', mediaType: 'video', durationSeconds: 60 },
    { key: 'audio', title: 'audio', mediaType: 'audio', durationSeconds: 30 }
  ]
};

async function prepared(targetPercent = 80, options = {}) {
  const c = coordinator(options);
  const id = c.addTab(LEARN);
  let r = await c.request(id, 'page', 'start', { title: 'course', singlePass: true, targetPercent });
  assert.equal(r.ok, true);
  r = await c.request(id, 'page', 'directory-checkpoint', { ...auth(r.job), snapshot: directory });
  r = await c.request(id, 'page', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: 'video', stage: 'ready', routeKey: routeKey(LEARN)
  });
  r = await c.request(id, 'page', 'record', {
    ...auth(r.job), key: 'video', result: {
      title: 'video', started: true, ended: false, confirmed: false, effectiveTarget: targetPercent
    }
  });
  assert.equal(r.ok, true);
  return { c, id, job: r.job };
}

test('shared preference updates task default without changing resource evidence or ownership', async()=>{
  const {c,id,job}=await prepared();
  c.storage.local['wb-playback-target']=95;
  c.onStorageChanged.fire({'wb-playback-target':{newValue:95}},'local');
  const r=await c.request(id,'page','get');
  assert.equal(r.job.targetPercent,95);assert.equal(r.job.generation,job.generation);
  assert.equal(r.job.ownerTabId,job.ownerTabId);
  assert.equal(r.job.candidates[0].records.video.effectiveTarget,80);
  assert.equal(r.job.candidates[0].records.video.confirmed,false);
});

test('target checkpoint advances without inventing natural end or platform confirmation', async () => {
  const { c, id, job } = await prepared();
  const r = await c.request(id, 'page', 'record', {
    ...auth(job), key: 'video', result: {
      targetReached: true, sitePercent: 80, effectiveTarget: 80
    }
  });
  const candidate = r.job.candidates[0];
  assert.equal(candidate.records.video.targetReached, true);
  assert.equal(candidate.records.video.ended, false);
  assert.equal(candidate.records.video.confirmed, false);
  assert.equal(candidate.currentResource, undefined);
  assert.equal(c.storage.local[KEY].candidates[0].records.video.targetReached, true);
});

test('platform confirmation may resolve a resource before its natural end', async () => {
  const { c, id, job } = await prepared();
  let r = await c.request(id, 'page', 'record', {
    ...auth(job), key: 'video', result: { error: 'media failed', deferred: true }
  });
  r = await c.request(id, 'page', 'record', {
    ...auth(r.job), key: 'video', result: { confirmed: true, completionSource: 'page-marker' }
  });
  assert.equal(r.job.candidates[0].records.video.ended, false);
  assert.equal(r.job.candidates[0].records.video.error, undefined);
  r = await c.request(id, 'page', 'record', {
    ...auth(r.job), key: 'audio', result: {
      title: 'audio', confirmed: true, completionSource: 'page-marker', ended: false
    }
  });
  r = await c.request(id, 'page', 'course-result', {
    ...auth(r.job), result: { total: 2, remaining: 0, finalPass: true }
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.phase, 'finished');
  assert.equal(r.job.candidates[0].status, 'completed');
  assert.equal(r.job.candidates[0].remaining, 0);
  assert.equal(r.job.candidates[0].records.video.ended, false);
});

test('single-pass course result cannot mark resources completed without per-item platform evidence', async () => {
  const { c, id, job } = await prepared();
  const r = await c.request(id, 'page', 'course-result', {
    ...auth(job), result: { total: 2, remaining: 0, finalPass: true }
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.phase, 'finished');
  assert.equal(r.job.candidates[0].status, 'manual');
  assert.equal(r.job.candidates[0].remaining, 2);
  assert.deepEqual(Array.from(r.job.candidates[0].unconfirmed).sort(), ['audio', 'video']);
});

test('all-complete course inspection does not require playback records', async () => {
  const { c, id, job } = await prepared();
  for (const area of [c.storage.local, c.storage.session]) {
    area[KEY].scope = 'all';
    area[KEY].targetPurpose = 'inspect';
    area[KEY].candidates[0].records = {};
  }
  const r = await c.request(id, 'page', 'course-result', {
    ...auth(job), result: { total: 2, remaining: 0 }
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.candidates[0].status, 'complete');
  assert.equal(r.job.candidates[0].remaining, 0);
  assert.equal(r.job.inspectIndex, job.inspectIndex + 1);
});

test('retry budgets are idempotent, resource-local, and retained by stale records and worker restart', async () => {
  const { c, id, job } = await prepared();
  let r = await c.request(id, 'page', 'resource-retry', {
    ...auth(job), key: 'video', phase: 'recovery', token: 'r1', reason: 'media failed'
  });
  r = await c.request(id, 'page', 'resource-retry', {
    ...auth(r.job), key: 'video', phase: 'recovery', token: 'r1'
  });
  assert.equal(r.job.candidates[0].records.video.recoveryAttempts, 1);
  assert.equal(r.job.candidates[0].records.video.effectiveTarget, 100);
  assert.equal(r.job.targetPercent, 80);
  r = await c.request(id, 'page', 'record', {
    ...auth(r.job), key: 'video', result: {
      recoveryAttempts: 0, finalAttempts: 0, retryTokens: {}, effectiveTarget: 80
    }
  });
  assert.equal(r.job.candidates[0].records.video.recoveryAttempts, 1);
  assert.equal(r.job.candidates[0].records.video.effectiveTarget, 100);
  c.restartWorker();
  r = await c.request(id, 'page', 'get');
  for (let count = 2; count <= 3; count += 1) {
    r = await c.request(id, 'page', 'resource-retry', {
      ...auth(r.job), key: 'video', phase: 'recovery', token: `r${count}`
    });
    assert.equal(r.job.candidates[0].records.video.recoveryAttempts, count);
  }
  const exhausted = await c.request(id, 'page', 'resource-retry', {
    ...auth(r.job), key: 'video', phase: 'recovery', token: 'r4'
  });
  assert.equal(exhausted.ok, false);
  assert.match(exhausted.error, /三次重试已用完/);
  r = await c.request(id, 'page', 'resource-retry', {
    ...auth(r.job), key: 'video', phase: 'final', token: 'f1'
  });
  assert.equal(r.job.candidates[0].records.video.finalAttempts, 1);
  assert.equal(r.job.candidates[0].records.video.recoveryAttempts, 3);
  r = await c.request(id, 'page', 'record', {
    ...auth(r.job), key: 'audio', result: { title: 'audio', effectiveTarget: 80 }
  });
  assert.equal(r.job.candidates[0].records.audio.effectiveTarget, 80);
  assert.equal(r.job.candidates[0].records.audio.recoveryAttempts, undefined);
});

test('course-end retry clears an old natural-end flag before the resource is reopened', async () => {
  const { c, id, job } = await prepared();
  let r = await c.request(id, 'page', 'record', {
    ...auth(job), key: 'video', result: {
      ended: true, confirmed: false, playbackAttempt: { finished: { currentTime: 60 } }
    }
  });
  assert.equal(r.job.candidates[0].records.video.ended, true);
  assert.equal(r.job.candidates[0].currentResource, undefined);

  r = await c.request(id, 'page', 'resource-retry', {
    ...auth(r.job), key: 'video', phase: 'final', token: 'final-after-ended'
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.candidates[0].records.video.ended, false);
  assert.equal(r.job.candidates[0].records.video.confirmed, false);

  r = await c.request(id, 'page', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: 'video', stage: 'opening', routeKey: ''
  });
  assert.equal(r.ok, true);
  r = await c.request(id, 'page', 'resource-checkpoint', {
    ...auth(r.job), key: 'video', title: 'video', stage: 'ready', routeKey: routeKey(LEARN)
  });
  assert.equal(r.ok, true);
  r = await c.request(id, 'page', 'record', {
    ...auth(r.job), key: 'video', result: {
      ended: false, started: true, confirmed: false, playbackAttempt: { events: [{ type: 'playing' }] }
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.candidates[0].records.video.ended, false);
  assert.deepEqual(r.job.candidates[0].currentResource, {
    key: 'video', title: 'video', stage: 'ready', routeKey: routeKey(LEARN)
  });
});

test('a resource already confirmed by the platform cannot be reopened by a stale retry request', async () => {
  const { c, id, job } = await prepared();
  let r = await c.request(id, 'page', 'record', {
    ...auth(job), key: 'video', result: {
      confirmed: true, completionSource: 'page-marker'
    }
  });
  assert.equal(r.ok, true);
  const retry = await c.request(id, 'page', 'resource-retry', {
    ...auth(r.job), key: 'video', phase: 'final', token: 'stale-retry'
  });
  assert.equal(retry.ok, false);
  assert.match(retry.error, /已核对为完成/);
  assert.equal(c.storage.session[KEY].candidates[0].records.video.confirmed, true);
  assert.equal(c.storage.session[KEY].candidates[0].records.video.finalAttempts, undefined);
});

test('course phase, retry counts and refresh tokens persist before an own refresh and resume', async () => {
  const { c, id, job } = await prepared();
  let r = await c.request(id, 'page', 'resource-retry', {
    ...auth(job), key: 'video', phase: 'recovery', token: 'r1'
  });
  r = await c.request(id, 'page', 'course-pass', {
    ...auth(r.job), phase: 'verify', pendingKeys: ['video', 'audio']
  });
  r = await c.request(id, 'page', 'course-refresh', {
    ...auth(r.job), key: 'video', token: 'r1', reason: 'media failed'
  });
  assert.equal(r.ok, true);
  assert.deepEqual(c.reloads, [id]);
  assert.equal(c.storage.local[KEY].candidates[0].pass.phase, 'verify');
  assert.equal(c.storage.local[KEY].candidates[0].records.video.recoveryAttempts, 1);
  r = await c.request(id, 'page', 'course-refresh', {
    ...auth(r.job), key: 'video', token: 'r1'
  });
  assert.deepEqual(c.reloads, [id]);
  c.restartWorker();
  r = await c.request(id, 'refreshed', 'hello', { title: 'course' });
  assert.equal(r.job.running, true);
  assert.equal(r.job.ownerInstance, 'refreshed');
  assert.equal(r.job.candidates[0].pass.phase, 'verify');
  assert.equal(r.job.candidates[0].records.video.recoveryAttempts, 1);
  assert.ok(r.job.generation > job.generation);
});

test('batch verification refresh works without an active resource checkpoint', async () => {
  const { c, id, job } = await prepared();
  let r = await c.request(id, 'page', 'record', {
    ...auth(job), key: 'video', result: { targetReached: true }
  });
  r = await c.request(id, 'page', 'course-pass', {
    ...auth(r.job), phase: 'verify', pendingKeys: ['video']
  });
  r = await c.request(id, 'page', 'course-refresh', {
    ...auth(r.job), token: 'verify-course'
  });
  assert.equal(r.ok, true);
  assert.deepEqual(c.reloads, [id]);
  r = await c.request(id, 'refreshed', 'hello', { title: 'course' });
  assert.equal(r.job.ownerInstance, 'refreshed');
  assert.equal(r.job.candidates[0].currentResource, undefined);
  assert.equal(r.job.candidates[0].pass.phase, 'verify');
});

test('course verification retries a rejected page refresh once, then leaves the failure visible', async () => {
  const { c, id, job } = await prepared(80, {
    beforeReload: async () => { throw new Error('temporarily unavailable'); }
  });
  let r = await c.request(id, 'page', 'course-pass', {
    ...auth(job), phase: 'verify', pendingKeys: ['video']
  });
  r = await c.request(id, 'page', 'course-refresh', {
    ...auth(r.job), token: 'verify-first', attempt: 1
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.candidates[0].lastRefresh.failed, true);
  assert.equal(r.job.candidates[0].lastRefresh.attempt, 1);
  assert.deepEqual(c.reloads, []);

  r = await c.request(id, 'page', 'course-refresh', {
    ...auth(r.job), token: 'verify-second', attempt: 2
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.candidates[0].lastRefresh.failed, true);
  assert.equal(r.job.candidates[0].lastRefresh.attempt, 2);
  const third = await c.request(id, 'page', 'course-refresh', {
    ...auth(r.job), token: 'verify-third', attempt: 3
  });
  assert.equal(third.ok, false);
  assert.match(third.error, /刷新检查点/);
});

test('pause received while saving own refresh cancels reload and prevents stale-owner resume', async () => {
  const { c, id, job } = await prepared();
  let cancellation;
  const stored = c.storage.local;
  c.storage.local = new Proxy(stored, {
    set(target, key, value) {
      target[key] = value;
      if (key === KEY && value.candidates?.[0]?.refreshTokens?.includes('verify-course') && !cancellation) {
        cancellation = c.request(id, 'page', 'pause', auth(job));
      }
      return true;
    }
  });
  const r = await c.request(id, 'page', 'course-refresh', {
    ...auth(job), token: 'verify-course'
  });
  await cancellation;
  assert.equal(r.job.phase, 'paused');
  assert.equal(r.job.running, false);
  assert.deepEqual(c.reloads, []);
  assert.deepEqual(c.storage.local[KEY].candidates[0].refreshTokens || [], []);
  assert.equal(c.storage.local[KEY].candidates[0].lastRefresh, undefined);
  const stale = await c.request(id, 'page', 'course-pass', {
    ...auth(job), phase: 'retry', pendingKeys: ['video']
  });
  assert.equal(stale.error, 'TASK_CANCELLED');
  const paused = await c.request(id, 'page', 'get');
  const resumed = await c.request(id, 'page', 'start', {
    ...auth(paused.job), singlePass: true, targetPercent: 80
  });
  const retried = await c.request(id, 'page', 'course-refresh', {
    ...auth(resumed.job), token: 'verify-course'
  });
  assert.equal(retried.ok, true);
  assert.deepEqual(c.reloads, [id]);
});

test('pause during retry checkpoint does not consume its budget; Continue can reuse the token', async () => {
  const { c, id, job } = await prepared();
  let cancellation;
  const stored = c.storage.local;
  c.storage.local = new Proxy(stored, {
    set(target, key, value) {
      target[key] = value;
      if (key === KEY && value.candidates?.[0]?.records?.video?.finalAttempts === 1 && !cancellation) {
        cancellation = c.request(id, 'page', 'pause', auth(job));
      }
      return true;
    }
  });
  const first = await c.request(id, 'page', 'resource-retry', {
    ...auth(job), key: 'video', phase: 'final', token: 'final-1'
  });
  await cancellation;
  assert.equal(first.job.candidates[0].records.video.finalAttempts, undefined);
  assert.equal(c.storage.local[KEY].candidates[0].records.video.finalAttempts, undefined);
  const paused = await c.request(id, 'page', 'get');
  const resumed = await c.request(id, 'page', 'start', {
    ...auth(paused.job), singlePass: true, targetPercent: 80
  });
  const retried = await c.request(id, 'page', 'resource-retry', {
    ...auth(resumed.job), key: 'video', phase: 'final', token: 'final-1'
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.job.candidates[0].records.video.finalAttempts, 1);
});

test('single pass finishes with durable precise reminders but never marks failures completed', async () => {
  const { c, id, job } = await prepared();
  let r = await c.request(id, 'page', 'record', {
    ...auth(job), key: 'video', result: { deferred: true, error: 'unable to play' }
  });
  r = await c.request(id, 'page', 'record', {
    ...auth(r.job), key: 'audio', result: {
      title: 'audio', confirmed: true, completionSource: 'page-marker', ended: false
    }
  });
  r = await c.request(id, 'page', 'course-result', {
    ...auth(r.job), finalPass: true, result: {
      total: 2, remaining: 1, unconfirmed: ['video'], failures: ['video: unable to play']
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.phase, 'finished');
  const candidate = r.job.candidates[0];
  assert.equal(candidate.status, 'manual');
  assert.equal(candidate.finalPass, true);
  assert.equal(candidate.retryAt, undefined);
  assert.equal(candidate.records.video.confirmed, false);
  assert.equal(candidate.records.video.ended, false);
  assert.equal(candidate.records.video.error, 'unable to play');
  assert.ok(r.job.logs.some(entry => entry.type === 'err' && entry.text.includes('course')));
  assert.equal(c.storage.local[KEY].candidates[0].records.video.error, 'unable to play');
});

test('all-course finish requires every incomplete course to have a final pass', async () => {
  const c = coordinator();
  const id = c.addTab(HOME);
  let r = await c.request(id, 'home', 'start', { singlePass: true, targetPercent: 100, scope: 'all' });
  r = await c.request(id, 'home', 'scan-result', {
    ...auth(r.job), candidates: [
      { key: 'first', title: 'first', page: 1, status: 'uninspected', remaining: null, total: null },
      { key: 'second', title: 'second', page: 1, status: 'uninspected', remaining: null, total: null }
    ]
  });
  const incomplete = await c.request(id, 'home', 'finish', auth(r.job));
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.error, /尚未处理/);
  for (const area of [c.storage.local, c.storage.session]) {
    area[KEY].inspectIndex = 2;
    area[KEY].candidates = area[KEY].candidates.map(candidate => ({
      ...candidate, status: 'manual', finalPass: true, remaining: 1
    }));
  }
  r = await c.request(id, 'home', 'finish', auth(r.job));
  assert.equal(r.ok, true);
  assert.equal(r.job.phase, 'finished');
  assert.equal(r.job.candidates.every(candidate => candidate.status === 'manual'), true);
});

test('explicit continue upgrades the old mode without erasing retry checkpoints', async () => {
  const { c, id, job } = await prepared();
  let r = await c.request(id, 'page', 'resource-retry', {
    ...auth(job), key: 'video', phase: 'final', token: 'f1'
  });
  r = await c.request(id, 'page', 'pause', auth(r.job));
  for (const area of [c.storage.local, c.storage.session]) delete area[KEY].singlePass;
  r = await c.request(id, 'page', 'start', {
    ...auth(r.job), singlePass: true, targetPercent: 90
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.singlePass, true);
  assert.equal(r.job.targetPercent, 90);
  assert.equal(r.job.candidates[0].records.video.finalAttempts, 1);
  assert.equal(r.job.candidates[0].records.video.effectiveTarget, 100);
});

test('target and directory identity validation reject unsupported checkpoint data', async () => {
  const { c, id, job } = await prepared();
  for (const result of [
    { effectiveTarget: 79 }, { effectiveTarget: 101 }, { sitePercent: 120 }, { targetReached: 'yes' }
  ]) {
    const r = await c.request(id, 'page', 'record', { ...auth(job), key: 'video', result });
    assert.equal(r.ok, false);
  }
  const unknown = await c.request(id, 'page', 'record', {
    ...auth(job), key: 'unknown-video', result: { confirmed: true }
  });
  assert.equal(unknown.ok, false);
  const badRetry = await c.request(id, 'page', 'resource-retry', {
    ...auth(job), key: 'unknown-video', phase: 'final', token: 'unknown'
  });
  assert.equal(badRetry.ok, false);
  const unspentRefresh = await c.request(id, 'page', 'course-refresh', {
    ...auth(job), key: 'video', token: 'not-spent'
  });
  assert.equal(unspentRefresh.ok, false);
  assert.deepEqual(c.reloads, []);
});
