/* Modified from WuXinbo-bo/xinwei-watcher: task controls and playback safeguards, 2026-10-16. */
(() => {
  'use strict';

  const CFG = {
    pollInterval: 1000,
    directoryRefreshInterval: 10000,
    directoryLoadTimeout: 30000,
    directoryStableTime: 1500,
    mediaLoadTimeout: 20000,
    confirmationTimeout: 60000,
    stallTimeout: 90000,
    gatewayPauseGrace: 5000,
    gatewayRetryDelayMin: 8000,
    gatewayRetryDelayMax: 12000,
    gatewayRecoveryTimeout: 90000,
    gatewayRetryLimit: 1,
    recoveryAttempts: 3,
    interruptionStableMs: 8000,
    interruptionMinProgress: 5,
    mediaObservationInterval: 3000,
    recoveryWaitMin: 1500,
    recoveryWaitMax: 3500,
    resourceRetryDelay: 30000,
    seekTolerance: 2,
    identityStableTime: 750,
    backgroundRetryDelay: 300,
    beforeClickDelayMin: 120,
    beforeClickDelayMax: 360,
    hoverDelayMin: 80,
    hoverDelayMax: 220,
    afterExpandDelayMin: 300,
    afterExpandDelayMax: 900,
    cooldownMin: 1800,
    cooldownMax: 3200,
    blockingText: [
      '系统检测到你的学习状态异常',
      '学习状态异常',
      '请刷新后继续学习',
      '验证码',
      '安全验证',
      '登录已过期',
      '请先登录'
    ]
  };

  const state = {
    running: false,
    mode: 'idle',
    playedCount: 0,
    confirmedCount: 0,
    manualItems: [],
    currentItemKey: '',
    pendingItems: [],
    videoItems: [],
    playedKeys: new Set(),
    endedKeys: new Set(),
    timer: null,
    logBox: null,
    logNewButton: null,
    logEntries: [],
    pendingLogEntries: new Map(),
    logRendered: false,
    logUnreadCount: 0,
    logHasUrgentNotice: false,
    logUrgentReason: '',
    logSerial: 0,
    renderingLogs: false,
    currentRoute: 'other',
    currentRouteKey: '',
    lastDirectoryRefresh: 0,
    manualNotice: '',
    lastLoggedItemKey: '',
    lastConfirmedCount: null,
    courseCompleteLogged: false,
    epoch: 0,
    processedItems: new Map(),
    job: null,
    jobPromise: null,
    instanceId: '',
    tabId: null,
    syncPromise: null,
    storageFailed: false,
    reloadPending: false,
    reloadTimer: null,
    reloadToken: null,
    processedCourseKey: '',
    resourceCheckpoint: null,
    homePageTransition: null,
    routeRecoveryPending: false,
    mediaLoadingHold: null,
    localMediaStop: null,
    startPending: false,
    pausePending: false,
    pauseRequestInFlight: false,
    playbackTarget: 100,
    playbackTargetReady: null,
    playbackTargetRevision: 0,
    playbackTargetWrites: Promise.resolve(),
    playbackTargetPendingWrites: 0,
    playbackTargetPendingChange: null,
    playbackTargetSync: null,
    panelExpanded: false,
    uiPosition: null,
    stopSequence: 0,
    resetEpoch: 0,
    resetSequence: 0,
    resetPending: false,
    resetRequest: null,
    pendingResetFromEpoch: null,
    resetMediaHold: false,
    durationCache: new WeakMap(),
    playbackDiagnostics: {
      version: 1, startedAt: Date.now(), entry: null, takeover: null,
      handshake: [], guards: [], mediaEvents: [], pauses: [], directory: []
    }
  };

  const MAX_PENDING_LOG_ENTRIES = 80;

  const JOB_CHANNEL = 'xinwei-job';

  const SELECTORS = {
    menuItems: [
      '.section-item',
      '[class*="section-item"]',
      '[class*="catalog-item"]',
      '[class*="directory-item"]',
      'li.el-menu-item[role="menuitem"]',
      'li.el-menu-item',
      '.el-menu-item[role="menuitem"]',
      '.el-menu-item',
      'div.section-content',
      '.section-content',
      '.section-area .section-content',
      'ul.el-menu.el-menu--inline li',
      '.courseware-list li',
      '.courseware-list-item',
      '.catalog-list li',
      '.directory-list li'
    ],
    videoIcons: [
      'i.unStart-icon',
      'i.inProgress-icon',
      'i.done-icon',
      'i[class*="unStart"]',
      'i[class*="inProgress"]',
      'i[class*="done"]',
      '.unStart-icon',
      '.inProgress-icon',
      '.done-icon',
      'i[class*="audio"]',
      'i[class*="music"]',
      'i[class*="video"]',
      'i[class*="play"]',
      '[class*="audio-icon"]',
      '[class*="music-icon"]',
      '[class*="video-icon"]',
      '[class*="play-icon"]',
      'svg[class*="audio"]',
      'svg[class*="music"]',
      'svg[class*="video"]',
      'svg[class*="play"]'
    ],
    pendingIcons: [
      'i.unStart-icon',
      'i.inProgress-icon',
      'i[class*="unStart"]',
      'i[class*="inProgress"]',
      '.unStart-icon',
      '.inProgress-icon'
    ],
    doneIcons: [
      'i.done-icon',
      'i[class*="done"]',
      '.done-icon'
    ],
    chapterRoots: [
      'li.el-sub-menu',
      'li.el-menu-item-group',
      '.el-menu-item-group',
      '.section-area',
      '.courseware-chapter',
      '.chapter-item',
      '.catalog-chapter'
    ],
    chapterTitles: [
      '.el-sub-menu__title',
      '.el-menu-item-group__title',
      '.section-area .el-menu-item-group__title',
      '.courseware-tab-header',
      '.courseware-chapter__title',
      '.courseware__chapter-head',
      '.courseware-chapter-main__title',
      '.chapter-title',
      '.catalog-title'
    ],
    progressTexts: [
      '.progress-text',
      '.study-progress',
      '.course-progress',
      '.video-progress',
      '.current-progress',
      '[class*="progress"]'
    ],
    mediaRoots: [
      'video',
      'audio',
      '.video-js video',
      '.vjs-tech',
      '.audio-player audio',
      '.player-wrapper video',
      '.player-wrapper audio'
    ]
  };

  function normalizeLogEntries(entries) {
    const recent = entries.slice(-80);
    const occurrences = new Map();
    const fallbackKeys = new Array(recent.length);
    // Old saved tasks have no log ids. Count equal legacy rows from the end
    // so removing old rows from the front does not rename the surviving rows.
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const entry = recent[index];
      const time = Number.isFinite(entry?.time) ? entry.time : Date.now();
      const text = String(entry?.text ?? '');
      const type = ['ok', 'err'].includes(entry?.type) ? entry.type : 'info';
      const signature = JSON.stringify([time, type, text]);
      const occurrence = occurrences.get(signature) || 0;
      occurrences.set(signature, occurrence + 1);
      fallbackKeys[index] = `${signature}:${occurrence}`;
    }
    return recent.map((entry, index) => {
      const time = Number.isFinite(entry?.time) ? entry.time : Date.now();
      const text = String(entry?.text ?? '');
      const type = ['ok', 'err'].includes(entry?.type) ? entry.type : 'info';
      const id = typeof entry?.id === 'string' && entry.id ? entry.id : '';
      return { time, text, type, id, key: id || entry?.key || fallbackKeys[index] };
    });
  }

  function logVisibleRange(entries = state.logEntries) {
    if (!state.logBox || !entries.length) return null;
    const nodes = [...state.logBox.children];
    if (!nodes.length) return null;
    const boxRect = state.logBox.getBoundingClientRect();
    const top = boxRect.top + (state.logBox.clientTop || 0);
    const height = state.logBox.clientHeight;
    if (height > 0) {
      const bottom = top + height;
      let first = -1, last = -1;
      nodes.forEach((node, index) => {
        const rect = node.getBoundingClientRect();
        if (rect.bottom > top && rect.top < bottom) {
          if (first < 0) first = index;
          last = index;
        }
      });
      if (first >= 0) return { first, last };
    }
    const atBottom = state.logBox.scrollTop + state.logBox.clientHeight >=
      state.logBox.scrollHeight - 1;
    return atBottom ? { first: nodes.length - 1, last: nodes.length - 1 } : null;
  }

  function logIsNearLatest(entries = state.logEntries) {
    if (!entries.length) return true;
    const box = state.logBox;
    if (box && box.scrollTop + box.clientHeight >= box.scrollHeight - 1) return true;
    const range = logVisibleRange(entries);
    // A missing layout range occurs only before layout or in DOM-only test
    // environments. In a real panel, visible rows provide the threshold.
    return range ? entries.length - 1 - range.first <= 12 : false;
  }

  function captureLogAnchor() {
    const range = logVisibleRange();
    if (!range) return null;
    const nodes = [...state.logBox.children];
    const node = nodes[range.first];
    if (!node) return null;
    return {
      key: node.dataset.logKey,
      oldIndex: range.first,
      top: node.getBoundingClientRect().top,
      oldKeys: nodes.map(item => item.dataset.logKey)
    };
  }

  function updateLogNewButton() {
    const button = state.logNewButton;
    if (!button) return;
    const show = state.logUnreadCount > 0 || state.logHasUrgentNotice;
    button.hidden = !show;
    button.classList.toggle('is-urgent', state.logHasUrgentNotice);
    if (state.logHasUrgentNotice) {
      button.textContent = state.logUnreadCount > 0
        ? `有新提醒和 ${state.logUnreadCount} 条新日志，跳到最新`
        : '有新的人工提醒，查看最新日志';
    } else {
      button.textContent = `有 ${state.logUnreadCount} 条新日志，跳到最新`;
    }
  }

  function renderLogEntries(entries, { reset = false, urgent = false } = {}) {
    if (!state.logBox) return;
    if (reset) {
      state.logEntries = [];
      state.pendingLogEntries.clear();
      state.logRendered = false;
      state.logUnreadCount = 0;
      state.logHasUrgentNotice = false;
      state.logUrgentReason = '';
      state.logBox.replaceChildren();
      updateLogNewButton();
      return;
    }

    const nextEntries = normalizeLogEntries(entries);
    const previousEntries = state.logEntries;
    const firstRender = !state.logRendered;
    const unchanged = !firstRender && nextEntries.length === previousEntries.length &&
      nextEntries.every((entry, index) => entry.key === previousEntries[index].key &&
        entry.time === previousEntries[index].time && entry.text === previousEntries[index].text &&
        entry.type === previousEntries[index].type);
    if (unchanged) {
      state.logHasUrgentNotice = state.logHasUrgentNotice || (urgent && !logIsNearLatest());
      updateLogNewButton();
      return;
    }
    const wasNearLatest = firstRender || logIsNearLatest(previousEntries);
    const anchor = firstRender ? null : captureLogAnchor();
    const previousKeys = new Set(previousEntries.map(entry => entry.key));
    const addedEntries = firstRender ? [] : nextEntries.filter(entry => !previousKeys.has(entry.key));
    const oldKeys = anchor?.oldKeys || [];

    state.renderingLogs = true;
    state.logBox.replaceChildren();
    for (const entry of nextEntries) {
      const div = document.createElement('div');
      div.className = 'wb-log-entry';
      div.dataset.logKey = entry.key;
      div.textContent = `[${new Date(entry.time).toLocaleTimeString()}] ${entry.text}`;
      div.style.color = entry.type === 'ok' ? '#1a7f37' : entry.type === 'err' ? '#d1242f' : '#666';
      state.logBox.appendChild(div);
    }
    state.logEntries = nextEntries;
    state.logRendered = true;

    if (wasNearLatest) {
      state.logBox.scrollTop = state.logBox.scrollHeight;
      state.logUnreadCount = 0;
      state.logHasUrgentNotice = false;
    } else if (anchor && nextEntries.length) {
      const nextKeys = new Set(nextEntries.map(entry => entry.key));
      let anchorKey = anchor.key;
      if (!nextKeys.has(anchorKey)) {
        // If the row being read was trimmed, keep its next retained row at
        // the same viewport position instead of jumping to the newest log.
        anchorKey = oldKeys.slice(anchor.oldIndex + 1).find(key => nextKeys.has(key)) ||
          nextEntries[0].key;
      }
      const nextNode = [...state.logBox.children].find(node => node.dataset.logKey === anchorKey);
      if (nextNode) {
        const topDelta = nextNode.getBoundingClientRect().top - anchor.top;
        const maxScroll = Math.max(0, state.logBox.scrollHeight - state.logBox.clientHeight);
        state.logBox.scrollTop = Math.min(maxScroll, Math.max(0, state.logBox.scrollTop + topDelta));
      }
      state.logUnreadCount += addedEntries.length;
      state.logHasUrgentNotice = state.logHasUrgentNotice || urgent ||
        addedEntries.some(entry => entry.type === 'err');
    } else if (!wasNearLatest) {
      state.logUnreadCount += addedEntries.length;
      state.logHasUrgentNotice = state.logHasUrgentNotice || urgent ||
        addedEntries.some(entry => entry.type === 'err');
    }
    state.renderingLogs = false;
    updateLogNewButton();
  }

  function appendLog(msg, type = 'info', time = Date.now()) {
    const entry = { id: `${state.instanceId}:${++state.logSerial}`, text: msg, type, time };
    if (state.logBox) renderLogEntries([...state.logEntries, entry]);
    return entry;
  }

  function mergePendingLogEntries(entries) {
    const merged = Array.isArray(entries) ? [...entries] : [];
    const receivedIds = new Set(merged.map(entry => entry?.id).filter(id => typeof id === 'string' && id));
    for (const id of receivedIds) state.pendingLogEntries.delete(id);
    for (const [id, entry] of state.pendingLogEntries) {
      if (receivedIds.has(id)) continue;
      const time = Number.isFinite(entry.time) ? entry.time : Date.now();
      let insertAt = -1;
      for (let index = 0; index < merged.length; index += 1) {
        const otherTime = Number.isFinite(merged[index]?.time) ? merged[index].time : 0;
        if (otherTime <= time) insertAt = index;
        else break;
      }
      merged.splice(insertAt + 1, 0, entry);
    }
    return merged;
  }

  function log(msg, type = 'info', persist = true) {
    const prefix = type === 'ok' ? '✅' : type === 'err' ? '⚠️' : 'ℹ️';
    console.log(`${prefix} ${msg}`);
    const entry = appendLog(msg, type);
    if (persist && state.running && state.job?.running && state.job.ownerInstance === state.instanceId) {
      state.pendingLogEntries.set(entry.id, entry);
      while (state.pendingLogEntries.size > MAX_PENDING_LOG_ENTRIES) {
        const oldestId = state.pendingLogEntries.keys().next().value;
        if (oldestId === undefined) break;
        state.pendingLogEntries.delete(oldestId);
      }
      jobCommand('log', { text: msg, type, time: entry.time, id: entry.id }).catch(error => {
        // A diagnostic write is not a task checkpoint. Keep the local log
        // without stopping playback when only this optional write fails.
        if (!(error instanceof TaskCancelled)) console.warn('任务日志暂未保存：', error.message);
      });
    }
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setCurrentTask(title) {
    setText('wb-current', title || '尚未开始');
  }

  function getInstanceId() {
    // Each content document has its own identity, even when sessionStorage is copied by an opener.
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function jobResetEpoch(job) {
    return Number.isSafeInteger(job?.resetEpoch) && job.resetEpoch >= 0 ? job.resetEpoch : 0;
  }

  async function jobCommand(action, data = {}) {
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('扩展后台不可用，请重新加载扩展和页面');
    const resetSequence = state.resetSequence;
    const resetRequest = action === 'reset' ? state.resetRequest : null;
    const requestResetEpoch = state.resetEpoch;
    const handshakeBefore = ['get', 'hello'].includes(action) ? observeHandshake(action, 'before') : null;
    let response;
    const message = {
        channel: JOB_CHANNEL, action, instanceId: state.instanceId,
        runId: state.job?.runId, generation: state.job?.generation,
        ...data, resetEpoch: requestResetEpoch
      };
    if (action === 'hello') {
      const active = document.querySelector('li.el-menu-item.is-active');
      message.documentRouteKey = getRouteKey();
      message.activeResourceKey = active ? getItemKey(active) : '';
    }
    if (['get', 'hello', 'interruption-attempt'].includes(action)) {
      const blocked = getBlockingNotice() || getPlaybackBlockingDialog();
      if (blocked) message.pageBlocked = `页面提示“${blocked}”，请按网站要求处理`;
    }
    if (['pause', 'manual'].includes(action)) {
      const resource = state.resourceCheckpoint || currentCandidate()?.currentResource;
      const gap = resource && state.processedItems.get(resource.key)?.progressGap;
      if (gap && Number.isFinite(gap.from) && Number.isFinite(gap.to)) {
        message.gapEvidence = { key: resource.key, from: gap.from, to: gap.to,
          round: Number(currentCandidate()?.retryRounds) || 0, courseKey: currentCourseKey() };
      }
    }
    const stoppedBeforeRequest = state.stopSequence;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await chrome.runtime.sendMessage(message);
        break;
      } catch (error) {
        if (resetSequence !== state.resetSequence || stoppedBeforeRequest !== state.stopSequence) throw new TaskCancelled();
        const reconnectable = ['get', 'hello'].includes(action);
        const checkpoint = ['record', 'resource-checkpoint', 'directory-checkpoint',
          'media-observation', 'interruption-position', 'interruption-gap',
          'course-pass', 'resource-retry'].includes(action);
        if (attempt >= 2 || (!reconnectable && !checkpoint) || /context invalidated/i.test(error?.message || '')) {
          throw new Error('无法连接扩展后台，已停止自动操作，请重新加载扩展和页面');
        }
        await new Promise(resolve => setTimeout(resolve, CFG.backgroundRetryDelay));
        if (resetSequence !== state.resetSequence || stoppedBeforeRequest !== state.stopSequence) throw new TaskCancelled();
        if (checkpoint) {
          // These writes are idempotent. Before replaying an uncertain write,
          // establish that the same document still owns the same generation.
          let current;
          try { current = await chrome.runtime.sendMessage({ ...message, action: 'get' }); }
          catch { throw new Error('任务检查点保存状态无法确认，已停止自动操作'); }
          if (!current?.ok || !current.job) throw new Error('任务检查点保存状态无法确认，已停止自动操作');
          const job = current.job;
          if (job.runId !== message.runId || job.generation !== message.generation ||
            !job.running || job.ownerTabId !== state.tabId || job.ownerInstance !== state.instanceId ||
            jobResetEpoch(job) !== requestResetEpoch) {
            acceptJob(job);
            throw new TaskCancelled();
          }
          if (resetSequence !== state.resetSequence || stoppedBeforeRequest !== state.stopSequence) throw new TaskCancelled();
          acceptJob(job);
        }
      }
    }
    const currentResetRequest = action === 'reset' && resetRequest && resetRequest === state.resetRequest;
    if (resetSequence !== state.resetSequence && action !== 'get' && !currentResetRequest) {
      throw new TaskCancelled();
    }
    if (response?.job && jobResetEpoch(response.job) < state.resetEpoch) throw new TaskCancelled();
    if (!response?.ok) {
      if (currentResetRequest && ['idle', 'resetting'].includes(response?.job?.phase) &&
        (jobResetEpoch(response.job) > requestResetEpoch ||
          (jobResetEpoch(response.job) === state.resetEpoch && response.job.runId === state.job?.runId))) {
        if (Number.isInteger(response.tabId)) state.tabId = response.tabId;
        acceptJob(response.job);
      }
      if (resetSequence !== state.resetSequence && !currentResetRequest) throw new TaskCancelled();
      if (currentResetRequest && response?.error === 'TASK_CANCELLED') {
        throw new Error('任务状态刚刚发生变化，本次重置未确认完成；请重试重置。');
      }
      if (response?.error === 'TASK_CANCELLED') throw new TaskCancelled();
      throw new Error(response?.error || '任务状态无法确认');
    }
    if (state.pendingResetFromEpoch != null &&
      jobResetEpoch(response.job) <= state.pendingResetFromEpoch) throw new TaskCancelled();
    const previousTabId = state.tabId;
    // Give the document its tab identity before applying the job. Reset hold
    // membership and task-page checks depend on this value.
    state.tabId = response.tabId;
    if (!acceptJob(response.job)) throw new TaskCancelled();
    if (action !== 'get' && action !== 'reset' && requestResetEpoch !== state.resetEpoch) {
      throw new TaskCancelled();
    }
    // A newer pause/reset broadcast can arrive before the first get reply.
    if (previousTabId !== state.tabId) pauseForStoppedTask();
    if (handshakeBefore && resetSequence === state.resetSequence) {
      const after = observeHandshake(action, 'after');
      // Loading titles can fill the bounded retry list. Preserve the first
      // successful takeover independently, without retaining job identities.
      if (action === 'hello' && !handshakeBefore.owns && after.owns &&
        !state.playbackDiagnostics.takeover) {
        state.playbackDiagnostics.takeover = { before: handshakeBefore, after };
      }
    }
    return state.job;
  }

  function clearLocalTask(holdMedia = false) {
    state.resetSequence += 1;
    state.stopSequence += 1;
    state.epoch += 1;
    state.running = false;
    state.mode = 'idle';
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.resetMediaHold = holdMedia;
    if (holdMedia) pauseMedia('extension-reset');
    state.playedCount = 0;
    state.confirmedCount = 0;
    state.manualItems = [];
    state.currentItemKey = '';
    state.pendingItems = [];
    state.videoItems = [];
    state.playedKeys.clear();
    state.endedKeys.clear();
    state.processedItems.clear();
    state.processedCourseKey = '';
    state.resourceCheckpoint = null;
    state.homePageTransition = null;
    state.routeRecoveryPending = false;
    state.mediaLoadingHold = null;
    state.localMediaStop = null;
    state.manualNotice = '';
    state.lastDirectoryRefresh = 0;
    state.lastLoggedItemKey = '';
    state.lastConfirmedCount = null;
    state.courseCompleteLogged = false;
    state.registeredRunId = '';
    state.activeGeneration = null;
    state.storageFailed = false;
    state.startPending = false;
    state.pausePending = false;
    state.pauseRequestInFlight = false;
    state.reloadPending = false;
    if (state.reloadTimer) clearTimeout(state.reloadTimer);
    state.reloadTimer = null;
    state.reloadToken = null;
    state.durationCache = new WeakMap();
    state.playbackDiagnostics = {
      version: 1, startedAt: Date.now(), entry: null, takeover: null,
      handshake: [], guards: [], mediaEvents: [], pauses: [], directory: []
    };
    clearPageNotice();
    renderLogEntries([], { reset: true });
    renderVideoDirectory([], []);
    renderManualItems([]);
    setText('wb-status', '未开始');
    setText('wb-job-summary', '尚未开始');
    setText('wb-count', '0');
    setText('wb-confirmed', '0');
    setText('wb-progress', '-');
    setText('wb-course-progress', '未识别');
    setText('wb-course', getRoute() === 'agent' ? '首页' : getRoute() === 'home' ? '课表' : getRoute() === 'site' ? '网站页面' : '尚未识别');
    setCurrentTask('尚未开始');
    // Keep jobPromise/syncPromise until their cancelled work reaches finally.
    // Clearing those references here would allow two executors to overlap.
  }

  function jobManualItems(job) {
    const result = [];
    for (const candidate of job?.candidates || []) {
      if (job.running && !job.singlePass && ['retry', 'inspected'].includes(candidate.status)) continue;
      const failedRecords = Object.values(candidate.records || {}).filter(record =>
        record.error && (!job?.singlePass || !job.running || candidate.finalPass === true));
      const failedTitles = new Set(failedRecords.map(record => record.title));
      // Inspection and recovery can leave unfinished records that the task
      // will still handle automatically. Only the completed attempt's manual
      // result makes these records reminders.
      if (candidate.status === 'manual') {
        const unfinished = new Set(candidate.unfinished || []);
        for (const title of unfinished) {
          if (!failedTitles.has(title)) result.push(`${candidate.title} / ${title}：尚未播放至自然结束`);
        }
        for (const title of candidate.unconfirmed || []) {
          if (!unfinished.has(title) && !failedTitles.has(title)) {
            result.push(`${candidate.title} / ${title}：平台状态待确认`);
          }
        }
      }
      for (const failure of candidate.failures || []) {
        result.push(`${candidate.title} / ${failure}`);
      }
      for (const record of failedRecords) {
        if (!(candidate.failures || []).some(failure => failure.includes(`${record.title}：`))) {
          result.push(`${candidate.title} / ${record.title}：${record.error}`);
        }
      }
      if (candidate.status === 'manual' && !candidate.unfinished?.length &&
        !candidate.unconfirmed?.length && !candidate.failures?.length && !failedRecords.length) {
        result.push(`${candidate.title}：音视频尚未确认完成`);
      }
    }
    if (job?.reason && ['manual', 'interrupted'].includes(job.phase)) result.unshift(job.reason);
    return [...new Set(result)];
  }

  function isTaskPage(job = state.job) {
    return Number.isInteger(state.tabId) && job &&
      [job.homeTabId, job.workerTabId, job.returningTabId].includes(state.tabId);
  }

  function getStartControl(job = state.job) {
    const route = getRoute();
    const stopped = job && ['paused', 'manual'].includes(job.phase);
    const restart = ['agent', 'home', 'site'].includes(route) && stopped &&
      (Number.isInteger(state.tabId) && !isTaskPage(job) ||
        (job.ownerTabId === state.tabId && (job.resumePhase === 'course' ||
          (route === 'agent' && !['entry-home', 'go-agent'].includes(job.resumePhase)) ||
          (route === 'site' && job.resumePhase !== 'go-agent'))));
    return {
      restart: Boolean(restart),
      label: state.resetPending || state.mode === 'resetting' || job?.phase === 'resetting' ? '等待重置完成' : state.startPending ? '正在开始' : job?.running ? '运行中'
        : restart ? '重新开始' : stopped && isTaskPage(job) ? '继续' : '开始',
      disabled: state.resetPending || state.mode === 'resetting' || job?.phase === 'resetting' ||
        state.startPending || state.pausePending || Boolean(job?.running) ||
        route === 'other'
    };
  }

  function updateTaskControls() {
    const panel = document.getElementById('wb-study-ui');
    const routeHidden = getRoute() === 'other';
    if (panel) panel.hidden = routeHidden || !state.panelExpanded;
    const assistantButton = document.getElementById('wb-assistant-button');
    if (assistantButton) assistantButton.hidden = routeHidden || state.panelExpanded;
    const control = getStartControl();
    const startButton = document.getElementById('wb-start');
    if (startButton) {
      startButton.textContent = control.label;
      startButton.disabled = control.disabled;
      startButton.title = control.restart ? '重新扫描课程，保留未完成音视频的记录' : '';
    }
    const stopButton = document.getElementById('wb-stop');
    if (stopButton) {
      const canPause = state.startPending || state.running ||
        (state.job?.running && isTaskPage());
      stopButton.disabled = state.resetPending || state.mode === 'resetting' || state.job?.phase === 'resetting' || state.pausePending || !canPause;
      stopButton.textContent = state.pausePending ? '正在暂停' : '暂停';
      stopButton.title = state.job?.running && !isTaskPage() && !state.startPending
        ? '请在正在执行任务的页面暂停' : '';
    }
    const resetButton = document.getElementById('wb-reset');
    if (resetButton) {
      resetButton.disabled = state.resetPending || getRoute() === 'other';
      resetButton.textContent = state.resetPending ? '正在重置' : state.mode === 'resetting' || state.job?.phase === 'resetting' ? '重试重置' : '重置插件';
    }
    const scanButton = document.getElementById('wb-scan');
    if (scanButton) scanButton.disabled = state.resetPending || state.mode === 'resetting' || state.job?.phase === 'resetting';
  }

  function acceptJob(job) {
    if (!job) return state.resetEpoch === 0 && state.pendingResetFromEpoch == null;
    const resetEpoch = jobResetEpoch(job);
    if (resetEpoch < state.resetEpoch || (state.pendingResetFromEpoch != null &&
      resetEpoch <= state.pendingResetFromEpoch)) return false;
    // The empty reset job and a later fresh task share the same reset epoch.
    // A delayed acknowledgement of the empty job cannot erase that fresh task.
    if (resetEpoch === state.resetEpoch && state.job && state.job.runId !== job.runId &&
      ['idle', 'resetting'].includes(job.phase) && !['idle', 'resetting'].includes(state.job.phase)) return false;
    const holdMedia = (job.resetHoldTabIds || []).includes(state.tabId) &&
      !(job.running && isTaskPage(job) &&
        !(job.returningTabId === state.tabId && getRoute() === 'learn'));
    if (resetEpoch > state.resetEpoch) {
      clearLocalTask(holdMedia);
      state.resetEpoch = resetEpoch;
      state.pendingResetFromEpoch = null;
    }

    if (state.job?.runId === job.runId && job.revision < state.job.revision) return true;
    const newRun = state.job?.runId !== job.runId;
    if (newRun) {
      state.epoch += 1;
      state.processedItems.clear();
      state.processedCourseKey = '';
      state.resourceCheckpoint = null;
      state.homePageTransition = null;
      state.routeRecoveryPending = false;
      state.mediaLoadingHold = null;
      state.localMediaStop = null;
      renderLogEntries([], { reset: true });
    }
    state.job = job;
    // Course metadata may arrive after the initial route event, including
    // while paused. Refresh only its label; task instructions stay intact.
    if (getRoute() === 'learn') {
      const title = getDisplayedCourseTitle();
      if (title) setText('wb-course', title);
    }
    state.resetMediaHold = holdMedia;
    const owns = job.running && job.ownerTabId === state.tabId && job.ownerInstance === state.instanceId;
    if (!job.running || job.phase !== 'course' || job.ownerTabId !== state.tabId) {
      // A user pause, reset, or completed task releases the local guard.
      state.routeRecoveryPending = false;
    } else if (job.interruption?.status === 'navigating') {
      state.routeRecoveryPending = true;
    } else if (state.routeRecoveryPending && owns) {
      const candidate = job.candidates?.[job.targetIndex];
      const resource = candidate?.currentResource;
      if (getRoute() === 'learn' && candidate?.courseKey === currentCourseKey() &&
        (!resource?.routeKey || routeEquals(getRouteKey(), resource.routeKey))) {
        state.routeRecoveryPending = false;
      }
    }
    if ((!owns || job.generation !== state.activeGeneration) && state.running) {
      state.running = false;
      state.mode = 'paused';
      state.epoch += 1;
      pauseMedia('owner-or-generation-changed');
    }
    pauseForStoppedTask();
    // A known task document may still be waiting for its title/hello. Keep
    // default media stopped in that interval, except an observed refresh
    // checkpoint on the same route. The executor renews this for its epoch.
    if (!state.running && !state.jobPromise && job.running && getRoute() === 'learn' &&
      [job.homeTabId, job.workerTabId, job.returningTabId].includes(state.tabId) &&
      ['opening', 'course'].includes(job.phase) && !retainCurrentMedia(job)) {
      holdLoadingMedia(state.epoch, job.targetPurpose === 'inspect' ? 'initial-inspection' : 'initial-resource-check');
    }
    updateTaskControls();
    const done = job.candidates.filter(c => ['complete', 'completed'].includes(c.status)).length;
    setText('wb-job-summary', ['idle', 'resetting'].includes(job.phase) ? '尚未开始' : `${done}/${job.candidates.length} 门音视频已确认`);
    state.playedCount = job.candidates.reduce((sum, c) => sum + Object.values(c.records || {}).filter(r => r.ended).length, 0);
    setText('wb-count', String(state.playedCount));
    const manual = jobManualItems(job);
    if (['agent', 'home', 'site'].includes(getRoute()) || !job.running) renderManualItems(manual);
    if (job.reason) logPageNotice(job.reason);
    else if (job.phase === 'idle') clearPageNotice();
    if (!job.running) {
      state.mode = job.phase;
      setText('wb-status', job.phase === 'idle' ? '未开始' : job.phase === 'resetting' ? '正在重置' : job.phase === 'finished' ? (manual.length ? '已结束，有待确认项' : '音视频已确认完成') : job.phase === 'manual' || job.phase === 'interrupted' ? '需要人工处理' : '已暂停');
      setCurrentTask(job.phase === 'idle' ? '尚未开始' : job.phase === 'resetting' ? job.reason || '正在停止旧任务，请稍候' : job.phase === 'finished' ? '文档、考试、作业仍需自行处理' : job.reason || '已暂停');
    } else if (!owns) {
      setText('wb-status', '运行中');
      setCurrentTask(!isTaskPage(job) ? '任务在另一个页面运行，请到任务页面暂停'
        : job.phase === 'opening' ? '等待课程页面打开'
          : job.phase === 'go-agent' ? '正在返回首页'
            : job.phase === 'entry-home' ? '正在打开课表'
            : job.returningTabId === state.tabId ? '正在返回课表' : '任务正在另一个页面继续');
    }
    if (state.pausePending) {
      setText('wb-status', '正在暂停');
      setCurrentTask('本页播放已停止，正在确认任务暂停');
    }
    const urgentReason = job.reason && ['manual', 'interrupted'].includes(job.phase) ? job.reason : '';
    renderLogEntries(mergePendingLogEntries(job.logs || []), {
      urgent: Boolean(urgentReason && urgentReason !== state.logUrgentReason)
    });
    state.logUrgentReason = urgentReason;
    updateTaskControls();
    return true;
  }

  function pauseForStoppedTask() {
    if (state.resetMediaHold) pauseMedia('reset-media-hold');
    const job = state.job;
    if (state.tabId != null && job &&
      ((!job.running && ['paused', 'manual', 'interrupted'].includes(job.phase)) ||
        (!state.running && ['paused', 'manual', 'interrupted'].includes(state.mode))) &&
      [job.homeTabId, job.workerTabId, job.returningTabId].includes(state.tabId)) {
      pauseMedia('task-stopped');
    }
  }

  async function syncSharedJob() {
    if (state.syncPromise || state.storageFailed || state.resetPending || state.reloadPending) return;
    const resetSequence = state.resetSequence;
    state.syncPromise = (async () => {
      try {
        await jobCommand('get');
        if (resetSequence !== state.resetSequence || state.resetPending) return;
        const job = state.job;
        if (!job?.running) return;
        if (job.phase === 'course' && job.targetPurpose === 'play' &&
          job.ownerTabId === state.tabId && job.ownerInstance === state.instanceId) {
          const candidate = currentCandidate();
          const checkpoint = state.resourceCheckpoint || candidate?.currentResource;
          const routeMismatch = getRoute() !== 'learn' ||
            currentCourseKey() !== candidate?.courseKey ||
            Boolean(checkpoint?.routeKey && !routeEquals(getRouteKey(), checkpoint.routeKey));
          if (routeMismatch) {
            requestRouteRecovery('页面发生变化，正在返回已保存的原课程和音视频');
            return;
          }
        }
        if ([job.homeTabId, job.workerTabId, job.returningTabId].includes(state.tabId) &&
          (state.registeredRunId !== job.runId ||
            (job.ownerTabId === state.tabId && job.ownerInstance !== state.instanceId) ||
            (job.phase === 'entry-home' && getRoute() === 'home') ||
            (job.phase === 'go-agent' && ['agent', 'home'].includes(getRoute())) ||
            (state.routeRecoveryPending && job.phase === 'course'))) {
          await jobCommand('hello', { title: compactText(getDisplayedCourseTitle()) });
          // A title can arrive after the document. Keep retrying until this
          // document has actually been accepted, rather than after one hello.
          if (state.job?.ownerInstance === state.instanceId ||
            (getRoute() === 'home' && state.job?.homeInstance === state.instanceId)) {
            state.registeredRunId = job.runId;
          }
        }
        if ((job.phase === 'opening' && getRoute() === 'learn' &&
            (job.workerTabId === state.tabId || job.homeTabId === state.tabId)) ||
            (job.ownerTabId === state.tabId && !job.ownerInstance)) {
          await jobCommand('hello', { title: compactText(getDisplayedCourseTitle()) });
        }
        if (state.job?.running && state.job.ownerTabId === state.tabId &&
          state.job.ownerInstance === state.instanceId &&
          ['entry-home', 'scan-home', 'home', 'course'].includes(state.job.phase) && !state.jobPromise &&
          !state.routeRecoveryPending) resumeSharedJob();
      } catch (error) {
        if (!(error instanceof TaskCancelled)) failLocally(error.message);
      }
    })().finally(() => { state.syncPromise = null; });
    return state.syncPromise;
  }

  function failLocally(message) {
    state.storageFailed = true;
    stopLocal('local-failure');
    state.mode = 'manual';
    state.manualNotice = message;
    setText('wb-status', '需要人工处理');
    setCurrentTask('本页自动操作已停止，请检查任务状态');
    updateTaskControls();
    logPageNotice(message);
    renderManualItems([message]);
    log(message, 'err', false);
    if (state.job?.running) jobCommand('manual', { reason: message }).catch(() => {});
  }

  function isPageCompletedItem(el) {
    if (!isLeafCourseItem(el)) return false;
    const host = getStatusHost(el);
    return SELECTORS.doneIcons.some(selector => host.querySelector(selector));
  }

  const RESOURCE_PROGRESS_SELECTORS = [
    '.progress-text', '.study-progress', '.video-progress',
    '.current-progress', '[class*="watch-progress"]'
  ];

  function isVisibleWithin(el, root) {
    if (!el?.isConnected || !el.getClientRects().length) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      if (node === root) return true;
    }
    return false;
  }

  function parseScopedProgress(root) {
    if (!root?.isConnected) return null;
    const matches = [];
    for (const selector of RESOURCE_PROGRESS_SELECTORS) {
      const elements = [
        ...(root.matches?.(selector) ? [root] : []),
        ...root.querySelectorAll(selector)
      ];
      for (const el of elements) {
        if (!isVisibleWithin(el, root)) continue;
        const text = compactText(el.innerText || el.textContent);
        const match = text.match(/^已观看\s*([0-9]+(?:\.[0-9]+)?)\s*%$/);
        if (!match) continue;
        const percent = Number(match[1]);
        if (Number.isFinite(percent) && percent >= 0 && percent <= 100) {
          matches.push({ percent, length: text.length });
        }
      }
    }
    if (!matches.length) return null;
    const shortest = Math.min(...matches.map(match => match.length));
    const values = [...new Set(matches.filter(match => match.length === shortest)
      .map(match => match.percent))];
    return values.length === 1 ? values[0] / 100 : null;
  }

  function parseProgressText(item) {
    const active = item || document.querySelector('li.el-menu-item.is-active');
    const rowProgress = parseScopedProgress(active);
    if (rowProgress != null) return rowProgress;
    if (!active?.classList.contains('is-active') || !isLeafCourseItem(active)) return null;
    const player = getActiveMediaEl()?.closest('.video-js, .audio-player, .player-wrapper');
    if (!player || player.closest('#wb-study-ui')) return null;
    return parseScopedProgress(player);
  }

  function getResourceCompletion(item) {
    if (!item) return { confirmed: false, sitePercent: null, source: '' };
    if (isPageCompletedItem(item)) {
      return { confirmed: true, sitePercent: null, source: 'page-marker' };
    }
    const progress = parseProgressText(item);
    const sitePercent = progress == null ? null : Number((progress * 100).toFixed(2));
    return {
      confirmed: sitePercent != null && sitePercent >= 80,
      sitePercent, source: sitePercent == null ? '' : 'site-progress'
    };
  }

  function isPlayerPlaybackErrorDialog(el) {
    if (!el || !isVisibleElement(el)) return false;
    const player = el.closest('.video-js, .audio-player, .player-wrapper') ||
      el.querySelector('.video-js, .audio-player, .player-wrapper');
    const text = compactText(el.innerText || el.textContent);
    return Boolean(player && /无法播放媒体|视频文件损坏|播放终止|media.*error|error.*play/i.test(text));
  }

  function needsNaturalEnd(el) {
    if (state.processedCourseKey !== currentCourseKey()) return false;
    const record = state.processedItems.get(getItemKey(el));
    return Boolean((record?.started || record?.attempted) && !record.ended);
  }

  function getUnfinishedTitles() {
    return [...state.processedItems.values()]
      .filter(record => (record.started || record.attempted) && !record.ended)
      .map(record => record.title);
  }

  function requireRecordedResources(items) {
    const keys = new Set(items.map(getItemKey));
    const missing = [...state.processedItems.entries()]
      .filter(([key, record]) => !keys.has(key) &&
        (((record.started || record.attempted) && !record.ended) || (record.ended && !record.confirmed)))
      .map(([, record]) => record.title);
    if (missing.length) {
      throw new Error(`先前待完成的资源在当前目录中无法确认：${missing.join('、')}。已停止，请核对目录后继续`);
    }
  }

  function renderManualItems(items) {
    state.manualItems = [...new Set(items.filter(Boolean))];
    const count = state.job || getRoute() === 'learn' || state.manualItems.length
      ? String(state.manualItems.length)
      : '—';
    setText('wb-manual', count);
    setText('wb-manual-count', count);

    const list = document.getElementById('wb-manual-list');
    if (!list) return;
    list.innerHTML = '';
    if (!state.manualItems.length) {
      list.className = 'manual-empty';
      list.textContent = state.job || getRoute() === 'learn'
        ? '暂未发现需要人工处理的项目'
        : '开始后查看需要人工处理的项目';
      return;
    }

    list.className = 'manual-list';
    state.manualItems.slice(0, 20).forEach(item => {
      const li = document.createElement('li');
      li.textContent = typeof item === 'string' ? item : itemTitle(item);
      list.appendChild(li);
    });
    if (state.manualItems.length > 20) {
      const li = document.createElement('li');
      li.textContent = `还有 ${state.manualItems.length - 20} 项未展开`;
      list.appendChild(li);
    }
  }

  function updateCompletionSummary(items, pendingItems) {
    const completedItems = items.filter(isPageCompletedItem);
    state.confirmedCount = completedItems.length;
    setText('wb-confirmed', String(state.confirmedCount));
    const sameCourse = state.processedCourseKey === currentCourseKey();
    const manualItems = state.job ? jobManualItems(state.job) : sameCourse
      ? [...state.processedItems.values()].filter(item => item.error)
        .map(item => `${item.title}：${item.error}`) : [];
    if (state.manualNotice) manualItems.unshift(state.manualNotice);
    renderManualItems(manualItems);

    if (state.lastConfirmedCount != null && state.confirmedCount > state.lastConfirmedCount) {
      log(`平台页面已标记完成 ${state.confirmedCount - state.lastConfirmedCount} 项资源`, 'ok');
    }
    state.lastConfirmedCount = state.confirmedCount;

    const completion = getCourseCompletionSignal();
    if (completion && completion.done && !state.courseCompleteLogged) {
      state.courseCompleteLogged = true;
      log(`页面显示考核点 ${completion.completed}/${completion.total}；这个计数不作为本次音视频切换条件`, 'ok');
    }
    setText('wb-course-progress', completion ? `${completion.completed}/${completion.total}` : '未识别');
  }

  function getCourseCompletionSignal() {
    if (getRoute() !== 'learn') return null;
    const text = compactText(document.body && document.body.innerText);
    const match = text.match(/考核点已完成[^\d]{0,20}(\d+)\s*\/\s*(\d+)/);
    if (!match) return null;
    const completed = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return null;
    return { completed, total, done: completed >= total };
  }

  function getRoute() {
    if (location.origin !== 'https://www.beeline-ai.com') return 'other';
    const path = location.pathname || '';
    const hash = location.hash || '';
    if (hash.includes('/courseInfo/learn/courseWare/')) return 'learn';
    if (path === '/stu/agent') return 'agent';
    if (path.includes('/myBank/courseResearch')) return 'home';
    return 'site';
  }

  function getRouteKey() {
    return `${location.pathname || ''}${location.hash || ''}`;
  }

  function normalizeRouteForComparison(routeKey) {
    const route = String(routeKey || '');
    const queryAt = route.indexOf('?');
    if (queryAt < 0) return route;
    // Compare different-key query order only. Keep raw values, empty pairs
    // and the order of repeated keys; their meaning is not ours to guess.
    const pairs = route.slice(queryAt + 1).split('&').map(pair => ({
      pair, key: pair.split('=', 1)[0]
    }));
    // Encoded keys could be aliases of another key. Keep their order strict.
    if (pairs.some(entry => /[%+]/.test(entry.key))) return route;
    pairs.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return `${route.slice(0, queryAt + 1)}${pairs.map(entry => entry.pair).join('&')}`;
  }

  function routeEquals(a, b) {
    return normalizeRouteForComparison(a) === normalizeRouteForComparison(b);
  }

  function compactText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function logPageNotice(message) {
    const text = compactText(message);
    if (!text) return;
    setText('wb-notice', text);
    const notice = document.getElementById('wb-notice');
    if (notice) notice.style.display = '';
  }

  function clearPageNotice() {
    const notice = document.getElementById('wb-notice');
    if (!notice) return;
    notice.textContent = '';
    notice.style.display = 'none';
  }

  function getBlockingNotice() {
    if (!document.body) return '';
    const bodyText = compactText(document.body.innerText || document.body.textContent);
    const panel = document.getElementById('wb-study-ui');
    const panelText = compactText(panel && (panel.innerText || panel.textContent));
    const text = panelText ? bodyText.replace(panelText, '') : bodyText;
    return CFG.blockingText.find(pattern => text.includes(pattern)) || '';
  }

  function stopForManual(message) {
    stopLocal('manual-stop');
    state.mode = 'manual';
    state.manualNotice = compactText(message);
    setText('wb-status', '需要人工处理');
    setCurrentTask('本页自动操作已停止');
    updateTaskControls();
    logPageNotice(state.manualNotice);
    renderManualItems([state.manualNotice, ...state.manualItems]);
    log(state.manualNotice, 'err', false);
    if (state.job) jobCommand('manual', { reason: state.manualNotice }).catch(error => {
      if (!(error instanceof TaskCancelled)) failLocally(error.message);
    });
  }

  const PLAYBACK_TARGET_KEY = 'wb-playback-target';

  function normalizePlaybackTarget(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return 100;
    const target = Number(value);
    return Number.isFinite(target) ? Math.max(80, Math.min(100, Math.round(target))) : 100;
  }

  function getPlaybackTarget() {
    return normalizePlaybackTarget(state.playbackTarget);
  }

  function savedPlaybackTarget(value) {
    return Number.isInteger(value) && value >= 80 && value <= 100 ? value : 100;
  }

  function renderPlaybackTarget() {
    const input = document.getElementById('wb-playback-target');
    if (input) input.value = String(getPlaybackTarget());
  }

  function savePlaybackTarget(value) {
    const target = normalizePlaybackTarget(value);
    state.playbackTarget = target;
    state.playbackTargetRevision += 1;
    renderPlaybackTarget();
    const storage = globalThis.chrome?.storage?.local;
    if (!storage?.set) return Promise.resolve(false);
    state.playbackTargetPendingWrites += 1;
    const write = state.playbackTargetWrites.then(() => storage.set({ [PLAYBACK_TARGET_KEY]: target }));
    state.playbackTargetWrites = write.catch(() => {});
    return write.then(() => true).finally(() => {
      state.playbackTargetPendingWrites -= 1;
      if (!state.playbackTargetPendingWrites && state.playbackTargetPendingChange) {
        const change = state.playbackTargetPendingChange;
        state.playbackTargetPendingChange = null;
        state.playbackTargetSync = syncChangedPlaybackTarget(change, state.playbackTargetRevision);
      }
    });
  }

  async function syncChangedPlaybackTarget(change, revision) {
    let value = change.newValue;
    try {
      const storage = globalThis.chrome?.storage?.local;
      if (storage?.get) value = (await storage.get(PLAYBACK_TARGET_KEY))?.[PLAYBACK_TARGET_KEY];
    } catch (_) {}
    if (revision !== state.playbackTargetRevision || state.playbackTargetPendingWrites) return;
    state.playbackTarget = savedPlaybackTarget(value);
    renderPlaybackTarget();
  }

  function observePlaybackTargetChanges() {
    globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !Object.hasOwn(changes || {}, PLAYBACK_TARGET_KEY)) return;
      state.playbackTargetRevision += 1;
      const change = changes[PLAYBACK_TARGET_KEY];
      if (state.playbackTargetPendingWrites) {
        state.playbackTargetPendingChange = change;
        return;
      }
      state.playbackTargetSync = syncChangedPlaybackTarget(change, state.playbackTargetRevision);
    });
  }

  async function loadPlaybackTarget() {
    const revision = state.playbackTargetRevision;
    let saved;
    try {
      const storage = globalThis.chrome?.storage?.local;
      saved = storage?.get ? await storage.get(PLAYBACK_TARGET_KEY) : null;
    } catch (_) {}
    if (revision === state.playbackTargetRevision) {
      state.playbackTarget = savedPlaybackTarget(saved?.[PLAYBACK_TARGET_KEY]);
      renderPlaybackTarget();
    }
    if (state.playbackTargetSync) await state.playbackTargetSync;
    return getPlaybackTarget();
  }

  function injectUI() {
    if (document.getElementById('wb-study-ui')) return;

    const style = document.createElement('style');
    style.textContent = `
      #wb-study-ui{
        position:fixed;right:18px;top:90px;width:340px;z-index:999999;
        background:#fff;border:1px solid #e6e6e6;border-radius:12px;
        box-shadow:0 8px 28px rgba(0,0,0,.16);font:13px/1.4 PingFang SC,Arial,sans-serif;color:#222;
        user-select:none;
      }
      #wb-study-ui[hidden]{display:none!important}
      #wb-assistant-button{
        position:fixed;right:18px;top:90px;z-index:1000000;
        box-sizing:border-box;width:56px;height:56px;padding:0;overflow:hidden;
        border:1px solid rgba(255,255,255,.9);border-radius:50%;background:#fff;
        box-shadow:0 4px 16px rgba(0,0,0,.2);cursor:grab;touch-action:none;
      }
      #wb-assistant-button[hidden]{display:none!important}
      #wb-assistant-button img{display:block;width:100%;height:100%;object-fit:cover;pointer-events:none}
      #wb-assistant-button:active{cursor:grabbing}
      #wb-assistant-button:focus-visible{outline:2px solid #005eff;outline-offset:3px}
      #wb-study-ui .hd{
        padding:10px 12px;background:#005eff;color:#fff;border-radius:12px 12px 0 0;
        display:flex;justify-content:space-between;align-items:center;font-weight:700;cursor:grab;touch-action:none;
      }
      #wb-study-ui .hd:active{cursor:grabbing}
      #wb-study-ui .bd{padding:12px}
      #wb-study-ui .btn{
        width:100%;border:none;border-radius:10px;padding:9px 10px;margin-top:8px;cursor:pointer;font-weight:700;
      }
      #wb-study-ui .scan{background:#f3f3f3;color:#333}
      #wb-study-ui .start{background:#005eff;color:#fff}
      #wb-study-ui .stop{background:#ff8200;color:#fff}
      #wb-study-ui .btn:disabled{opacity:.5;cursor:not-allowed}
      #wb-study-ui .kv{display:flex;justify-content:space-between;gap:8px;font-size:12px;margin:4px 0;color:#444}
      #wb-study-ui .playback-target{align-items:center;min-height:30px}
      #wb-study-ui .target-value{display:inline-flex;align-items:center;gap:4px}
      #wb-study-ui .playback-target input{
        box-sizing:border-box;width:72px;height:28px;border:1px solid #ccc;border-radius:6px;
        padding:3px 5px;background:#fff;color:#222;font:inherit;text-align:right;
      }
      #wb-study-ui .playback-target input:focus-visible{outline:2px solid #005eff;outline-offset:1px}
      #wb-study-ui .log{
        margin-top:8px;height:180px;overflow:auto;background:#fafafa;border:1px solid #eee;border-radius:10px;padding:8px;font-size:11px;
      }
      #wb-study-ui .log-new{
        width:100%;margin-top:8px;padding:7px 9px;border:1px solid #bfd4ff;border-radius:8px;
        background:#f2f7ff;color:#005eff;font-size:11px;font-weight:700;cursor:pointer;text-align:left;
      }
      #wb-study-ui .log-new[hidden]{display:none}
      #wb-study-ui .log-new.is-urgent{
        border-color:#f0b35a;background:#fff4e5;color:#8a4b00;
      }
      #wb-study-ui .section{
        margin-top:10px;padding-top:10px;border-top:1px solid #efefef;
      }
      #wb-study-ui .section-title{
        display:flex;justify-content:space-between;align-items:center;
        font-size:12px;font-weight:700;color:#333;margin-bottom:6px;
      }
      #wb-study-ui .section-meta{
        font-size:11px;color:#666;font-weight:400;
      }
      #wb-study-ui .current-task{
        margin:8px 0;padding:8px 10px;background:#f5f8ff;border:1px solid #dbe7ff;
        border-radius:10px;font-size:12px;color:#333;
      }
      #wb-study-ui .current-task strong{
        display:block;margin-top:3px;color:#005eff;font-size:12px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      }
      #wb-study-ui details{
        margin-top:8px;border-top:1px solid #efefef;padding-top:8px;
      }
      #wb-study-ui details summary{
        cursor:pointer;color:#666;font-size:12px;user-select:none;
      }
      #wb-study-ui .manual-list{
        margin:6px 0 0;padding-left:18px;color:#b42318;font-size:11px;font-weight:500;
        max-height:100px;overflow:auto;
      }
      #wb-study-ui .manual-list li{margin:4px 0;overflow-wrap:anywhere}
      #wb-study-ui .manual-empty{
        color:#777;font-size:11px;margin-top:5px;
      }
      #wb-study-ui .notice{
        margin-top:8px;padding:8px 10px;border-radius:10px;
        background:#fff4e5;border:1px solid #ffd7a0;color:#8a4b00;font-size:11px;
      }
      #wb-study-ui .dir-list{
        max-height:220px;overflow:auto;background:#fafafa;border:1px solid #eee;border-radius:10px;padding:6px;
      }
      #wb-study-ui .dir-item{
        display:block;width:100%;border:none;background:#fff;border-radius:8px;
        padding:7px 8px;margin:4px 0;text-align:left;font-size:12px;line-height:1.35;
        color:#333;cursor:pointer;border:1px solid #ececec;
      }
      #wb-study-ui .dir-item:hover{border-color:#005eff;background:#f5f8ff}
      #wb-study-ui .dir-item small{
        display:block;margin-top:3px;color:#7a7a7a;font-size:11px;
      }
      #wb-study-ui .dir-item.is-pending{
        border-color:#bfd4ff;background:#f6f9ff;
      }
      #wb-study-ui .dir-badge{
        display:inline-flex;align-items:center;justify-content:center;
        min-width:46px;height:20px;padding:0 6px;margin-left:8px;border-radius:999px;
        font-size:11px;font-weight:700;
      }
      #wb-study-ui .dir-badge.pending{background:#e8f1ff;color:#005eff}
      #wb-study-ui .dir-badge.done{background:#ebf8ee;color:#1a7f37}
      #wb-study-ui .dir-badge.unknown{background:#fff4e5;color:#8a4b00}
      #wb-study-ui .dir-head{
        display:flex;justify-content:space-between;align-items:flex-start;gap:8px;
      }
      #wb-study-ui .dir-empty{
        font-size:12px;color:#888;padding:6px 4px;
      }
      #wb-study-ui .mini{
        display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
        padding:0;border:0;border-radius:4px;background:transparent;color:inherit;
        font:inherit;font-size:20px;line-height:1;cursor:pointer;
      }
      #wb-study-ui .mini:hover{background:rgba(255,255,255,.16)}
      #wb-study-ui .mini:focus-visible{outline:2px solid #fff;outline-offset:1px}
    `;
    document.head.appendChild(style);

    const box = document.createElement('div');
    box.id = 'wb-study-ui';
    box.hidden = getRoute() === 'other' || !state.panelExpanded;
    box.innerHTML = `
      <div class="hd" id="wb-drag">
        <span>课程学习助手</span>
        <button class="mini" id="wb-min" type="button" title="收起" aria-label="收起课程学习助手">−</button>
      </div>
      <div class="bd" id="wb-body">
        <div class="kv"><span>状态</span><span id="wb-status">未开始</span></div>
        <div class="kv"><span>课程任务</span><span id="wb-job-summary">尚未开始</span></div>
        <div class="kv"><span>当前播放位置</span><span id="wb-progress">-</span></div>
        <div class="current-task">
          <span>当前任务</span>
          <strong id="wb-current">尚未开始</strong>
        </div>
        <div class="kv"><span>当前页面</span><span id="wb-course">尚未识别</span></div>
        <div class="kv"><span>页面考核点（仅供参考）</span><span id="wb-course-progress">未识别</span></div>
        <div class="kv"><span>本次已完整播放</span><span id="wb-count">0</span></div>
        <div class="kv"><span>页面已标记完成的音视频</span><span id="wb-confirmed">0</span></div>
        <div class="kv"><span>需人工处理</span><span id="wb-manual">0</span></div>
        <div class="notice" id="wb-notice" style="display:none"></div>

        <label class="kv playback-target" for="wb-playback-target">
          <span>播放目标</span>
          <span class="target-value">
            <input id="wb-playback-target" type="number" min="80" max="100" step="1" value="100"
              title="播放目标百分比" aria-label="播放目标百分比">
            <span aria-hidden="true">%</span>
          </span>
        </label>
        <button class="btn start" id="wb-start">开始</button>
        <button class="btn stop" id="wb-stop">暂停</button>

        <details class="section">
          <summary class="section-title">
            <span>音视频目录</span>
            <span class="section-meta">待处理 <span id="wb-pending-count">—</span> / 音视频 <span id="wb-video-count">—</span></span>
          </summary>
          <div class="dir-list" id="wb-video-list">
            <div class="dir-empty">暂未识别到学习目录</div>
          </div>
        </details>

        <div class="section">
          <div class="section-title">
            <span>人工提醒</span>
            <span class="section-meta">共 <span id="wb-manual-count">0</span> 项</span>
          </div>
          <div id="wb-manual-list" class="manual-empty" aria-live="polite">暂未发现需要人工处理的项目</div>
        </div>

        <button class="btn scan" id="wb-scan">查看最新目录</button>
        <button class="btn scan" id="wb-reset">重置插件</button>

        <button class="log-new" id="wb-log-new" type="button" aria-live="polite" hidden></button>
        <div class="log" id="wb-log"></div>
      </div>
    `;
    document.body.appendChild(box);
    const assistantButton = document.createElement('button');
    assistantButton.id = 'wb-assistant-button';
    assistantButton.type = 'button';
    assistantButton.setAttribute('aria-label', '展开课程学习助手');
    assistantButton.setAttribute('aria-expanded', 'false');
    assistantButton.title = '展开课程学习助手';
    assistantButton.hidden = getRoute() === 'other' || state.panelExpanded;
    const assistantImage = document.createElement('img');
    assistantImage.alt = '';
    assistantImage.draggable = false;
    const getExtensionUrl = globalThis.chrome?.runtime?.getURL;
    if (typeof getExtensionUrl === 'function') {
      assistantImage.src = getExtensionUrl.call(globalThis.chrome.runtime, 'assets/floating-assistant.png');
    }
    assistantButton.appendChild(assistantImage);
    document.body.appendChild(assistantButton);
    const targetInput = box.querySelector('#wb-playback-target');
    targetInput.addEventListener('change', () => {
      savePlaybackTarget(targetInput.value).catch(() => {
        log('播放目标保存失败，本页仍使用当前设置', 'err');
      });
    });
    observePlaybackTargetChanges();
    state.playbackTargetReady = loadPlaybackTarget();
    state.logBox = box.querySelector('#wb-log');
    state.logNewButton = box.querySelector('#wb-log-new');
    state.logBox.addEventListener('scroll', () => {
      if (state.renderingLogs) return;
      if (logIsNearLatest()) {
        state.logUnreadCount = 0;
        state.logHasUrgentNotice = false;
        updateLogNewButton();
      }
    });
    state.logNewButton.addEventListener('click', () => {
      state.logBox.scrollTop = state.logBox.scrollHeight;
      state.logUnreadCount = 0;
      state.logHasUrgentNotice = false;
      updateLogNewButton();
    });

    function getElementSize(element, fallback) {
      const rect = element.getBoundingClientRect();
      const computed = window.getComputedStyle(element);
      const borderWidth = (parseFloat(computed.borderLeftWidth) || 0) +
        (parseFloat(computed.borderRightWidth) || 0);
      const width = rect.width || element.offsetWidth ||
        ((parseFloat(computed.width) || 0) + (computed.boxSizing === 'border-box' ? 0 : borderWidth));
      const height = rect.height || element.offsetHeight || element.scrollHeight || fallback.height;
      return { width: width || fallback.width, height: height || fallback.height };
    }

    function keepBoxInViewport(left, top, width, height, margin = 8) {
      const maxLeft = Math.max(margin, window.innerWidth - width - margin);
      const maxTop = Math.max(margin, window.innerHeight - height - margin);
      return {
        left: Math.min(Math.max(margin, left), maxLeft),
        top: Math.min(Math.max(margin, top), maxTop)
      };
    }

    function readPanelPosition() {
      if (state.uiPosition) return { ...state.uiPosition };
      const size = getElementSize(box, { width: 342, height: 0 });
      const left = box.style.left ? parseFloat(box.style.left) :
        window.innerWidth - size.width - 18;
      const top = box.style.top ? parseFloat(box.style.top) : 90;
      return { left, top };
    }

    function applyPanelPosition(left, top) {
      const size = getElementSize(box, { width: 342, height: Math.max(0, window.innerHeight - 16) });
      const position = keepBoxInViewport(left, top, size.width, size.height);
      box.style.left = `${position.left}px`;
      box.style.top = `${position.top}px`;
      box.style.right = 'auto';
      state.uiPosition = position;

      const buttonSize = getElementSize(assistantButton, { width: 56, height: 56 });
      const buttonPosition = keepBoxInViewport(
        position.left + size.width - buttonSize.width,
        position.top,
        buttonSize.width,
        buttonSize.height
      );
      assistantButton.style.left = `${buttonPosition.left}px`;
      assistantButton.style.top = `${buttonPosition.top}px`;
      assistantButton.style.right = 'auto';
    }

    function applyAssistantPosition(left, top) {
      const buttonSize = getElementSize(assistantButton, { width: 56, height: 56 });
      const position = keepBoxInViewport(left, top, buttonSize.width, buttonSize.height);
      assistantButton.style.left = `${position.left}px`;
      assistantButton.style.top = `${position.top}px`;
      assistantButton.style.right = 'auto';
      const panelSize = getElementSize(box, { width: 342, height: Math.max(0, window.innerHeight - 16) });
      state.uiPosition = keepBoxInViewport(
        position.left + buttonSize.width - panelSize.width,
        position.top,
        panelSize.width,
        panelSize.height
      );
    }

    function setPanelExpanded(expanded) {
      if (state.panelExpanded === expanded) return;
      const position = readPanelPosition();
      state.panelExpanded = expanded;
      assistantButton.setAttribute('aria-expanded', String(expanded));
      assistantButton.setAttribute('aria-label', expanded ? '课程学习助手已展开' : '展开课程学习助手');
      assistantButton.title = expanded ? '课程学习助手已展开' : '展开课程学习助手';
      updateTaskControls();
      if (expanded) applyPanelPosition(position.left, position.top);
    }

    let activeDrag = null;
    const drag = box.querySelector('#wb-drag');

    function beginDrag(event, element, kind) {
      if ((event.button != null && event.button !== 0) || event.isPrimary === false) return;
      if (kind === 'panel' && event.target.closest('button, a, input, select, textarea, summary')) return;
      const rect = element.getBoundingClientRect();
      const initial = kind === 'panel' ? readPanelPosition() : { left: rect.left, top: rect.top };
      activeDrag = {
        element,
        kind,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: initial.left,
        top: initial.top,
        moved: false
      };
      event.preventDefault();
    }

    assistantButton.addEventListener('pointerdown', event => beginDrag(event, assistantButton, 'assistant'));
    drag.addEventListener('pointerdown', event => beginDrag(event, box, 'panel'));
    document.addEventListener('pointermove', event => {
      if (!activeDrag || (activeDrag.pointerId != null && event.pointerId != null &&
        event.pointerId !== activeDrag.pointerId)) return;
      const dx = event.clientX - activeDrag.startX;
      const dy = event.clientY - activeDrag.startY;
      if (!activeDrag.moved && Math.hypot(dx, dy) < 6) return;
      activeDrag.moved = true;
      event.preventDefault();
      if (activeDrag.kind === 'panel') {
        applyPanelPosition(activeDrag.left + dx, activeDrag.top + dy);
      } else {
        applyAssistantPosition(activeDrag.left + dx, activeDrag.top + dy);
      }
    });

    function endDrag(event, canceled = false) {
      if (!activeDrag || (activeDrag.pointerId != null && event.pointerId != null &&
        event.pointerId !== activeDrag.pointerId)) return;
      const finished = activeDrag;
      activeDrag = null;
      if (!canceled && finished.kind === 'assistant' && !finished.moved) setPanelExpanded(true);
    }

    document.addEventListener('pointerup', event => endDrag(event));
    document.addEventListener('pointercancel', event => endDrag(event, true));
    assistantButton.addEventListener('click', event => {
      if (event.detail === 0) setPanelExpanded(true);
    });
    window.addEventListener('resize', () => {
      if (state.panelExpanded) {
        const position = readPanelPosition();
        applyPanelPosition(position.left, position.top);
      } else {
        const buttonSize = getElementSize(assistantButton, { width: 56, height: 56 });
        const left = assistantButton.style.left ? parseFloat(assistantButton.style.left) :
          window.innerWidth - buttonSize.width - 18;
        const top = assistantButton.style.top ? parseFloat(assistantButton.style.top) : 90;
        applyAssistantPosition(left, top);
      }
    });
    window.visualViewport?.addEventListener('resize', () => {
      if (state.panelExpanded) {
        const position = readPanelPosition();
        applyPanelPosition(position.left, position.top);
      } else {
        const buttonSize = getElementSize(assistantButton, { width: 56, height: 56 });
        const left = assistantButton.style.left ? parseFloat(assistantButton.style.left) :
          window.innerWidth - buttonSize.width - 18;
        const top = assistantButton.style.top ? parseFloat(assistantButton.style.top) : 90;
        applyAssistantPosition(left, top);
      }
    });

    box.querySelector('#wb-min').addEventListener('click', () => setPanelExpanded(false));

    box.querySelector('#wb-scan').addEventListener('click', scanDirectory);
    box.querySelector('#wb-start').addEventListener('click', start);
    box.querySelector('#wb-stop').addEventListener('click', () => stop());
    box.querySelector('#wb-reset').addEventListener('click', resetPlugin);
  }

  function getMenuItems() {
    const seen = new Set();
    const items = [];

    const addItem = el => {
      const itemEl = normalizeCourseItem(el);
      const title = itemTitle(itemEl);
      if (!title || title.length < 2) return;
      const key = getItemKey(itemEl);
      if (!key || seen.has(key)) return;
      seen.add(key);
      items.push(itemEl);
    };

    getStructuredMediaItems().forEach(addItem);

    SELECTORS.menuItems.forEach(selector => {
      document.querySelectorAll(selector).forEach(addItem);
    });

    inferMediaItemsFromDirectory().forEach(addItem);

    return items.filter(isLikelyCourseItem);
  }

  function normalizeCourseItem(el) {
    if (!el) return null;
    return el.closest([
      'li.el-menu-item[role="menuitem"]',
      'li.el-menu-item',
      '.section-item',
      '[class*="section-item"]',
      '[class*="catalog-item"]',
      '[class*="directory-item"]',
      'div.section-content',
      '.section-content',
      '.el-menu-item[role="menuitem"]',
      '.el-menu-item',
      '.courseware-list-item'
    ].join(', ')) || el;
  }

  function isUnstartedItem(el) {
    if (!isLeafCourseItem(el)) return false;
    const host = getStatusHost(el);
    return SELECTORS.pendingIcons.some(selector => host.querySelector(selector));
  }

  function isVideoItem(el) {
    if (!isLeafCourseItem(el)) return false;
    if (el.querySelector('i.text-icon')) return false;
    if (el.querySelector('i.video-icon, i.audio-icon, i.music-icon')) return true;
    if (!looksLikePlayableMedia(el)) return false;
    const host = getStatusHost(el);
    return hasMediaDuration(el) || SELECTORS.videoIcons.some(selector => host.querySelector(selector));
  }

  function isDocumentItem(el) {
    if (!isLeafCourseItem(el)) return false;
    const text = getPrimaryItemText(el);
    if (!text) return false;
    if (!/(ppt|课件|讲义|教材|文档|资料|pdf|doc|docx|slides)/i.test(text)) return false;
    return !hasMediaDuration(el);
  }

  function isActionableItem(el) {
    return isVideoItem(el);
  }

  function itemTitle(el) {
    return getPrimaryItemText(el).slice(0, 90);
  }

  function getChapterTitle(chapterEl) {
    if (!chapterEl) return '';
    const titleEl = chapterEl.querySelector(SELECTORS.chapterTitles.join(', '));
    return titleEl ? compactText(titleEl.innerText || titleEl.textContent).slice(0, 60) : '';
  }

  function getItemKey(el) {
    if (!el) return '';
    const title = itemTitle(el);
    const path = [];
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (node.matches(SELECTORS.chapterRoots.join(', '))) {
        const peers = [...(node.parentElement?.children || [])].filter(n => n.matches(SELECTORS.chapterRoots.join(', ')));
        path.unshift(`${getChapterTitle(node)}#${peers.indexOf(node)}`);
      }
    }
    const root = getChapterRoot(el) || findDirectoryRoot();
    const index = root ? [...root.querySelectorAll('li.el-menu-item')].indexOf(el) : -1;
    return `${path.join('/')}__${title}#${index}`;
  }

  function isLikelyCourseItem(el) {
    const text = getPrimaryItemText(el);
    if (!text) return false;
    if (isVideoItem(el)) return true;
    if (el.querySelector('ul, .section-area, .directory-list, .catalog-list') && !el.matches('div.section-content, .section-content, li.el-menu-item, .el-menu-item')) {
      return false;
    }
    if (/^(目录|笔记|课程资料|课程互动)$/.test(text)) return false;
    if (text.length < 3) return false;
    return true;
  }

  function isLeafCourseItem(el) {
    if (!el) return false;
    if (el.matches('li.el-menu-item[role="menuitem"], li.el-menu-item')) return true;
    return !el.querySelector([
      '.section-item',
      '[class*="section-item"]',
      '.section-content',
      'li.el-menu-item',
      '.el-menu-item',
      '.courseware-list-item'
    ].join(', '));
  }

  function looksLikePlayableMedia(el) {
    const text = getPrimaryItemText(el);
    if (!text) return false;
    if (/(讲义|教材|资料|文档|作业|考试|测试|笔记)/.test(text)) return false;
    if (/小节共/.test(text)) return false;
    if (/^(part\s*[ivx0-9]+|unit\s*\d+\s*(audio|video)?|专题|章节|课程章节)$/i.test(text)) return false;
    return hasMediaDuration(el) || /(track|audio|video|听力|口语|录音|音频)/i.test(text);
  }

  function getStatusHost(el) {
    if (!el) return document.createElement('div');
    return el.closest('.section-item, .section-content, li.el-menu-item, .el-menu-item, .courseware-list-item, .section-area') || el.parentElement || el;
  }

  function hasMediaDuration(el) {
    if (!el) return false;
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return /([0-9]{1,2}\s*[:：]\s*[0-9]{2})|([0-9]{1,2}\s*分\s*[0-9]{1,2}\s*秒)/.test(text);
  }

  function inferMediaItemsFromDirectory() {
    const root = findDirectoryRoot();
    if (!root) return [];

    const nodes = root.querySelectorAll('div, li, button, a');
    const items = [];

    nodes.forEach(node => {
      if (!hasMediaDuration(node)) return;
      const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 160) return;
      if (/^(课程章节|目录|课程资料|课程互动|笔记)$/i.test(text)) return;
      const item = node.closest([
        'li.el-menu-item[role="menuitem"]',
        'li.el-menu-item',
        '.section-item',
        '[class*="section-item"]',
        '[class*="catalog-item"]',
        '[class*="directory-item"]',
        'div.section-content',
        '.section-content',
        '.el-menu-item',
        '.courseware-list-item'
      ].join(', ')) || node;
      items.push(item);
    });

    return items;
  }

  function findDirectoryRoot() {
    return document.querySelector([
      '.sub-menu-area',
      'li.el-sub-menu.is-opened > ul.el-menu.el-menu--inline',
      'ul.el-menu.el-menu--inline',
      '.section-area',
      '[class*="directory"]',
      '[class*="catalog"]',
      '[class*="course-chapter"]',
      '[class*="courseware"]'
    ].join(', '));
  }

  function getStructuredMediaItems() {
    const items = [];

    document.querySelectorAll('li.el-menu-item-group').forEach(group => {
      group.querySelectorAll(':scope > ul > li.el-menu-item[role="menuitem"], :scope > ul > li.el-menu-item').forEach(item => {
        items.push(item);
      });
    });

    document.querySelectorAll('li.el-sub-menu.is-opened > ul.el-menu.el-menu--inline > li.el-menu-item[role="menuitem"], li.el-sub-menu.is-opened > ul.el-menu.el-menu--inline > li.el-menu-item').forEach(item => {
      items.push(item);
    });

    return items;
  }

  function getPrimaryItemText(el) {
    if (!el) return '';
    const lectureTitle = el.querySelector('.lecture-title');
    if (lectureTitle) return compactText(lectureTitle.textContent);
    const lines = (el.innerText || el.textContent || '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!lines.length) return '';

    const primary = lines.find(line => {
      if (/小节共/.test(line)) return false;
      if (/^(目录|笔记|课程资料|课程互动)$/.test(line)) return false;
      return true;
    }) || lines[0];

    return primary.replace(/\s+/g, ' ').trim();
  }

  function getChapterRoot(el) {
    return el ? el.closest(SELECTORS.chapterRoots.join(', ')) : null;
  }

  function getChapterTitle(chapterEl) {
    if (!chapterEl) return '';
    const titleEl = chapterEl.querySelector(SELECTORS.chapterTitles.join(', '));
    return titleEl
      ? compactText(titleEl.innerText || titleEl.textContent).slice(0, 60)
      : '';
  }

  function getActiveMediaEl() {
    const candidates = [];
    for (const selector of SELECTORS.mediaRoots) {
      document.querySelectorAll(selector).forEach(el => {
        if (!candidates.includes(el)) candidates.push(el);
      });
    }
    return candidates.find(el => !el.paused && !el.ended) || candidates[0] || null;
  }

  function renderVideoDirectory(videoItems, pendingItems) {
    const listEl = document.getElementById('wb-video-list');
    const videoCountEl = document.getElementById('wb-video-count');
    const pendingCountEl = document.getElementById('wb-pending-count');
    if (!listEl || !videoCountEl || !pendingCountEl) return;

    const pendingKeys = new Set(pendingItems.map(getItemKey));
    const orderedItems = sortActionableItems(videoItems, pendingKeys);

    const hasLearnDirectory = getRoute() === 'learn' && videoItems.length > 0;
    videoCountEl.textContent = hasLearnDirectory ? String(videoItems.length) : '—';
    pendingCountEl.textContent = hasLearnDirectory ? String(pendingItems.length) : '—';
    listEl.innerHTML = '';

    if (!orderedItems.length) {
      const empty = document.createElement('div');
      empty.className = 'dir-empty';
      empty.textContent = getRoute() === 'home'
        ? '请先进入某门课程的学习页'
        : '暂未识别到学习目录';
      listEl.appendChild(empty);
      return;
    }

    orderedItems.forEach((el, idx) => {
      const btn = document.createElement('button');
      btn.className = 'dir-item';
      const title = itemTitle(el);
      const chapter = getChapterTitle(getChapterRoot(el));
      const pending = pendingKeys.has(getItemKey(el));
      const pageCompleted = isPageCompletedItem(el);
      const itemType = isDocumentItem(el) ? '文档' : '媒体';
      if (pending) btn.classList.add('is-pending');
      const badgeClass = pending ? 'pending' : (pageCompleted ? 'done' : 'unknown');
      const head = document.createElement('div');
      head.className = 'dir-head';
      const titleEl = document.createElement('span');
      titleEl.textContent = `${idx + 1}. ${title}`;
      const badge = document.createElement('span');
      badge.className = `dir-badge ${badgeClass}`;
      badge.textContent = pending ? '待处理' : (pageCompleted ? '页面已完成' : '状态待确认');
      head.append(titleEl, badge);
      const meta = document.createElement('small');
      meta.textContent = [chapter, itemType].filter(Boolean).join(' · ');
      btn.append(head, meta);
      btn.addEventListener('click', () => {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        log(`已定位到：${title}；请由你点击页面中的课程条目`, 'info');
      });
      listEl.appendChild(btn);
    });
  }

  function refreshDirectories(options = {}) {
    const { render = true, logSummary = true } = options;
    if (getRoute() !== 'learn') {
      state.videoItems = [];
      state.pendingItems = [];
      state.lastDirectoryRefresh = Date.now();
      if (render) renderVideoDirectory([], []);
      setText('wb-confirmed', '—');
      setText('wb-course-progress', '未识别');
      renderManualItems(state.manualNotice ? [state.manualNotice] : []);
      if (logSummary) {
        log('首页可以开始自动任务；音视频数量将在扫描课程目录后显示', 'info');
      }
      return { videoItems: [], pendingItems: [] };
    }

    const items = getMenuItems();
    const actionableItems = items.filter(isActionableItem);
    // 没有状态图标的音视频也需要处理，不能把“未识别”当作“已完成”。
    const pendingItems = sortActionableItems(actionableItems.filter(el => !isPageCompletedItem(el) || needsNaturalEnd(el)));
    const videoItems = sortActionableItems(actionableItems);

    state.lastDirectoryRefresh = Date.now();
    state.videoItems = videoItems;
    state.pendingItems = pendingItems;

    if (render) renderVideoDirectory(videoItems, pendingItems);
    if (videoItems.length > 0) {
      updateCompletionSummary(videoItems, pendingItems);
    } else {
      setText('wb-confirmed', '—');
      setText('wb-course-progress', '未识别');
      renderManualItems(state.manualNotice ? [state.manualNotice] : []);
    }
    if (logSummary && videoItems.length === 0) {
      log('当前页面暂未识别到学习资源；请等待目录加载后重新扫描', 'err');
    } else if (logSummary) {
      log(`找到 ${videoItems.length} 个音视频，待处理 ${pendingItems.length} 个`, 'ok');
    }

    return { videoItems, pendingItems };
  }

  function scanDirectory() {
    if (state.resetPending || state.mode === 'resetting' || state.job?.phase === 'resetting') return [];
    return refreshDirectories({ render: true, logSummary: true }).pendingItems;
  }

  function sortActionableItems(items, pendingKeys = null) {
    return [...items].sort((a, b) => compareActionableItems(a, b, pendingKeys));
  }

  function compareActionableItems(a, b, pendingKeys = null) {
    if (pendingKeys) {
      const aPending = pendingKeys.has(getItemKey(a)) ? 0 : 1;
      const bPending = pendingKeys.has(getItemKey(b)) ? 0 : 1;
      if (aPending !== bPending) return aPending - bPending;
    }

    const aDoc = isDocumentItem(a) ? 1 : 0;
    const bDoc = isDocumentItem(b) ? 1 : 0;
    if (aDoc !== bDoc) return aDoc - bDoc;

    const aDuration = getDurationSeconds(a);
    const bDuration = getDurationSeconds(b);
    const aHasDuration = Number.isFinite(aDuration) ? 0 : 1;
    const bHasDuration = Number.isFinite(bDuration) ? 0 : 1;
    if (aHasDuration !== bHasDuration) return aHasDuration - bHasDuration;
    if (aHasDuration === 0 && aDuration !== bDuration) return aDuration - bDuration;

    return itemTitle(a).localeCompare(itemTitle(b), 'zh-CN');
  }

  function getDurationSeconds(el) {
    if (!el) return Number.NaN;
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const cached = state.durationCache.get(el);
    if (cached?.text === text) return cached.seconds;
    let seconds = Number.NaN;
    const hm = text.match(/([0-9]{1,2})\s*[:：]\s*([0-9]{2})(?:\s*[:：]\s*([0-9]{2}))?/);
    if (hm) {
      seconds = hm[3] != null
        ? Number(hm[1]) * 3600 + Number(hm[2]) * 60 + Number(hm[3])
        : Number(hm[1]) * 60 + Number(hm[2]);
    } else {
      const cm = text.match(/([0-9]{1,2})\s*分\s*([0-9]{1,2})\s*秒/);
      if (cm) seconds = Number(cm[1]) * 60 + Number(cm[2]);
    }
    state.durationCache.set(el, { text, seconds });
    return seconds;
  }

  function getDirectoryMediaType(item) {
    if (item.querySelector('i.text-icon')) return 'document';
    if (item.querySelector('i.audio-icon, i.music-icon')) return 'audio';
    if (item.querySelector('i.video-icon')) return 'video';
    return isVideoItem(item) ? 'media' : isDocumentItem(item) ? 'document' : 'other';
  }

  function getDirectorySnapshot(items = getMenuItems()) {
    // Selector priority and expanded chapters can change discovery order.
    // The checkpoint always follows this document's actual directory order.
    const leaves = items.filter(isLeafCourseItem).sort((a, b) => {
      const position = a.compareDocumentPosition(b);
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 :
        position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });
    return {
      version: 1, courseKey: currentCourseKey(),
      items: leaves.map(item => {
        const seconds = getDurationSeconds(item);
        return {
          key: getItemKey(item), title: itemTitle(item), mediaType: getDirectoryMediaType(item),
          durationSeconds: Number.isFinite(seconds) ? seconds : null
        };
      })
    };
  }

  function directorySignature(snapshot) {
    // Storage may reorder object properties. Compare metadata values and
    // actual item order, rather than the insertion order of object fields.
    return JSON.stringify((snapshot?.items || []).map(item => [
      item.key, item.title, item.mediaType, item.durationSeconds
    ]));
  }

  function currentCandidate() {
    return state.job?.phase === 'course' ? state.job.candidates[state.job.targetIndex] : null;
  }

  function savedDirectory() {
    const snapshot = currentCandidate()?.directory;
    return snapshot?.version === 1 && snapshot.courseKey === currentCourseKey() &&
      Array.isArray(snapshot.items) && snapshot.items.length ? snapshot : null;
  }

  function containsSavedDirectory(snapshot, saved) {
    const fresh = new Map(snapshot.items.map(item => [item.key, item]));
    return saved.items.every(item => {
      const found = fresh.get(item.key);
      return found?.title === item.title && found.mediaType === item.mediaType;
    });
  }

  function knownChaptersHaveItems() {
    return [...document.querySelectorAll('li.el-sub-menu')]
      .every(chapter => chapter.querySelector('li.el-menu-item'));
  }

  async function saveDirectoryCheckpoint(snapshot, epoch) {
    assertRunning(epoch);
    if (!currentCandidate() || directorySignature(currentCandidate().directory) === directorySignature(snapshot)) return;
    await jobCommand('directory-checkpoint', { snapshot });
    assertRunning(epoch);
  }

  function getHomeCourseCards() {
    // The paginated home list uses `.course-card-item`.  The similarly named
    // `.left-img-course-item .card-item` nodes belong to a hidden course strip
    // and remain unchanged when the visible list is paginated.
    return [...document.querySelectorAll('.course-card-item')];
  }

  function getHomeCourseCandidate(card, page, order) {
    if (!card) return null;
    const text = compactText(card.innerText || card.textContent);
    if (!/正在上课/.test(text) || /已结课/.test(text)) return null;
    const titleEl = card.querySelector('.item-bg-text p.sle, .course-name p, .right-course-info .name');
    const title = compactText(titleEl && (titleEl.getAttribute('title') || titleEl.textContent));
    if (!title) throw new Error('首页课程名称未识别，不能安全选择课程');
    // The live card only exposes its course title and generic type (e.g.
    // “教学班”), not a unique teaching-class label.  Use the title as identity
    // and stop on duplicates instead of treating that generic type as a class.
    return { key: title, title, page, order, remaining: null, total: null, status: 'uninspected', records: {} };
  }

  function getHomePageNumber() {
    const active = document.querySelector('.el-pagination li.number.is-active');
    return Number(active?.textContent?.trim()) || (document.querySelector('.el-pagination') ? 0 : 1);
  }

  function homeCardsSignature() {
    return getHomeCourseCards().map(card => compactText(card.textContent)).join('|');
  }

  function pageLoading() {
    return [...document.querySelectorAll('.el-loading-mask')].some(el =>
      getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');
  }

  async function waitForHomeCards(epoch, previous = null, expectedPage = null) {
    let signature = '', stableAt = 0;
    const result = await waitUntil(() => {
      if (getRoute() !== 'home') throw new Error('课表页面已改变，请核对页面');
      const next = homeCardsSignature();
      const page = getHomePageNumber();
      if (pageLoading() || !page || (expectedPage != null && page !== expectedPage) ||
        !next || (previous != null && next === previous)) {
        signature = ''; stableAt = 0; return false;
      }
      const observed = `${page}:${next}`;
      if (observed !== signature) { signature = observed; stableAt = Date.now(); return false; }
      return Date.now() - stableAt >= CFG.directoryStableTime;
    }, CFG.directoryLoadTimeout, epoch);
    if (!result) throw new RecoverableError('课表课程列表尚未加载完成，稍后重新识别', 'home-loading');
  }

  async function settleHomePageTransition(epoch) {
    const pending = state.homePageTransition;
    if (!pending) return;
    const checkPage = () => {
      if (getRoute() !== 'home') throw new Error('课表页面已改变，请核对页面');
      const page = getHomePageNumber();
      if (page && page !== pending.fromPage && page !== pending.targetPage) {
        throw new Error('课表分页位置与当前扫描不符，请核对页面');
      }
      return page;
    };
    // Retain an unfinished page change across retry rounds. A changed page
    // number alone does not prove that its course cards have arrived.
    if (pending.retryClick && checkPage() === pending.fromPage &&
      homeCardsSignature() === pending.previousSignature && !pageLoading()) {
      const button = document.querySelector(`.el-pagination .btn-${pending.direction}`);
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
        throw new RecoverableError('课表分页按钮暂不可用，稍后重新识别', 'home-loading');
      }
      pending.retryClick = false;
      const clicked = await humanClick(button, epoch, () => checkPage() === pending.fromPage &&
        homeCardsSignature() === pending.previousSignature && !pageLoading() &&
        button === document.querySelector(`.el-pagination .btn-${pending.direction}`) &&
        button.isConnected && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
      if (clicked === false && checkPage() === pending.fromPage) {
        if (state.homePageTransition === pending) state.homePageTransition = null;
        throw new RecoverableError('课表分页状态已变化，稍后重新识别', 'home-loading');
      }
    }
    const changed = await waitUntil(() => checkPage() === pending.targetPage, CFG.directoryLoadTimeout, epoch);
    if (!changed) {
      pending.retryClick = checkPage() === pending.fromPage &&
        homeCardsSignature() === pending.previousSignature && !pageLoading();
      throw new RecoverableError('课表分页暂未切换，稍后重试', 'home-loading');
    }
    await waitForHomeCards(epoch, pending.previousSignature, pending.targetPage);
    if (state.homePageTransition === pending) state.homePageTransition = null;
  }

  async function stepHomePage(direction, epoch) {
    const page = getHomePageNumber();
    state.homePageTransition = { runId: state.job?.runId, direction,
      fromPage: page, targetPage: page + (direction === 'next' ? 1 : -1),
      previousSignature: homeCardsSignature(), retryClick: true };
    await settleHomePageTransition(epoch);
  }

  async function goToHomePageNumber(page, epoch) {
    if (state.homePageTransition?.runId !== state.job?.runId) state.homePageTransition = null;
    await settleHomePageTransition(epoch);
    await waitForHomeCards(epoch);
    if (!getHomePageNumber()) throw new Error('首页当前页码无法识别');
    while (getHomePageNumber() !== page) {
      await stepHomePage(getHomePageNumber() < page ? 'next' : 'prev', epoch);
    }
  }

  async function scanHomeCourses(epoch) {
    await goToHomePageNumber(1, epoch);
    const candidates = [], seen = new Set(), signatures = new Set();
    while (true) {
      assertRunning(epoch);
      const page = getHomePageNumber();
      const signature = homeCardsSignature();
      if (state.homePageTransition || pageLoading() || !page || !signature) {
        throw new RecoverableError('课表正在更新，稍后重新扫描', 'home-loading');
      }
      if (signatures.has(signature)) throw new Error('首页分页内容重复，课程范围无法确认');
      signatures.add(signature);
      for (const [order, card] of getHomeCourseCards().entries()) {
        const candidate = getHomeCourseCandidate(card, page, order);
        if (!candidate) continue;
        if (seen.has(candidate.key)) throw new Error(`课程名称重复，不能区分：${candidate.title}`);
        seen.add(candidate.key);
        candidates.push(candidate);
      }
      const next = document.querySelector('.el-pagination .btn-next');
      if (!next) {
        if (document.querySelector('.el-pagination')) throw new Error('首页下一页按钮未识别');
        break;
      }
      if (next.disabled || next.getAttribute('aria-disabled') === 'true') break;
      await stepHomePage('next', epoch);
    }
    return candidates;
  }

  async function findHomeCandidate(candidate, epoch) {
    await goToHomePageNumber(candidate.page, epoch);
    const matching = getHomeCourseCards().filter(card => getHomeCourseCandidate(card, candidate.page, 0)?.key === candidate.key);
    if (matching.length !== 1) throw new Error(`首页不能唯一找到课程：${candidate.title}；请重新扫描`);
    // Real-site evidence is the course name, not an arbitrary card container.
    const entry = matching[0].querySelector('.item-bg-text p.sle, .course-name p, .right-course-info .name');
    if (!entry || compactText(entry.getAttribute('title') || entry.textContent) !== candidate.title) throw new Error('课程名称点击入口未识别');
    return entry;
  }

  function chooseLowestRemaining(candidates) {
    return candidates.map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => (candidate.status === 'inspected' ||
        (candidate.status === 'retry' && Number(candidate.retryAt) <= Date.now())) &&
        Number.isFinite(candidate.remaining) && candidate.remaining > 0)
      .sort((a, b) => Number(a.candidate.status === 'retry') - Number(b.candidate.status === 'retry') ||
        (Number(a.candidate.retryRounds) || 0) - (Number(b.candidate.retryRounds) || 0) ||
        a.candidate.remaining - b.candidate.remaining || a.index - b.index)[0] || null;
  }

  function nextCourseRetryAt(candidates) {
    return Math.min(...candidates.filter(candidate => candidate.status === 'retry')
      .map(candidate => Number(candidate.retryAt)).filter(Number.isFinite));
  }

  function getAgentTimetableEntry() {
    // The observed homepage uses a Vue click handler on this anchor. It has
    // no href; use its actual visible control rather than inventing a URL.
    const entries = [...document.querySelectorAll('.my-course-container a.timetable')]
      .filter(el => compactText(el.textContent) === '查看所有课表' && isVisibleElement(el));
    if (entries.length > 1) throw new Error('首页出现多个“查看所有课表”入口，已停止，请核对页面');
    return entries[0] || null;
  }

  async function runAgentEntryJob(epoch) {
    // A reload or delayed navigation must not click the entry a second time.
    // The background retains the attempt and stops it if its deadline expires.
    if (state.job.entryClicked) { setCurrentTask('等待课表打开'); return; }
    setCurrentTask('正在打开课表');
    const assertAgentPage = () => {
      if (getRoute() !== 'agent') throw new Error('首页已变化，已停止打开课表，请核对后继续');
    };
    const ready = await waitUntil(() => {
      assertAgentPage();
      const entry = getAgentTimetableEntry();
      const expand = document.getElementById('collapseBtn2');
      return entry ? { entry } : isVisibleElement(expand) ? { expand } : null;
    }, Math.min(CFG.directoryLoadTimeout, 10000), epoch);
    if (!ready) throw new RecoverableError('课表入口暂未加载，稍后重新识别', 'entry');
    let entry = ready.entry;
    if (!entry) {
      // On a narrow window the real site collapses this sidebar. Expand it
      // once using the observed button and keep the original click rhythm.
      await humanClick(ready.expand, epoch, () => {
        assertAgentPage();
        if (getAgentTimetableEntry() || !isVisibleElement(ready.expand)) {
          throw new RecoverableError('首页侧栏正在变化，重新识别入口', 'entry');
        }
      });
      entry = await waitUntil(() => {
        assertAgentPage();
        return getAgentTimetableEntry();
      }, Math.min(CFG.directoryLoadTimeout, 10000), epoch);
      if (!entry) throw new RecoverableError('课表入口暂未显示，稍后重新识别', 'entry');
    }
    assertRunning(epoch);
    await jobCommand('entry-open');
    await humanClick(entry, epoch, () => {
      assertAgentPage();
      if (getAgentTimetableEntry() !== entry) throw new RecoverableError('课表入口正在更新，重新识别后继续', 'entry');
    });
    setCurrentTask('等待课表打开');
  }

  async function runHomeJob(epoch) {
    if (state.job.phase === 'scan-home') {
      const candidates = await scanHomeCourses(epoch);
      await jobCommand('scan-result', { candidates });
    }
    if (state.job.phase !== 'home') return;
    const job = state.job;
    const missingEntry = job.candidates.findIndex(candidate =>
      candidate.status === 'inspected' && candidate.remaining > 0 && !candidate.learnUrl);
    const inspectIndex = job.inspectIndex < job.candidates.length ? job.inspectIndex : missingEntry;
    const inspecting = inspectIndex >= 0;
    const selected = inspecting ? { index: inspectIndex, candidate: job.candidates[inspectIndex] } : chooseLowestRemaining(job.candidates);
    if (!selected) {
      const nextRetry = nextCourseRetryAt(job.candidates);
      if (Number.isFinite(nextRetry)) {
        setText('wb-status', '等待自动重试');
        setCurrentTask('暂时未完成的课程稍后再试');
        await taskWait(Math.max(1, Math.min(nextRetry - Date.now(), 30000)), epoch);
        return;
      }
      await jobCommand('finish'); return;
    }
    const entry = await findHomeCandidate(selected.candidate, epoch);
    await jobCommand('open', { index: selected.index, purpose: inspecting ? 'inspect' : 'play' });
    if (state.job.workerTabId === state.tabId) return; // The background already navigated this tab.
    await humanClick(entry, epoch);
    setCurrentTask('等待课程页面打开');
    // No repeated clicks: the background accepts only this newly opened task tab.
  }

  async function runCurrentCourseJob(epoch) {
    const job = state.job;
    const candidate = job.candidates[job.targetIndex];
    if (candidate.status === 'retry') {
      setText('wb-status', '等待自动重试');
      setCurrentTask('暂时未完成的音视频稍后再试');
      await taskWait(Math.max(1, Number(candidate.retryAt) - Date.now()), epoch);
      await jobCommand('open', { index: job.targetIndex, purpose: 'play' });
      return;
    }
    // Media can be created or restarted after the first pause, while title
    // and directory loading are still in progress.
    const recovering = job.targetPurpose === 'play' &&
      job.interruption?.courseKey === candidate.courseKey;
    const retainCurrent = !recovering && retainCurrentMedia(job);
    observeDiagnostic('guards', {
      decision: job.targetPurpose === 'inspect' ? 'pause-inspection' : recovering
        ? 'pause-recovery-directory' : retainCurrent ? 'retain-current' : 'pause-initial',
      media: observeCurrentMedia()
    });
    if (retainCurrent) state.mediaLoadingHold = null;
    else holdLoadingMedia(epoch, job.targetPurpose === 'inspect' ? 'initial-inspection'
      : recovering ? 'interruption-directory-check' : 'initial-resource-check');
    if (recovering) {
      setText('wb-status', '正在恢复');
      setCurrentTask('正在核对原课程目录，请稍候');
      log('已返回原课程，正在核对目录；核对完成后继续原音视频');
    }
    const title = await waitUntil(() => compactText(getDisplayedCourseTitle()), CFG.directoryLoadTimeout, epoch);
    if (title !== candidate.title || currentCourseKey() !== candidate.courseKey) throw new Error('打开的课程或教学班与任务不符');
    setText('wb-course', title);
    state.processedCourseKey = candidate.courseKey;
    state.processedItems = new Map(Object.entries(candidate.records || {}));
    state.resourceCheckpoint = candidate.currentResource || null;
    if (job.targetPurpose === 'inspect') {
      setCurrentTask(`正在统计：${candidate.title}`);
      const summary = await waitForDirectory(epoch);
      requireRecordedResources(summary.videoItems);
      assertRunning(epoch);
      pauseMedia('inspection-finished');
      if (state.mediaLoadingHold?.epoch === epoch) state.mediaLoadingHold.leavingInspection = true;
      await jobCommand('course-result', { result: {
        total: summary.videoItems.length, remaining: summary.pendingItems.length,
        unfinished: getUnfinishedTitles()
      } });
    } else {
      const result = job.singlePass
        ? await runSinglePassCourse(epoch)
        : await runCourse(epoch);
      if (result?.refreshing) return;
      assertRunning(epoch);
      pauseMedia('course-finished');
      await jobCommand('course-result', { result: {
        total: result.total, remaining: result.unconfirmed.length,
        unconfirmed: result.unconfirmed, failures: result.failures,
        unfinished: result.unfinished, ...(result.finalPass ? { finalPass: true } : {})
      } });
    }
  }

  async function resumeSharedJob() {
    if (state.resetPending || state.startPending || state.pausePending || state.reloadPending || state.jobPromise || !state.job?.running || state.job.ownerTabId !== state.tabId ||
      state.job.ownerInstance !== state.instanceId || !['entry-home', 'scan-home', 'home', 'course'].includes(state.job.phase)) return;
    // An already-issued get can arrive while the explicit pause is being
    // saved. Only a newer authorized generation can resume this document.
    if (state.localMediaStop?.runId === state.job.runId) {
      if (state.job.generation <= state.localMediaStop.generation) return;
      state.localMediaStop = null;
    }
    const epoch = ++state.epoch;
    state.activeGeneration = state.job.generation;
    state.running = true;
    state.mode = 'automatic';
    setText('wb-status', '运行中');
    state.jobPromise = (async () => {
      try {
        if (getRoute() === 'agent' && state.job.phase === 'entry-home') await runAgentEntryJob(epoch);
        else if (getRoute() === 'home' && ['scan-home', 'home'].includes(state.job.phase)) await runHomeJob(epoch);
        else if (getRoute() === 'learn' && state.job.phase === 'course') await runCurrentCourseJob(epoch);
        else throw new Error('当前页面与自动任务不符，请核对后继续');
      } catch (error) {
        if (error instanceof RecoverableError && state.running && epoch === state.epoch) {
          // Course-level interruptions (route/identity/directory changes) are
          // recorded in the durable three-attempt episode. Resource-level
          // playback errors are handled by playItemWithRecovery itself.
          const candidate = currentCandidate();
          const resource = candidate?.currentResource;
          if (state.job?.phase === 'course' && candidate?.courseKey) {
            try {
              // A returned SPA can retain a broken directory component. Once
              // its ordinary loading checks time out, reload only this saved
              // resource entry, within the same durable interruption budget.
              const reload = error.kind === 'directory-load' && state.job.targetPurpose === 'play' &&
                state.job.interruption?.courseKey === candidate.courseKey && resource?.stage === 'ready' &&
                resource.routeKey && getRoute() === 'learn' && currentCourseKey() === candidate.courseKey &&
                routeEquals(getRouteKey(), resource.routeKey);
              const navigation = ['navigation', 'source'].includes(error.kind) || Boolean(reload);
              await spendInterruptionAttempt(error, resource?.key || '', epoch, navigation, Boolean(reload));
              if (navigation) return;
              setText('wb-status', '正在恢复');
              setCurrentTask(error.message);
              log(`页面暂未就绪，稍后自动重试：${error.message}`);
              await taskWait(randomDelay(CFG.recoveryWaitMin, CFG.recoveryWaitMax), epoch);
            } catch (cancelled) {
              if (!(cancelled instanceof TaskCancelled)) stopForManual(cancelled.message);
            }
          } else {
            setText('wb-status', '等待自动恢复');
            setCurrentTask(error.message);
            log(`页面暂未就绪，稍后自动重试：${error.message}`);
            try { await taskWait(CFG.resourceRetryDelay, epoch); }
            catch (cancelled) { if (!(cancelled instanceof TaskCancelled)) stopForManual(cancelled.message); }
          }
        } else if (!(error instanceof TaskCancelled) && state.running && epoch === state.epoch) stopForManual(error.message);
      }
    })().finally(() => { state.jobPromise = null; });
    return state.jobPromise;
  }

  function refreshProgressUI(pct) {
    const progress = document.getElementById('wb-progress');
    if (progress) progress.textContent = pct == null ? '未识别' : `${(pct * 100).toFixed(1)}%`;
  }

  function getDisplayedCourseTitle() {
    const selectors = [
      '[class*="course-name"]',
      '[class*="course-title"]',
      '[class*="courseName"]',
      '[class*="courseTitle"]',
      'h1',
      'h2'
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = compactText(el && (el.innerText || el.textContent));
      if (text && !/课程监督助手|目录|课程章节/.test(text)) return text.slice(0, 80);
    }
    const media = getActiveMediaEl();
    if (media) {
      const parentText = compactText(media.parentElement && media.parentElement.innerText);
      if (parentText) return parentText.slice(0, 80);
    }
    return '';
  }

  function getDisplayedItemTitle() {
    const active = document.querySelector('li.el-menu-item.is-active .lecture-title');
    if (active) return compactText(active.textContent);
    const media = getActiveMediaEl();
    if (!media) return '';
    let node = media.parentElement;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      const text = compactText(node.innerText || node.textContent);
      if (text && text.length < 140 && !/总计视频长度|已观看|播放|静音|全屏/.test(text)) {
        return text.slice(0, 90);
      }
    }
    return '';
  }

  function getMediaSnapshot() {
    const media = getActiveMediaEl();
    if (!media) return null;
    const duration = Number(media.duration);
    const currentTime = Number(media.currentTime);
    return {
      media,
      duration,
      currentTime,
      ended: Boolean(media.ended),
      paused: Boolean(media.paused),
      readyState: Number(media.readyState) || 0
    };
  }

  function updateCurrentTask() {
    if (getRoute() !== 'learn') return;
    const media = getActiveMediaEl();
    const itemTitleText = getDisplayedItemTitle();
    const courseTitle = getDisplayedCourseTitle();
    setText('wb-course', courseTitle || (getRoute() === 'learn' ? '学习页' : '未识别页面'));
    // The executor owns this label once a task exists. A late SPA route or
    // title update must not replace inspection/recovery/pause instructions.
    const showResourceAsTask = !state.job && !state.running && !state.startPending;
    if (itemTitleText) {
      state.currentItemKey = itemTitleText;
      if (showResourceAsTask) setCurrentTask(itemTitleText);
      if (itemTitleText !== state.lastLoggedItemKey) {
        state.lastLoggedItemKey = itemTitleText;
        log(`页面当前显示资源：${itemTitleText}`, 'info');
      }
    } else {
      state.currentItemKey = '';
      if (showResourceAsTask && media) {
        setCurrentTask('当前媒体名称未识别');
      } else if (showResourceAsTask && getRoute() === 'learn') {
        setCurrentTask('等待识别当前媒体');
      }
    }
  }

  function refreshDirectoryIfNeeded() {
    if (getRoute() !== 'learn') return;
    const now = Date.now();
    if (now - state.lastDirectoryRefresh < CFG.directoryRefreshInterval) return;
    state.lastDirectoryRefresh = now;
    refreshDirectories({ render: true, logSummary: false });
  }

  class TaskCancelled extends Error {}

  class RecoverableError extends Error {
    constructor(message, kind = 'playback') {
      super(message);
      this.kind = kind;
    }
  }

  class DeferredResource extends RecoverableError {}

  function currentCourseKey() {
    const course = (location.hash || '').match(/\/courseWare\/([^/?]+)/);
    const classId = new URLSearchParams((location.hash || '').split('?')[1] || '').get('classId') || '';
    return course ? `${course[1]}::${classId}` : '';
  }

  async function rememberItem(key, result) {
    state.processedItems.set(key, result);
    if (result.ended && state.resourceCheckpoint?.key === key) state.resourceCheckpoint = null;
    if (state.job?.phase === 'course' && state.job.running &&
      currentCourseKey() === currentCandidate()?.courseKey) {
      await jobCommand('record', { key, result });
    }
  }

  async function rememberResource(key, title, stage, routeKey, epoch) {
    assertRunning(epoch);
    if (currentCandidate()) await jobCommand('resource-checkpoint', { key, title, stage, routeKey });
    state.resourceCheckpoint = { key, title, stage, routeKey };
    assertRunning(epoch);
  }

  function assertRunning(epoch) {
    if (!state.running || epoch !== state.epoch) throw new TaskCancelled();
    if (state.job && (!state.job.running || state.job.generation !== state.activeGeneration ||
      state.job.ownerTabId !== state.tabId || state.job.ownerInstance !== state.instanceId)) throw new TaskCancelled();
    const notice = getBlockingNotice();
    if (notice) {
      stopForManual(`页面提示“${notice}”，自动任务已停止，请按网站要求处理`);
      throw new TaskCancelled();
    }
  }

  function randomDelay(min, max) {
    return Math.round(min + Math.random() * (max - min));
  }

  async function taskWait(ms, epoch, checkTarget = () => {}) {
    const end = Date.now() + ms;
    do {
      assertRunning(epoch);
      checkTarget();
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, end - Date.now()))));
    } while (Date.now() < end);
    assertRunning(epoch);
    checkTarget();
  }

  async function waitUntil(predicate, timeout, epoch) {
    const end = Date.now() + timeout;
    do {
      assertRunning(epoch);
      const value = predicate();
      if (value) return value;
      await taskWait(250, epoch);
    } while (Date.now() < end);
    return null;
  }

  // 复用原版的滚动、鼠标路径、悬停、按下/松开和停顿节奏。
  // 原版同时 dispatch click 和 el.click()，此处只发出一次最终点击。
  async function humanClick(el, epoch, checkTarget = () => {}) {
    if (state.job) await jobCommand('get');
    assertRunning(epoch);
    checkTarget();
    if (!el || !el.isConnected || el.disabled) throw new RecoverableError('页面操作按钮暂时不可用', 'button');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await taskWait(randomDelay(CFG.beforeClickDelayMin, CFG.beforeClickDelayMax), epoch);
    const rect = el.getBoundingClientRect();
    const endX = rect.left + rect.width * (0.2 + Math.random() * 0.6);
    const endY = rect.top + rect.height * (0.2 + Math.random() * 0.6);
    const startX = Math.max(0, endX - randomDelay(40, 150));
    const startY = Math.max(0, endY - randomDelay(20, 100));
    const p1 = { x: startX + (endX - startX) * 0.3, y: startY + randomDelay(-20, 20) };
    const p2 = { x: endX - randomDelay(10, 30), y: endY + randomDelay(-10, 10) };
    for (let step = 1; step <= 12; step += 1) {
      const t = step / 12;
      const q = 1 - t;
      const x = q ** 3 * startX + 3 * q ** 2 * t * p1.x + 3 * q * t ** 2 * p2.x + t ** 3 * endX;
      const y = q ** 3 * startY + 3 * q ** 2 * t * p1.y + 3 * q * t ** 2 * p2.y + t ** 3 * endY;
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      await taskWait(randomDelay(8, 18), epoch);
    }
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await taskWait(randomDelay(CFG.hoverDelayMin, CFG.hoverDelayMax), epoch);
    checkTarget();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: endX, clientY: endY }));
    await taskWait(randomDelay(35, 110), epoch);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: endX, clientY: endY }));
    await taskWait(randomDelay(35, 120), epoch);
    if (state.job) await jobCommand('get');
    assertRunning(epoch);
    if (checkTarget() === false) return false;
    el.click();
    return true;
  }

  function pauseMedia(reason = 'local-stop') {
    document.querySelectorAll('video, audio').forEach(media => {
      if (!media.paused) {
        const before = playbackObservation(media);
        media.pause();
        observeDiagnostic('pauses', { reason, before, after: playbackObservation(media) });
      }
    });
  }

  function retainCurrentMedia(job) {
    const checkpoint = job?.candidates[job.targetIndex]?.currentResource;
    return job?.targetPurpose !== 'inspect' && checkpoint?.routeKey &&
      routeEquals(checkpoint.routeKey, getRouteKey());
  }

  function holdLoadingMedia(epoch, reason) {
    state.mediaLoadingHold = {
      epoch, runId: state.job?.runId, generation: state.job?.generation, reason,
      courseKey: currentCourseKey(), leavingInspection: false
    };
    pauseMedia(reason);
  }

  function enforceMediaPause() {
    pauseForStoppedTask();
    const hold = state.mediaLoadingHold;
    if (hold && (hold.epoch === state.epoch ||
      (hold.leavingInspection && !state.running && hold.courseKey === currentCourseKey())) &&
      hold.runId === state.job?.runId &&
      hold.generation === state.job?.generation && getRoute() === 'learn') {
      pauseMedia(hold.reason);
    }
  }

  function releaseLoadingMedia(epoch) {
    assertRunning(epoch);
    const hold = state.mediaLoadingHold;
    if (hold?.epoch === epoch && hold.runId === state.job?.runId &&
      hold.generation === state.job?.generation) state.mediaLoadingHold = null;
  }

  function isVisibleElement(el) {
    if (!el?.isConnected || !el.getClientRects().length) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return true;
  }

  function getPlaybackStartButton(media) {
    const player = media?.closest('.video-js, .audio-player, .player-wrapper');
    if (!player) return null;
    if (player.matches('.video-js') && !player.classList.contains('vjs-paused')) return null;
    const candidates = [
      player.querySelector('button.vjs-big-play-button'),
      player.querySelector('button.vjs-play-control.vjs-paused')
    ];
    return candidates.find(button => button && !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true' && isVisibleElement(button)) || null;
  }

  function playbackObservation(media) {
    const activation = navigator.userActivation;
    return {
      time: Date.now(),
      pageIsActive: activation?.isActive ?? null,
      pageHasBeenActive: activation?.hasBeenActive ?? null,
      paused: media.paused, ended: media.ended,
      currentTime: media.currentTime, readyState: media.readyState,
      errorCode: media.error?.code ?? null,
      connected: media.isConnected,
      currentMedia: getActiveMediaEl() === media,
      visibility: document.visibilityState
    };
  }

  function observeDiagnostic(section, value) {
    if (state.resetPending || (state.resetEpoch > 0 && ['idle', 'resetting'].includes(state.mode))) return;
    const entries = state.playbackDiagnostics[section];
    const limit = section === 'mediaEvents' ? 60 : 16;
    // Preserve early evidence; later polls cannot replace the first handshake.
    if (entries && entries.length < limit) entries.push({ time: Date.now(), ...value });
  }

  function observeCurrentMedia() {
    const media = getActiveMediaEl();
    return media ? playbackObservation(media) : null;
  }

  function observeHandshake(action, stage) {
    const entries = state.playbackDiagnostics.handshake;
    const job = state.job;
    const observation = {
      time: Date.now(), action, stage, localRunning: state.running, tabKnown: state.tabId != null,
      phase: job?.phase ?? null, taskRunning: job?.running ?? null,
      owns: Boolean(job && state.tabId != null &&
        job.ownerTabId === state.tabId && job.ownerInstance === state.instanceId),
      generation: job?.generation ?? null, media: observeCurrentMedia()
    };
    if (action !== 'get' || !entries.some(entry => entry.action === action && entry.stage === stage)) {
      observeDiagnostic('handshake', observation);
    }
    return observation;
  }

  function observeEarlyMedia(event) {
    const media = event.target;
    if (getRoute() !== 'learn' || !media?.matches?.('video, audio')) return;
    observeDiagnostic('mediaEvents', { type: event.type, ...playbackObservation(media) });
    if (['loadstart', 'loadedmetadata', 'play', 'playing'].includes(event.type)) enforceMediaPause();
  }

  // Read only: these entries describe requests made by the website itself.
  // No response body, account identifier or request URL is saved in task records.
  function getReportTiming(entry) {
    try {
      const url = new URL(entry.name);
      if (url.origin !== location.origin || url.username || url.password ||
        url.pathname !== '/api/learning-service/admin/studentLearning/videoLearnProcessReport' ||
        !['fetch', 'xmlhttprequest'].includes(entry.initiatorType)) return null;
      const origin = performance.timeOrigin;
      if (!Number.isFinite(origin) || !Number.isFinite(entry.startTime) ||
        !Number.isFinite(entry.responseEnd) || entry.startTime < 0 ||
        entry.responseEnd <= entry.startTime) return null;
      return {
        status: Number(entry.responseStatus) || 0,
        startAt: origin + entry.startTime,
        endAt: origin + entry.responseEnd
      };
    } catch { return null; }
  }

  function gatewayFailureForPause(reports, pauseAt, startedAt) {
    if (!pauseAt) return null;
    const latest = reports.filter(entry => entry.startAt >= startedAt && entry.endAt <= pauseAt)
      .sort((a, b) => b.endAt - a.endAt)[0];
    return latest && [502, 503, 504].includes(latest.status) &&
      pauseAt - latest.endAt <= 2000 ? latest : null;
  }

  function getPlaybackBlockingDialog() {
    const hasVisibleArea = el => isVisibleElement(el) &&
      [...el.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
    return [...document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], [role="alert"], .el-message-box, ' +
      '.el-dialog, .el-overlay, .popup-question-dialog, #popupDomId'
    )].find(el => !el.closest('#wb-study-ui') && !isPlayerPlaybackErrorDialog(el) && isVisibleElement(el) &&
      // The site leaves an empty, zero-height question container mounted.
      // A positioned child can still be visible outside a zero-height parent.
      (hasVisibleArea(el) || [...el.querySelectorAll('*')].some(hasVisibleArea))) || null;
  }

  function trustedPlayerInput(event, media) {
    if (!event.isTrusted || !['pointerdown', 'click', 'keydown'].includes(event.type)) return false;
    const player = media.closest('.video-js, .audio-player, .player-wrapper');
    const target = event.type === 'keydown' && !player?.contains(event.target)
      ? document.activeElement : event.target;
    const volumeControl = target?.closest?.(
      '.vjs-mute-control, .vjs-volume-panel, .vjs-volume-control, .vjs-volume-bar, .vjs-volume-menu-button'
    );
    if (volumeControl && player?.contains(volumeControl)) return false;
    if (event.type === 'keydown' && ['ArrowUp', 'ArrowDown', 'm', 'M'].includes(event.key)) return false;
    return Boolean(player && (player.contains(event.target) ||
      (event.type === 'keydown' && player.contains(document.activeElement))));
  }

  async function waitForDirectory(epoch) {
    observeDiagnostic('directory', { stage: 'before', media: observeCurrentMedia() });
    const sideButton = [...document.querySelectorAll('.sidebar-item')]
      .find(el => compactText(el.textContent) === '目录');
    if (sideButton && !findDirectoryRoot()?.getClientRects().length) {
      await humanClick(sideButton, epoch);
      await taskWait(randomDelay(CFG.afterExpandDelayMin, CFG.afterExpandDelayMax), epoch);
    }
    // Expand each known chapter normally. A stable partial list is not enough.
    const ready = await waitUntil(() => findDirectoryRoot() && !pageLoading() &&
      (getMenuItems().length || document.querySelector('li.el-sub-menu')), CFG.directoryLoadTimeout, epoch);
    if (!ready) throw new RecoverableError('课程目录尚未加载，正在等待重新识别', 'directory-load');
    const saved = savedDirectory();
    if (saved && knownChaptersHaveItems() &&
      directorySignature(getDirectorySnapshot()) === directorySignature(saved)) {
      let stableSince = Date.now();
      const reused = await waitUntil(() => {
        if (pageLoading() || !findDirectoryRoot()) { stableSince = Date.now(); return false; }
        const snapshot = getDirectorySnapshot();
        if (!knownChaptersHaveItems() ||
          directorySignature(snapshot) !== directorySignature(saved)) return 'changed';
        return Date.now() - stableSince >= CFG.directoryStableTime && snapshot;
      }, CFG.directoryLoadTimeout, epoch);
      if (reused && reused !== 'changed') {
        log('已核对当前课目录，沿用已有课程统计和时长；完成状态重新读取页面');
        observeDiagnostic('directory', { stage: 'reused', media: observeCurrentMedia() });
        return refreshDirectories({ render: true, logSummary: false });
      }
    }
    const expanded = new WeakSet();
    while (true) {
      assertRunning(epoch);
      const chapter = [...document.querySelectorAll('li.el-sub-menu')]
        .find(el => !expanded.has(el));
      if (!chapter) break;
      expanded.add(chapter);
      if (chapter.getAttribute('aria-expanded') !== 'true') {
        const button = chapter.querySelector(':scope > .el-sub-menu__title');
        if (!button) throw new RecoverableError('章节展开入口暂未识别', 'directory-load');
        await humanClick(button, epoch);
        const open = await waitUntil(() => chapter.getAttribute('aria-expanded') === 'true', CFG.directoryLoadTimeout, epoch);
        if (!open) throw new RecoverableError('章节暂未展开', 'directory-load');
        await taskWait(randomDelay(CFG.afterExpandDelayMin, CFG.afterExpandDelayMax), epoch);
      }
      const chapterReady = await waitUntil(() => !chapter.isConnected || chapter.querySelector('li.el-menu-item'),
        CFG.directoryLoadTimeout, epoch);
      if (!chapterReady || !chapter.isConnected) throw new RecoverableError('章节条目尚未加载完成', 'directory-load');
    }
    let signature = '';
    let firstStableAt = 0;
    const loaded = await waitUntil(() => {
      if (pageLoading()) { signature = ''; return false; }
      const items = getMenuItems();
      if (!findDirectoryRoot() || !items.length) { signature = ''; return false; }
      const snapshot = getDirectorySnapshot(items);
      // A refresh cannot turn missing or changed saved resources into a
      // smaller, supposedly complete course. Wait for the whole directory.
      if (saved && !containsSavedDirectory(snapshot, saved)) { signature = ''; return false; }
      const next = directorySignature(snapshot);
      if (next !== signature) {
        signature = next;
        firstStableAt = Date.now();
        return false;
      }
      return Date.now() - firstStableAt >= CFG.directoryStableTime && items;
    }, CFG.directoryLoadTimeout, epoch);
    if (!loaded) throw new RecoverableError(saved
      ? '课程目录尚未与保存的完整目录一致，稍后重新识别'
      : '课程目录尚未完整加载', 'directory-load');
    await saveDirectoryCheckpoint(getDirectorySnapshot(loaded), epoch);
    observeDiagnostic('directory', { stage: 'collected', media: observeCurrentMedia() });
    return refreshDirectories({ render: true, logSummary: true });
  }

  async function openMediaItem(item, epoch, forceOpen = false) {
    const sideButton = [...document.querySelectorAll('.sidebar-item')]
      .find(el => compactText(el.innerText || el.textContent) === '目录');
    const root = findDirectoryRoot();
    if (sideButton && root && !root.getClientRects().length) {
      await humanClick(sideButton, epoch);
      await taskWait(randomDelay(CFG.afterExpandDelayMin, CFG.afterExpandDelayMax), epoch);
    }
    const chapters = [];
    for (let node = item.parentElement; node; node = node.parentElement) {
      if (node.matches('li.el-sub-menu')) chapters.unshift(node);
    }
    for (const chapter of chapters) {
      if (chapter.getAttribute('aria-expanded') !== 'true') {
        const title = chapter.querySelector(':scope > .el-sub-menu__title');
        if (!title) throw new RecoverableError('章节展开入口暂未识别', 'directory');
        await humanClick(title, epoch);
        await taskWait(randomDelay(CFG.afterExpandDelayMin, CFG.afterExpandDelayMax), epoch);
      }
    }
    if (forceOpen || !item.classList.contains('is-active')) await humanClick(item, epoch);
  }

  async function playItemToEnd(item, epoch, courseKey, options = {}) {
    const resourceStartedAt = Date.now();
    const key = getItemKey(item);
    const title = itemTitle(item);
    const singlePass = options.singlePass === true;
    const savedRecord = state.processedItems.get(key) || {};
    const effectiveTarget = singlePass
      ? normalizePlaybackTarget(options.targetPercent ?? savedRecord.effectiveTarget ?? getPlaybackTarget())
      : 100;
    if (currentCourseKey() !== courseKey) {
      throw new RecoverableError('页面已离开当前课程，正在返回原课程', 'navigation');
    }
    const checkpoint = state.resourceCheckpoint || currentCandidate()?.currentResource;
    const expectedRoute = checkpoint?.key === key ? checkpoint.routeKey : '';
    const previousRecoveries = state.processedItems.get(key)?.playbackAttempt?.recoveries || [];
    setCurrentTask(`正在打开：${title}`);
    // Save the intended resource before any click or media-loading wait.
    // This is an attempt, not evidence that it has opened or completed.
    await rememberResource(key, title, 'opening', expectedRoute || '', epoch);
    const wasActive = item.classList.contains('is-active');
    const before = getActiveMediaEl();
    const beforeSource = before && (before.currentSrc || before.src);
    let metadataLoaded = false;
    const onMetadata = () => { metadataLoaded = true; };
    before?.addEventListener('loadedmetadata', onMetadata);
    let ready;
    try {
      await openMediaItem(item, epoch, options.forceOpen);
      ready = await waitUntil(() => {
        const active = document.querySelector('li.el-menu-item.is-active');
        const snapshot = getMediaSnapshot();
        const newMedia = snapshot && (wasActive || snapshot.media !== before ||
          (snapshot.media.currentSrc || snapshot.media.src) !== beforeSource || metadataLoaded);
        return newMedia && active && getItemKey(active) === key && snapshot.readyState >= 1 &&
          Number.isFinite(snapshot.duration) && snapshot.duration > 0 && snapshot;
      }, CFG.mediaLoadTimeout, epoch);
    } finally {
      before?.removeEventListener('loadedmetadata', onMetadata);
    }
    if (!ready) throw new RecoverableError('音视频未能打开或播放器尚未就绪', 'loading');
    if (currentCourseKey() !== courseKey) {
      throw new RecoverableError('打开资源时页面已离开当前课程，正在返回原课程', 'navigation');
    }
    const media = ready.media;
    const source = media.currentSrc || media.src;
    const resourceRouteKey = getRouteKey();
    if (expectedRoute && !routeEquals(resourceRouteKey, expectedRoute)) {
      const error = new RecoverableError('资源入口与保存的断点不符，正在返回原资源', 'navigation');
      error.expectedSource = source;
      throw error;
    }
    await rememberResource(key, title, 'ready', resourceRouteKey, epoch);
    const savedInterruption = state.job?.interruption;
    const recoveryEpisode = savedInterruption?.courseKey === courseKey &&
      (!savedInterruption.key || savedInterruption.key === key)
      ? { id: savedInterruption.id, key, startedAt: null, from: null, successSent: false }
      : null;
    if (recoveryEpisode) {
      await jobCommand('interruption-position', { episodeId: recoveryEpisode.id, key,
        routeKey: resourceRouteKey, position: media.currentTime });
      const savedGap = currentCandidate()?.records?.[key]?.progressGap;
      if (savedGap) {
        const previousGap = state.processedItems.get(key)?.progressGap;
        const progressGap = previousGap ? {
          from: Math.min(previousGap.from, savedGap.from), to: Math.max(previousGap.to, savedGap.to)
        } : { ...savedGap };
        await rememberItem(key, { ...state.processedItems.get(key), progressGap });
      }
    } else if (!media.paused && !media.seeking && !media.ended) {
      // Establish a baseline before any page transition can make the time
      // between documents look like watched progress.
      await jobCommand('media-observation', { key, routeKey: resourceRouteKey,
        position: media.currentTime, time: Date.now(), allowance: CFG.seekTolerance });
    }
    const attempt = { before: playbackObservation(media), events: [], recoveries: previousRecoveries.slice() };
    log(`已打开：${title}`);
    await rememberItem(key, {
      ...state.processedItems.get(key), title, confirmed: false, ended: false,
      started: true, playbackAttempt: attempt
    });
    const reports = new Map();
    let lastPauseAt = 0;
    let userIntervened = false;
    let recovery = null;
    let identityInvalidated = false;
    let identityMismatch = '';
    let reportInvalidated = false;
    let restrictedReport = null;
    let naturalEndRecorded = false;
    class ResourceResolved extends Error {
      constructor(completion) {
        super('播放器异常前，页面已达到完成标准');
        this.completion = completion;
      }
    }
    let positionSample = { position: media.currentTime, time: Date.now() };
    let seekStart = null;
    let seekFailure = null;
    const localGap = state.processedItems.get(key)?.progressGap;
    const observedGap = currentCandidate()?.records?.[key]?.progressGap;
    let progressGap = localGap && observedGap ? {
      from: Math.min(localGap.from, observedGap.from),
      to: Math.max(localGap.to, observedGap.to)
    } : localGap || observedGap || null;
    if (observedGap && (!localGap || localGap.from !== progressGap.from ||
      localGap.to !== progressGap.to)) {
      await rememberItem(key, { ...state.processedItems.get(key), progressGap,
        ended: false, confirmed: false });
    }
    let coveringGap = Boolean(progressGap && media.currentTime <= progressGap.from + CFG.seekTolerance);
    let gapCovered = false;
    const beginSeek = () => {
      if (seekStart) return;
      const now = Date.now();
      // Only the short interval BEFORE seeking may contain normal playback.
      // Time spent seeking/buffering (or a long suspended observation) never
      // becomes evidence that the skipped interval was watched.
      seekStart = { ...positionSample, observedAt: now,
        allowance: Math.min(2, Math.max(0, (now - positionSample.time) / 1000)) + CFG.seekTolerance };
    };
    const inspectSeek = eventType => {
      if (!playbackStarted) return;
      beginSeek();
      if (seekFailure) return;
      const now = Date.now();
      const from = seekStart.position;
      const to = Number(media.currentTime);
      const jumpedForward = to - from > seekStart.allowance;
      // Persist a visible forward gap at seek start, even if seeked never
      // arrives. Ordinary short/backward seeks are logged after settling.
      if (media.seeking && !jumpedForward && eventType !== 'seek-timeout') return;
      attempt.seekAdjustments ||= [];
      attempt.seekAdjustments.push({ from, to, time: now, jumpedForward, eventType });
      attempt.seekAdjustments = attempt.seekAdjustments.slice(-20);
      if (jumpedForward) {
        progressGap = {
          from: progressGap ? Math.min(progressGap.from, from) : from,
          to: progressGap ? Math.max(progressGap.to, to) : to
        };
        coveringGap = false;
        // A forward jump is recoverable: keep the uncovered interval and let
        // the bounded interruption episode reopen the same resource.  The
        // player must naturally cover the saved gap before completion can be
        // recorded; recovery never seeks forward or fabricates progress.
        seekFailure = new RecoverableError('播放位置出现跳跃，已保留未观看区间，正在重新识别当前资源', 'progress-gap');
        // Write the observed gap before yielding to another UI event. A later
        // explicit pause must not turn this observation into a clean record.
        rememberItem(key, { ...state.processedItems.get(key), progressGap, playbackAttempt: attempt })
          .catch(error => { if (!(error instanceof TaskCancelled)) failLocally(error.message); });
      } else if (!media.seeking) {
        if (progressGap && to <= progressGap.from + CFG.seekTolerance) coveringGap = true;
        log('已重新识别播放位置，继续当前音视频');
      }
      if (!media.seeking) {
        positionSample = { position: to, time: now };
        seekStart = null;
      }
    };
    // A website may restore its saved position while the resource is loading.
    // Guard seeks only after actual playback has started, including a retained
    // player that is already running when this task takes it over.
    let playbackStarted = media.readyState >= 3 && !media.paused && !media.ended && !media.seeking;
    let completionBlocked = '';
    const blockCompletion = (message, eventType) => {
      if (completionBlocked) return;
      completionBlocked = message;
      attempt.completionBlocked = {
        reason: message, eventType, playbackRate: Number(media.playbackRate),
        ...playbackObservation(media)
      };
    };
    const readReports = entries => {
      for (const raw of entries) {
        const entry = getReportTiming(raw);
        if (entry && entry.startAt >= resourceStartedAt) {
          reports.set(`${entry.startAt}:${entry.endAt}`, entry);
          if ([401, 403].includes(entry.status)) restrictedReport = entry;
          if (recovery && entry.endAt > recovery.failure.endAt &&
            !(entry.status >= 200 && entry.status < 300)) reportInvalidated = true;
        }
      }
      while (reports.size > 20) reports.delete(reports.keys().next().value);
    };
    const reportSnapshot = () => {
      try { readReports(performance.getEntriesByType('resource')); } catch {}
      return [...reports.values()];
    };
    let reportObserver;
    try {
      reportObserver = new PerformanceObserver(list => readReports(list.getEntries()));
      reportObserver.observe({ type: 'resource', buffered: false });
    } catch { reportObserver?.disconnect(); reportObserver = null; }
    const observeInput = event => {
      if (trustedPlayerInput(event, media)) userIntervened = true;
    };
    const inputTypes = ['pointerdown', 'click', 'keydown'];
    for (const type of inputTypes) document.addEventListener(type, observeInput, { capture: true, passive: true });
    const eventTypes = [
      'play', 'playing', 'pause', 'waiting', 'stalled', 'error', 'ended',
      'seeking', 'seeked', 'ratechange'
    ];
    const observeMedia = event => {
      const observation = playbackObservation(media);
      if (event.type === 'pause') lastPauseAt = observation.time;
      if (event.type === 'playing' && !media.paused && !media.ended && !media.seeking) {
        playbackStarted = true;
      }
      if (playbackStarted && ['seeking', 'seeked'].includes(event.type)) {
        inspectSeek(event.type);
      }
      if (playbackStarted && event.type === 'ratechange' &&
        Number.isFinite(Number(media.playbackRate)) && Number(media.playbackRate) !== 1) {
        blockCompletion('播放速度已改变，不能确认正常观看，自动任务已暂停；请恢复网站正常播放后继续', event.type);
      }
      if (attempt.events.length < 30) attempt.events.push({ type: event.type, ...observation });
    };
    for (const type of eventTypes) media.addEventListener(type, observeMedia, { passive: true });
    const identityRecovery = (message, kind = 'identity') => {
      const error = new RecoverableError(message, kind);
      error.expectedSource = source;
      error.positionSample = { ...positionSample,
        allowance: Math.min(2, Math.max(0, (Date.now() - positionSample.time) / 1000)) + CFG.seekTolerance };
      return error;
    };
    const checkMediaIdentity = () => {
      if (identityMismatch) throw identityRecovery(identityMismatch, 'navigation');
      if (currentCourseKey() !== courseKey) {
        identityMismatch = '页面已离开当前课程';
        throw identityRecovery('页面已离开当前课程，正在返回原课程', 'navigation');
      }
      const active = document.querySelector('li.el-menu-item.is-active');
      if (!routeEquals(getRouteKey(), resourceRouteKey) || (active && getItemKey(active) !== key)) {
        identityMismatch = '页面切换了资源或更换了播放器';
        throw identityRecovery('页面切换了资源，正在返回原资源', 'navigation');
      }
      const currentMedia = getActiveMediaEl();
      const currentSource = currentMedia && (currentMedia.currentSrc || currentMedia.src);
      if (currentSource && currentSource !== source) {
        identityMismatch = '当前媒体来源已改变';
        throw identityRecovery('当前媒体来源已改变，正在重新核对原资源', 'source');
      }
      if (!active || !media.isConnected || currentMedia !== media || !currentSource) {
        identityInvalidated = true;
        // Freeze the last observed playback window here. Waiting for a new
        // media node is not evidence that the missing player kept playing.
        throw identityRecovery('播放器正在重新加载，正在重新识别当前资源', 'identity');
      }
      identityInvalidated = false;
    };
    const observeIdentity = (mutations = []) => {
      // A DOM repaint is not proof of a resource switch. The next check reads
      // the current course, route, active leaf and media source together.
      const relevant = !mutations.length || mutations.some(change =>
        (change.type === 'attributes' && (change.target === item || change.target === media ||
          media.contains(change.target) || change.target.matches?.('li.el-menu-item'))) ||
        (change.type === 'childList' && [...change.removedNodes, ...change.addedNodes].some(node =>
          node === media || node === item || node.contains?.(media) || node.contains?.(item) ||
          node.matches?.('video, audio') || node.querySelector?.('video, audio'))));
      if (!relevant) return;
      try { checkMediaIdentity(); } catch { identityInvalidated = true; }
    };
    const identityObserver = new MutationObserver(observeIdentity);
    identityObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src'], attributeOldValue: true
    });
    const invalidatingEvents = ['loadstart', 'emptied', 'abort'];
    const invalidateMedia = () => {
      // loadstart/emptied/abort can be emitted while the website is
      // finalizing the same source. Only latch a failure when the identity
      // check actually observes a changed resource.
      try { checkMediaIdentity(); } catch { identityInvalidated = true; }
    };
    for (const type of invalidatingEvents) media.addEventListener(type, invalidateMedia, { passive: true });
    const observeRoute = event => {
      const route = url => {
        try { const value = new URL(url); return `${value.pathname}${value.hash}`; } catch { return ''; }
      };
      if (!routeEquals(route(event.oldURL), resourceRouteKey) ||
        !routeEquals(route(event.newURL), resourceRouteKey)) {
        identityMismatch = '页面切换了资源';
      }
    };
    window.addEventListener('hashchange', observeRoute);
    const checkPlaybackState = () => {
      checkMediaIdentity();
      reportSnapshot();
      if (restrictedReport) throw new Error('网站登录或权限已受限制，请先按页面要求处理');
      if (Number.isFinite(Number(media.playbackRate)) && Number(media.playbackRate) !== 1) {
        blockCompletion('播放速度已改变，不能确认正常观看，自动任务已暂停；请恢复网站正常播放后继续', 'ratecheck');
      }
      if (playbackStarted && media.seeking) {
        beginSeek();
        if (Date.now() - seekStart.observedAt > CFG.mediaLoadTimeout) {
          inspectSeek('seek-timeout');
          if (seekFailure) throw seekFailure;
          throw new RecoverableError('播放器正在调整位置，稍后重新识别', 'loading');
        }
      }
      if (seekStart && !media.seeking) inspectSeek('seekcheck');
      if (seekFailure) throw seekFailure;
      if (completionBlocked) throw new Error(completionBlocked);
      const playerError = media.error || [...document.querySelectorAll(
        '[role="dialog"], [aria-modal="true"], .vjs-error-display, .vjs-modal-dialog'
      )].some(isPlayerPlaybackErrorDialog);
      if (playerError) {
        const fresh = getMenuItems().find(el => getItemKey(el) === key) || item;
        const completion = getResourceCompletion(fresh);
        if (singlePass && completion.confirmed) throw new ResourceResolved(completion);
        throw new RecoverableError('播放器报告播放异常', singlePass ? 'player-error' : 'loading');
      }
      if (getPlaybackBlockingDialog()) {
        throw new Error('网站显示需要处理的提示，自动任务已暂停，请先按页面要求处理');
      }
      if (!media.seeking && !seekStart && media.currentTime !== positionSample.position) {
        if (progressGap && coveringGap) {
          const elapsed = Math.max(0, (Date.now() - positionSample.time) / 1000);
          if (media.currentTime - positionSample.position > elapsed + CFG.seekTolerance) {
            coveringGap = false;
          } else if (media.currentTime >= progressGap.to) {
            progressGap = null;
            gapCovered = true;
          }
        }
        positionSample = { position: media.currentTime, time: Date.now() };
      }
    };
    const checkRecovery = pauseAt => {
      assertRunning(epoch);
      checkPlaybackState();
      if (lastPauseAt !== pauseAt) throw new RecoverableError('播放器再次暂停，稍后重试');
      if (recovery) {
        reportSnapshot();
        if (reportInvalidated) {
          throw new RecoverableError('网站上报暂时失败，稍后重试');
        }
      }
    };
    const recordNaturalEnd = async () => {
      if (naturalEndRecorded) return;
      assertRunning(epoch);
      checkPlaybackState();
      if (!media.ended) return;
      if (progressGap) throw new RecoverableError('这段音视频仍有未确认的播放区间，稍后重试', 'progress-gap');
      if (!playbackStarted) {
        throw new RecoverableError('播放器已在结束位置，本次尚未确认正常播放，稍后重试', 'progress-gap');
      }
      naturalEndRecorded = true;
      attempt.finished = playbackObservation(media);
      state.playedCount += 1;
      setText('wb-count', String(state.playedCount));
      await rememberItem(key, {
        ...state.processedItems.get(key), title, confirmed: false, ended: true, progressGap, playbackAttempt: attempt
      });
      log(`已播放至结束：${title}；正在核对页面完成状态`, 'ok');
    };
    const recoverGatewayPause = async () => {
      const failure = gatewayFailureForPause(reportSnapshot(), lastPauseAt, resourceStartedAt);
      if (!failure) return false;
      if (attempt.recoveries.length >= CFG.gatewayRetryLimit) {
        throw new RecoverableError('网站网络故障再次暂停，重新识别后重试');
      }
      checkRecovery(lastPauseAt);
      const pauseAt = lastPauseAt;
      recovery = { failure, pauseAt, position: media.currentTime, outcome: 'waiting' };
      attempt.recoveries.push(recovery);
      await rememberItem(key, { ...state.processedItems.get(key), playbackAttempt: attempt });
      log('网站网络暂时出错，稍等后尝试一次继续播放；当前位置保持不变');
      setCurrentTask('网站网络暂时出错，正在等待');
      await taskWait(randomDelay(CFG.gatewayRetryDelayMin, CFG.gatewayRetryDelayMax), epoch,
        () => checkRecovery(pauseAt));
      checkRecovery(pauseAt);
      if (media.paused && !media.ended) {
        const button = getPlaybackStartButton(media);
        if (!button) throw new RecoverableError('网络故障后播放按钮尚未出现', 'button');
        const gestureAt = Date.now();
        const observeClick = () => { recovery.resumeAt = Date.now(); };
        button.addEventListener('click', observeClick, { capture: true, passive: true });
        try {
          recovery.clicked = await humanClick(button, epoch, () => {
            checkRecovery(pauseAt);
            if (!media.paused || media.ended) return false;
            if (getPlaybackStartButton(media) !== button) {
              throw new RecoverableError('播放器状态已变化，重新识别后继续', 'button');
            }
          });
        }
        finally { button.removeEventListener('click', observeClick, { capture: true }); }
        recovery.resumeAt ||= gestureAt;
      } else {
        recovery.resumeAt = Date.now();
        recovery.clicked = false;
      }
      recovery.deadline = Date.now() + CFG.gatewayRecoveryTimeout;
      recovery.outcome = 'awaiting-website-report';
      await rememberItem(key, { ...state.processedItems.get(key), playbackAttempt: attempt });
      return true;
    };
    try {
      assertRunning(epoch);
      checkPlaybackState();
      if (progressGap && !coveringGap) throw new RecoverableError('仍有未确认的播放区间，正在重新打开', 'progress-gap');
      // Release only after this resource is ready, its route is saved and
      // normal-end/identity observers are installed. Playback still uses the
      // site's visible control; this does not start or seek media.
      if (media.paused && !media.ended) {
        const playButton = getPlaybackStartButton(media);
        if (!playButton) {
          throw new RecoverableError('播放按钮尚未出现，稍后重新识别', 'button');
        }
        releaseLoadingMedia(epoch);
        attempt.buttonClass = playButton.className;
        const observeClick = event => {
          attempt.click = { isTrusted: event.isTrusted, ...playbackObservation(media) };
        };
        playButton.addEventListener('click', observeClick, { capture: true, passive: true });
        try {
          await humanClick(playButton, epoch, () => {
            checkPlaybackState();
            if (!media.paused || media.ended) return false;
            if (getPlaybackStartButton(media) !== playButton) {
              throw new RecoverableError('播放器状态已变化，重新识别后继续', 'button');
            }
          });
        }
        finally { playButton.removeEventListener('click', observeClick, { capture: true }); }
        checkPlaybackState();
        attempt.after = playbackObservation(media);
        await rememberItem(key, { ...state.processedItems.get(key), playbackAttempt: attempt });
      } else releaseLoadingMedia(epoch);
      let lastTime = media.currentTime;
      let lastAdvanceAt = Date.now();
      let pauseSince = 0;
      let playingLogged = false;
      let lastMediaObservationAt = 0;
      while (!media.ended || recovery?.outcome === 'awaiting-website-report') {
        assertRunning(epoch);
        checkPlaybackState();
        if (singlePass && effectiveTarget < 100 && !media.ended &&
          !media.paused && !media.seeking && !progressGap &&
          media.duration > 0 && media.currentTime / media.duration >= effectiveTarget / 100) {
          const result = {
            ...state.processedItems.get(key), title, ended: false,
            confirmed: false, targetReached: true, deferred: false,
            effectiveTarget, progressGap, playbackAttempt: attempt
          };
          delete result.sitePercent;
          delete result.completionSource;
          delete result.error;
          await rememberItem(key, result);
          log(`已达到播放目标${effectiveTarget}%：${title}；本门课程结束后核对平台状态`, 'ok');
          await taskWait(randomDelay(CFG.cooldownMin, CFG.cooldownMax), epoch, checkPlaybackState);
          return result;
        }
        if (gapCovered) {
          // Preserve the natural coverage before another position sample
          // reads the background record and reinstates the old interval.
          await rememberItem(key, { ...state.processedItems.get(key), progressGap: null,
            playbackAttempt: attempt });
          gapCovered = false;
        }
        if (media.ended) await recordNaturalEnd();
        if (!media.paused && media.currentTime > lastTime && !media.seeking) playbackStarted = true;
        if (!media.paused && !media.seeking && !media.ended && !progressGap &&
          playbackStarted && Date.now() - lastMediaObservationAt >= CFG.mediaObservationInterval) {
          await jobCommand('media-observation', { key, routeKey: resourceRouteKey,
            position: media.currentTime, time: Date.now(), allowance: CFG.seekTolerance });
          lastMediaObservationAt = Date.now();
          const savedGap = currentCandidate()?.records?.[key]?.progressGap;
          if (savedGap && Number.isFinite(savedGap.from) && Number.isFinite(savedGap.to)) {
            progressGap = progressGap ? {
              from: Math.min(progressGap.from, savedGap.from),
              to: Math.max(progressGap.to, savedGap.to)
            } : { ...savedGap };
            coveringGap = false;
            await rememberItem(key, { ...state.processedItems.get(key), progressGap,
              ended: false, confirmed: false, playbackAttempt: attempt });
            throw new RecoverableError('播放位置出现未确认区间，正在重新识别原音视频', 'progress-gap');
          }
        }
        if (recoveryEpisode && !recoveryEpisode.successSent) {
          if (media.paused || media.seeking || progressGap ||
            recovery?.outcome === 'awaiting-website-report') {
            recoveryEpisode.startedAt = null;
            recoveryEpisode.from = null;
          } else if (recoveryEpisode.startedAt == null) {
            recoveryEpisode.startedAt = Date.now();
            recoveryEpisode.from = media.currentTime;
          } else {
            const elapsedMs = Date.now() - recoveryEpisode.startedAt;
            const progress = media.currentTime - recoveryEpisode.from;
            if (elapsedMs >= CFG.interruptionStableMs &&
              progress >= CFG.interruptionMinProgress &&
              progress <= elapsedMs / 1000 + CFG.seekTolerance) {
              await jobCommand('interruption-success', { episodeId: recoveryEpisode.id, key,
                evidence: { key, courseKey, routeKey: resourceRouteKey, from: recoveryEpisode.from,
                  to: media.currentTime, elapsedMs } });
              assertRunning(epoch);
              recoveryEpisode.successSent = true;
              setText('wb-status', '运行中');
              log('已自然播放并稳定推进，恢复次数已清零', 'ok');
            }
          }
        }
        if (!media.paused && media.currentTime > 0 && !playingLogged) {
          playingLogged = true;
          log(`正在正常播放：${title}`, 'ok');
        }
        if (media.currentTime !== lastTime && !media.seeking) {
          lastTime = media.currentTime;
          lastAdvanceAt = Date.now();
        }
        if (recovery?.outcome === 'awaiting-website-report') {
          observeIdentity();
          if (identityInvalidated) checkMediaIdentity();
          if (getPlaybackBlockingDialog()) {
            throw new Error('网络恢复期间出现网站提示，自动任务已暂停');
          }
          const newerReports = reportSnapshot().filter(entry => entry.startAt >= recovery.resumeAt);
          const latest = newerReports.sort((a, b) => b.endAt - a.endAt)[0];
          if (reportInvalidated) {
            throw new RecoverableError('网站上报再次出错，稍后重试');
          }
          if (latest && latest.status >= 200 && latest.status < 300 &&
            media.currentTime > recovery.position && (!media.paused || media.ended)) {
            recovery.outcome = 'transport-restored';
            recovery.transport = latest;
            await rememberItem(key, { ...state.processedItems.get(key), playbackAttempt: attempt });
            log('播放已继续，网站上报请求已恢复；完成状态仍以页面标记为准', 'ok');
          } else if (Date.now() > recovery.deadline) {
            throw new RecoverableError('暂未确认网站继续上报，稍后重试');
          }
          if (media.ended && recovery.outcome === 'awaiting-website-report') {
            setCurrentTask('已经播放至结束，等待网站恢复上报');
          }
        }
        if (media.paused && !media.ended) {
          pauseSince ||= Date.now();
          if (Date.now() - pauseSince > CFG.gatewayPauseGrace) {
            if (playingLogged && await recoverGatewayPause()) {
              pauseSince = 0;
              lastAdvanceAt = Date.now();
              continue;
            }
            throw new RecoverableError(`${playingLogged ? '播放已暂停' : '播放没有开始'}，正在重新识别播放状态`);
          }
        } else pauseSince = 0;
        if (!media.ended && Date.now() - lastAdvanceAt > CFG.stallTimeout) throw new RecoverableError('音视频长时间没有播放进展', 'stalled');
        const pct = media.currentTime / media.duration;
        refreshProgressUI(Number.isFinite(pct) ? pct : null);
        if (!media.ended) setCurrentTask(`正在播放：${title}`);
        await taskWait(CFG.pollInterval, epoch, checkPlaybackState);
      }
      assertRunning(epoch);
      checkPlaybackState();
      await recordNaturalEnd();
      const confirmed = singlePass ? false : Boolean(await waitUntil(() => {
        checkPlaybackState();
        const fresh = getMenuItems().find(el => getItemKey(el) === key);
        return fresh && isPageCompletedItem(fresh);
      }, CFG.confirmationTimeout, epoch));
      assertRunning(epoch);
      checkPlaybackState();
      const result = {
        ...state.processedItems.get(key), title, confirmed, ended: true,
        ...(singlePass ? {
          targetReached: true, effectiveTarget
        } : {}),
        progressGap, playbackAttempt: attempt
      };
      if (confirmed) {
        delete result.error;
        result.deferred = false;
      }
      await rememberItem(key, result);
      if (confirmed && recoveryEpisode && !recoveryEpisode.successSent) {
        await jobCommand('interruption-success', { episodeId: recoveryEpisode.id, key, pageConfirmed: true });
        recoveryEpisode.successSent = true;
        log('页面已确认原音视频完成，恢复次数已清零', 'ok');
      }
      if (confirmed) log(`页面已标记音视频完成：${title}`, 'ok');
      else if (singlePass) log(`已达到播放目标${effectiveTarget}%；课程结束后统一核对平台状态：${title}`, 'ok');
      else log(`已播放至结束，但平台状态仍未确认：${title}`, 'err');
      await taskWait(randomDelay(CFG.cooldownMin, CFG.cooldownMax), epoch, checkPlaybackState);
      return result;
    } catch (error) {
      if (error instanceof ResourceResolved) {
        const result = {
          ...state.processedItems.get(key), title, ended: false, confirmed: true,
          sitePercent: error.completion.sitePercent, completionSource: error.completion.source,
          effectiveTarget, deferred: false, progressGap, playbackAttempt: attempt
        };
        delete result.error;
        await rememberItem(key, result);
        log(`播放器报告异常，但页面已达到完成标准：${title}`, 'ok');
        return result;
      }
      if (!(error instanceof TaskCancelled)) {
        attempt.stopped = playbackObservation(media);
        await rememberItem(key, { ...state.processedItems.get(key), progressGap, playbackAttempt: attempt });
      }
      throw error;
    } finally {
      for (const type of eventTypes) media.removeEventListener(type, observeMedia);
      for (const type of inputTypes) document.removeEventListener(type, observeInput, { capture: true });
      reportObserver?.disconnect();
      identityObserver.disconnect();
      for (const type of invalidatingEvents) media.removeEventListener(type, invalidateMedia);
      window.removeEventListener('hashchange', observeRoute);
    }
  }

  function resourceRecovery(key) {
    const round = Number(currentCandidate()?.retryRounds) || 0;
    const saved = state.processedItems.get(key)?.recovery;
    return saved?.round === round ? { ...saved } : {
      attempts: 0, reloads: 0, nextRetryAt: 0, lastReason: '', round
    };
  }

  async function reacquireResource(key, courseKey, routeKey, epoch, expectedSource = '') {
    let stableAt = 0;
    let lastMedia = null;
    const identityRecovery = (message, kind = 'navigation') => {
      const error = new RecoverableError(message, kind);
      if (expectedSource) error.expectedSource = expectedSource;
      return error;
    };
    const current = await waitUntil(() => {
      if (currentCourseKey() !== courseKey || !routeEquals(getRouteKey(), routeKey)) {
        throw identityRecovery('当前课程或资源身份已改变，正在返回原资源', 'navigation');
      }
      const item = getMenuItems().find(el => getItemKey(el) === key);
      const active = document.querySelector('li.el-menu-item.is-active');
      if (active && getItemKey(active) !== key) {
        throw identityRecovery('当前资源已改变，正在重新识别原资源', 'navigation');
      }
      const media = getActiveMediaEl();
      const source = media && (media.currentSrc || media.src);
      if (source && expectedSource && source !== expectedSource) {
        throw identityRecovery('当前媒体来源已改变，正在重新核对原资源', 'source');
      }
      if (!item || !media?.isConnected || !source || pageLoading()) { stableAt = 0; return null; }
      if (media !== lastMedia) { lastMedia = media; stableAt = Date.now(); }
      if (!stableAt) stableAt = Date.now();
      return Date.now() - stableAt >= CFG.identityStableTime ? item : null;
    }, CFG.mediaLoadTimeout, epoch);
    if (!current) throw new RecoverableError('当前播放器尚未稳定，稍后重试', 'loading');
    return current;
  }

  async function spendInterruptionAttempt(error, key, epoch, navigate = false, reload = false) {
    if (!state.job?.running || state.job.phase !== 'course') return null;
    const blocked = getBlockingNotice() || getPlaybackBlockingDialog();
    if (blocked) throw new Error('网站显示需要处理的提示，请先按页面要求处理');
    const previous = state.job.interruption;
    if (previous?.status === 'navigating') throw new TaskCancelled();
    if (previous?.status === 'attempting' && !navigate) {
      await jobCommand('interruption-failed', { episodeId: previous.id, reason: error.message });
      if (!state.job?.running) throw new TaskCancelled();
      assertRunning(epoch);
    }
    const job = await jobCommand('interruption-attempt', {
      key, episodeId: state.job.interruption?.id, navigate,
      reason: reload ? '课程目录还未恢复，正在重新载入原音视频页面' : error.message,
      ...(reload ? { reload: true } : {})
    });
    if (!job?.running) throw new TaskCancelled();
    if (navigate) throw new TaskCancelled();
    assertRunning(epoch);
    return job.interruption;
  }

  async function playItemWithRecovery(item, epoch, courseKey) {
    const key = getItemKey(item);
    const title = itemTitle(item);
    let retry = resourceRecovery(key);
    let forceOpen = false;
    let pendingError = null;
    while (true) {
      assertRunning(epoch);
      try {
        if (pendingError) {
          const error = pendingError;
          pendingError = null;
          throw error;
        }
        const result = await playItemToEnd(item, epoch, courseKey, { forceOpen });
        setText('wb-status', '运行中');
        return result;
      } catch (error) {
        if (!(error instanceof RecoverableError)) throw error;
        assertRunning(epoch);
        const endedRecord = state.processedItems.get(key);
        if (endedRecord?.ended) {
          // A late website report cannot erase a natural end or replay the
          // resource. The platform completion mark is checked separately.
          return endedRecord;
        }
        const shared = state.job?.running && state.job.phase === 'course';
        if (!shared && (retry.attempts || 0) >= CFG.recoveryAttempts) {
          throw new Error(`连续三次恢复仍未成功，已停止任务并保留断点：${error.message}`);
        }
        // The background saves each attempt before this document may click
        // or navigate. Its episode survives a refresh or service-worker restart.
        const navigate = ['navigation', 'source'].includes(error.kind);
        const episode = await spendInterruptionAttempt(error, key, epoch, navigate);
        retry = resourceRecovery(key);
        retry.attempts = shared ? episode.attempts : (retry.attempts || 0) + 1;
        retry.lastReason = error.message;
        retry.nextRetryAt = 0;
        await rememberItem(key, { ...state.processedItems.get(key), recovery: retry });
        setText('wb-status', '正在恢复');
        setCurrentTask(`正在恢复：${title}`);
        log(`正在恢复播放（${retry.attempts}/${CFG.recoveryAttempts}）：${title}`);
        await taskWait(randomDelay(CFG.recoveryWaitMin, CFG.recoveryWaitMax), epoch);
        try {
          const checkpoint = state.resourceCheckpoint || currentCandidate()?.currentResource;
          item = await reacquireResource(key, courseKey, checkpoint?.routeKey || getRouteKey(), epoch,
            error.expectedSource || '');
          forceOpen = ['loading', 'stalled', 'progress-gap'].includes(error.kind);
          if (error.positionSample) {
            const from = error.positionSample.position;
            const to = getActiveMediaEl()?.currentTime;
            const allowance = error.positionSample.allowance;
            if (Number.isFinite(to) && to - from > allowance) {
              const previousGap = state.processedItems.get(key)?.progressGap;
              await rememberItem(key, { ...state.processedItems.get(key), progressGap: {
                from: previousGap ? Math.min(previousGap.from, from) : from,
                to: previousGap ? Math.max(previousGap.to, to) : to
              } });
              throw new RecoverableError('恢复期间播放位置前跳，已保存未观看区间并重新核对', 'progress-gap');
            }
          }
        } catch (reacquireError) {
          if (!(reacquireError instanceof RecoverableError)) throw reacquireError;
          pendingError = reacquireError;
          forceOpen = true;
        }
      }
    }
  }

  async function confirmRecoveredNaturalEnd(key, courseKey) {
    const episode = state.job?.interruption;
    const record = state.processedItems.get(key);
    if (!state.job?.running || state.job.phase !== 'course' ||
      !episode || episode.courseKey !== courseKey ||
      (episode.key && episode.key !== key) ||
      !record?.ended || !record.confirmed || record.progressGap) return false;
    await jobCommand('interruption-success', { episodeId: episode.id, key, pageConfirmed: true });
    log('页面已确认原音视频完成，恢复次数已清零', 'ok');
    return true;
  }

  async function runCourse(epoch) {
    const courseKey = currentCourseKey();
    if (!courseKey) throw new Error('当前课程身份未识别');
    if (state.processedCourseKey !== courseKey) {
      state.processedItems.clear();
      state.processedCourseKey = courseKey;
    }
    const directory = await waitForDirectory(epoch);
    requireRecordedResources(directory.videoItems);
    const requireCompleteDirectory = () => {
      if (currentCourseKey() !== courseKey) {
        throw new RecoverableError('当前课程身份已改变，正在返回原课程', 'navigation');
      }
      const saved = savedDirectory();
      const snapshot = getDirectorySnapshot();
      if (!saved || pageLoading() || !findDirectoryRoot() || !knownChaptersHaveItems() ||
        !containsSavedDirectory(snapshot, saved)) {
        throw new RecoverableError('课程目录正在加载，稍后重新核对完整目录', 'directory');
      }
      return snapshot;
    };
    const episode = state.job?.interruption;
    if (episode?.courseKey === courseKey && episode.key) {
      await confirmRecoveredNaturalEnd(episode.key, courseKey);
    }
    const failures = [...state.processedItems.values()].filter(r => r.error).map(r => `${r.title}：${r.error}`);
    // A resumed ended resource is only checked for a completion mark; it is not replayed.
    for (const [key, record] of state.processedItems) {
      if (!record.ended || record.confirmed) continue;
      const confirmed = Boolean(await waitUntil(() => {
        requireCompleteDirectory();
        const fresh = getMenuItems().find(el => getItemKey(el) === key);
        return fresh && isPageCompletedItem(fresh);
      }, CFG.confirmationTimeout, epoch));
      assertRunning(epoch);
      requireCompleteDirectory();
      if (confirmed) {
        await rememberItem(key, { ...record, confirmed: true });
        await confirmRecoveredNaturalEnd(key, courseKey);
      } else if (state.job?.interruption?.courseKey === courseKey &&
        state.job.interruption.key === key) {
        throw new RecoverableError('原音视频已自然结束，平台仍未确认完成，稍后重新核对', 'directory');
      }
    }
    while (true) {
      assertRunning(epoch);
      if (currentCourseKey() !== courseKey) {
        throw new RecoverableError('当前课程已改变，正在返回原课程', 'navigation');
      }
      // Keep every known leaf, including resources that have not been tried.
      // A folded or partially re-rendered directory cannot finish the course.
      const snapshot = requireCompleteDirectory();
      await saveDirectoryCheckpoint(snapshot, epoch);
      assertRunning(epoch);
      requireCompleteDirectory();
      const { videoItems } = refreshDirectories({ logSummary: false });
      requireRecordedResources(videoItems);
      for (const el of videoItems) {
        const key = getItemKey(el);
        const record = state.processedItems.get(key);
        if (record?.ended && !record.confirmed && isPageCompletedItem(el)) {
          assertRunning(epoch);
          requireCompleteDirectory();
          if (!el.isConnected) throw new RecoverableError('课程目录正在更新，稍后重新识别', 'directory');
          await rememberItem(key, { ...record, confirmed: true });
          await confirmRecoveredNaturalEnd(key, courseKey);
          log(`页面已补充完成标记：${record.title}`, 'ok');
        }
      }
      const queue = sortActionableItems(videoItems.filter(el => !isPageCompletedItem(el) || needsNaturalEnd(el)));
      const checkpoint = state.resourceCheckpoint || currentCandidate()?.currentResource;
      let resumeKey = checkpoint?.key;
      if (!resumeKey) {
        const unfinished = [...state.processedItems].filter(([, record]) =>
          (record.started || record.attempted) && !record.ended && !record.error);
        if (unfinished.length === 1) resumeKey = unfinished[0][0];
      }
      const resumed = resumeKey && videoItems.find(el => getItemKey(el) === resumeKey);
      if (resumeKey && !resumed) throw new Error('保存的资源断点在当前目录无法确认，已停止');
      const resumedRecord = resumeKey && state.processedItems.get(resumeKey);
      const item = resumed && !resumedRecord?.ended && !resumedRecord?.error ? resumed : queue.find(el => {
        const record = state.processedItems.get(getItemKey(el));
        return !record || (!record.ended && !record.error);
      });
      assertRunning(epoch);
      const currentDirectory = requireCompleteDirectory();
      // A record save above yields to the page. Rebuild the queue if its
      // leaves or metadata changed before selecting or returning a result.
      if (directorySignature(currentDirectory) !== directorySignature(snapshot) ||
        videoItems.some(el => !el.isConnected)) continue;
      if (!item) {
        const finalDirectory = refreshDirectories({ logSummary: false });
        requireRecordedResources(finalDirectory.videoItems);
        const unconfirmed = [...new Set([...finalDirectory.pendingItems,
          ...finalDirectory.videoItems.filter(needsNaturalEnd)])].map(el => itemTitle(el));
        const unfinished = getUnfinishedTitles();
        return { total: finalDirectory.videoItems.length, unconfirmed, failures, unfinished,
          complete: unconfirmed.length === 0 && failures.length === 0 && unfinished.length === 0 };
      }
      try {
        const result = await playItemWithRecovery(item, epoch, courseKey);
        if (result?.ended && !result.confirmed &&
          state.job?.interruption?.courseKey === courseKey &&
          state.job.interruption.key === getItemKey(item)) {
          throw new RecoverableError('原音视频已自然结束，平台仍未确认完成，稍后重新核对', 'directory');
        }
      } catch (error) {
        if (error instanceof TaskCancelled) throw error;
        // Only an exhausted ordinary recovery can defer this resource.
        // Unknown errors, real restrictions and checkpoint failures stop.
        if (!(error instanceof DeferredResource)) throw error;
        pauseMedia('resource-failed');
        const title = itemTitle(item);
        failures.push(`${title}：${error.message}`);
        const key = getItemKey(item);
        await rememberItem(key, {
          ...state.processedItems.get(key), title, attempted: true,
          confirmed: false, ended: false, error: error.message
        });
        setText('wb-status', '运行中');
        log(`暂缓此项，先处理其他音视频，稍后自动重试：${title}`);
      }
    }
  }

  function retryableSinglePassError(error) {
    return error instanceof RecoverableError &&
      !['navigation', 'source', 'identity', 'directory', 'directory-load'].includes(error.kind);
  }

  function courseRefreshToken() {
    return `verify-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  }

  async function saveSinglePassCompletion(item, completion) {
    const key = getItemKey(item);
    const previous = state.processedItems.get(key) || {};
    const result = {
      ...previous, title: itemTitle(item), confirmed: true,
      sitePercent: completion.sitePercent, completionSource: completion.source,
      ended: Boolean(previous.ended), targetReached: Boolean(previous.targetReached),
      deferred: false
    };
    delete result.error;
    await rememberItem(key, result);
  }

  async function saveSinglePassFailure(item, reason) {
    const key = getItemKey(item);
    const previous = state.processedItems.get(key) || {};
    await rememberItem(key, {
      ...previous, title: itemTitle(item), attempted: true, confirmed: false,
      ended: Boolean(previous.ended), deferred: true, error: reason
    });
  }

  async function playSinglePassItem(item, epoch, courseKey, options = {}) {
    const key = getItemKey(item);
    const title = itemTitle(item);
    const phase = options.phase === 'recovery' ? 'recovery' : 'final';
    const field = phase === 'recovery' ? 'recoveryAttempts' : 'finalAttempts';
    let previous = state.processedItems.get(key) || {};
    let lastReason = previous.error || '播放异常，平台状态尚未确认';
    let attempts = Number(currentCandidate()?.records?.[key]?.[field] || previous[field]) || 0;
    let forceOpen = true;

    while (attempts < 3) {
      assertRunning(epoch);
      const fresh = getMenuItems().find(el => getItemKey(el) === key);
      if (!fresh) throw new RecoverableError('待重试音视频暂时不在当前目录', 'directory');
      item = fresh;
      const completion = getResourceCompletion(item);
      if (completion.confirmed) {
        await saveSinglePassCompletion(item, completion);
        return state.processedItems.get(key);
      }

      const token = `${phase}-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
      await jobCommand('resource-retry', { key, phase, token, reason: lastReason });
      assertRunning(epoch);
      attempts = Number(currentCandidate()?.records?.[key]?.[field]) || attempts + 1;
      previous = {
        ...previous, attempted: true, effectiveTarget: 100,
        targetReached: false, deferred: false
      };
      delete previous.error;
      state.processedItems.set(key, previous);
      setCurrentTask(`正在按100%重试：${title}`);

      try {
        const result = await playItemToEnd(item, epoch, courseKey, {
          singlePass: true, targetPercent: 100, forceOpen
        });
        forceOpen = true;
        const latestItem = getMenuItems().find(el => getItemKey(el) === key) || item;
        const latestCompletion = result.confirmed ? {
          confirmed: true, sitePercent: result.sitePercent,
          source: result.completionSource || 'page-marker'
        } : getResourceCompletion(latestItem);
        if (latestCompletion.confirmed) {
          await saveSinglePassCompletion(latestItem, latestCompletion);
          return state.processedItems.get(key);
        }
        if (phase === 'recovery' && result.targetReached) return result;
        lastReason = '播放已尝试至目标，但平台仍未显示80%以上或完成标记';
      } catch (error) {
        if (error instanceof TaskCancelled) throw error;
        if (!retryableSinglePassError(error)) throw error;
        lastReason = error.message;
        pauseMedia('resource-failed');
        forceOpen = true;
      }

      if (attempts < 3) await taskWait(CFG.backgroundRetryDelay, epoch);
    }

    const failure = `播放异常，尝试三次仍无法播放：${lastReason}`;
    await saveSinglePassFailure(item, failure);
    log(`播放异常，尝试多次仍无法播放：${title}`, 'err');
    throw new DeferredResource(failure, 'player-error');
  }

  async function runSinglePassCourse(epoch) {
    const courseKey = currentCourseKey();
    if (!courseKey) throw new Error('当前课程身份未识别');
    if (state.processedCourseKey !== courseKey) {
      state.processedItems.clear();
      state.processedCourseKey = courseKey;
    }
    const directory = await waitForDirectory(epoch);
    requireRecordedResources(directory.videoItems);
    const saved = savedDirectory();
    const currentSnapshot = getDirectorySnapshot();
    if (!saved || directorySignature(saved) !== directorySignature(currentSnapshot)) {
      await saveDirectoryCheckpoint(currentSnapshot, epoch);
    }
    const videoItems = refreshDirectories({ logSummary: false }).videoItems;
    const requireCompleteDirectory = () => {
      if (currentCourseKey() !== courseKey) {
        throw new RecoverableError('当前课程身份已改变，正在返回原课程', 'navigation');
      }
      const known = savedDirectory();
      const snapshot = getDirectorySnapshot();
      if (!known || pageLoading() || !findDirectoryRoot() || !knownChaptersHaveItems() ||
        !containsSavedDirectory(snapshot, known)) {
        throw new RecoverableError('课程目录正在加载，稍后重新核对完整目录', 'directory');
      }
      return snapshot;
    };
    const markVisibleCompletions = async items => {
      for (const item of items) {
        const completion = getResourceCompletion(item);
        if (completion.confirmed) await saveSinglePassCompletion(item, completion);
      }
    };
    const getPendingKeys = items => items.filter(item =>
      state.processedItems.get(getItemKey(item))?.confirmed !== true
    ).map(getItemKey);
    let pass = currentCandidate()?.pass;

    if (!pass || pass.phase === 'play') {
      setCurrentTask(`首轮处理课程音视频：${currentCandidate()?.title || ''}`);
      for (const listed of videoItems) {
        assertRunning(epoch);
        const snapshot = requireCompleteDirectory();
        const item = getMenuItems().find(el => getItemKey(el) === getItemKey(listed));
        if (!item || directorySignature(snapshot) !== directorySignature(getDirectorySnapshot())) continue;
        const key = getItemKey(item);
        const record = state.processedItems.get(key) || {};
        const completion = getResourceCompletion(item);
        if (completion.confirmed) {
          await saveSinglePassCompletion(item, completion);
          continue;
        }
        if (record.confirmed || record.ended || record.targetReached || record.deferred) continue;

        try {
          const target = record.effectiveTarget === 100 &&
            ((record.recoveryAttempts || 0) + (record.finalAttempts || 0) > 0)
            ? 100 : getPlaybackTarget();
          await playItemToEnd(item, epoch, courseKey, { singlePass: true, targetPercent: target });
        } catch (error) {
          if (error instanceof TaskCancelled) throw error;
          if (!retryableSinglePassError(error)) throw error;
          if (error.kind === 'progress-gap') {
            try {
              await playSinglePassItem(item, epoch, courseKey, { phase: 'recovery' });
              continue;
            } catch (recoveryError) {
              if (recoveryError instanceof TaskCancelled) throw recoveryError;
              if (recoveryError instanceof DeferredResource) continue;
              if (!retryableSinglePassError(recoveryError)) throw recoveryError;
              error = recoveryError;
            }
          }
          pauseMedia('resource-failed');
          await saveSinglePassFailure(item, `首轮播放异常，待课程末核对：${error.message}`);
          log(`首轮播放异常，先继续本门其他视频：${itemTitle(item)}`, 'err');
        }
      }

      assertRunning(epoch);
      requireCompleteDirectory();
      await markVisibleCompletions(getMenuItems().filter(isActionableItem));
      await jobCommand('course-pass', { phase: 'verify', pendingKeys: getPendingKeys(videoItems) });
      await jobCommand('course-refresh', {
        token: courseRefreshToken(), reason: '本门视频首轮处理完成，刷新核对平台完成状态'
      });
      return { refreshing: true };
    }

    const lastRefresh = currentCandidate()?.lastRefresh;
    if (pass.phase === 'verify' && (!lastRefresh ||
      (lastRefresh.failed === true && (lastRefresh.attempt || 1) < 2))) {
      const attempt = lastRefresh?.failed ? (lastRefresh.attempt || 1) + 1 : 1;
      if (attempt > 1) await taskWait(CFG.backgroundRetryDelay, epoch);
      await jobCommand('course-refresh', {
        token: courseRefreshToken(), attempt, reason: '继续课程末平台状态核对'
      });
      return { refreshing: true };
    }

    requireCompleteDirectory();
    await markVisibleCompletions(getMenuItems().filter(isActionableItem));
    pass = currentCandidate()?.pass;
    if (pass?.phase === 'verify') {
      const pendingKeys = getPendingKeys(videoItems);
      await jobCommand('course-pass', { phase: 'retry', pendingKeys });
      pass = currentCandidate()?.pass;
    }

    if (pass?.phase === 'retry') {
      for (const key of pass.pendingKeys || []) {
        assertRunning(epoch);
        const item = getMenuItems().find(el => getItemKey(el) === key);
        if (!item) throw new RecoverableError('待重试音视频暂时不在当前目录', 'directory');
        const completion = getResourceCompletion(item);
        if (completion.confirmed || state.processedItems.get(key)?.confirmed) {
          if (completion.confirmed) await saveSinglePassCompletion(item, completion);
          continue;
        }
        try {
          await playSinglePassItem(item, epoch, courseKey, { phase: 'final' });
        } catch (error) {
          if (error instanceof TaskCancelled) throw error;
          if (!(error instanceof DeferredResource)) throw error;
        }
        const remainingKeys = (currentCandidate()?.pass?.pendingKeys || []).filter(pendingKey =>
          state.processedItems.get(pendingKey)?.confirmed !== true
        );
        await jobCommand('course-pass', { phase: 'retry', pendingKeys: remainingKeys });
        pass = currentCandidate()?.pass;
      }
    }

    requireCompleteDirectory();
    const finalItems = refreshDirectories({ logSummary: false }).videoItems;
    await markVisibleCompletions(finalItems);
    const unconfirmedItems = finalItems.filter(item =>
      state.processedItems.get(getItemKey(item))?.confirmed !== true
    );
    const failures = unconfirmedItems.map(item => {
      const record = state.processedItems.get(getItemKey(item));
      const chapter = getChapterTitle(getChapterRoot(item));
      const location = [chapter, itemTitle(item)].filter(Boolean).join(' / ');
      return `${location}：${record?.error || '平台未确认达到80%或完成标记'}`;
    });
    const unconfirmed = unconfirmedItems.map(item => itemTitle(item));
    const incompleteRecords = [...state.processedItems.values()]
      .filter(record => (record.started || record.attempted) && !record.ended &&
        !record.targetReached && !record.deferred && !record.confirmed)
      .map(record => record.title);
    return {
      total: finalItems.length, remaining: unconfirmed.length, unconfirmed,
      failures, unfinished: incompleteRecords, finalPass: true
    };
  }

  async function start() {
    if (state.resetPending || state.mode === 'resetting' || state.job?.phase === 'resetting' ||
      state.startPending || state.pausePending || state.running || state.job?.running) return;
    const resetSequence = state.resetSequence;
    clearPageNotice();
    const notice = getBlockingNotice();
    if (notice) { stopForManual(`页面提示“${notice}”，请按网站要求处理后继续`); return; }
    state.storageFailed = false;
    state.manualNotice = '';
    const control = getStartControl();
    const stoppedBeforeStart = state.stopSequence;
    let cancelled = false;
    state.startPending = true;
    updateTaskControls();
    try {
      await state.playbackTargetReady;
      await state.playbackTargetWrites;
      await jobCommand('start', {
        title: compactText(getDisplayedCourseTitle()), scope: 'all',
        singlePass: true, targetPercent: getPlaybackTarget(),
        ...(control.restart ? { restart: true } : {})
      });
      if (state.stopSequence !== stoppedBeforeStart) {
        // The user paused while this start/continue was still in flight.
        // Its late success cannot become permission to play.
        state.localMediaStop = { runId: state.job?.runId, generation: state.job?.generation };
        const paused = await jobCommand('pause');
        if (paused?.running) throw new Error('任务尚未确认暂停，请到任务页面检查');
        cancelled = true;
      }
      state.startPending = false;
      await syncSharedJob();
    } catch (error) {
      if (resetSequence !== state.resetSequence) return;
      if (error instanceof TaskCancelled) {
        logPageNotice('任务已变化，请到当前任务页面检查后操作');
        setText('wb-status', '需要确认任务状态');
        setCurrentTask('任务已变化');
      } else failLocally(error.message);
    }
    finally {
      if (resetSequence !== state.resetSequence) return;
      state.startPending = false;
      if (!state.pauseRequestInFlight) state.pausePending = false;
      updateTaskControls();
      if (cancelled && !state.job?.running && !state.storageFailed) showTaskPaused();
    }
  }

  function stopLocal(reason = 'local-stop') {
    state.stopSequence += 1;
    state.routeRecoveryPending = false;
    if (state.reloadTimer) clearTimeout(state.reloadTimer);
    state.reloadTimer = null;
    state.reloadToken = null;
    state.reloadPending = false;
    state.running = false;
    state.epoch += 1;
    state.mode = 'paused';
    if (state.job) state.localMediaStop = {
      runId: state.job.runId, generation: state.job.generation
    };
    pauseMedia(reason);
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  async function stop(writeLog = true) {
    if (state.resetPending || state.mode === 'resetting' || state.job?.phase === 'resetting' || state.pausePending) return;
    const resetSequence = state.resetSequence;
    if (state.job?.running && !isTaskPage() && !state.startPending) {
      const message = '任务在另一个页面运行，请到任务页面暂停';
      logPageNotice(message);
      setCurrentTask(message);
      updateTaskControls();
      return;
    }
    stopLocal('extension-pause');
    state.pausePending = true;
    state.pauseRequestInFlight = true;
    updateTaskControls();
    setText('wb-status', '正在暂停');
    setCurrentTask('本页播放已停止，正在确认任务暂停');
    try {
      if (state.startPending || (isTaskPage() && state.job?.running)) {
        const paused = await jobCommand('pause');
        if (paused?.running && !state.startPending) throw new Error('任务尚未确认暂停，请到任务页面检查');
      }
      if (state.startPending) {
        setCurrentTask('本页播放已停止，正在取消开始');
      } else if (state.job?.running) {
        logPageNotice('本页播放已停止；任务仍在另一个页面运行，请到任务页面暂停');
        setText('wb-status', '需要确认任务状态');
      } else showTaskPaused(writeLog);
    } catch (error) {
      if (resetSequence !== state.resetSequence) return;
      if (error instanceof TaskCancelled) {
        const message = '本页播放已停止；任务已变化，请到当前任务页面确认暂停状态';
        logPageNotice(message);
        setText('wb-status', '需要确认任务状态');
        setCurrentTask('任务已变化');
      } else failLocally(error.message);
    } finally {
      if (resetSequence !== state.resetSequence) return;
      // A pending Start still needs its late response to be cancelled before
      // the controls can claim that the task has stopped.
      state.pauseRequestInFlight = false;
      if (!state.startPending) state.pausePending = false;
      updateTaskControls();
    }
  }

  async function resetPlugin() {
    if (state.resetPending || getRoute() === 'other') return;
    if (!window.confirm('将停止当前任务，清除本地任务、断点、课程统计、日志和错误记录。下次开始会回到课程首页重新扫描。网站登录和学习进度不会删除。确定重置吗？')) return;
    const request = {};
    state.resetRequest = request;
    state.resetPending = true;
    state.pendingResetFromEpoch = state.resetEpoch;
    clearLocalTask(true);
    state.mode = 'resetting';
    updateTaskControls();
    setText('wb-status', '正在重置');
    setCurrentTask('正在停止旧任务并清理记录');
    try {
      await jobCommand('reset');
    } catch (error) {
      if (state.resetRequest !== request || error instanceof TaskCancelled) return;
      state.mode = 'resetting';
      setText('wb-status', '重置尚未完成');
      setCurrentTask('本页已停止，请重试重置');
      logPageNotice(error.message);
    } finally {
      if (state.resetRequest === request) {
        state.resetPending = false;
        state.resetRequest = null;
        // A failed send must keep rejecting the old epoch until a reset is saved.
        updateTaskControls();
      }
    }
  }

  function showTaskPaused(writeLog = true) {
    setText('wb-status', '已暂停');
    setCurrentTask('已暂停');
    if (writeLog) log('已暂停：播放、自动点击、滚动和切换均已停止', 'info', false);
  }

  function requestRouteRecovery(reason) {
    const job = state.job;
    if (!job?.running || job.phase !== 'course' || job.targetPurpose !== 'play' ||
      job.ownerTabId !== state.tabId || job.ownerInstance !== state.instanceId ||
      state.routeRecoveryPending || state.storageFailed || state.pausePending || state.resetPending ||
      (state.localMediaStop?.runId === job.runId && job.generation <= state.localMediaStop.generation)) return;
    const blocked = getBlockingNotice() || getPlaybackBlockingDialog();
    if (blocked) {
      stopForManual('页面提示“' + blocked + '”，自动任务已停止，请按网站要求处理');
      return;
    }
    const candidate = currentCandidate();
    const resource = state.resourceCheckpoint || candidate?.currentResource;
    if (!candidate?.courseKey) {
      stopForManual('页面已变化，但原课程身份无法确认；任务已保留，请检查课程页面');
      return;
    }
    state.routeRecoveryPending = true;
    const stoppedBeforeRecovery = state.stopSequence;
    // Cancel the old executor immediately. It must not click a stale DOM node
    // while the background saves the destination and navigates this tab.
    state.epoch += 1;
    pauseMedia('route-recovery');
    setText('wb-status', '正在恢复');
    setCurrentTask('正在返回原课程：' + (resource?.title || candidate.title));
    log('检测到页面切换，正在返回原课程：' + (resource?.title || candidate.title));
    jobCommand('interruption-attempt', {
      key: resource?.key || '', episodeId: state.job.interruption?.id,
      navigate: true, reason
    }).catch(error => {
      if (!(error instanceof TaskCancelled) && state.job?.running &&
        stoppedBeforeRecovery === state.stopSequence && !state.pausePending && !state.resetPending) {
        stopForManual(error.message);
      }
    });
  }

  function updateRoute() {
    const route = getRoute();
    const routeKey = getRouteKey();
    if (routeEquals(routeKey, state.currentRouteKey)) return;
    state.currentRoute = route;
    state.currentRouteKey = routeKey;
    state.lastDirectoryRefresh = 0;
    state.lastLoggedItemKey = '';
    state.lastConfirmedCount = null;
    state.courseCompleteLogged = false;
    if (state.resetPending || state.mode === 'resetting' || state.job?.phase === 'idle') {
      setText('wb-course', route === 'agent' ? '首页' : route === 'home' ? '课表' : route === 'site' ? '网站页面' : '尚未识别');
      updateTaskControls();
      syncSharedJob();
      return;
    }
    const candidate = currentCandidate();
    const checkpoint = state.resourceCheckpoint || candidate?.currentResource;
    const taskRouteMismatch = state.running && state.job?.running && state.job.phase === 'course' &&
      state.job.targetPurpose === 'play' && candidate?.courseKey &&
      (route !== 'learn' || currentCourseKey() !== candidate.courseKey ||
        (checkpoint?.routeKey && !routeEquals(routeKey, checkpoint.routeKey)));
    if (taskRouteMismatch) {
      requestRouteRecovery('页面发生变化，正在返回已保存的原课程和音视频');
    }
    if (route === 'agent' || route === 'home' || route === 'site') {
      state.videoItems = [];
      state.pendingItems = [];
      renderVideoDirectory([], []);
      setText('wb-confirmed', '—');
      setText('wb-course-progress', '未识别');
      setText('wb-course', route === 'agent' ? '首页' : route === 'home' ? '课表' : '网站页面');
      if (!state.job?.running && state.job?.phase !== 'finished') setCurrentTask('尚未开始');
    } else if (route === 'learn') {
      const candidateNow = currentCandidate();
      const checkpointNow = state.resourceCheckpoint || candidateNow?.currentResource;
      if (state.routeRecoveryPending && candidateNow?.courseKey === currentCourseKey() &&
        (!checkpointNow?.routeKey || routeEquals(routeKey, checkpointNow.routeKey))) {
        state.routeRecoveryPending = false;
      }
      updateCurrentTask();
      refreshDirectories({ logSummary: false });
      if (state.running) {
        setText('wb-status', '运行中');
        log('学习页已打开，正在核对目录', 'info');
      }
    } else {
      state.videoItems = [];
      state.pendingItems = [];
      renderVideoDirectory([], []);
      setText('wb-confirmed', '—');
      setText('wb-course-progress', '未识别');
      renderManualItems(state.manualNotice ? [state.manualNotice] : []);
      setText('wb-course', '页面未识别');
      if (state.running && (taskRouteMismatch || state.routeRecoveryPending)) {
        setText('wb-status', '正在恢复');
        setCurrentTask('页面已变化，正在返回原课程和音视频');
      } else if (state.running) {
        stopForManual('当前页面无法识别，自动任务已停止');
      } else setCurrentTask('尚未开始');
    }
    updateTaskControls();
    syncSharedJob();
  }

  injectUI();
  state.instanceId = getInstanceId();
  state.currentRoute = getRoute();
  state.currentRouteKey = getRouteKey();
  state.playbackDiagnostics.entry = observeCurrentMedia();
  // Capture non-bubbling media events from existing or later-loaded players
  // before the initial background handshake. Observation never starts media.
  for (const type of ['loadstart', 'loadedmetadata', 'play', 'playing', 'pause', 'waiting', 'stalled', 'error', 'ended']) {
    document.addEventListener(type, observeEarlyMedia, { capture: true, passive: true });
  }
  // A site can insert a media node that already started while detached,
  // without a new document play event. Ignore ordinary UI/directory changes.
  const loadingMediaObserver = new MutationObserver(changes => {
    if (changes.some(change => [...change.addedNodes].some(node =>
      node.matches?.('video, audio') || node.querySelector?.('video, audio')))) enforceMediaPause();
  });
  loadingMediaObserver.observe(document.body, { childList: true, subtree: true });
  refreshDirectories({ logSummary: false });
  if (['agent', 'home', 'site'].includes(state.currentRoute)) {
    setText('wb-course', state.currentRoute === 'agent' ? '首页' : state.currentRoute === 'home' ? '课表' : '网站页面');
    setCurrentTask('尚未开始');
  }
  updateCurrentTask();
  setText('wb-status', '未开始');
  setText('wb-count', '0');
  updateTaskControls();
  log('已准备好；只处理视频和音频，文档、考试和作业暂不处理', 'ok');
  setInterval(updateRoute, 1200);
  if (globalThis.chrome?.runtime?.onMessage) chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.channel !== JOB_CHANNEL) return;
    if (Number.isInteger(message.tabId)) state.tabId = message.tabId;
    const accepted = acceptJob(message.job);
    if (message.reset) {
      // Pause synchronously before acknowledging; an old executor observes
      // the incremented local epoch before it can perform its next action.
      pauseForStoppedTask();
      const held = (state.job?.resetHoldTabIds || []).includes(state.tabId);
      sendResponse({ resetEpoch: state.resetEpoch, stopped: Boolean(accepted &&
        (!held || [...document.querySelectorAll('video, audio')].every(media => media.paused || media.ended))) });
    }
  });
  setInterval(syncSharedJob, 1000);
  setTimeout(syncSharedJob, 0);

  window.__wbStudyTest = {
    start, stop, resetPlugin, scanDirectory, refreshDirectories, state, CFG,
    normalizePlaybackTarget, getPlaybackTarget, savePlaybackTarget,
    parseProgressText, getResourceCompletion,
    getMenuItems, getItemKey, isVideoItem, isPageCompletedItem, currentCourseKey,
    appendLog, log, renderLogEntries, logIsNearLatest,
    humanClick, getPlaybackStartButton, runCourse, playItemToEnd, getHomeCourseCards,
    getReportTiming, gatewayFailureForPause, getPlaybackBlockingDialog, trustedPlayerInput,
    getHomeCourseCandidate, scanHomeCourses, runHomeJob, runAgentEntryJob, getAgentTimetableEntry, jobCommand,
    acceptJob, syncSharedJob, chooseLowestRemaining, waitForDirectory, runCurrentCourseJob,
    getDirectorySnapshot, directorySignature, playItemWithRecovery, reacquireResource,
    resourceRecovery, nextCourseRetryAt, RecoverableError, DeferredResource,
    playSinglePassItem, runSinglePassCourse
  };
})();
