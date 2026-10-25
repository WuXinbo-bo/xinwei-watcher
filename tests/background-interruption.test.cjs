const assert = require('node:assert/strict');
const test = require('node:test');
const { coordinator } = require('./coordinator.cjs');

const COURSE = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course/video/resource?classId=class';
const PROJECT = 'https://www.beeline-ai.com/student/#/courseInfo/course/project/class';
const routeKey = url => { const value = new URL(url); return value.pathname + value.hash; };
const auth = job => ({ runId: job.runId, generation: job.generation, resetEpoch: job.resetEpoch });

async function navigateRecovery() {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const request = async (instance, action, data = {}, documentUrl) => {
    const result = await c.request(id, instance, action, data, documentUrl);
    assert.equal(result.ok, true, result.error);
    return result.job;
  };
  let job = await request('owner', 'start', { title: '课程' });
  job = await request('owner', 'directory-checkpoint', { ...auth(job), snapshot: {
    version: 1, items: [{ key: 'video', title: '原视频', mediaType: 'video', durationSeconds: 60 }]
  } });
  job = await request('owner', 'resource-checkpoint', {
    ...auth(job), key: 'video', title: '原视频', stage: 'ready', routeKey: routeKey(COURSE)
  });
  c.tabs.get(id).url = PROJECT;
  job = await request('owner', 'interruption-attempt', {
    ...auth(job), key: 'video', navigate: true, reason: '误触项目页'
  });
  assert.equal(c.tabs.get(id).url, COURSE);
  assert.equal(job.ownerInstance, null);
  assert.equal(job.interruption.status, 'navigating');
  return { c, id, job, request };
}

test('浏览器先显示目标地址时，旧文档未对齐资源不能抢先接回恢复任务', async () => {
  const { request } = await navigateRecovery();
  for (const observed of [
    {},
    { documentRouteKey: routeKey(PROJECT), activeResourceKey: 'video' },
    { documentRouteKey: routeKey(COURSE), activeResourceKey: 'other-video' }
  ]) {
    const waiting = await request('owner', 'hello', { title: '课程', ...observed }, PROJECT);
    assert.equal(waiting.running, true);
    assert.equal(waiting.ownerInstance, null);
    assert.equal(waiting.interruption.status, 'navigating');
    assert.equal(waiting.interruption.attempts, 1);
  }
  const arrived = await request('owner', 'hello', {
    title: '课程', documentRouteKey: routeKey(COURSE), activeResourceKey: 'video'
  }, PROJECT);
  assert.equal(arrived.ownerInstance, 'owner');
  assert.equal(arrived.interruption.status, 'attempting');
  assert.equal(arrived.interruption.attempts, 1);
});

test('导航后的新文档仍可正常接管，旧文档随后消息不能夺回任务', async () => {
  const { request } = await navigateRecovery();
  const arrived = await request('replacement', 'hello', { title: '课程' });
  assert.equal(arrived.ownerInstance, 'replacement');
  assert.equal(arrived.interruption.status, 'attempting');
  const stale = await request('owner', 'hello', {
    title: '课程', documentRouteKey: routeKey(COURSE), activeResourceKey: 'video'
  }, PROJECT);
  assert.equal(stale.ownerInstance, 'replacement');
  assert.equal(stale.interruption.attempts, 1);
});

test('导航接回后再次失败必须消耗下一次预算，不能反复升级同一次恢复', async () => {
  const { c, id, request } = await navigateRecovery();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const owner = `replacement-${attempt}`;
    const arrived = await request(owner, 'hello', { title: '课程' });
    assert.equal(arrived.interruption.attempts, attempt);
    assert.equal(arrived.interruption.navigationAttempt, attempt);
    c.tabs.get(id).url = PROJECT;
    const retried = await request(owner, 'interruption-attempt', {
      ...auth(arrived), key: 'video', episodeId: arrived.interruption.id,
      navigate: true, reason: '导航回来后资源仍不符'
    });
    if (attempt < 3) {
      assert.equal(retried.running, true);
      assert.equal(retried.interruption.attempts, attempt + 1);
    } else {
      assert.equal(retried.running, false);
      assert.equal(retried.phase, 'manual');
      assert.equal(retried.interruption.attempts, 3);
      assert.equal(c.navigation.filter(entry => entry.url).length, 3);
    }
  }
});
