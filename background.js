/* Only coordinates extension tasks and tabs. It never calls learning APIs.
 * Updated 2026-10-13: confirmed full reset and fresh homepage collection. */
(() => {
  'use strict';
  const CHANNEL = 'xinwei-job';
  const KEY = 'xinwei-job-v3';
  const OBS_KEY = 'xinwei-media-observation-v1';
  const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
  const AGENT = 'https://www.beeline-ai.com/stu/agent';
  let queue = Promise.resolve();
  let emergencyJob = null;
  let lastKnownJob = null;
  let cancellationFence = null;
  let pendingCancellations = [];
  const resetEpoch = job => Number.isSafeInteger(job?.resetEpoch) && job.resetEpoch >= 0 ? job.resetEpoch : 0;

  const serial = task => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };
  const copy = value => JSON.parse(JSON.stringify(value));
  const addLog = (job, text, type = 'info', metadata = {}) => {
    const time = Number.isFinite(metadata.time) ? metadata.time : Date.now();
    const sequence = (Number.isSafeInteger(job.logSequence) ? job.logSequence : 0) + 1;
    job.logSequence = sequence;
    const id = typeof metadata.id === 'string' && metadata.id
      ? metadata.id : `background:${time}:${sequence}`;
    job.logs = [...(job.logs || []), { time, text, type, id }].slice(-300);
  };
  const taskTabIds = job => [job.homeTabId, job.workerTabId, job.returningTabId].filter(Number.isInteger);
  const INSPECTION_OPEN_RETRY_LIMIT = 2;
  const INSPECTION_OPEN_RETRY_DELAY = 30000;
  const isStartCancellation = (job, msg, tabId) => msg.action === 'pause' &&
    !isRetiredInstance(job, tabId, msg.instanceId) &&
    job.startRequest?.tabId === tabId && job.startRequest.instanceId === msg.instanceId &&
    job.startRequest.runId === (msg.runId || null) &&
    job.startRequest.generation === (msg.generation ?? null) && resetEpoch(job) === resetEpoch(msg);
  const pendingStop = job => pendingCancellations.find(({ msg, tabId, pageBlocked }) =>
    pageBlocked ? (job.ownerTabId === tabId && resetEpoch(msg) === resetEpoch(job) &&
      (!msg.runId || msg.runId === job.runId) && !isRetiredInstance(job, tabId, msg.instanceId)) :
    (msg.action === 'reset' && msg.resetEpoch === resetEpoch(job)) ||
    isStartCancellation(job, msg, tabId) ||
    (taskTabIds(job).includes(tabId) && msg.runId === job.runId &&
      (msg.action === 'pause' || msg.generation === job.generation)));
  const canOperate = job => {
    if (!job?.running || (cancellationFence?.runId === job.runId &&
      cancellationFence.generation === job.generation)) return false;
    return !pendingStop(job);
  };
  const uniqueTexts = values => [...new Set(values.filter(value => typeof value === 'string' && value))];
  const outstandingRecords = (candidate, singlePass = false) => Object.values(candidate.records || {}).filter(record =>
    singlePass ? record.confirmed !== true && Boolean(record.started || record.attempted ||
      record.targetReached || record.deferred || record.ended || record.error || record.progressGap) :
      ((record.started || record.attempted) && !record.ended) ||
      (record.ended && !record.confirmed) || (record.error && !record.ended) || record.progressGap);
  const validTargetPercent = value => Number.isInteger(value) && value >= 80 && value <= 100;
  const isRetiredInstance = (job, tabId, instanceId) => (job.retiredInstances || []).some(entry =>
    entry.tabId === tabId && entry.instanceId === instanceId);

  function retireInstance(job, tabId, instanceId) {
    if (!Number.isInteger(tabId) || typeof instanceId !== 'string' || !instanceId ||
      isRetiredInstance(job, tabId, instanceId)) return;
    job.retiredInstances = [...(job.retiredInstances || []), { tabId, instanceId }];
  }

  function bindHomeInstance(job, instanceId) {
    if (instanceId && job.homeInstance && job.homeInstance !== instanceId) {
      retireInstance(job, job.homeTabId, job.homeInstance);
    }
    job.homeInstance = instanceId;
  }

  function bindOwnerInstance(job, tabId, instanceId) {
    if (instanceId) {
      if (job.ownerTabId === tabId && job.ownerInstance && job.ownerInstance !== instanceId) {
        retireInstance(job, tabId, job.ownerInstance);
      }
      if (job.ownerHandoff?.tabId === tabId && job.ownerHandoff.instanceId !== instanceId) {
        retireInstance(job, tabId, job.ownerHandoff.instanceId);
      }
      delete job.ownerHandoff;
    } else if (job.ownerTabId === tabId && job.ownerInstance) {
      // Retire the departing document only when its replacement has actually arrived.
      // Before navigation, the existing page must still be able to pause and continue.
      job.ownerHandoff = { tabId, instanceId: job.ownerInstance };
    } else if (job.ownerTabId !== tabId) delete job.ownerHandoff;
    job.ownerTabId = tabId;
    job.ownerInstance = instanceId;
  }

  function validateDirectorySnapshot(raw, key) {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.items) ||
      (raw.courseKey != null && raw.courseKey !== key) ||
      (raw.signature != null && typeof raw.signature !== 'string')) {
      throw new Error('课程目录检查点无法确认');
    }
    const keys = new Set();
    const items = raw.items.map(item => {
      if (!item || typeof item.key !== 'string' || !item.key.trim() ||
        typeof item.title !== 'string' || !item.title.trim() ||
        !['video', 'audio', 'media', 'document', 'other'].includes(item.mediaType) ||
        !(item.durationSeconds === null ||
          (typeof item.durationSeconds === 'number' && Number.isFinite(item.durationSeconds) &&
            item.durationSeconds >= 0)) || keys.has(item.key)) {
        throw new Error('课程目录条目无法确认');
      }
      keys.add(item.key);
      return { key: item.key, title: item.title, mediaType: item.mediaType,
        durationSeconds: item.durationSeconds,
        ...(typeof item.chapterTitle === 'string' ? { chapterTitle: item.chapterTitle.slice(0, 160) } : {}),
        ...(typeof item.observedCompleted === 'boolean' ? { observedCompleted: item.observedCompleted } : {}) };
    });
    const snapshot = { version: 1, courseKey: key, items };
    if (raw.signature != null) snapshot.signature = raw.signature;
    return snapshot;
  }

  async function takeOverRefreshedOwner(job, msg, sender) {
    const previousGeneration = job.generation;
    if (!canOperate(job)) return job;
    // User refreshes require explicit Continue; the executor's own bounded
    // verification reload is the only continuation authorized in advance.
    const expected = job.expectedRefresh;
    const authorizedRefresh = expected && expected.tabId === sender.tab.id &&
      expected.courseKey === courseKey(sender) && expected.generation === job.generation &&
      expected.expiresAt >= Date.now();
    if (job.workflow === 'manual' && !authorizedRefresh) {
      bindOwnerInstance(job, sender.tab.id, msg.instanceId);
      if (route(sender) === 'home') bindHomeInstance(job, msg.instanceId);
      return save(pause(job, '页面已刷新，记录已保留；请点击继续或重新扫描本课。'));
    }
    delete job.expectedRefresh;
    bindOwnerInstance(job, sender.tab.id, msg.instanceId);
    if (['agent', 'home'].includes(route(sender))) bindHomeInstance(job, msg.instanceId);
    job.generation += 1;
    addLog(job, '页面刷新后已接回原任务；保留课程统计和断点，正在核对当前页面');
    return saveOwnerHandoff(job, previousGeneration);
  }

  async function saveOwnerHandoff(job, previousGeneration) {
    await save(job);
    // A cancellation can arrive while this new generation is being saved/broadcast.
    // Check both generations so an already requested pause cannot be skipped by takeover.
    if (!canOperate(job) || !canOperate({ ...job, generation: previousGeneration })) {
      const cancellation = pendingStop(job) || pendingStop({ ...job, generation: previousGeneration });
      return save(pauseForCancellation(job, cancellation));
    }
    return job;
  }

  function retryRecords(records) {
    return Object.fromEntries(Object.entries(records || {}).map(([key, record]) => {
      const next = copy(record);
      if (!next.ended) {
        // Older versions saved failed attempts without a started/attempted marker.
        if (next.error) next.attempted = true;
        delete next.error;
      }
      return [key, next];
    }));
  }

  function recoveryRecords(job) {
    const result = copy(job?.recoveryRecords || {});
    for (const candidate of job?.candidates || []) {
      if (!candidate.courseKey) continue;
      const records = Object.fromEntries(Object.entries(candidate.records || {}).filter(([, record]) =>
        ((record.started || record.attempted) && !record.ended) ||
        (record.ended && !record.confirmed) || (record.error && !record.ended)));
      if (Object.keys(records).length) result[candidate.courseKey] = records;
      else delete result[candidate.courseKey];
    }
    return result;
  }

  function resetAttempt(candidate) {
    candidate.records = retryRecords(candidate.records);
    candidate.failures = [];
    candidate.unconfirmed = [];
    candidate.unfinished = [];
  }

  const recoveryRound = candidate => Number.isSafeInteger(candidate.retryRounds) && candidate.retryRounds >= 0
    ? candidate.retryRounds : 0;
  const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;

  function recordRecovery(candidate, previous, incoming) {
    const round = recoveryRound(candidate);
    const saved = previous?.round === round ? previous : {};
    const proposed = incoming && typeof incoming === 'object' && !Array.isArray(incoming) &&
      (incoming.round == null || incoming.round === round) ? incoming : {};
    return {
      ...saved, ...proposed,
      attempts: Math.max(nonnegativeInteger(saved.attempts) ? saved.attempts : 0,
        nonnegativeInteger(proposed.attempts) ? proposed.attempts : 0),
      // Only reload-course spends this budget. A stale content record cannot
      // reset it, and a content-provided round cannot create a fresh budget.
      reloads: nonnegativeInteger(saved.reloads) ? saved.reloads : 0,
      // Only the background's actual reload result may set this marker.
      // It survives stale content records, but a new retry round clears it.
      reloadFailed: saved.reloadFailed === true,
      nextRetryAt: Number.isFinite(proposed.nextRetryAt) && proposed.nextRetryAt >= 0
        ? proposed.nextRetryAt : Number.isFinite(saved.nextRetryAt) ? saved.nextRetryAt : 0,
      lastReason: String(proposed.lastReason ?? saved.lastReason ?? '').slice(0, 400),
      round
    };
  }

  function prepareRetry(candidate) {
    resetAttempt(candidate);
    for (const record of Object.values(candidate.records || {})) {
      if (!record.ended) record.recovery = recordRecovery(candidate, null, null);
    }
    candidate.status = 'inspected';
    delete candidate.retryAt;
  }

  function scheduleCourseRetry(candidate) {
    candidate.status = 'retry';
    candidate.retryRounds = recoveryRound(candidate) + 1;
    candidate.retryAt = Date.now() + Math.min(300000, 30000 * 2 ** Math.min(candidate.retryRounds - 1, 4));
  }

  function preserveStopGap(job, msg, tabId) {
    const evidence = msg.gapEvidence;
    const candidate = job.candidates?.[job.targetIndex];
    const resource = candidate?.currentResource;
    if (!evidence || !candidate || !resource || job.runId !== msg.runId ||
      resetEpoch(job) !== resetEpoch(msg) || tabId !== job.ownerTabId ||
      msg.instanceId !== job.ownerInstance || evidence.key !== resource.key ||
      (evidence.courseKey != null && evidence.courseKey !== candidate.courseKey) ||
      (evidence.round != null && evidence.round !== recoveryRound(candidate)) ||
      !Number.isFinite(evidence.from) || !Number.isFinite(evidence.to) ||
      evidence.from < 0 || evidence.to <= evidence.from) return;
    const record = candidate.records?.[resource.key];
    if (!record) return;
    const prior = record.progressGap;
    record.progressGap = {
      from: Number.isFinite(prior?.from) ? Math.min(prior.from, evidence.from) : evidence.from,
      to: Number.isFinite(prior?.to) ? Math.max(prior.to, evidence.to) : evidence.to
    };
    // Stopping may conservatively add an unwatched range; it never supplies
    // playback authority or a successful completion assertion.
    record.ended = false;
  }

  function pauseForCancellation(job, cancellation) {
    if (cancellation) preserveStopGap(job, cancellation.msg, cancellation.tabId);
    return pause(job, cancellation?.msg.action === 'reset' ? '正在重置插件'
      : cancellation?.msg.reason || '', cancellation?.msg.action === 'manual');
  }

  function fenceCancellation(msg, sender) {
    if (!isSite(sender)) return null;
    const blocked = pageBlockingReason(msg);
    if (blocked) {
      // A freshly reported verification/login prompt must cancel an already
      // persisted navigation before its queued message handler gets a turn.
      const pending = { pageBlocked: true, tabId: sender.tab.id,
        msg: { action: 'manual', runId: msg.runId, generation: msg.generation,
          instanceId: msg.instanceId, resetEpoch: resetEpoch(msg), reason: blocked } };
      pendingCancellations.push(pending);
      return pending;
    }
    if (!['pause', 'manual', 'reset'].includes(msg.action)) return null;
    if (msg.action === 'reset') {
      const pending = { msg: { action: 'reset', resetEpoch: resetEpoch(msg) }, tabId: sender.tab.id };
      pendingCancellations.push(pending);
      if (lastKnownJob && resetEpoch(lastKnownJob) === resetEpoch(msg)) {
        cancellationFence = { runId: lastKnownJob.runId, generation: lastKnownJob.generation };
      }
      return pending;
    }
    // A newly restarted service worker may still be reading its first checkpoint.
    // Validate such messages against the loaded job before allowing browser actions.
    const pending = msg.runId || msg.action === 'pause' ? {
      msg: { action: msg.action, runId: msg.runId, generation: msg.generation,
        instanceId: msg.instanceId, resetEpoch: resetEpoch(msg),
        reason: String(msg.reason || ''), gapEvidence: msg.gapEvidence }, tabId: sender.tab.id
    } : null;
    if (pending) pendingCancellations.push(pending);
    const job = lastKnownJob;
    if (!job?.running ||
      resetEpoch(job) !== resetEpoch(msg) ||
      !taskTabIds(job).includes(sender.tab.id) ||
      (msg.runId && msg.runId !== job.runId && !isStartCancellation(job, msg, sender.tab.id)) ||
      (msg.action === 'manual' && msg.generation !== job.generation)) return pending;
    // A pause message must cancel browser actions before its serialized handler runs.
    cancellationFence = { runId: job.runId, generation: job.generation };
    return pending;
  }

  async function read() {
    if (emergencyJob) return copy(emergencyJob);
    let session, saved, observation;
    try {
      [session, saved, observation] = await Promise.all([
        chrome.storage.session.get(KEY).then(value => value[KEY]),
        chrome.storage.local.get(KEY).then(value => value[KEY]),
        chrome.storage.session.get(OBS_KEY).then(value => value[OBS_KEY])
      ]);
      // A reset written to disk must beat an older live checkpoint even if
      // the session write failed before the service worker was restarted.
      if (session && resetEpoch(session) >= resetEpoch(saved)) {
        mergeObservation(session, observation);
        lastKnownJob = copy(session);
        return session;
      }
    } catch {
      if (lastKnownJob) {
        if (['idle', 'resetting'].includes(lastKnownJob.phase)) {
          emergencyJob = { ...copy(lastKnownJob), running: false, phase: 'resetting',
            reason: '无法核对重置状态，已保持停止；请重试重置。' };
        } else {
          emergencyJob = pause(copy(lastKnownJob), '无法读取任务状态，已停止。请检查扩展后重新开始。', true);
        }
        await broadcast(emergencyJob);
      }
      throw new Error('无法读取任务状态，已停止。请检查扩展后重新开始。');
    }
    if (!saved) return null;
    mergeObservation(saved, observation);
    // Disk checkpoints never authorize an automatic browser restart.
    saved.running = false;
    if (!['finished', 'idle', 'resetting', 'selection'].includes(saved.phase)) {
      saved.phase = 'interrupted';
      saved.reason = '浏览器或扩展已重启。请回到首页点击开始，重新核对课程。';
    }
    lastKnownJob = copy(saved);
    return saved;
  }

  function mergeObservation(job, observation) {
    const candidate = job?.candidates?.[job.targetIndex];
    const resource = candidate?.currentResource;
    const sample = observation?.sample;
    if (observation?.runId !== job?.runId || observation?.courseKey !== candidate?.courseKey ||
      observation?.key !== resource?.key || observation?.routeKey !== resource?.routeKey ||
      !sample || !Number.isFinite(sample.position) || !Number.isFinite(sample.time) ||
      sample.position < 0) return;
    if (!resource.positionSample || sample.time > resource.positionSample.time) {
      resource.positionSample = copy(sample);
    }
  }

  async function broadcast(job) {
    const ids = new Set([...taskTabIds(job), ...(job.resetHoldTabIds || [])]);
    await Promise.all([...ids].map(id =>
      chrome.tabs.sendMessage(id, { channel: CHANNEL, job, tabId: id }).catch(() => {})));
  }

  async function save(job) {
    job.revision = (job.revision || 0) + 1;
    job.updatedAt = Date.now();
    try {
      const checkpoint = copy(job);
      checkpoint.running = false;
      if (['idle', 'resetting'].includes(job.phase)) {
        const writes = await Promise.allSettled([
          chrome.storage.local.set({ [KEY]: checkpoint }),
          chrome.storage.session.set({ [KEY]: job, [OBS_KEY]: null })
        ]);
        if (writes.some(result => result.status === 'rejected')) throw new Error('reset storage failed');
      } else {
        await chrome.storage.local.set({ [KEY]: checkpoint });
        await chrome.storage.session.set({ [KEY]: job });
      }
      emergencyJob = null;
      lastKnownJob = copy(job);
    } catch {
      const resetting = ['idle', 'resetting'].includes(job.phase);
      job.running = false;
      job.resumePhase = job.phase;
      job.phase = resetting ? 'resetting' : 'manual';
      job.generation += 1;
      job.reason = resetting ? '重置未能完整保存，已保持停止；请重试重置。'
        : '任务状态无法保存，已停止。请检查扩展后重新开始。';
      emergencyJob = copy(job);
      await broadcast(job);
      throw new Error(job.reason);
    }
    // A pause can arrive while Start's new job is being persisted, before
    // its new runId is known by the initiating page. Cancel before broadcast
    // or navigation can authorize another document to execute.
    const cancellation = job.running && pendingStop(job);
    if (cancellation) {
      return save(pauseForCancellation(job, cancellation));
    }
    await broadcast(job);
    return job;
  }

  async function saveLog(job) {
    const prior = copy(lastKnownJob || job);
    job.revision = (job.revision || 0) + 1;
    job.updatedAt = Date.now();
    try {
      // Diagnostic text must not turn a working media task into a permanent
      // stop. Critical checkpoints still use save() and require both stores.
      await chrome.storage.session.set({ [KEY]: job });
    } catch {
      return prior;
    }
    lastKnownJob = copy(job);
    const cancellation = pendingStop(job);
    if (cancellation) return save(pauseForCancellation(job, cancellation));
    await broadcast(job);
    return job;
  }

  async function saveObservation(job, candidate, resource, observed) {
    // Position samples are advisory continuity evidence.  They arrive every
    // few seconds during natural playback, so keep them in a small session
    // record instead of rewriting the full task checkpoint on every sample.
    // A failure to write this hint never authorizes progress; the next
    // interruption is handled conservatively from the last durable record.
    const observation = {
      runId: job.runId,
      courseKey: candidate.courseKey,
      key: resource.key,
      routeKey: resource.routeKey,
      sample: copy(observed)
    };
    try {
      await chrome.storage.session.set({ [OBS_KEY]: observation });
    } catch {
      // Keep the in-memory sample for the current document.  Do not turn a
      // transient diagnostic storage failure into a false task stop.
    }
    resource.positionSample = copy(observed);
    lastKnownJob = copy(job);
    return job;
  }

  function pause(job, reason = '', manual = false) {
    if (job.running) job.resumePhase = job.phase;
    job.running = false;
    job.phase = manual ? 'manual' : 'paused';
    delete job.expectedRefresh;
    job.generation += 1;
    job.reason = reason;
    if (job.workflow === 'manual' && job.operation === 'inspect') {
      const candidate = job.candidates?.[job.targetIndex ?? job.selectedIndex];
      if (candidate) { candidate.scanState = manual ? 'error' : 'paused'; candidate.scanError = reason || '扫描已暂停'; }
    }
    addLog(job, reason || '已暂停：停止播放和后续自动操作', manual ? 'err' : 'info');
    return job;
  }

  function isSite(sender) {
    if (!sender.tab || sender.frameId !== 0) return false;
    try { return new URL(sender.url).origin === 'https://www.beeline-ai.com'; } catch { return false; }
  }

  function route(sender) {
    const url = new URL(sender.url);
    if (url.pathname === '/stu/agent') return 'agent';
    if (url.pathname === '/myBank/courseResearch') return 'home';
    if (url.hash.includes('/courseInfo/learn/courseWare/')) return 'learn';
    return 'other';
  }

  function courseKey(sender) {
    const hash = new URL(sender.url).hash;
    const id = hash.match(/\/courseWare\/([^/?]+)/)?.[1];
    const classId = new URLSearchParams(hash.split('?')[1] || '').get('classId');
    return id && classId ? `${id}::${classId}` : '';
  }

  function normalizeRouteForComparison(routeKey) {
    const queryAt = routeKey.indexOf('?');
    if (queryAt < 0) return routeKey;
    const parameters = routeKey.slice(queryAt + 1).split('&')
      .map((raw, index) => ({ raw, index, key: raw.split('=')[0] }));
    if (parameters.some(({ key }) => /[%+]/.test(key))) return routeKey;
    parameters.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index);
    // Keep paths, raw values and repeated-key order; only compare independent-key order.
    return `${routeKey.slice(0, queryAt + 1)}${parameters.map(item => item.raw).join('&')}`;
  }

  const routeEquals = (first, second) =>
    normalizeRouteForComparison(first) === normalizeRouteForComparison(second);

  function sameResourceUrl(actual, expected) {
    try {
      const current = new URL(actual), target = new URL(expected);
      return !current.username && !current.password && current.origin === target.origin &&
        current.search === target.search &&
        routeEquals(`${current.pathname}${current.hash}`, `${target.pathname}${target.hash}`);
    } catch { return false; }
  }

  function pageBlockingReason(msg) {
    if (msg.pageBlocked === true) return '当前页面有登录、验证或平台限制，需要人工处理';
    return typeof msg.pageBlocked === 'string' ? msg.pageBlocked.trim().slice(0, 400) : '';
  }

  function recoverableTaskPage(tab) {
    try {
      const url = new URL(tab.url);
      if (url.origin !== 'https://www.beeline-ai.com' || url.username || url.password) return false;
      const page = route({ url: url.href });
      return ['agent', 'home'].includes(page) ||
        (url.pathname.startsWith('/student/') && /^#\/courseInfo\//.test(url.hash));
    } catch { return false; }
  }

  function interruptionStop(job, reason) {
    if (job.interruption) {
      job.interruption.status = 'failed';
      delete job.interruption.deadline;
    }
    return pause(job, reason || '连续三次恢复仍未成功，已停止任务并保留断点，请检查页面后继续。', true);
  }

  async function attemptInterruption(job, msg, sender, currentTab) {
    if (!canOperate(job)) return job;
    if (msg.reload === true && msg.navigate !== true) {
      throw new Error('恢复刷新必须先核对原音视频入口');
    }
    const candidate = job.candidates?.[job.targetIndex];
    if (job.phase !== 'course' || job.targetPurpose !== 'play' || !candidate?.courseKey) {
      throw new Error('当前课程恢复目标无法确认');
    }
    const blocked = pageBlockingReason(msg);
    if (blocked) return save(interruptionStop(job, blocked));
    const tabId = job.ownerTabId;
    currentTab ||= await chrome.tabs.get(tabId);
    if (!canOperate(job)) return job;
    if (!recoverableTaskPage(currentTab) ||
      (currentTab.pendingUrl && !recoverableTaskPage({ url: currentTab.pendingUrl }))) {
      return save(interruptionStop(job, '当前页面不在已确认的课程入口范围，已保留断点；请检查登录或平台提示。'));
    }
    const resource = candidate.currentResource;
    let destination;
    if (msg.navigate === true) {
      try { destination = verifiedResourceUrl(candidate); }
      catch (error) { return save(interruptionStop(job, error.message)); }
      if (msg.reload === true && (resource?.stage !== 'ready' || !resource.routeKey ||
        !sameResourceUrl(currentTab.url, destination) ||
        (currentTab.pendingUrl && !sameResourceUrl(currentTab.pendingUrl, destination)))) {
        throw new Error('当前页面尚未回到已保存的精确音视频入口，不能刷新恢复');
      }
    }
    let episode = job.interruption;
    if (episode && (episode.courseKey !== candidate.courseKey ||
      (msg.episodeId && msg.episodeId !== episode.id))) throw new Error('TASK_CANCELLED');
    if (!episode && msg.episodeId) throw new Error('TASK_CANCELLED');
    if (msg.key && (episode?.key || resource?.key) && msg.key !== (episode?.key || resource?.key)) {
      throw new Error('保存的恢复资源与当前任务不符');
    }
    if (msg.key && !episode?.key && !resource?.key &&
      !candidate.directory?.items?.some(item => item.key === msg.key &&
        ['video', 'audio', 'media'].includes(item.mediaType))) {
      throw new Error('恢复目标不在已保存的课程目录中');
    }
    if (episode?.status === 'navigating' && episode.deadline > Date.now()) return job;
    if (episode?.status === 'attempting' && msg.navigate !== true) return job;
    if (!episode) {
      episode = job.interruption = {
        id: crypto.randomUUID(), courseKey: candidate.courseKey,
        key: resource?.key || msg.key || '', title: resource?.title || candidate.title,
        attempts: 0, status: 'failed', startedAt: Date.now(),
        ...(resource?.positionSample ? { positionSample: copy(resource.positionSample) } : {})
      };
    }
    if (!episode.key && msg.key) {
      const known = candidate.directory?.items?.find(item => item.key === msg.key &&
        ['video', 'audio', 'media'].includes(item.mediaType));
      if (!known) throw new Error('恢复目标不在已保存的课程目录中');
      episode.key = msg.key;
      episode.title = known.title;
    }
    if (msg.positionSample && resource?.stage === 'ready' && resource.routeKey &&
      !episode.gapDetected) {
      try {
        const sample = validateMediaObservation({
          ...msg.positionSample, key: resource.key, routeKey: resource.routeKey
        }, resource);
        if (!episode.positionSample || sample.time >= episode.positionSample.time) {
          episode.positionSample = sample;
        }
      } catch {
        // An out-of-date page sample grants no continuity credit. Keep the
        // most recent owned checkpoint, or start from the conservative origin.
      }
    }
    // Moving from a local playback retry to the saved learning entry is part
    // of the same attempt. Only a reported failure (or a navigation timeout)
    // spends the next attempt.
    const escalatingAttempt = episode.status === 'attempting' && msg.navigate === true &&
      episode.navigationAttempt !== episode.attempts;
    if (!escalatingAttempt) {
      if (episode.attempts >= 3) return save(interruptionStop(job));
      episode.attempts += 1;
    }
    episode.status = msg.navigate === true ? 'navigating' : 'attempting';
    if (msg.navigate === true) {
      episode.navigationAttempt = episode.attempts;
      episode.requiresContinuityCheck = true;
      episode.continuityChecked = false;
      episode.navigationMode = msg.reload === true ? 'reload' : 'navigate';
      episode.requireNewDocument = msg.reload === true;
    }
    episode.reason = String(msg.reason || episode.reason || '播放暂时中断').slice(0, 400);
    if (msg.navigate === true && !episode.positionSample && resource?.positionSample) {
      episode.positionSample = copy(resource.positionSample);
    }
    addLog(job, `正在恢复（${episode.attempts}/3）：${episode.reason}`, 'warn');
    if (!msg.navigate) {
      delete episode.deadline;
      return save(job);
    }
    episode.deadline = Date.now() + 15000;
    episode.departureInstance = job.ownerInstance || job.ownerHandoff?.instanceId || null;
    const previousGeneration = job.generation;
    bindOwnerInstance(job, tabId, null);
    job.generation += 1;
    await saveOwnerHandoff(job, previousGeneration);
    if (!canOperate(job)) return job;
    // The saved checkpoint authorizes one normal document navigation. A pause,
    // redirect or verification page discovered during persistence cancels it.
    let latest;
    try { latest = await chrome.tabs.get(tabId); }
    catch { return save(interruptionStop(job, '任务页面已关闭，已保留断点；请重新打开网站。')); }
    if (!canOperate(job)) return job;
    if (!recoverableTaskPage(latest) ||
      (latest.pendingUrl && !recoverableTaskPage({ url: latest.pendingUrl }))) {
      return save(interruptionStop(job, '课程页面出现未确认跳转，已保留断点；请检查登录或平台提示。'));
    }
    if (latest.url !== currentTab.url) return job;
    if (msg.reload === true && (!sameResourceUrl(latest.url, destination) ||
      (latest.pendingUrl && !sameResourceUrl(latest.pendingUrl, destination)))) return job;
    try {
      if (msg.reload === true) await chrome.tabs.reload(tabId);
      else await chrome.tabs.update(tabId, { url: destination });
    }
    catch {
      // Keep the spent attempt and deadline across refresh/service-worker restart.
      // The next observed timeout retries this same verified entry, up to three.
    }
    return job;
  }

  function verifiedLearnUrl(candidate) {
    try {
      const url = new URL(candidate.learnUrl);
      const page = { url: url.href };
      if (url.origin === 'https://www.beeline-ai.com' && !url.username && !url.password &&
        url.pathname.startsWith('/student/') && route(page) === 'learn' &&
        candidate.courseKey && courseKey(page) === candidate.courseKey) return url.href;
    } catch {}
    throw new Error('课程入口尚未核对，请回到首页重新统计课程');
  }

  function verifiedResourceUrl(candidate) {
    const entry = verifiedLearnUrl(candidate);
    const routeKey = candidate.currentResource?.routeKey;
    if (!routeKey) return entry;
    try {
      const url = new URL(routeKey, entry);
      const page = { url: url.href };
      if (url.origin === 'https://www.beeline-ai.com' && !url.username && !url.password &&
        url.pathname.startsWith('/student/') && route(page) === 'learn' &&
        courseKey(page) === candidate.courseKey &&
        routeEquals(`${url.pathname}${url.hash}`, routeKey)) return url.href;
    } catch {}
    throw new Error('原音视频入口与已保存的课程不符，已保留断点');
  }

  function validateMediaObservation(raw, resource) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      typeof raw.key !== 'string' || raw.key !== resource?.key ||
      typeof raw.routeKey !== 'string' || !resource?.routeKey ||
      !routeEquals(raw.routeKey, resource.routeKey) ||
      !Number.isFinite(raw.position) || raw.position < 0 ||
      !Number.isFinite(raw.time)) throw new Error('播放位置观察无法确认');
    const now = Date.now();
    // A sample is useful only while the owned document is still live. It is
    // never allowed to be backdated to manufacture time watched during a
    // navigation or a suspended browser.
    if (raw.time < now - 60000 || raw.time > now + 2000) {
      throw new Error('播放位置观察已过期');
    }
    const allowance = raw.allowance == null ? 2 : Number(raw.allowance);
    if (!Number.isFinite(allowance) || allowance < 0 || allowance > 5) {
      throw new Error('播放位置观察范围无法确认');
    }
    return { position: Number(raw.position), time: Number(raw.time),
      allowance: Number(allowance), key: raw.key, routeKey: raw.routeKey };
  }

  function requireOwner(job, msg, sender, phases) {
    if (!canOperate(job) || msg.runId !== job.runId ||
      msg.generation !== job.generation || sender.tab.id !== job.ownerTabId ||
      msg.instanceId !== job.ownerInstance || !phases.includes(job.phase)) {
      throw new Error('TASK_CANCELLED');
    }
  }

  async function expireOpening(job) {
    if (!canOperate(job)) return job;
    if (job.phase === 'course' && job.interruption?.status === 'navigating' &&
      Date.now() >= job.interruption.deadline) {
      let currentTab;
      try { currentTab = await chrome.tabs.get(job.ownerTabId); }
      catch { return save(interruptionStop(job, '任务页面已关闭，已保留断点；请重新打开网站。')); }
      if (!canOperate(job)) return job;
      const candidate = job.candidates?.[job.targetIndex];
      let reload = job.interruption.navigationMode === 'reload';
      // If the user moved again while a reload was pending, first return by
      // the ordinary verified navigation path; never refresh that other page.
      if (reload) {
        try { reload = sameResourceUrl(currentTab.url, verifiedResourceUrl(candidate)) &&
          (!currentTab.pendingUrl || sameResourceUrl(currentTab.pendingUrl, verifiedResourceUrl(candidate))); }
        catch { reload = false; }
      }
      return attemptInterruption(job, {
        episodeId: job.interruption.id, navigate: true,
        reload,
        reason: reload
          ? '学习页面刷新尚未接回，正在重新载入原音视频页面'
          : '学习入口尚未接回，正在重新打开已保存的课程'
      }, null, currentTab);
    }
    const deadline = job.phase === 'go-agent' ? 'agentDeadline'
      : job.phase === 'entry-home' ? 'entryDeadline'
        : job.phase === 'opening' ? 'openDeadline'
          : job.returnDeadline ? 'returnDeadline' : null;
    if (!deadline || !(Date.now() > job[deadline])) return job;
    const target = job.candidates[job.targetIndex];
    const key = `${deadline}:${job.targetIndex ?? ''}:${job.workerTabId ?? ''}`;
    const previous = job.navigationRecovery?.key === key ? job.navigationRecovery : {};
    if (Number(previous.nextRetryAt) > Date.now()) return job;
    const attempts = (Number(previous.attempts) || 0) + 1;
    const delay = attempts <= 3 ? 45000 : 300000;
    if (deadline === 'returnDeadline' && Number.isInteger(job.returningTabId) &&
      job.returningTabId !== job.homeTabId) {
      job.navigationRecovery = { key, attempts, nextRetryAt: Date.now() + delay };
      job.returnDeadline = job.navigationRecovery.nextRetryAt;
      if (attempts === 1 || attempts === 4) addLog(job, attempts > 3
        ? '统计页暂未关闭，保留任务并稍后自动重试'
        : '正在重新返回课表并关闭原统计页');
      await save(job);
      return completeInspectionReturn(job);
    }
    const tabId = job.phase === 'opening' && job.workerTabId != null ? job.workerTabId : job.homeTabId;
    let tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch {
      if (canOperate(job)) return save(pause(job, '任务页面已关闭，已保留断点；请在网站页面重新开始。', true));
      return job;
    }
    if (!canOperate(job)) return job;
    let current;
    try { current = new URL(tab.url); } catch {}
    if (!current || current.origin !== 'https://www.beeline-ai.com') {
      return save(pause(job, '任务页面已离开本站，已保留断点；请检查登录状态后继续。', true));
    }
    const page = route({ url: current.href });
    const currentCourse = courseKey({ url: current.href });
    let destination = null;
    let retryEntry = false;
    let notice = '页面加载较慢，正在等待当前任务页面接回';
    if (deadline === 'agentDeadline') {
      if (page !== 'agent' && page !== 'home') {
        if (job.agentDepartureUrl !== current.href) {
          return save(pause(job, '首页跳转进入了未确认页面，已保留任务；请检查登录或平台提示。', true));
        }
        destination = AGENT;
      }
    } else if (deadline === 'entryDeadline') {
      if (page === 'agent') {
        retryEntry = true;
        notice = '课表尚未打开，正在重新识别首页的正常入口';
      } else if (page !== 'home') {
        return save(pause(job, '课表入口进入了未确认页面，已保留任务；请检查登录或平台提示。', true));
      }
    } else if (deadline === 'returnDeadline') {
      if (page !== 'home') {
        if (page !== 'learn' || !job.returnCourseKey || currentCourse !== job.returnCourseKey) {
          return save(pause(job, '返回课表时出现未确认页面，已保留任务；请检查登录或平台提示。', true));
        }
        destination = HOME;
      }
    } else if (job.targetPurpose === 'play') {
      const expected = verifiedLearnUrl(target);
      if (page === 'learn' && currentCourse === target.courseKey) {
        // Being at the destination URL is not a document handshake. Leave
        // ownership untouched until the new page sends its verified hello.
      } else if (page === 'home') destination = expected;
      else return save(pause(job, '课程跳转进入了未确认页面，已保留任务；请检查登录或平台提示。', true));
    } else {
      // Only a never-created inspection tab is a popup-blocking case. A tab
      // that existed and was later closed is handled by tabs.onRemoved.
      if (job.workerTabId == null) {
        if (page !== 'home') {
          return save(pause(job, '课程统计页打开前首页已离开本站，已保留任务；请回到课表后继续。', true));
        }
        const recovery = job.openRecovery?.key === key ? job.openRecovery : { attempts: 0 };
        if (recovery.attempts < INSPECTION_OPEN_RETRY_LIMIT) {
          const attempts = recovery.attempts + 1;
          const nextRetryAt = Date.now() + INSPECTION_OPEN_RETRY_DELAY;
          job.openRecovery = {
            key, attempts, nextRetryAt,
            token: `${job.runId}:${job.targetIndex}:${attempts}:${Date.now()}`
          };
          job.navigationRecovery = { key, attempts, nextRetryAt };
          job.openDeadline = nextRetryAt;
          addLog(job, `课程统计页尚未打开，正在第 ${attempts} 次重试；等待新页面最多 ${INSPECTION_OPEN_RETRY_DELAY / 1000} 秒`);
          await save(job);
          return job;
        }
        return save(pause(job,
          '课程统计页未能打开；请检查地址栏拦截提示，允许本站弹出窗口或新标签页后点击“继续”；无拦截提示时请检查网络或课程入口。',
          true));
      }
      notice = '正在等待课程统计页加载并确认课程身份';
      if (job.workerTabId != null && page !== 'learn') {
        return save(pause(job, '课程统计页进入了未确认页面，请检查登录或平台提示。', true));
      }
    }
    job.navigationRecovery = { key, attempts, nextRetryAt: Date.now() + delay };
    job[deadline] = job.navigationRecovery.nextRetryAt;
    const previousGeneration = job.generation;
    if (retryEntry) {
      job.entryClicked = false;
      job.generation += 1;
    }
    if (attempts === 1 || attempts === 4) addLog(job, attempts > 3 ? `${notice}；保持任务，稍后自动再试` : notice);
    if (retryEntry) await saveOwnerHandoff(job, previousGeneration);
    else await save(job);
    if (!destination || !canOperate(job)) return job;
    // Saving can race a user pause or a platform redirect. Never pull an
    // unknown page back merely because an earlier URL was recoverable.
    let latest;
    try { latest = await chrome.tabs.get(tabId); } catch { return job; }
    if (!canOperate(job) || latest.url !== tab.url) return job;
    try { await chrome.tabs.update(tabId, { url: destination }); }
    catch { /* Keep this persisted deadline; the next bounded attempt retries. */ }
    return job;
  }

  async function navigateToCourse(job) {
    const url = verifiedLearnUrl(job.candidates[job.targetIndex]);
    if (!canOperate(job)) return job;
    try {
      // A normal navigation to a site-observed URL; playback permission remains the browser's decision.
      await chrome.tabs.update(job.homeTabId, { url, active: true });
    } catch {
      // The opening deadline retains the verified target and performs a
      // bounded retry instead of turning one navigation failure into a stop.
    }
    return job;
  }

  async function finish(job) {
    job.running = false;
    job.phase = 'finished';
    job.generation += 1;
    const pending = job.candidates.filter(c => c.status === 'manual').length;
    addLog(job, pending
      ? `自动任务结束：${pending} 门课有音视频待确认，请查看人工提醒。`
      : '所有已扫描课程的音视频均有页面完成标记。');
    addLog(job, '文档、考试、作业未处理；音视频任务结束不代表整门课程完成。');
    return save(job);
  }

  async function returnHome(job, workerId) {
    job.returnCourseKey = job.candidates[job.targetIndex]?.courseKey || job.returnCourseKey;
    job.targetIndex = null;
    job.targetPurpose = '';
    job.phase = 'home';
    const sameTab = workerId === job.homeTabId;
    // Do not let the home executor open another course while an inspection
    // tab is still waiting to close. It is rebound only after cleanup succeeds.
    bindOwnerInstance(job, job.homeTabId, null);
    if (sameTab) {
      bindHomeInstance(job, null);
    }
    job.returnDeadline = Date.now() + 45000;
    job.workerTabId = null;
    job.returningTabId = workerId;
    // Retain the worker until navigation finishes so its pause button stays valid.
    await save(job);
    if (!sameTab) return completeInspectionReturn(job);
    try {
      if (!canOperate(job)) return job;
      if (sameTab) {
        await chrome.tabs.update(job.homeTabId, { url: HOME, active: true });
        // Keep the return checkpoint until the destination document confirms arrival.
        return job;
      }
      if (!canOperate(job)) return job;
      delete job.returningTabId;
      await save(job);
    } catch {
      if (canOperate(job)) {
        job.returnDeadline = Date.now() + 45000;
        addLog(job, '返回课表暂未成功，已保留任务，稍后自动重试');
        await save(job);
      }
    }
    return job;
  }

  async function checkInspectionReturn(job) {
    if (!canOperate(job)) return false;
    let home, worker;
    try {
      home = await chrome.tabs.get(job.homeTabId);
      if (!canOperate(job)) return false;
      worker = await chrome.tabs.get(job.returningTabId);
    } catch {
      if (canOperate(job)) await save(pause(job, '返回课表的任务页面已关闭，已保留记录；请核对页面后继续。', true));
      return false;
    }
    if (!canOperate(job)) return false;
    const valid = tab => {
      try { return new URL(tab.url).origin === 'https://www.beeline-ai.com'; } catch { return false; }
    };
    if (!job.createdTabIds.includes(job.returningTabId) || !valid(home) || !valid(worker) ||
      route(home) !== 'home' || route(worker) !== 'learn' ||
      !job.returnCourseKey || courseKey(worker) !== job.returnCourseKey) {
      await save(pause(job, '返回课表时页面身份已改变，已保留记录；请核对页面后继续。', true));
      return false;
    }
    return true;
  }

  async function completeInspectionReturn(job) {
    if (!await checkInspectionReturn(job)) return job;
    try {
      await chrome.tabs.update(job.homeTabId, { active: true });
      // A platform redirect or a user stop can race activation. Recheck both
      // known pages before closing only the tab created for this inspection.
      if (!await checkInspectionReturn(job)) return job;
      await chrome.tabs.remove(job.returningTabId);
    } catch {
      // A temporary browser operation failure keeps the persisted deadline.
      // Missing or changed pages are a real identity block, not a retry grant.
      if (await checkInspectionReturn(job)) {
        addLog(job, '返回课表暂未成功，已保留任务，稍后自动重试');
        await save(job);
      }
      return job;
    }
    // The close already completed even if a stop arrived while the browser
    // promise was settling. Save that fact so an explicit Continue does not
    // later mistake our successfully closed tab for an unexpected disappearance.
    let home;
    try { home = await chrome.tabs.get(job.homeTabId); } catch {}
    const cancellation = pendingStop(job);
    const stoppedDuringClose = !canOperate(job);
    delete job.returningTabId;
    delete job.returnDeadline;
    delete job.returnCourseKey;
    delete job.navigationRecovery;
    if (stoppedDuringClose) return save(pauseForCancellation(job, cancellation));
    if (!home) return save(pause(job, '课表页面已关闭，已保留记录；请重新进入首页。', true));
    let homeIsValid = false;
    try { homeIsValid = new URL(home.url).origin === 'https://www.beeline-ai.com' && route(home) === 'home'; } catch {}
    if (!homeIsValid) {
      return save(pause(job, '课表页面身份已改变，已保留记录；请核对页面后继续。', true));
    }
    bindOwnerInstance(job, job.homeTabId, job.homeInstance);
    return save(job);
  }

  async function resetTask(previous, sender) {
    const currentTab = await chrome.tabs.get(sender.tab.id);
    if (!isSite({ ...sender, url: currentTab.url })) throw new Error('请在网站页面重置插件');
    const holdIds = [...new Set([
      ...taskTabIds(previous || {}), ...(previous?.resetHoldTabIds || []),
      ...(previous?.createdTabIds || []), sender.tab.id
    ])];
    // This marker contains no old courses, playback records or logs. It only
    // prevents old documents and delayed replies from reviving erased work.
    const empty = {
      version: 3, runId: crypto.randomUUID(), generation: 1, revision: 0,
      resetEpoch: resetEpoch(previous) + 1, running: false, phase: 'resetting',
      candidates: [], logs: [], resetHoldTabIds: holdIds
    };
    if (previous?.phase === 'opening' || previous?.resumePhase === 'opening') {
      empty.resetOpeningParentId = previous.homeTabId;
      empty.resetOpeningUntil = Date.now() + 5000;
    }
    let saved = true;
    try { await save(empty); } catch { saved = false; }
    let tabs;
    try { tabs = await chrome.tabs.query({ url: 'https://www.beeline-ai.com/*' }); }
    catch {
      empty.reason = '已停止重置操作，但无法核对原任务页面；请刷新任务页后重试重置。';
      emergencyJob = copy(empty);
      throw new Error(empty.reason);
    }
    const present = new Set(tabs.map(tab => tab.id));
    if (previous?.phase === 'opening' || previous?.resumePhase === 'opening') {
      // A click may already have opened its page before onCreated's queued
      // handler ran. Include that page in the reset stop acknowledgement.
      for (const tab of tabs) {
        if (tab.openerTabId === previous.homeTabId && !holdIds.includes(tab.id)) holdIds.push(tab.id);
      }
    }
    empty.resetHoldTabIds = holdIds.filter(id => present.has(id));
    const required = new Set(empty.resetHoldTabIds);
    const reloaded = [];
    const outcomes = await Promise.all(tabs.map(async tab => {
      let timer;
      try {
        const result = await Promise.race([
          chrome.tabs.sendMessage(tab.id, { channel: CHANNEL, job: empty, tabId: tab.id, reset: true }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5000); })
        ]);
        if (!required.has(tab.id) || (result?.resetEpoch === empty.resetEpoch && result.stopped === true)) return true;
        // The old document answered but could not pause its media (for
        // example while its player is suspended). A reset must still stop the
        // page, so use the same reload fallback as a missing listener.
        await chrome.tabs.reload(tab.id);
        reloaded.push(tab.id);
        return true;
      } catch {
        if (!required.has(tab.id)) return true;
        // A stale, discarded, or extension-reloaded document may no longer
        // have a content listener. Reset is already persisted before this
        // point; reloading the task page is the safe stop acknowledgement and
        // lets the new document observe the empty reset marker on startup.
        try {
          await chrome.tabs.get(tab.id);
          await chrome.tabs.reload(tab.id);
          reloaded.push(tab.id);
          return true;
        } catch {
          // A tab closed during delivery has no media left to stop.
          try { await chrome.tabs.get(tab.id); return false; } catch { return true; }
        }
      } finally { clearTimeout(timer); }
    }));
    if (saved && outcomes.every(Boolean)) {
      empty.phase = 'idle';
      delete empty.reason;
    } else {
      empty.reason = saved
        ? '原任务页面尚未全部确认停止。请刷新仍打开的任务页，再点击重置；旧任务记录已清除。'
        : '本地记录清理尚未完整保存，已保持停止；请重试重置。';
    }
    if (reloaded.length) {
      // Reloading a task tab stops its old media and the empty marker prevents
      // the replacement document from reviving the erased run. Keep the
      // marker in resetHoldTabIds until the tab reports its new document.
      empty.reason = '';
      empty.phase = 'idle';
      delete empty.reason;
    }
    await save(empty);
    // All site panels see the new empty state, while only task pages pause
    // their media. Repeated messages for this epoch never clear a newer run.
    await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id,
      { channel: CHANNEL, job: empty, tabId: tab.id, reset: true }).catch(() => {})));
    return empty;
  }

  async function goHomeToScan(job) {
    const source = await chrome.tabs.get(job.homeTabId);
    job.returnCourseKey = courseKey({ url: source.url });
    bindHomeInstance(job, null);
    bindOwnerInstance(job, job.homeTabId, null);
    job.returningTabId = job.homeTabId;
    job.returnDeadline = Date.now() + 45000;
    await save(job);
    if (!canOperate(job)) return job;
    try { await chrome.tabs.update(job.homeTabId, { url: HOME, active: true }); }
    catch {
      // The persisted return deadline will retry the same known destination.
    }
    return job;
  }

  async function goAgentToStart(job, departingInstance) {
    const source = await chrome.tabs.get(job.homeTabId);
    if (!canOperate(job)) return job;
    job.agentDepartureUrl = source.url;
    job.agentDepartureInstance = departingInstance;
    bindHomeInstance(job, null);
    bindOwnerInstance(job, job.homeTabId, null);
    job.agentDeadline = Date.now() + 45000;
    await save(job);
    if (!canOperate(job)) return job;
    try { await chrome.tabs.update(job.homeTabId, { url: AGENT, active: true }); }
    catch {
      // The persisted entry deadline will retry this observed departure page.
    }
    return job;
  }

  function applyResourceRecord(job, msg, sender) {
    requireOwner(job, msg, sender, ['course']);
    const candidate = job.candidates[job.targetIndex];
    if (courseKey(sender) !== candidate.courseKey) throw new Error('课程身份已改变');
    if (typeof msg.key !== 'string' || !msg.key.trim() || !msg.result ||
      typeof msg.result !== 'object' || Array.isArray(msg.result) ||
      ['started', 'attempted', 'ended', 'confirmed'].some(field =>
        msg.result[field] != null && typeof msg.result[field] !== 'boolean')) {
      throw new Error('音视频记录无法确认');
    }
    if (job.singlePass && (
      ['targetReached', 'deferred'].some(field =>
        msg.result[field] != null && typeof msg.result[field] !== 'boolean') ||
      (msg.result.effectiveTarget != null && !validTargetPercent(msg.result.effectiveTarget)) ||
      (msg.result.sitePercent != null && (!Number.isFinite(msg.result.sitePercent) ||
        msg.result.sitePercent < 0 || msg.result.sitePercent > 100)) ||
      (msg.result.completionSource != null &&
        !['page-marker', 'site-progress'].includes(msg.result.completionSource)) ||
      (msg.result.confirmed === true && candidate.records?.[msg.key]?.confirmed !== true &&
        !(msg.result.completionSource === 'page-marker' ||
          (msg.result.completionSource === 'site-progress' && msg.result.sitePercent >= 80))) ||
      !candidate.directory?.items?.some(item => item.key === msg.key &&
        ['video', 'audio', 'media'].includes(item.mediaType)))) {
      throw new Error('音视频观看目标或平台状态无法确认');
    }
    candidate.records ||= {};
    const previous = candidate.records[msg.key];
    const next = { ...previous, ...msg.result };
    if (job.singlePass) {
      next.effectiveTarget = previous?.effectiveTarget === 100 &&
        ((previous.recoveryAttempts || 0) + (previous.finalAttempts || 0) > 0)
        ? 100 : msg.result.effectiveTarget ?? previous?.effectiveTarget ?? job.targetPercent ?? 100;
      // Retry budgets belong to background checkpoints, not content records.
      for (const field of ['recoveryAttempts', 'finalAttempts', 'retryTokens']) {
        if (previous?.[field] == null) delete next[field];
        else next[field] = previous[field];
      }
    }
    if (previous?.recovery || msg.result.recovery) {
      next.recovery = recordRecovery(candidate, previous?.recovery, msg.result.recovery);
    }
    if (previous?.ended === true) {
      next.ended = true;
      if (previous.playbackAttempt) {
        if (msg.result.ended !== true) next.playbackAttempt = previous.playbackAttempt;
        else {
          next.playbackAttempt = { ...previous.playbackAttempt, ...msg.result.playbackAttempt };
          if (previous.playbackAttempt.finished) {
            next.playbackAttempt.finished = previous.playbackAttempt.finished;
          }
          const endEvents = (previous.playbackAttempt.events || []).filter(event => event.type === 'ended');
          if (endEvents.length && !next.playbackAttempt.events?.some(event => event.type === 'ended')) {
            next.playbackAttempt.events = [...(next.playbackAttempt.events || []), ...endEvents];
          }
        }
      }
    }
    if (previous?.confirmed === true) next.confirmed = true;
    if (previous?.started === true) next.started = true;
    if (previous?.attempted === true) next.attempted = true;
    if (next.ended === true && next.progressGap) throw new Error('仍有未观看的进度区间，不能确认播放结束');
    if (next.ended === true || (job.singlePass && next.confirmed === true)) delete next.error;
    candidate.records[msg.key] = next;
    const released = next.ended === true ||
      (job.singlePass && (next.targetReached === true || next.deferred === true || next.confirmed === true));
    if (candidate.currentResource?.key === msg.key && released) delete candidate.currentResource;
    if (job.singlePass && released && job.interruption?.courseKey === candidate.courseKey &&
      job.interruption.key === msg.key) delete job.interruption;
  }

  function awaitSelection(job, message) {
    job.running = false;
    job.phase = 'selection';
    job.generation += 1;
    delete job.expectedRefresh;
    job.lastOperation = job.operation;
    job.operation = '';
    delete job.learnAfterScan;
    job.selectedIndex = null;
    delete job.resumePhase;
    delete job.interruption;
    delete job.reason;
    addLog(job, message);
    return job;
  }

  async function selectCourse(job, msg, sender) {
    if (!job || job.workflow !== 'manual' || job.running ||
        job.phase === 'resetting' || msg.runId !== job.runId ||
        msg.generation !== job.generation || isRetiredInstance(job, sender.tab.id, msg.instanceId)) {
      throw new Error('TASK_CANCELLED');
    }
    const candidate = Number.isInteger(msg.index) && job.candidates[msg.index];
    if (!candidate || msg.candidateKey !== (candidate.courseKey || candidate.key) ||
        !['inspect', 'play', 'learn'].includes(msg.purpose)) throw new Error('课程选择已变化，请重新选择');
    if (msg.purpose === 'play' && (!Number.isFinite(candidate.scannedAt) ||
        !candidate.directory || candidate.scanState !== 'ready')) {
      throw new Error('请先完整扫描这门课的目录');
    }
    const current = await chrome.tabs.get(sender.tab.id);
    if (!isSite({ ...sender, url: current.url }) ||
        (pageBlockingReason(msg))) throw new Error('请先核对网站页面');
    // Every explicit operation gets a new generation. Late scan/play writes
    // from any previous operation can no longer authorize navigation.
    job.generation += 1;
    job.running = true;
    job.learnAfterScan = msg.purpose === 'learn';
    job.operation = job.learnAfterScan ? 'inspect' : msg.purpose;
    job.selectedIndex = msg.index;
    job.targetIndex = msg.index;
    job.targetPurpose = job.operation;
    job.homeTabId = sender.tab.id;
    job.homeInstance = msg.instanceId;
    job.workerTabId = null;
    job.ownerTabId = sender.tab.id;
    job.ownerInstance = msg.instanceId;
    job.singlePass = true;
    if (validTargetPercent(msg.targetPercent)) job.targetPercent = msg.targetPercent;
    for (const key of ['reason', 'resumePhase', 'returningTabId', 'returnDeadline',
      'navigationRecovery', 'openRecovery', 'interruption', 'expectedRefresh']) delete job[key];
    delete candidate.scanDraft;
    if (job.operation === 'inspect') {
      candidate.scanState = 'scanning';
      delete candidate.scanError;
    } else {
      for (const key of ['pass', 'finalPass', 'lastRefresh', 'refreshTokens', 'currentResource', 'retryAt']) delete candidate[key];
      // A new user-requested pass retries unconfirmed items with a fresh
      // attempt budget while keeping historical evidence for reference.
      candidate.previousRecords = copy(candidate.records || {});
      candidate.records = Object.fromEntries(Object.entries(candidate.records || {})
        .filter(([, record]) => record.confirmed === true));
      candidate.failures = []; candidate.unconfirmed = []; candidate.unfinished = [];
      candidate.status = 'inspected';
    }
    if (candidate.learnUrl) {
      verifiedLearnUrl(candidate);
      job.workerTabId = sender.tab.id;
      if (route(current) === 'learn' && courseKey(current) === candidate.courseKey) {
        job.phase = 'course';
        addLog(job, job.operation === 'inspect' ? `核对本课目录：${candidate.title}` : `仅学习本课：${candidate.title}`);
        return save(job);
      }
      job.phase = 'opening';
      job.openDeadline = Date.now() + 45000;
      bindOwnerInstance(job, sender.tab.id, null);
      await save(job);
      return navigateToCourse(job);
    }
    job.phase = 'home';
    addLog(job, `等待打开用户选择的课程：${candidate.title}`);
    if (route(current) !== 'home') return goHomeToScan(job);
    return save(job);
  }

  async function handle(msg, sender) {
    if (!isSite(sender)) throw new Error('页面来源无法确认');
    let job = await read();
    if (job?.running && sender.tab.id === job.ownerTabId && pageBlockingReason(msg) &&
      (!msg.runId || msg.runId === job.runId) &&
      !isRetiredInstance(job, sender.tab.id, msg.instanceId)) {
      return save(interruptionStop(job, pageBlockingReason(msg)));
    }
    job = await expireOpening(job);
    const tabId = sender.tab.id;
    if (msg.action === 'get') return job;
    if (msg.action === 'focus-task') {
      if (!job || msg.runId !== job.runId || msg.generation !== job.generation ||
          resetEpoch(msg) !== resetEpoch(job)) throw new Error('任务已变化，请重试');
      const targetId = job.ownerTabId;
      if (!Number.isInteger(targetId)) throw new Error('学习标签页已关闭');
      const target = await chrome.tabs.get(targetId);
      if (!isSite({ ...sender, url: target.url })) throw new Error('学习标签页已离开网站');
      await chrome.tabs.update(targetId, { active: true });
      if (Number.isInteger(target.windowId)) await chrome.windows.update(target.windowId, { focused: true });
      return job;
    }
    if (resetEpoch(msg) !== resetEpoch(job)) throw new Error('TASK_CANCELLED');
    if (msg.action === 'reset') return resetTask(job, sender);
    if (msg.action === 'course-select') return selectCourse(job, msg, sender);
    if (msg.action === 'hello') {
      if (!job || !canOperate(job) || (msg.runId && msg.runId !== job.runId) ||
        typeof msg.instanceId !== 'string' || !msg.instanceId ||
        isRetiredInstance(job, tabId, msg.instanceId)) return job;
      if (Number.isInteger(job.returningTabId) && job.returningTabId !== job.homeTabId) {
        // A refreshed home may announce its new document while cleanup is
        // pending; retain that identity without authorizing another course.
        if (tabId === job.homeTabId && route(sender) === 'home' && job.homeInstance !== msg.instanceId) {
          bindHomeInstance(job, msg.instanceId);
          return save(job);
        }
        return job;
      }
      if (job.phase === 'course' && tabId === job.ownerTabId) {
        const currentTab = await chrome.tabs.get(tabId);
        if (!canOperate(job)) return job;
        const blocked = pageBlockingReason(msg);
        if (blocked) return save(interruptionStop(job, blocked));
        const current = { ...sender, url: currentTab.url };
        const candidate = job.candidates[job.targetIndex];
        const liveRouteKey = `${new URL(currentTab.url).pathname}${new URL(currentTab.url).hash}`;
        const routeMismatch = candidate.currentResource?.stage === 'ready' &&
          !routeEquals(liveRouteKey, candidate.currentResource.routeKey);
        if (!isSite(current) || route(current) !== 'learn' || courseKey(current) !== candidate.courseKey || routeMismatch) {
          if (job.targetPurpose === 'play') return attemptInterruption(job,
            { ...msg, navigate: true, reason: '页面发生变化，正在返回原课程' }, sender, currentTab);
          return save(pause(job, '当前课程或教学班与保存的任务不符，已停止。', true));
        }
        // The browser can expose the destination before its old DOM unloads.
        // A surviving SPA document may reconnect only after its own route and
        // selected resource agree with the saved task, not from the tab URL alone.
        if (job.interruption?.status === 'navigating' &&
          msg.instanceId === job.interruption.departureInstance) {
          if (job.interruption.requireNewDocument) return job;
          const resource = candidate.currentResource;
          if (typeof msg.documentRouteKey !== 'string' ||
            !routeEquals(msg.documentRouteKey, liveRouteKey) ||
            (resource?.key && msg.activeResourceKey !== resource.key)) return job;
        }
        if (!msg.title) return job;
        if (msg.title !== candidate.title) {
          if (job.targetPurpose === 'play') return attemptInterruption(job,
            { ...msg, navigate: true, reason: '课程名称尚未对齐，正在重新核对原课程' }, sender, currentTab);
          return save(pause(job, '当前课程名称与保存的任务不符，已停止。', true));
        }
        const arrivedAfterInterruption = job.interruption?.status === 'navigating';
        if (arrivedAfterInterruption) {
          job.interruption.status = 'attempting';
          delete job.interruption.deadline;
          delete job.interruption.departureInstance;
          delete job.interruption.requireNewDocument;
        }
        if (job.ownerInstance && job.ownerInstance !== msg.instanceId) {
          return takeOverRefreshedOwner(job, msg, current);
        }
        if (!job.ownerInstance) {
          bindOwnerInstance(job, tabId, msg.instanceId);
          return save(job);
        }
        return arrivedAfterInterruption ? save(job) : job;
      }
      if (job.phase === 'go-agent') {
        if (tabId !== job.homeTabId || tabId !== job.ownerTabId) return job;
        // A SPA can retain an old sender URL. Only the browser's current tab
        // URL can confirm arrival at the site's observed homepage.
        const currentTab = await chrome.tabs.get(tabId);
        if (!canOperate(job)) return job;
        const currentPage = isSite({ ...sender, url: currentTab.url })
          ? route({ url: currentTab.url }) : 'other';
        if (currentPage === 'agent' || currentPage === 'home') {
          // tabs.update can expose the destination URL before the old page
          // unloads. It performs a document navigation for this path change:
          // only a new document whose own URL is the destination may claim it.
          if (msg.instanceId === job.agentDepartureInstance ||
            !['agent', 'home'].includes(route(sender))) return job;
          const previousGeneration = job.generation;
          bindHomeInstance(job, msg.instanceId);
          bindOwnerInstance(job, tabId, msg.instanceId);
          job.phase = currentPage === 'agent' ? 'entry-home' : 'scan-home';
          if (currentPage === 'agent') {
            job.entryClicked = false;
            job.entryDeadline = Date.now() + 45000;
          }
          delete job.agentDeadline;
          delete job.agentDepartureInstance;
          delete job.agentDepartureUrl;
          delete job.navigationRecovery;
          job.generation += 1;
          addLog(job, currentPage === 'agent'
            ? '已进入网站首页，正在打开全部课表'
            : '已进入全部课表，开始核对正在上的课程');
          return saveOwnerHandoff(job, previousGeneration);
        }
        // The old document may refresh while navigation is in flight. Keep
        // the bounded handoff rather than opening a second page or resuming it.
        if (job.ownerInstance !== msg.instanceId) return takeOverRefreshedOwner(job, msg, sender);
        return job;
      }
      if (job.phase === 'entry-home') {
        if (tabId !== job.homeTabId || tabId !== job.ownerTabId) return job;
        // Vue navigation can keep the content instance and its original sender
        // document URL. Confirm arrival against this task tab's live URL.
        const currentTab = await chrome.tabs.get(tabId);
        if (!canOperate(job)) return job;
        const currentPage = isSite({ ...sender, url: currentTab.url })
          ? route({ url: currentTab.url }) : 'other';
        if (currentPage === 'home' && (job.entryClicked === true || job.entryAttempted === true)) {
          const previousGeneration = job.generation;
          bindHomeInstance(job, msg.instanceId);
          bindOwnerInstance(job, tabId, msg.instanceId);
          job.phase = 'scan-home';
          delete job.entryClicked;
          delete job.entryAttempted;
          delete job.entryDeadline;
          delete job.navigationRecovery;
          job.generation += 1;
          addLog(job, '已进入全部课表，开始核对正在上的课程');
          return saveOwnerHandoff(job, previousGeneration);
        }
        if (currentPage === 'agent') {
          if (job.ownerInstance !== msg.instanceId) return takeOverRefreshedOwner(job, msg, sender);
          return job;
        }
        return save(pause(job, '当前页面与课表入口任务不符，已停止，请核对页面。', true));
      }
      let changed = false;
      if (job.returningTabId === job.homeTabId) {
        if (tabId !== job.homeTabId || route(sender) !== 'home') return job;
        bindHomeInstance(job, msg.instanceId);
        bindOwnerInstance(job, tabId, msg.instanceId);
        delete job.returningTabId;
        delete job.returnDeadline;
        delete job.returnCourseKey;
        delete job.navigationRecovery;
        changed = true;
      }
      if (job.phase === 'opening' && job.workerTabId === job.homeTabId &&
        tabId === job.homeTabId && route(sender) !== 'learn') return job;
      if (tabId === job.homeTabId && route(sender) === 'home') {
        if (job.ownerTabId === tabId && job.ownerInstance && job.ownerInstance !== msg.instanceId) {
          if (!['scan-home', 'home'].includes(job.phase)) {
            return save(pause(job, '当前页面与原任务不符，已停止，请核对页面。', true));
          }
          return takeOverRefreshedOwner(job, msg, sender);
        }
        if (job.homeInstance !== msg.instanceId) { bindHomeInstance(job, msg.instanceId); changed = true; }
        if (job.ownerTabId === tabId && !job.ownerInstance) {
          bindOwnerInstance(job, tabId, msg.instanceId);
          changed = true;
        }
      }
      const inOpeningTab = job.phase === 'opening' &&
        (tabId === job.workerTabId || (tabId === job.homeTabId && job.workerTabId == null));
      if (inOpeningTab && route(sender) === 'learn') {
        const candidate = job.candidates[job.targetIndex];
        const key = courseKey(sender);
        if (!msg.title || !key) return job; // page is still loading
        if (candidate.courseKey && candidate.courseKey !== key) {
          return save(pause(job, '打开的课程或教学班与任务不符，已停止，请核对页面。', true));
        }
        if (msg.title !== candidate.title) return job;
        candidate.courseKey = key;
        candidate.learnUrl = sender.url;
        if (job.recoveryRecords?.[key]) {
          candidate.records = retryRecords(job.recoveryRecords[key]);
          delete job.recoveryRecords[key];
        }
        job.workerTabId = tabId;
        bindOwnerInstance(job, tabId, msg.instanceId);
        job.phase = 'course';
        delete job.navigationRecovery;
        delete job.openRecovery;
        changed = true;
        addLog(job, `已打开课程：${candidate.title}；${job.targetPurpose === 'inspect' ? '统计音视频，不启动播放' : '开始正常播放'}`);
      } else if (tabId === job.ownerTabId && job.phase === 'course') {
        const candidate = job.candidates[job.targetIndex];
        if (route(sender) !== 'learn' || courseKey(sender) !== candidate.courseKey) {
          return save(pause(job, '当前课程或教学班与保存的任务不符，已停止。', true));
        }
        if (!msg.title) return job; // A refreshed document may still be loading the course title.
        if (msg.title !== candidate.title) {
          return save(pause(job, '当前课程名称与保存的任务不符，已停止。', true));
        }
        if (job.ownerInstance && job.ownerInstance !== msg.instanceId) {
          return takeOverRefreshedOwner(job, msg, sender);
        }
        if (!job.ownerInstance) {
          bindOwnerInstance(job, tabId, msg.instanceId);
          changed = true;
        }
      } else if (tabId === job.ownerTabId && job.ownerInstance &&
        job.ownerInstance !== msg.instanceId) {
        return save(pause(job, '任务页面已重新加载，已暂停。点击继续前将重新核对目录。', true));
      }
      return changed ? save(job) : job;
    }
    if (msg.action === 'pause' || msg.action === 'manual') {
      if (!job || ['finished', 'idle', 'resetting'].includes(job.phase)) return job;
      if (!taskTabIds(job).includes(tabId)) throw new Error('任务在另一个页面，请到任务页面暂停');
      // An old document must not pause a replacement task.
      if (msg.runId && msg.runId !== job.runId && !isStartCancellation(job, msg, tabId)) return job;
      if (msg.action === 'manual' && msg.generation !== job.generation) return job;
      preserveStopGap(job, msg, tabId);
      return save(pause(job, String(msg.reason || ''), msg.action === 'manual'));
    }
    if (msg.action === 'start') {
      if (job?.phase === 'resetting') throw new Error(job.reason || '重置还未确认完成，请重试重置');
      if (msg.singlePass != null && typeof msg.singlePass !== 'boolean') {
        throw new Error('课程任务模式无法确认');
      }
      if (msg.targetPercent != null && !validTargetPercent(msg.targetPercent)) {
        throw new Error('观看目标必须为80到100之间的整数');
      }
      if (job && isRetiredInstance(job, tabId, msg.instanceId)) return job;
      if (job && msg.runId && (msg.runId !== job.runId || msg.generation !== job.generation)) {
        throw new Error('TASK_CANCELLED');
      }
      const currentTab = await chrome.tabs.get(tabId);
      if (!isSite({ ...sender, url: currentTab.url })) throw new Error('当前标签已离开网站，请在网站页面重新开始');
      const page = route({ url: currentTab.url });
      const requestedAll = msg.scope === 'all';
      const restart = msg.restart === true || (page === 'agent' &&
        ['paused', 'manual'].includes(job?.phase) && job.ownerTabId === tabId &&
        !['entry-home', 'go-agent'].includes(job.resumePhase));
      if (restart && !requestedAll && !['agent', 'home'].includes(page)) throw new Error('请在首页或课表重新开始');
      if (job?.running) return job;
      const resetFromHome = job?.phase === 'idle';
      const currentResetEpoch = resetEpoch(job);
      const resetHoldTabIds = job?.resetHoldTabIds || [];
      const recovered = recoveryRecords(job);
      if (!restart && (!msg.workflow || job?.workflow === msg.workflow) && job && ['paused', 'manual'].includes(job.phase) &&
        taskTabIds(job).includes(tabId)) {
        let ownerExists = true;
        await chrome.tabs.get(job.ownerTabId).catch(() => { ownerExists = false; });
        if (!ownerExists) {
          if (!requestedAll && !['agent', 'home'].includes(page)) throw new Error('任务页面已关闭，请回到首页重新开始');
          job = null;
        }
      }
      if (!restart && (!msg.workflow || job?.workflow === msg.workflow) && job && ['paused', 'manual'].includes(job.phase) &&
        taskTabIds(job).includes(tabId)) {
        const continuingManualStop = job.phase === 'manual';
        if (msg.singlePass === true) job.singlePass = true;
        if (job.singlePass) {
          job.targetPercent = msg.targetPercent ?? job.targetPercent ?? 100;
        }
        const resume = job.resumePhase;
        let needsCourseNavigation = false;
        // Opening is retried from the homepage, never by adopting a similarly named old tab.
        if (resume === 'go-agent') {
          if (tabId !== job.homeTabId) throw new Error('请回到原任务标签页继续');
          job.phase = page === 'agent' ? 'entry-home' : page === 'home' ? 'scan-home' : 'go-agent';
          job.ownerTabId = job.homeTabId;
          if (job.phase === 'entry-home') {
            job.entryClicked = false;
            job.entryDeadline = Date.now() + 45000;
            delete job.agentDeadline;
            delete job.agentDepartureInstance;
          } else if (job.phase === 'scan-home') {
            delete job.agentDeadline;
            delete job.agentDepartureInstance;
          }
        } else if (resume === 'entry-home') {
          if (tabId !== job.homeTabId || !['agent', 'home'].includes(page)) {
            throw new Error('请回到原首页或课表继续');
          }
          job.phase = page === 'agent' ? 'entry-home' : 'scan-home';
          job.ownerTabId = job.homeTabId;
          if (page === 'agent') {
            job.entryClicked = false;
            job.entryDeadline = Date.now() + 45000;
          } else {
            delete job.entryClicked;
            delete job.entryDeadline;
          }
        } else if (resume === 'opening') {
          if (job.workerTabId != null) {
            await chrome.tabs.get(job.workerTabId).catch(() => { job.workerTabId = null; });
          }
          if (job.workerTabId === job.homeTabId && job.targetPurpose === 'play') {
            const candidate = job.candidates[job.targetIndex];
            verifiedLearnUrl(candidate);
            const currentTab = await chrome.tabs.get(job.homeTabId);
            const current = { url: currentTab.url };
            if (route(current) === 'home') needsCourseNavigation = true;
            else if (route(current) !== 'learn' || courseKey(current) !== candidate.courseKey) {
              throw new Error('当前课程或教学班与任务不符，请回到首页重新开始');
            }
            job.phase = 'opening';
            job.ownerTabId = job.homeTabId;
          } else if (job.workerTabId != null) job.phase = 'opening';
          else if (job.targetPurpose === 'inspect') {
            job.phase = 'opening';
            job.ownerTabId = job.homeTabId;
            job.openDeadline = Date.now() + 45000;
            job.openRecovery = {
              key: `openDeadline:${job.targetIndex ?? ''}:`,
              attempts: Number(job.openRecovery?.attempts) || 0,
              nextRetryAt: Date.now(),
              token: `${job.runId}:${job.targetIndex}:continue:${Date.now()}`
            };
          } else {
            job.phase = 'home';
            job.ownerTabId = job.homeTabId;
            job.targetIndex = null;
          }
        } else job.phase = resume;
        await chrome.tabs.get(job.ownerTabId); // closed task tab needs a fresh scan
        if (job.phase === 'course') {
          const worker = await chrome.tabs.get(job.ownerTabId);
          if (!worker.url || !worker.url.includes('/courseInfo/learn/courseWare/')) {
            throw new Error('任务学习页已离开，请回到首页重新开始');
          }
          if (!job.singlePass) resetAttempt(job.candidates[job.targetIndex]);
        }
        job.running = true;
        // An explicit Continue after a manual stop starts a fresh recovery
        // episode. A user Pause/Continue preserves the current failure budget.
        if (continuingManualStop) delete job.interruption;
        job.generation += 1;
        bindOwnerInstance(job, job.ownerTabId,
          job.phase === 'opening' && job.workerTabId === job.homeTabId
            ? null : job.ownerTabId === tabId ? msg.instanceId : null);
        if (tabId === job.homeTabId && ['agent', 'home'].includes(page)) bindHomeInstance(job, msg.instanceId);
        if (job.phase === 'opening') job.openDeadline = Date.now() + 45000;
        delete job.reason;
        addLog(job, '继续自动任务；先核对当前页面和目录');
        if (Number.isInteger(job.returningTabId)) {
          const currentTab = await chrome.tabs.get(job.homeTabId);
          if (job.returningTabId === job.homeTabId && route({ url: currentTab.url }) === 'home') {
            if (tabId !== job.homeTabId || route(sender) !== 'home') {
              bindOwnerInstance(job, job.ownerTabId, null);
              bindHomeInstance(job, null);
              job.returnDeadline = Date.now() + 45000;
              return save(job);
            }
            delete job.returningTabId;
            delete job.returnDeadline;
            bindOwnerInstance(job, job.ownerTabId, msg.instanceId);
            return save(job);
          }
          if (job.phase === 'scan-home') return goHomeToScan(job);
          return returnHome(job, job.returningTabId);
        }
        await save(job);
        if (job.phase === 'go-agent') return goAgentToStart(job, msg.instanceId);
        if (needsCourseNavigation) return navigateToCourse(job);
        if (canOperate(job)) await chrome.tabs.update(job.ownerTabId, { active: true });
        return job;
      }
      if (!requestedAll && !['agent', 'home', 'learn'].includes(page)) {
        throw new Error('请先进入首页、课表或课程学习页');
      }
      const key = courseKey({ url: currentTab.url });
      if (!requestedAll && !resetFromHome && page === 'learn' && (!key || !msg.title)) {
        throw new Error('当前课程身份未识别');
      }
      const manualWorkflow = msg.workflow === 'manual';
      const cachedCourses = manualWorkflow ? copy(job?.candidates || []) : [];
      const allCourses = manualWorkflow || requestedAll || ['agent', 'home'].includes(page) || resetFromHome;
      const enteringHome = page === 'agent';
      const navigateToAgent = requestedAll && !['agent', 'home'].includes(page);
      const navigateFromLearn = !requestedAll && resetFromHome && page === 'learn';
      job = {
        version: 3, runId: crypto.randomUUID(), generation: 1, revision: 0,
        resetEpoch: currentResetEpoch, resetHoldTabIds,
        startRequest: { runId: msg.runId || null, generation: msg.generation ?? null,
          instanceId: msg.instanceId, tabId },
        running: true, scope: allCourses ? 'all' : 'single',
        ...(manualWorkflow ? { workflow: 'manual', operation: 'list', selectedIndex: null, cachedCourses } : {}),
        ...(msg.singlePass === true
          ? { singlePass: true, targetPercent: msg.targetPercent ?? 100 } : {}),
        phase: navigateToAgent ? 'go-agent' : enteringHome ? 'entry-home' : allCourses ? 'scan-home' : 'course',
        ...(enteringHome ? { entryClicked: false, entryDeadline: Date.now() + 45000 } : {}),
        homeTabId: tabId, homeInstance: navigateFromLearn || navigateToAgent ? null : msg.instanceId,
        ownerTabId: tabId, ownerInstance: navigateFromLearn || navigateToAgent ? null : msg.instanceId,
        workerTabId: allCourses ? null : tabId, createdTabIds: [],
        retiredInstances: [],
        candidates: allCourses ? [] : [{
          title: msg.title, key, courseKey: key, learnUrl: currentTab.url,
          status: 'inspected', records: retryRecords(recovered[key])
        }],
        recoveryRecords: recovered,
        inspectIndex: allCourses ? 0 : 1,
        targetIndex: allCourses ? null : 0, targetPurpose: allCourses ? '' : 'play',
        logs: [], startedAt: Date.now()
      };
      if (!allCourses) delete job.recoveryRecords[key];
      if (restart) addLog(job, '重新开始：重新扫描首页，保留同一课程和教学班的未完成音视频记录。');
      if (navigateToAgent) addLog(job, '开始：正在进入网站首页');
      if (enteringHome) addLog(job, '开始：正在进入全部课表');
      addLog(job, allCourses
        ? manualWorkflow ? '获取课程列表：完成后等待用户选择，不进入课程。' : '开始：先逐门统计，再按剩余音视频数量最少安排课程。'
        : '开始：只处理当前课程的音视频。');
      if (navigateFromLearn) return goHomeToScan(job);
      if (navigateToAgent) return goAgentToStart(job, msg.instanceId);
      return save(job);
    }
    if (msg.action === 'entry-open') {
      requireOwner(job, msg, sender, ['entry-home']);
      const currentTab = await chrome.tabs.get(tabId);
      if (!canOperate(job) || !isSite({ ...sender, url: currentTab.url }) ||
        route({ url: currentTab.url }) !== 'agent' || job.entryClicked) {
        throw new Error('TASK_CANCELLED');
      }
      job.entryClicked = true;
      job.entryAttempted = true;
      return save(job);
    }
    if (msg.action === 'scan-result') {
      requireOwner(job, msg, sender, ['scan-home']);
      job.candidates = msg.candidates.map(candidate => {
        const next = { ...candidate, records: {} };
        // A title on the homepage is not evidence of a course or teaching-class ID.
        delete next.courseKey;
        delete next.learnUrl;
        delete next.directory;
        delete next.currentResource;
        return next;
      });
      job.inspectIndex = 0;
      job.phase = 'home';
      addLog(job, `首页扫描完成：${job.candidates.length} 门正在上的课程`);
      if (job.workflow === 'manual') {
        const cached = new Map((job.cachedCourses || []).map(c => [c.key, c]));
        job.candidates = job.candidates.map(candidate => {
          const old = cached.get(candidate.key);
          // The homepage exposes titles, not course IDs. Keep results as
          // reference, but re-enter via the card to verify identity again.
          if (!old) return candidate;
          const next = { ...old, ...candidate, records: old.records || {},
            directory: old.directory, total: old.total, remaining: old.remaining,
            scannedAt: old.scannedAt, scanState: old.scannedAt ? 'stale' : 'uninspected',
            status: old.status };
          delete next.courseKey; delete next.learnUrl; delete next.scanDraft;
          return next;
        });
        delete job.cachedCourses;
        job.listScannedAt = Date.now();
        return save(awaitSelection(job, '课程列表已获取，请选择一门课扫描目录。'));
      }
      return save(job);
    }
    if (msg.action === 'open') {
      requireOwner(job, msg, sender, ['home', 'course']);
      const candidate = job.candidates[msg.index];
      if (!candidate) throw new Error('课程选择失效，请重新扫描');
      if (!['inspect', 'play'].includes(msg.purpose)) throw new Error('课程操作类型无法确认');
      if (job.workflow === 'manual' && (msg.index !== job.selectedIndex || msg.purpose !== job.operation)) {
        throw new Error('未授权此课程操作，请先选择课程');
      }
      if (job.singlePass && msg.purpose === 'play' && candidate.finalPass === true) {
        throw new Error('此课程本轮已处理，未完成项已保留提醒');
      }
      const singleRetry = job.scope === 'single' && job.phase === 'course' &&
        msg.index === job.targetIndex && candidate.status === 'retry' && msg.purpose === 'play';
      if (job.phase === 'course' && !singleRetry) throw new Error('TASK_CANCELLED');
      if (candidate.status === 'retry') {
        if (msg.purpose !== 'play' || !Number.isFinite(candidate.retryAt) || Date.now() < candidate.retryAt) {
          throw new Error('课程仍在等待自动重试');
        }
        if (singleRetry) {
          const currentTab = await chrome.tabs.get(tabId);
          requireOwner(job, msg, sender, ['course']);
          const currentPage = { ...sender, url: currentTab.url };
          if (!isSite(currentPage) || route(currentPage) !== 'learn' ||
            courseKey(currentPage) !== candidate.courseKey) throw new Error('当前课程或教学班已改变，不能重试');
          prepareRetry(candidate);
          const previousGeneration = job.generation;
          job.generation += 1;
          addLog(job, `正在重试未完成的音视频：${candidate.title}`);
          return saveOwnerHandoff(job, previousGeneration);
        }
        prepareRetry(candidate);
      }
      if (msg.purpose === 'play') verifiedLearnUrl(candidate);
      job.targetIndex = msg.index;
      job.targetPurpose = msg.purpose;
      job.phase = 'opening';
      delete job.navigationRecovery;
      delete job.openRecovery;
      job.openDeadline = Date.now() + 45000;
      job.workerTabId = msg.purpose === 'play' ? job.homeTabId : null;
      bindOwnerInstance(job, job.ownerTabId, msg.purpose === 'play' ? null : msg.instanceId);
      addLog(job, msg.purpose === 'inspect'
        ? `正在统计：${candidate.title}`
        : `选择剩余音视频最少的课程：${candidate.title}（${candidate.remaining} 个）`);
      await save(job);
      if (msg.purpose === 'play') return navigateToCourse(job);
      return job;
    }
    if (msg.action === 'interruption-attempt') {
      requireOwner(job, msg, sender, ['course']);
      return attemptInterruption(job, msg, sender);
    }
    if (msg.action === 'interruption-failed') {
      requireOwner(job, msg, sender, ['course']);
      const episode = job.interruption;
      if (!episode || msg.episodeId !== episode.id) throw new Error('TASK_CANCELLED');
      const blocked = pageBlockingReason(msg);
      if (blocked) return save(interruptionStop(job, blocked));
      episode.reason = String(msg.reason || episode.reason || '本次恢复未成功').slice(0, 400);
      episode.status = 'failed';
      delete episode.deadline;
      if (episode.attempts >= 3) return save(interruptionStop(job,
        `连续三次恢复仍未成功，已停止任务并保留断点：${episode.reason}`));
      return save(job);
    }
    if (msg.action === 'interruption-gap') {
      requireOwner(job, msg, sender, ['course']);
      const episode = job.interruption;
      if (!episode || msg.episodeId !== episode.id) throw new Error('TASK_CANCELLED');
      const candidate = job.candidates[job.targetIndex];
      const key = episode.key || candidate.currentResource?.key;
      if (!key || msg.key !== key) throw new Error('恢复资源与当前任务不符');
      const evidence = msg.gapEvidence;
      const resource = candidate.currentResource;
      const sample = episode.positionSample || resource?.positionSample;
      if (!resource || resource.key !== key || resource.stage !== 'ready' ||
        !evidence || evidence.courseKey !== candidate.courseKey || evidence.key !== key ||
        typeof evidence.routeKey !== 'string' || !routeEquals(evidence.routeKey, resource.routeKey) ||
        !Number.isFinite(evidence.from) || !Number.isFinite(evidence.to) ||
        evidence.to <= evidence.from || (sample && Math.abs(evidence.from - sample.position) > 0.01)) {
        throw new Error('未观看区间证据无法确认');
      }
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      const page = { ...sender, url: currentTab.url };
      const liveUrl = new URL(currentTab.url);
      if (!isSite(page) || route(page) !== 'learn' || courseKey(page) !== candidate.courseKey ||
        !routeEquals(`${liveUrl.pathname}${liveUrl.hash}`, resource.routeKey)) {
        throw new Error('未观看区间页面无法确认');
      }
      preserveStopGap(job, { ...msg, gapEvidence: msg.gapEvidence }, tabId);
      const record = candidate.records?.[key];
      if (!record?.progressGap) throw new Error('未能保存恢复后的未观看区间');
      addLog(job, `恢复后发现未观看区间：${Math.floor(record.progressGap.from)}-${Math.ceil(record.progressGap.to)} 秒，继续从区间起点核对`, 'warn');
      return save(job);
    }
    if (msg.action === 'interruption-success') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      const episode = job.interruption;
      if (!episode || msg.episodeId !== episode.id || episode.courseKey !== candidate.courseKey) {
        throw new Error('TASK_CANCELLED');
      }
      const blocked = pageBlockingReason(msg);
      if (blocked) return save(interruptionStop(job, blocked));
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      const current = { ...sender, url: currentTab.url };
      if (!isSite(current) || route(current) !== 'learn' || courseKey(current) !== candidate.courseKey) {
        throw new Error('恢复后的课程或教学班尚未确认');
      }
      const resource = candidate.currentResource;
      const key = episode.key || resource?.key;
      const record = candidate.records?.[key];
      const item = candidate.directory?.items?.find(entry => entry.key === key &&
        ['video', 'audio', 'media'].includes(entry.mediaType));
      if (!key || msg.key !== key || !item || record?.progressGap) {
        throw new Error('恢复后的音视频目标或未观看区间尚未确认');
      }
      if (msg.pageConfirmed === true && !(record?.ended === true && record.confirmed === true)) {
        throw new Error('页面标记不能代替自然播放结束及平台完成确认');
      }
      if (!(record?.ended === true && record.confirmed === true)) {
        if (episode.requiresContinuityCheck === true && !episode.continuityChecked) {
          throw new Error('恢复后的播放位置尚未核对');
        }
        const evidence = msg.evidence;
        const url = new URL(currentTab.url);
        if (!resource || resource.key !== key || resource.stage !== 'ready' || !resource.routeKey ||
          !evidence || evidence.courseKey !== candidate.courseKey || evidence.key !== key ||
          typeof evidence.routeKey !== 'string' || !routeEquals(evidence.routeKey, resource.routeKey) ||
          !routeEquals(`${url.pathname}${url.hash}`, resource.routeKey) ||
          !Number.isFinite(evidence.from) || evidence.from < 0 ||
          !Number.isFinite(evidence.to) || !Number.isFinite(evidence.elapsedMs) ||
          evidence.elapsedMs < 8000 || evidence.to - evidence.from < 5 ||
          evidence.to - evidence.from > evidence.elapsedMs / 1000 + 2) {
          throw new Error('恢复后尚未持续正常播放，保留本次重试次数');
        }
      }
      delete job.interruption;
      addLog(job, msg.pageConfirmed === true
        ? '已核对原音视频的自然结束和平台确认，本次恢复次数已清零'
        : '已恢复正常播放，本次恢复次数已清零', 'ok');
      return save(job);
    }
    if (msg.action === 'directory-checkpoint') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      if (courseKey(sender) !== candidate.courseKey) throw new Error('课程身份已改变');
      const snapshot = validateDirectorySnapshot(msg.snapshot, candidate.courseKey);
      const fresh = new Map(snapshot.items.map(item => [item.key, item]));
      if (!(job.workflow === 'manual' && job.operation === 'inspect') && candidate.directory?.items?.some(item => {
        const found = fresh.get(item.key);
        return !found || found.title !== item.title || found.mediaType !== item.mediaType;
      })) throw new Error('课程目录缺少已保存的条目，已停止；请确认目录完整后继续');
      if (job.workflow === 'manual' && job.operation === 'inspect') candidate.scanDraft = snapshot;
      else candidate.directory = snapshot;
      return save(job);
    }
    if (msg.action === 'course-pass') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      if (!job.singlePass || courseKey(sender) !== candidate.courseKey ||
        !['play', 'verify', 'retry'].includes(msg.phase)) {
        throw new Error('课程核对阶段无法确认');
      }
      const pendingKeys = msg.pendingKeys ?? candidate.pass?.pendingKeys ?? [];
      const mediaKeys = new Set((candidate.directory?.items || [])
        .filter(item => ['video', 'audio', 'media'].includes(item.mediaType)).map(item => item.key));
      if (!Array.isArray(pendingKeys) || pendingKeys.some(key =>
        typeof key !== 'string' || !mediaKeys.has(key))) {
        throw new Error('待核对音视频不在已保存的课程目录中');
      }
      candidate.pass = { phase: msg.phase, pendingKeys: [...new Set(pendingKeys)] };
      return save(job);
    }
    if (msg.action === 'resource-retry') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      const item = candidate.directory?.items?.find(entry => entry.key === msg.key &&
        ['video', 'audio', 'media'].includes(entry.mediaType));
      if (!job.singlePass || courseKey(sender) !== candidate.courseKey || !item ||
        !['recovery', 'final'].includes(msg.phase) ||
        typeof msg.token !== 'string' || !msg.token.trim() || msg.token.length > 200) {
        throw new Error('音视频重试目标无法确认');
      }
      if (candidate.records?.[msg.key]?.confirmed === true) {
        throw new Error('此音视频已核对为完成，不能重试');
      }
      candidate.records ||= {};
      const previousRecord = candidate.records[msg.key] ? copy(candidate.records[msg.key]) : null;
      const previousInterruption = job.interruption ? copy(job.interruption) : null;
      const record = candidate.records[msg.key] ||= { title: item.title, attempted: true };
      const tokens = record.retryTokens?.[msg.phase] || [];
      if (tokens.includes(msg.token)) return job;
      const field = msg.phase === 'recovery' ? 'recoveryAttempts' : 'finalAttempts';
      const attempts = nonnegativeInteger(record[field]) ? record[field] : 0;
      if (attempts >= 3) throw new Error('此项音视频的本轮三次重试已用完');
      record[field] = attempts + 1;
      record.retryTokens = { ...record.retryTokens, [msg.phase]: [...tokens, msg.token] };
      record.ended = false;
      record.effectiveTarget = 100;
      record.targetReached = false;
      record.deferred = false;
      delete record.error;
      record.lastRetryReason = String(msg.reason || '音视频尚未确认完成').slice(0, 400);
      if (job.interruption?.courseKey === candidate.courseKey && job.interruption.key === msg.key) {
        delete job.interruption;
      }
      await save(job);
      if (!canOperate(job)) {
        if (previousRecord) candidate.records[msg.key] = previousRecord;
        else delete candidate.records[msg.key];
        if (previousInterruption) job.interruption = previousInterruption;
        await save(job);
        return job;
      }
      addLog(job, `重试（${record[field]}/3）：${candidate.title} / ${item.title}`);
      return save(job);
    }
    if (msg.action === 'course-refresh') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      const expectedAttempt = candidate.lastRefresh?.failed
        ? (candidate.lastRefresh.attempt || 1) + 1 : 1;
      const attempt = msg.attempt ?? expectedAttempt;
      if (!job.singlePass || typeof msg.token !== 'string' || !msg.token.trim() ||
        msg.token.length > 200 || !Number.isInteger(attempt) || attempt !== expectedAttempt ||
        attempt > 2 || (msg.key != null && !candidate.directory?.items?.some(item =>
          item.key === msg.key && ['video', 'audio', 'media'].includes(item.mediaType)))) {
        throw new Error('课程刷新检查点无法确认');
      }
      if (candidate.refreshTokens?.includes(msg.token)) return job;
      if (msg.key != null) {
        const tokens = candidate.records?.[msg.key]?.retryTokens;
        if (![...(tokens?.recovery || []), ...(tokens?.final || [])].includes(msg.token)) {
          throw new Error('本次刷新尚未保存音视频重试次数');
        }
      }
      const validTab = tab => {
        const currentPage = { url: tab.url };
        return isSite({ ...sender, url: tab.url }) && route(currentPage) === 'learn' &&
          courseKey(currentPage) === candidate.courseKey &&
          (!candidate.currentResource?.routeKey || routeEquals(
            `${new URL(tab.url).pathname}${new URL(tab.url).hash}`, candidate.currentResource.routeKey));
      };
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      if (!validTab(currentTab)) throw new Error('当前课程或资源已改变，未刷新');
      const previousRefreshTokens = [...(candidate.refreshTokens || [])];
      const previousLastRefresh = candidate.lastRefresh ? copy(candidate.lastRefresh) : null;
      candidate.refreshTokens = [...previousRefreshTokens, msg.token];
      candidate.lastRefresh = {
        token: msg.token, key: msg.key || '', attempt, phase: candidate.pass?.phase || 'play',
        reason: String(msg.reason || '刷新后核对网站显示状态').slice(0, 400)
      };
      if (job.workflow === 'manual') job.expectedRefresh = { token: msg.token, tabId,
        courseKey: candidate.courseKey, generation: job.generation, expiresAt: Date.now() + 45000 };
      addLog(job, '正在刷新课程页面，已保留当前核对阶段和重试次数');
      await save(job);
      if (!canOperate(job)) {
        candidate.refreshTokens = previousRefreshTokens;
        if (previousLastRefresh) candidate.lastRefresh = previousLastRefresh;
        else delete candidate.lastRefresh;
        await save(job);
        return job;
      }
      const latestTab = await chrome.tabs.get(tabId);
      if (!canOperate(job)) return job;
      requireOwner(job, msg, sender, ['course']);
      if (!validTab(latestTab)) throw new Error('当前课程或资源已改变，未刷新');
      try { await chrome.tabs.reload(tabId); }
      catch {
        requireOwner(job, msg, sender, ['course']);
        delete job.expectedRefresh;
        candidate.lastRefresh.failed = true;
        addLog(job, '课程页面暂时无法刷新，已保留具体音视频和重试次数', 'err');
        await save(job);
      }
      return job;
    }
    if (msg.action === 'resource-checkpoint') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      if (courseKey(sender) !== candidate.courseKey) throw new Error('课程身份已改变');
      if (typeof msg.key !== 'string' || !msg.key.trim() ||
        typeof msg.title !== 'string' || !msg.title.trim() ||
        !['opening', 'ready'].includes(msg.stage) || typeof msg.routeKey !== 'string') {
        throw new Error('音视频断点数据格式无法确认');
      }
      const matching = candidate.directory?.items?.filter(item =>
        item.key === msg.key && item.title === msg.title &&
        ['video', 'audio', 'media'].includes(item.mediaType)) || [];
      if (matching.length !== 1 || (!job.singlePass && candidate.records?.[msg.key]?.ended)) {
        throw new Error('音视频断点目标在当前目录无法确认');
      }
      let currentTab;
      try {
        // The sender document URL can retain its entry route while a SPA changes hash.
        // Read the task tab's observed browser URL; this does not navigate or call the site.
        currentTab = await chrome.tabs.get(sender.tab.id);
      } catch {
        requireOwner(job, msg, sender, ['course']);
        throw new Error('当前任务标签页无法读取，音视频断点未保存');
      }
      requireOwner(job, msg, sender, ['course']);
      let url;
      try { url = new URL(currentTab.url); }
      catch { throw new Error('当前任务标签页网址无法确认，音视频断点未保存'); }
      const currentPage = { url: url.href };
      if (url.origin !== 'https://www.beeline-ai.com' || url.username || url.password ||
        !url.pathname.startsWith('/student/') || route(currentPage) !== 'learn' ||
        courseKey(currentPage) !== candidate.courseKey) {
        throw new Error('当前任务标签页课程或教学班已改变，音视频断点未保存');
      }
      const routeKey = `${url.pathname}${url.hash}`;
      const priorRoute = candidate.currentResource?.key === msg.key
        ? candidate.currentResource.routeKey : '';
      const validRoute = msg.stage === 'opening'
        ? priorRoute ? routeEquals(msg.routeKey, priorRoute) : msg.routeKey === '' || routeEquals(msg.routeKey, routeKey)
        : routeEquals(msg.routeKey, routeKey) && (!priorRoute || routeEquals(msg.routeKey, priorRoute));
      if (!validRoute) throw new Error('音视频断点路由与当前资源不符，断点未保存');
      if (msg.stage === 'opening') {
        candidate.records ||= {};
        const previous = candidate.records[msg.key];
        candidate.records[msg.key] = {
          ...previous, title: msg.title, attempted: true,
          ended: Boolean(job.singlePass && previous?.ended === true),
          confirmed: previous?.confirmed === true
        };
      }
      candidate.currentResource = {
        key: msg.key, title: msg.title, stage: msg.stage, routeKey: msg.routeKey,
        ...(candidate.currentResource?.key === msg.key &&
          candidate.currentResource.positionSample && msg.stage === 'ready'
          ? { positionSample: candidate.currentResource.positionSample } : {})
      };
      if (job.interruption && !job.interruption.key && job.interruption.courseKey === candidate.courseKey) {
        job.interruption.key = msg.key;
        job.interruption.title = msg.title;
      }
      return save(job);
    }
    if (msg.action === 'media-observation') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      const resource = candidate.currentResource;
      if (candidate.courseKey !== courseKey(sender) || resource?.stage !== 'ready') {
        throw new Error('当前播放资源尚未核对');
      }
      const observed = validateMediaObservation(msg, resource);
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      const page = { ...sender, url: currentTab.url };
      const url = new URL(currentTab.url);
      if (!isSite(page) || route(page) !== 'learn' || courseKey(page) !== candidate.courseKey ||
        !routeEquals(`${url.pathname}${url.hash}`, observed.routeKey)) {
        throw new Error('当前页面与播放位置观察不符');
      }
      const episode = job.interruption;
      if (episode?.requiresContinuityCheck === true && !episode.continuityChecked) {
        throw new Error('恢复后的播放位置尚未核对');
      }
      const previous = resource.positionSample;
      let gapDetected = false;
      if (previous && observed.time > previous.time &&
        observed.position - previous.position > (observed.time - previous.time) / 1000 + 2) {
        const record = candidate.records?.[resource.key];
        if (!record) throw new Error('播放记录无法确认，位置观察未保存');
        const prior = record.progressGap;
        record.progressGap = {
          from: Math.min(prior?.from ?? previous.position, previous.position),
          to: Math.max(prior?.to ?? observed.position, observed.position)
        };
        record.ended = false;
        record.confirmed = false;
        gapDetected = true;
      }
      if (gapDetected) return save(job);
      return saveObservation(job, candidate, resource, observed);
    }
    if (msg.action === 'interruption-position') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      const episode = job.interruption;
      const resource = candidate.currentResource;
      if (!episode || msg.episodeId !== episode.id || !resource ||
        (episode.key || resource.key) !== msg.key || resource.stage !== 'ready') {
        throw new Error('恢复位置与保存的任务不符');
      }
      const observed = validateMediaObservation({ ...msg, time: Date.now(), allowance: 0 }, resource);
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      const page = { ...sender, url: currentTab.url };
      const url = new URL(currentTab.url);
      if (!isSite(page) || route(page) !== 'learn' || courseKey(page) !== candidate.courseKey ||
        !routeEquals(`${url.pathname}${url.hash}`, observed.routeKey)) {
        throw new Error('恢复后的页面或资源路由无法确认');
      }
      const sample = episode.positionSample || resource.positionSample;
      if ((sample && observed.position - sample.position > sample.allowance + 2) ||
        (!sample && observed.position > 2)) {
        const record = candidate.records?.[resource.key];
        if (!record) throw new Error('恢复资源播放记录无法确认');
        const prior = record.progressGap;
        const from = sample?.position ?? 0;
        record.progressGap = {
          from: Math.min(prior?.from ?? from, from),
          to: Math.max(prior?.to ?? observed.position, observed.position)
        };
        record.ended = false;
        record.confirmed = false;
        episode.gapDetected = true;
        addLog(job, '恢复页面的播放位置已前跳，已保留未观看区间，需从区间起点自然覆盖', 'warn');
      }
      episode.continuityChecked = true;
      episode.position = observed.position;
      return save(job);
    }
    if (msg.action === 'record-completions') {
      requireOwner(job, msg, sender, ['course']);
      if (!job.singlePass || !Array.isArray(msg.entries) || !msg.entries.length || msg.entries.length > 32 ||
        new Set(msg.entries.map(entry => entry?.key)).size !== msg.entries.length) {
        throw new Error('批量平台状态无法确认');
      }
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      if (!isSite({ ...sender, url: currentTab.url }) || route({ url: currentTab.url }) !== 'learn' ||
        courseKey({ url: currentTab.url }) !== candidate.courseKey) throw new Error('课程身份已改变');
      // Validate on the read copy; nothing is persisted until all entries pass.
      for (const entry of msg.entries) {
        if (!entry || !['page-marker', 'site-progress'].includes(entry.completionSource) ||
          !(entry.completionSource === 'page-marker' || entry.sitePercent >= 80)) {
          throw new Error('批量平台完成证据无法确认');
        }
        const previous = candidate.records?.[entry.key] || {};
        const item = candidate.directory?.items?.find(item => item.key === entry.key);
        applyResourceRecord(job, { ...msg, key: entry.key, result: {
          title: item?.title, confirmed: true, sitePercent: entry.sitePercent,
          completionSource: entry.completionSource, ended: Boolean(previous.ended),
          targetReached: Boolean(previous.targetReached), deferred: false
        } }, sender);
      }
      return save(job);
    }
    if (msg.action === 'record') {
      applyResourceRecord(job, msg, sender);
      return save(job);
    }
    if (msg.action === 'reload-course') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      const resource = candidate.currentResource;
      const record = candidate.records?.[msg.key];
      const round = recoveryRound(candidate);
      if (typeof msg.key !== 'string' || !resource || resource.key !== msg.key ||
        !record || record.ended || !resource.routeKey || typeof msg.routeKey !== 'string' ||
        !routeEquals(resource.routeKey, msg.routeKey) ||
        (msg.round != null && msg.round !== round) || candidate.status === 'retry') {
        throw new Error('当前音视频恢复目标无法确认，未刷新');
      }
      const validTab = tab => {
        const currentPage = { ...sender, url: tab.url };
        if (!isSite(currentPage) || route(currentPage) !== 'learn' ||
          courseKey(currentPage) !== candidate.courseKey) return false;
        const url = new URL(tab.url);
        return routeEquals(`${url.pathname}${url.hash}`, resource.routeKey);
      };
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      if (!validTab(currentTab)) throw new Error('当前课程或资源已改变，未刷新');
      const recovery = recordRecovery(candidate, record.recovery, null);
      if (recovery.reloads >= 1) throw new Error('本轮已刷新过学习页，将稍后重试');
      record.recovery = {
        ...recovery, reloads: recovery.reloads + 1,
        lastReason: String(msg.reason || recovery.lastReason || '播放恢复失败').slice(0, 400)
      };
      if (job.workflow === 'manual') job.expectedRefresh = { token: String(Date.now()), tabId,
        courseKey: candidate.courseKey, generation: job.generation, expiresAt: Date.now() + 45000 };
      addLog(job, '正在刷新当前学习页，已保存课程和音视频断点');
      await save(job);
      if (!canOperate(job)) return job;
      // A pause or route change can arrive while the checkpoint is saved.
      // Recheck after persistence before authorizing the one normal reload.
      const latestTab = await chrome.tabs.get(tabId);
      if (!canOperate(job)) return job;
      requireOwner(job, msg, sender, ['course']);
      if (!validTab(latestTab)) throw new Error('当前课程或资源已改变，未刷新');
      try { await chrome.tabs.reload(tabId); }
      catch {
        requireOwner(job, msg, sender, ['course']);
        let afterFailure;
        try { afterFailure = await chrome.tabs.get(tabId); }
        catch { throw new Error('任务学习页已关闭，无法继续恢复'); }
        requireOwner(job, msg, sender, ['course']);
        if (!validTab(afterFailure)) throw new Error('当前课程或资源已改变，未继续恢复');
        delete job.expectedRefresh;
        record.recovery.reloadFailed = true;
        record.recovery.lastReason = '学习页暂时无法刷新，已保留断点，稍后自动重试';
        addLog(job, record.recovery.lastReason);
        await save(job);
        requireOwner(job, msg, sender, ['course']);
      }
      return job;
    }
    if (msg.action === 'course-result') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      if (courseKey(sender) !== candidate.courseKey) throw new Error('课程身份已改变');
      const result = msg.result;
      if (!result || !Number.isInteger(result.total) || result.total < 0 ||
        !Number.isInteger(result.remaining) || result.remaining < 0 || result.remaining > result.total) {
        throw new Error('课程音视频数量未确认，不能结束任务');
      }
      const directory = job.workflow === 'manual' && job.operation === 'inspect' ? candidate.scanDraft || candidate.directory : candidate.directory;
      const mediaCount = directory?.items?.filter(item =>
        ['video', 'audio', 'media'].includes(item.mediaType)).length;
      if (!Array.isArray(directory?.items) || (!directory.items.length && job.workflow !== 'manual') || directory.courseKey !== candidate.courseKey ||
        result.total !== mediaCount) {
        throw new Error('课程结果与已保存的完整目录不符，不能标记完成；请核对目录后继续');
      }
      if (job.workflow === 'manual' && job.operation === 'inspect') {
        if (job.selectedIndex !== job.targetIndex) throw new Error('TASK_CANCELLED');
        const oldRecords = candidate.directory?.courseKey === candidate.courseKey ? candidate.records || {} : {};
        candidate.records = Object.fromEntries(directory.items.filter(item => ['video', 'audio', 'media'].includes(item.mediaType)).map(item => [item.key, {
          ...oldRecords[item.key], title: item.title, confirmed: item.observedCompleted === true
        }]));
        candidate.directory = directory;
        delete candidate.scanDraft;
        candidate.total = result.total;
        candidate.remaining = result.remaining;
        candidate.unfinished = uniqueTexts(result.unfinished || []);
        candidate.failures = []; candidate.unconfirmed = [];
        candidate.status = result.remaining === 0 ? 'complete' : 'inspected';
        candidate.scannedAt = Date.now(); candidate.scanState = 'ready';
        delete candidate.scanError;
        if (job.learnAfterScan && result.remaining > 0) {
          const previousGeneration = job.generation;
          job.generation += 1;
          job.operation = 'play'; job.targetPurpose = 'play';
          delete job.learnAfterScan;
          for (const key of ['pass', 'finalPass', 'lastRefresh', 'refreshTokens', 'currentResource', 'retryAt']) delete candidate[key];
          candidate.previousRecords = copy(candidate.records);
          candidate.records = Object.fromEntries(Object.entries(candidate.records).filter(([, record]) => record.confirmed));
          addLog(job, `本课目录已核对，按用户授权开始学习：${candidate.title}`);
          return saveOwnerHandoff(job, previousGeneration);
        }
        return save(awaitSelection(job, `本课扫描完成：${candidate.title}，待完成 ${result.remaining}/${result.total} 项；等待用户选择。`));
      }
      const outstanding = outstandingRecords(candidate, job.singlePass);
      const unverifiedMedia = job.singlePass && job.targetPurpose === 'play'
        ? directory.items.filter(item => ['video', 'audio', 'media'].includes(item.mediaType) &&
          candidate.records?.[item.key]?.confirmed !== true)
        : [];
      candidate.total = result.total;
      candidate.unfinished = uniqueTexts([...(result.unfinished || []),
        ...outstanding.filter(record => (record.started || record.attempted) && !record.ended &&
          !(job.singlePass && (record.targetReached || record.deferred || record.confirmed))).map(record => record.title)]);
      candidate.unconfirmed = uniqueTexts([...(result.unconfirmed || []),
        ...outstanding.filter(record => (record.ended || (job.singlePass && record.targetReached)) &&
          !record.confirmed).map(record => record.title),
        ...unverifiedMedia.map(item => item.title)]);
      candidate.failures = uniqueTexts([...(result.failures || []),
        ...outstanding.filter(record => record.error).map(record => `${record.title}：${record.error}`)]);
      candidate.remaining = Math.max(result.remaining, outstanding.length, unverifiedMedia.length,
        candidate.unfinished.length, candidate.unconfirmed.length, candidate.failures.length);
      const complete = candidate.remaining === 0;
      if (job.targetPurpose === 'inspect') {
        candidate.status = complete ? 'complete' : 'inspected';
        job.inspectIndex += 1;
        addLog(job, `已统计 ${candidate.title}：待处理 ${candidate.remaining}/${candidate.total} 个音视频`);
      } else {
        if (job.singlePass) {
          if (result.finalPass !== true && msg.finalPass !== true) {
            throw new Error('课程本轮最终核对尚未完成');
          }
          candidate.finalPass = true;
          candidate.status = complete ? 'completed' : 'manual';
          delete candidate.retryAt;
          if (job.interruption?.courseKey === candidate.courseKey) delete job.interruption;
        } else if (complete) {
          candidate.status = 'completed';
          delete candidate.retryAt;
        } else scheduleCourseRetry(candidate);
        addLog(job, complete
          ? `${candidate.title}：音视频均有页面完成标记`
          : job.singlePass
            ? `${candidate.title}：${candidate.remaining} 个音视频尚未确认完成，已保留具体提醒并继续其他课程`
            : `${candidate.title}：${candidate.remaining} 个音视频待重试，稍后自动继续`,
        candidate.remaining ? (job.singlePass ? 'err' : 'warn') : 'ok');
      }
      if (job.workflow === 'manual') {
        if (job.selectedIndex !== job.targetIndex) throw new Error('TASK_CANCELLED');
        candidate.scannedAt = Date.now();
        return save(awaitSelection(job, `本课处理结束：${candidate.title}；未确认项已保留，请自行选择下一门课程。`));
      }
      if (job.scope === 'single') {
        if (complete || job.singlePass) return finish(job);
        const previousGeneration = job.generation;
        job.generation += 1;
        return saveOwnerHandoff(job, previousGeneration);
      }
      return returnHome(job, tabId);
    }
    if (msg.action === 'finish') {
      requireOwner(job, msg, sender, ['home']);
      if (job.inspectIndex < job.candidates.length ||
        job.candidates.some(c => {
          if (job.singlePass && c.status === 'manual' && c.finalPass === true) return false;
          return !['complete', 'completed'].includes(c.status) ||
            !Number.isInteger(c.remaining) || c.remaining < 0 ||
            c.remaining !== 0 || outstandingRecords(c, job.singlePass).length;
        })) {
        throw new Error('仍有课程尚未处理');
      }
      return finish(job);
    }
    if (msg.action === 'log') {
      requireOwner(job, msg, sender, ['go-agent', 'entry-home', 'scan-home', 'home', 'opening', 'course']);
      addLog(job, String(msg.text).slice(0, 400), msg.type, { time: msg.time, id: msg.id });
      return saveLog(job);
    }
    throw new Error('自动任务命令未识别');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.channel !== CHANNEL) return;
    const pendingCancellation = fenceCancellation(msg, sender);
    serial(() => handle(msg, sender)).then(
      job => sendResponse({ ok: true, job, tabId: sender.tab?.id }),
      error => sendResponse({ ok: false, error: error.message,
        ...(msg.action === 'reset' && isSite(sender)
          ? { job: emergencyJob || lastKnownJob, tabId: sender.tab.id } : {}) })
    ).finally(() => {
      if (pendingCancellation) pendingCancellations = pendingCancellations.filter(item => item !== pendingCancellation);
    });
    return true;
  });

  // Settings are shared by all pages. Keep the task's default in sync without
  // changing ownership, generations, completed records or forced retry targets.
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes || {}, 'wb-playback-target')) return;
    serial(async () => {
      const value = (await chrome.storage.local.get('wb-playback-target'))['wb-playback-target'];
      const target = validTargetPercent(value) ? value : 100;
      const job = await read();
      if (!job?.singlePass || ['idle', 'resetting'].includes(job.phase) || job.targetPercent === target) return;
      job.targetPercent = target;
      await save(job);
    }).catch(console.error);
  });

  chrome.runtime.onInstalled?.addListener(() => {
    serial(async () => {
      const job = await read();
      if (!job || job.workflow === 'manual' || ['idle', 'resetting'].includes(job.phase)) return;
      pause(job, '助手已更新为按需模式，请获取课程列表后选择课程。');
      job.phase = 'interrupted';
      await save(job);
    }).catch(console.error);
  });

  chrome.tabs.onCreated.addListener(tab => {
    const createdAt = Date.now();
    serial(async () => {
      const job = await read();
      const latePausedOpening = !job?.running && ['paused', 'manual'].includes(job?.phase) && job.resumePhase === 'opening';
      const authorizedOpening = (job?.running && job.phase === 'opening' || latePausedOpening) &&
        tab.openerTabId === job.homeTabId;
      if (!authorizedOpening && ['idle', 'resetting'].includes(job?.phase) &&
        tab.openerTabId === job.resetOpeningParentId && createdAt <= job.resetOpeningUntil) {
        // A page can arrive after its old click's reset snapshot. Keep it
        // stopped, without restoring erased course or resource information.
        job.resetHoldTabIds = [...new Set([...job.resetHoldTabIds, tab.id])];
        await save(job);
        return;
      }
      if ((!job?.running || job.phase !== 'opening') && !latePausedOpening) return;
      if (tab.openerTabId !== job.homeTabId) return;
      if (job.workerTabId != null) {
        await save(pause(job, '一次选课打开了多个标签页，已停止，请核对页面。', true));
        return;
      }
      job.createdTabIds.push(tab.id);
      job.workerTabId = tab.id;
      bindOwnerInstance(job, tab.id, null);
      await save(job);
    }).catch(console.error);
  });
  chrome.tabs.onRemoved.addListener(id => {
    serial(async () => {
      const job = await read();
      if (job?.resetHoldTabIds?.includes(id)) {
        job.resetHoldTabIds = job.resetHoldTabIds.filter(tabId => tabId !== id);
        await save(job);
      }
      if (!job?.running || ![job.homeTabId, job.workerTabId].includes(id)) return;
      await save(pause(job, '任务页面已关闭，自动任务已停止。请回到首页重新开始。', true));
    }).catch(console.error);
  });
})();
