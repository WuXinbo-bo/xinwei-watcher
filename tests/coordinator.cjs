const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const event = () => {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    fire(...args) { listeners.forEach(fn => fn(...args)); },
    message(message) {
      return new Promise((resolve, reject) => {
        let answered = false, pending = false;
        const respond = value => {
          if (!answered) { answered = true; resolve(clone(value)); }
        };
        try {
          for (const listener of listeners) {
            if (listener(clone(message), {}, respond) === true) pending = true;
          }
          if (!answered && !pending) resolve(undefined);
        } catch (error) { reject(error); }
      });
    }
  };
};
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function coordinator(options = {}) {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  let failStorage = false, messageListener, nextId = 1;
  const tabs = new Map(), receivers = new Map(), navigation = [], removed = [], reloads = [];
  const storage = { session: {}, local: {} };
  const area = name => ({
    async get(key) { if (failStorage) throw new Error('disk error'); return { [key]: clone(storage[name][key]) }; },
    async set(values) { if (failStorage) throw new Error('disk error'); Object.assign(storage[name], clone(values)); }
  });
  const onCreated = event(), onRemoved = event(), onNavigation = event();
  const chrome = {
    storage: { session: area('session'), local: area('local') },
    runtime: { onMessage: { addListener(fn) { messageListener = fn; } } },
    tabs: {
      onCreated, onRemoved,
      async get(id) { if (!tabs.has(id)) throw new Error('Tab closed'); return clone(tabs.get(id)); },
      async query({ url } = {}) {
        // The production reset currently queries this one host only. Reject
        // unsupported mock queries rather than silently claiming to model them.
        if (url !== 'https://www.beeline-ai.com/*') throw new Error('Unsupported test tab query');
        return [...tabs.values()].filter(tab => tab.url.startsWith('https://www.beeline-ai.com/')).map(clone);
      },
      async update(id, info) {
        if (!tabs.has(id)) throw new Error('Tab closed');
        Object.assign(tabs.get(id), info); navigation.push({ id, ...info });
        if (Object.hasOwn(info, 'url')) {
          // A navigation replaces the document, not just its displayed URL.
          // Arrival is asynchronous and does not block the background's message queue.
          receivers.delete(id);
          const destination = clone(tabs.get(id));
          setTimeout(() => onNavigation.fire(destination), 0);
        }
        return clone(tabs.get(id));
      },
      async reload(id) {
        if (!tabs.has(id)) throw new Error('Tab closed');
        if (options.beforeReload) await options.beforeReload(id);
        reloads.push(id);
        receivers.delete(id);
        const destination = clone(tabs.get(id));
        setTimeout(() => onNavigation.fire(destination), 0);
      },
      async remove(id) { tabs.delete(id); receivers.delete(id); removed.push(id); onRemoved.fire(id); },
      async sendMessage(id, msg) {
        const receiver = receivers.get(id);
        if (!receiver) throw new Error('No receiving document');
        return receiver.message(msg);
      }
    }
  };
  const globals = { chrome, crypto, URL, URLSearchParams, Date, console, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync('background.js', 'utf8'), globals);
  const addTab = (url, openerTabId) => {
    const tab = { id: nextId++, url, openerTabId };
    tabs.set(tab.id, tab);
    if (openerTabId != null) onCreated.fire(tab);
    return tab.id;
  };
  const request = (id, instanceId, action, payload = {}, documentUrl) => new Promise(resolve => {
    messageListener({
      channel: 'xinwei-job', instanceId, action, ...clone(payload)
    }, { tab: { id }, frameId: 0, url: documentUrl || tabs.get(id)?.url || 'https://www.beeline-ai.com/myBank/courseResearch' }, resolve);
  });
  const connect = id => window => {
    const messages = event();
    receivers.set(id, messages);
    window.chrome = {
      runtime: {
        onMessage: messages,
        getManifest: () => clone(manifest),
        sendMessage: msg => {
          if (!tabs.has(id)) return Promise.reject(new Error('Tab closed'));
          if (receivers.get(id) !== messages) return Promise.reject(new Error('Document replaced'));
          tabs.get(id).url = window.location.href;
          return request(id, msg.instanceId, msg.action, msg, window.location.href);
        }
      }
    };
  };
  return {
    addTab, request, connect, tabs, storage, navigation, removed, reloads, onNavigation, onTabRemoved: onRemoved,
    failStorage: () => { failStorage = true; },
    restartWorker: () => { vm.runInNewContext(fs.readFileSync('background.js', 'utf8'), globals); },
    restartBrowser: () => { storage.session = {}; },
    closeTab: async id => chrome.tabs.remove(id)
  };
}
module.exports = { coordinator };
