// End-to-end test of the release -> alert pipeline, running the real
// background.js against a mocked Chrome. Unlike parse-test.mjs, which mirrors
// the parsing logic, this executes the shipped service worker, so it fails if
// the alert path drifts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const STORAGE_KEY = 'instapoll_state';
const COURSE_TAB = { id: 7, windowId: 1, url: 'https://polls.la.utexas.edu/course/6609/student' };

function harness({ polls, focused = true, openPopup = true } = {}) {
  const log = {
    created: [], updated: [], chimes: 0, popupOpens: 0,
    activated: [], createdTabs: [], injected: [], reloaded: [],
  };
  const store = {
    [STORAGE_KEY]: {
      tabs: { 7: { courseId: '6609', url: COURSE_TAB.url, windowId: 1 } },
      seen: {}, notifs: {},
    },
  };
  const listeners = {};
  const capture = name => ({ addListener: fn => { listeners[name] = fn; } });

  class FakeWebSocket {
    constructor() { this.readyState = 0; }
    send() {}
    close() {}
  }
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1;

  const chrome = {
    runtime: {
      id: 'ext',
      getURL: p => 'chrome-extension://ext/' + p,
      getContexts: async () => [],
      async sendMessage(msg) {
        if (msg && msg.target === 'offscreen') { log.chimes++; return { ok: true }; }
        return undefined;
      },
      onMessage: capture('message'),
      onInstalled: capture('installed'),
      onStartup: capture('startup'),
    },
    storage: {
      local: {
        async get(key) { return key in store ? { [key]: store[key] } : {}; },
        async set(obj) { Object.assign(store, obj); },
      },
    },
    tabs: {
      query: async () => [COURSE_TAB],
      async reload(id) { log.reloaded.push(id); },
      async sendMessage(tabId, msg) {
        if (tabId !== COURSE_TAB.id) throw new Error('no such tab');
        if (msg.type === 'PING') return { ok: true, courseId: '6609' };
        if (msg.type === 'GET_POLLS') {
          if (!polls) throw new Error('tab cannot answer');
          return { ok: true, polls };
        }
        return undefined;
      },
      async update(id) { log.activated.push(id); },
      async create(opts) { log.createdTabs.push(opts.url); },
      onRemoved: capture('removed'),
      onUpdated: capture('updated'),
    },
    windows: {
      getLastFocused: async () => ({ id: 1, focused }),
      update: async () => {},
    },
    notifications: {
      create(id, opts) { log.created.push({ id, opts }); },
      async update(id, opts) { log.updated.push({ id, opts }); return true; },
      clear() {},
      onClicked: capture('notifClicked'),
      onButtonClicked: capture('notifButton'),
    },
    action: {
      setBadgeText() {}, setBadgeBackgroundColor() {},
      openPopup: openPopup ? async () => { log.popupOpens++; } : undefined,
    },
    alarms: { create() {}, onAlarm: capture('alarm') },
    offscreen: { createDocument: async () => {} },
    scripting: { executeScript: async ({ target }) => { log.injected.push(target.tabId); return [{}]; } },
  };

  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    chrome, WebSocket: FakeWebSocket, setTimeout, clearTimeout,
    setInterval, clearInterval, Date, JSON, Object, Set, Map, Math, Number,
    String, Array, Promise, RegExp, Error,
  });
  vm.runInContext(readFileSync(new URL('../background.js', import.meta.url), 'utf8'), context);
  return { context, log, store, listeners, chrome };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

// ---------------------------------------------------------------------------
// A release alerts even with no course tab focused, and names the question.
// ---------------------------------------------------------------------------
{
  const { context, log } = harness({
    polls: [{
      id: '229271', name: 'Warm-up', state: 'sent', type: 'multiplechoice',
      prompt: '<p>What is <b>2&nbsp;+&nbsp;2</b>?</p>',
    }],
  });
  await settle();
  await context.__simulatePoll(6609, 229271);
  await settle();

  assert.equal(log.created.length, 1, 'a release must raise exactly one notification');
  const notif = log.created[0].opts;
  assert.equal(notif.requireInteraction, true);
  assert.equal(Array.from(notif.buttons, b => b.title).join(' | '),
    'Answer here | Open course page');
  assert.equal(log.chimes, 1, 'the chime must play regardless of which tab is focused');

  // The question is filled in afterwards so the alert is never delayed by it.
  assert.equal(log.updated.length, 1, 'the notification must be enriched with the question');
  assert.equal(log.updated[0].opts.message, 'What is 2 + 2?');
  assert.equal(log.updated[0].opts.title, '\u{1F4CA} Warm-up');
  assert.equal(log.popupOpens, 1, 'the popup should open while Chrome has focus');
}

// ---------------------------------------------------------------------------
// The alert still fires when no tab can supply the question text.
// ---------------------------------------------------------------------------
{
  const { context, log } = harness({ polls: null });
  await settle();
  await context.__simulatePoll(6609, 555);
  await settle();

  assert.equal(log.created.length, 1);
  assert.match(log.created[0].opts.message, /a poll is open/);
  assert.equal(log.updated.length, 0, 'nothing to enrich with');
  assert.equal(log.chimes, 1, 'a failed lookup must never cost the chime');
}

// ---------------------------------------------------------------------------
// Chrome in the background: no popup, but the notification and chime stand.
// ---------------------------------------------------------------------------
{
  const { context, log } = harness({ polls: null, focused: false });
  await settle();
  await context.__simulatePoll(6609, 556);
  await settle();
  assert.equal(log.popupOpens, 0, 'never try to open a popup without a focused window');
  assert.equal(log.created.length, 1);
  assert.equal(log.chimes, 1);
}

// ---------------------------------------------------------------------------
// Chrome older than 127 has no action.openPopup; the rest must still work.
// ---------------------------------------------------------------------------
{
  const { context, log } = harness({ polls: null, openPopup: false });
  await settle();
  await context.__simulatePoll(6609, 557);
  await settle();
  assert.equal(log.created.length, 1);
  assert.equal(log.chimes, 1);
}

// ---------------------------------------------------------------------------
// A repeated frame must not re-alert.
// ---------------------------------------------------------------------------
{
  const { context, log } = harness({ polls: null });
  await settle();
  await context.__simulatePoll(6609, 229271);
  await context.__simulatePoll(6609, 229271);
  await settle();
  assert.equal(log.created.length, 1, 'duplicate releases must alert once');
}

// ---------------------------------------------------------------------------
// Notification actions route correctly.
// ---------------------------------------------------------------------------
{
  const { context, log, listeners } = harness({ polls: null });
  await settle();
  await context.__simulatePoll(6609, 900);
  await settle();
  const notifId = log.created[0].id;

  await listeners.notifButton(notifId, 0);      // "Answer here"
  assert.equal(log.popupOpens, 2, 'button 0 opens the popup');

  await listeners.notifButton(notifId, 1);      // "Open course page"
  assert.deepEqual(log.activated, [7], 'button 1 focuses the live course tab');

  await listeners.notifClicked(notifId);        // plain click
  assert.deepEqual(log.activated, [7, 7], 'a body click focuses the course tab');
}

// ---------------------------------------------------------------------------
// A click on a notification that outlived the worker still opens the course.
// The id carries the course, so an unknown notification is still actionable.
// ---------------------------------------------------------------------------
{
  const { listeners, log, chrome } = harness({ polls: null });
  await settle();
  chrome.tabs.update = async () => { throw new Error('tab was closed'); };
  await listeners.notifClicked('instapoll_6609_229271_1700000000000');
  await settle();
  assert.deepEqual(log.createdTabs, ['https://polls.la.utexas.edu/course/6609/student#'],
    'an orphaned notification must still open the course page');
}

// ---------------------------------------------------------------------------
// Install/update evicts stale content scripts; a plain worker start does not.
//
// A content script from before the dispose() handover cannot be retired from
// the worker, so the only way to stop it throwing into the page is to reload
// the tab. That must not happen on every service worker spin-up.
// ---------------------------------------------------------------------------
{
  const { log, listeners } = harness({ polls: null });
  await settle();
  assert.deepEqual(log.reloaded, [],
    'a worker restart must never reload a course tab');

  await listeners.installed();
  await settle();
  assert.deepEqual(log.reloaded, [7],
    'install/update must reload course tabs to evict a stale content script');
}

console.log('Alert tests passed (cross-tab chime, question text, popup, buttons, '
  + 'dedup, orphan click, stale-script eviction).');
