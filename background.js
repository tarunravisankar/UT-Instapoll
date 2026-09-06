// ============================================================================
// UT Instapoll Notifier — service worker
//
// Design summary (see README for the full rationale):
//   The extension does NOT rely on sniffing the Instapoll page's own Pusher
//   connection. A background tab's JavaScript timers get throttled by Chrome,
//   which can silently kill the page's Pusher heartbeat after a few minutes and
//   make you MISS a poll — exactly the situation this extension exists to avoid.
//
//   Instead, the service worker opens its OWN WebSocket to the same public
//   Pusher endpoint and subscribes to each open course's public channel. Service
//   worker timers are not throttled the way background-tab timers are, and a
//   20s keepalive ping keeps both the Pusher connection and the SW itself alive
//   (supported since Chrome 116). This is still true realtime — not polling.
//
//   An open Instapoll course tab is what "arms" a course (we read the course ID
//   from its URL). You can then switch away; alerts fire from here regardless of
//   which tab is focused. If the tab is later frozen/closed, monitoring keeps
//   running and clicking a notification re-opens the course URL.
// ============================================================================

const PUSHER_URL =
  'wss://pusher-ws.la.utexas.edu/app/instapollprod?protocol=7&client=js&version=8.6.0&flash=false';

const KEEPALIVE_MS = 20_000;   // must be < 30s SW idle window and < Pusher activity_timeout
const SEEN_TTL_MS = 12 * 60 * 60 * 1000; // forget a poll id after 12h
const STORAGE_KEY = 'instapoll_state';

// ---- runtime state (rebuilt from storage on SW start) -----------------------
let ws = null;
let wsState = 'idle';          // idle | connecting | connected | closed
let keepaliveTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastConnectedAt = 0;
let lastEventAt = 0;

// Persisted-ish state. `tabs` maps tabId -> {courseId, url, windowId}.
// `seen` maps "courseId:pollId" -> timestamp (dedup across reloads/reconnects).
let state = { tabs: {}, seen: {}, notifs: {} };

// notificationId -> {courseId, url} so clicks can focus/open the right tab.
// Notifications use requireInteraction, so they outlive the service worker;
// keeping targets only in memory made every click after a worker restart a
// no-op. They live in `state.notifs` and are pruned with `seen`.
const COURSE_URL_MATCH = '*://polls.la.utexas.edu/course/*';
const CONTENT_FILES = ['poll-model.js', 'content.js'];

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------
async function loadState() {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  const saved = got[STORAGE_KEY];
  if (!saved) return;
  // Merge instead of replacing. A COURSE_ACTIVE message can land while this
  // read is in flight, and a wholesale replace silently dropped the tab that
  // had just armed itself, leaving the worker monitoring nothing.
  state = {
    tabs: { ...(saved.tabs || {}), ...state.tabs },
    seen: { ...(saved.seen || {}), ...state.seen },
    notifs: { ...(saved.notifs || {}), ...state.notifs },
  };
}
async function saveState() {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function activeCourseIds() {
  return [...new Set(Object.values(state.tabs).map((t) => t.courseId))];
}
function channelFor(courseId) {
  return `polls_course_${courseId}`;
}
function courseIdFromChannel(channel) {
  const m = /^polls_course_(\d+)$/.exec(channel || '');
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// content script health
//
// Manifest content scripts are injected only when a page loads. Installing,
// updating or reloading the extension therefore leaves every already-open
// course tab WITHOUT a content script, and nothing repaired it: the popup could
// still see the tab via tabs.query and still show a green "connected" dot from
// stored state, while every message to that tab failed with "Reload your
// signed-in Instapoll course tab". Re-injecting here fixes those tabs in place.
// content.js guards against running twice, so this is safe to repeat.
// ---------------------------------------------------------------------------
async function ensureContentScript(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (reply && reply.ok) return true;
  } catch { /* no listener yet — inject below */ }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: CONTENT_FILES,
      injectImmediately: true,
    });
    return true;
  } catch (e) {
    // Discarded, still loading, or a page we cannot touch. It will inject
    // itself normally when it next loads.
    return false;
  }
}

async function healOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: COURSE_URL_MATCH }); } catch { return; }
  await Promise.all(tabs.map((t) => t.id != null && ensureContentScript(t.id)));
}

// Injecting a fresh copy does not silence an old one. A content script from a
// previous version keeps its listeners bound to the page, and once its context
// dies every tab switch throws "Extension context invalidated" from a closure
// we hold no reference to. Copies from v1.2.1 on hand over via dispose(); older
// ones left no handle at all, so the page has to be reloaded to evict them.
//
// This runs ONLY on install/update -- never on a worker restart or browser
// start -- so a page is never disturbed while the extension is just running.
async function reloadCourseTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: COURSE_URL_MATCH }); } catch { return; }
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try { await chrome.tabs.reload(tab.id); } catch { /* gone, or not ours to touch */ }
  }
}

// ---------------------------------------------------------------------------
// WebSocket lifecycle
// ---------------------------------------------------------------------------
function ensureConnection() {
  if (activeCourseIds().length === 0) return; // nothing to monitor
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connect();
}

function connect() {
  clearTimeout(reconnectTimer);
  wsState = 'connecting';
  updateBadge();
  try {
    ws = new WebSocket(PUSHER_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => { /* wait for pusher:connection_established before subscribing */ };
  ws.onmessage = onWsMessage;
  ws.onerror = () => { /* an onclose will follow */ };
  ws.onclose = () => {
    wsState = 'closed';
    stopKeepalive();
    updateBadge();
    if (activeCourseIds().length > 0) scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts));
  reconnectAttempts++;
  reconnectTimer = setTimeout(connect, delay);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function subscribeAll() {
  for (const courseId of activeCourseIds()) {
    send({ event: 'pusher:subscribe', data: { channel: channelFor(courseId), auth: '' } });
  }
}

function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(() => send({ event: 'pusher:ping', data: {} }), KEEPALIVE_MS);
}
function stopKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

function onWsMessage(evt) {
  let frame;
  try { frame = JSON.parse(evt.data); } catch { return; }
  const event = frame.event;

  if (event === 'pusher:connection_established') {
    wsState = 'connected';
    lastConnectedAt = Date.now();
    reconnectAttempts = 0;
    updateBadge();
    subscribeAll();
    startKeepalive();
    return;
  }
  if (event === 'pusher:ping') { send({ event: 'pusher:pong', data: {} }); return; }
  if (event === 'pusher:pong') { return; }
  if (event === 'pusher_internal:subscription_succeeded') { return; }
  if (event === 'pusher:error') { console.warn('[Instapoll] pusher error', frame.data); return; }

  if (event === 'poll_released') {
    handlePollReleased(frame);
  }
}

// ---------------------------------------------------------------------------
// poll handling + dedup
// ---------------------------------------------------------------------------
async function handlePollReleased(frame) {
  lastEventAt = Date.now();
  const courseId = courseIdFromChannel(frame.channel) || 'unknown';

  let pollId = 'unknown';
  try {
    const data = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data;
    if (data && data.poll && data.poll.id != null) pollId = String(data.poll.id);
  } catch { /* keep 'unknown' */ }

  const key = `${courseId}:${pollId}`;
  if (pollId !== 'unknown' && state.seen[key]) return; // duplicate — ignore
  state.seen[key] = Date.now();
  await saveState();

  await notifyPoll(courseId, pollId);
}

async function notifyPoll(courseId, pollId) {
  const target = targetForCourse(courseId);
  const notifId = `instapoll_${courseId}_${pollId}_${Date.now()}`;
  state.notifs[notifId] = { courseId, url: target.url, at: Date.now() };
  await saveState();

  // Fire the alert before looking anything up. Reading the question needs a
  // network round trip through a course tab, and being late to a poll is the
  // one failure this extension exists to prevent.
  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: '📊 New Instapoll released!',
    message: `Course ${courseId} — a poll is open. Click to answer.`,
    contextMessage: `Course ${courseId}`,
    priority: 2,
    requireInteraction: true, // stays on screen until you act on it
    buttons: [{ title: 'Answer here' }, { title: 'Open course page' }],
  });

  await playAlertSound();
  // Surface the question without stealing the tab: this only lands when a
  // Chrome window already has focus, which is the "reading another tab" case.
  await openActionPopup();
  await describeInNotification(notifId, courseId, pollId);
}

// ---------------------------------------------------------------------------
// filling the question into the notification
//
// The service worker has no Instapoll session of its own, so the poll text has
// to come from a course tab. Entirely best effort: if no tab can answer, the
// generic alert above stands on its own.
// ---------------------------------------------------------------------------
function textFromHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function pollDetails(courseId, pollId) {
  const tabIds = Object.entries(state.tabs)
    .filter(([, t]) => t.courseId === courseId)
    .map(([id]) => Number(id));
  for (const tabId of tabIds) {
    try {
      if (!await ensureContentScript(tabId)) continue;
      const reply = await chrome.tabs.sendMessage(tabId, { type: 'GET_POLLS', courseId });
      if (!reply || !reply.ok || !Array.isArray(reply.polls)) continue;
      return reply.polls.find((p) => p.id === String(pollId))
        || reply.polls.find((p) => p.state === 'sent')
        || null;
    } catch { /* try the next tab */ }
  }
  return null;
}

async function describeInNotification(notifId, courseId, pollId) {
  let poll = null;
  try { poll = await pollDetails(courseId, pollId); } catch { /* keep generic */ }
  if (!poll) return;
  const question = textFromHtml(poll.prompt);
  const options = {};
  if (poll.name) options.title = `📊 ${poll.name}`;
  if (question) options.message = question.length > 200 ? question.slice(0, 197) + '…' : question;
  if (Object.keys(options).length === 0) return;
  try { await chrome.notifications.update(notifId, options); } catch { /* already dismissed */ }
}

// Opening our own popup needs a focused Chrome window, and action.openPopup()
// only reached stable in Chrome 127. Both are treated as best effort — the
// desktop notification is the alert that always works.
async function openActionPopup() {
  if (typeof chrome.action?.openPopup !== 'function') return false;
  try {
    const win = await chrome.windows.getLastFocused();
    if (!win || win.focused === false) return false;
    await chrome.action.openPopup({ windowId: win.id });
    return true;
  } catch { return false; }
}

function targetForCourse(courseId) {
  for (const [tabId, t] of Object.entries(state.tabs)) {
    if (t.courseId === courseId) return { tabId: Number(tabId), url: t.url, windowId: t.windowId };
  }
  return { tabId: null, url: `https://polls.la.utexas.edu/course/${courseId}/student#`, windowId: null };
}

// ---------------------------------------------------------------------------
// audio via offscreen document (SW has no Audio API)
// ---------------------------------------------------------------------------
// Two alerts arriving together used to race here: both saw no document and both
// called createDocument, and the loser threw. Serialise on one promise.
let offscreenReady = null;
function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing.length > 0) return;
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play an audible alert when a poll is released.',
      });
    } catch (e) {
      // A concurrent caller may have created it first; anything else is real.
      if (!/single offscreen document/i.test(String(e && e.message))) throw e;
    }
  })();
  offscreenReady = offscreenReady.catch((e) => { offscreenReady = null; throw e; });
  return offscreenReady;
}
async function playAlertSound() {
  // The document can be torn down between alerts, and a freshly created one may
  // not have registered its listener yet. Retry, but only on a real rejection:
  // offscreen.js acknowledges the message, so a resolve means the chime played.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'PLAY_ALERT' });
      return true;
    } catch (e) {
      offscreenReady = null;
      if (attempt === 2) { console.warn('[Instapoll] could not play sound', e); break; }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// notification click -> focus the course tab, or open it
// ---------------------------------------------------------------------------
async function consumeNotification(notifId) {
  chrome.notifications.clear(notifId);
  await loadState();
  // Fall back to the id itself: a notification can outlive the worker that
  // created it, and a click that opens nothing is worse than a best-effort one.
  const tgt = state.notifs[notifId] || (() => {
    const courseId = /^instapoll_(\d+)_/.exec(notifId)?.[1];
    return courseId
      ? { courseId, url: `https://polls.la.utexas.edu/course/${courseId}/student#` }
      : null;
  })();
  if (state.notifs[notifId]) { delete state.notifs[notifId]; await saveState(); }
  return tgt;
}

async function focusCourseTab(tgt) {
  // Prefer focusing a live tab for this course.
  for (const [tabId, t] of Object.entries(state.tabs)) {
    if (t.courseId === tgt.courseId) {
      try {
        await chrome.tabs.update(Number(tabId), { active: true });
        if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
        return;
      } catch { /* tab gone — fall through to open */ }
    }
  }
  chrome.tabs.create({ url: tgt.url });
}

chrome.notifications.onClicked.addListener(async (notifId) => {
  const tgt = await consumeNotification(notifId);
  if (tgt) await focusCourseTab(tgt);
});

// Button 0 answers in the popup, button 1 goes to the course page. If the popup
// cannot be opened (no focused window, or Chrome older than 127) fall through
// to the course tab rather than doing nothing.
chrome.notifications.onButtonClicked.addListener(async (notifId, index) => {
  const tgt = await consumeNotification(notifId);
  if (!tgt) return;
  if (index === 0 && await openActionPopup()) return;
  await focusCourseTab(tgt);
});

// ---------------------------------------------------------------------------
// badge
// ---------------------------------------------------------------------------
function updateBadge() {
  const monitoring = activeCourseIds().length > 0;
  if (!monitoring) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const ok = wsState === 'connected';
  chrome.action.setBadgeText({ text: ok ? '●' : '…' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#1a7f37' : '#9a6700' });
}

// ---------------------------------------------------------------------------
// messages from content scripts + popup
// ---------------------------------------------------------------------------
const HANDLED = new Set([
  'COURSE_ACTIVE', 'GET_STATUS', 'TEST_ALERT', 'RECONNECT_NOW', 'ENSURE_CONTENT',
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only claim the response port for our own message types. Returning true for
  // everything also swallowed the offscreen audio messages, which left that
  // send hanging until the port closed.
  if (!msg || msg.target === 'offscreen' || !HANDLED.has(msg.type)) return false;
  (async () => {
    if (msg.type === 'ENSURE_CONTENT') {
      // The popup asks for this when a tab stops answering, so "Refresh polls"
      // can repair the tab instead of telling the user to reload it by hand.
      const tabId = Number(msg.tabId);
      sendResponse({ ok: Number.isInteger(tabId) ? await ensureContentScript(tabId) : false });
      return;
    }

    if (msg.type === 'COURSE_ACTIVE') {
      const tab = sender.tab;
      if (tab && msg.courseId) {
        state.tabs[tab.id] = { courseId: msg.courseId, url: msg.url, windowId: tab.windowId };
        await saveState();
        // if already connected, make sure we're subscribed to this channel
        if (wsState === 'connected') {
          send({ event: 'pusher:subscribe', data: { channel: channelFor(msg.courseId), auth: '' } });
        }
        ensureConnection();
        updateBadge();
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'GET_STATUS') {
      sendResponse(buildStatus());
      return;
    }

    if (msg.type === 'TEST_ALERT') {
      // Simulate an inbound poll_released so the full pipeline (dedup + notify +
      // sound + click-to-focus) is exercised without a real professor.
      const courseId = msg.courseId || activeCourseIds()[0] || '0000';
      const fakeId = `test-${Date.now()}`;
      await notifyPoll(courseId, fakeId);
      sendResponse({ ok: true, courseId });
      return;
    }

    if (msg.type === 'RECONNECT_NOW') {
      try { ws && ws.close(); } catch {}
      reconnectAttempts = 0;
      ensureConnection();
      sendResponse({ ok: true });
      return;
    }
  })();
  return true; // async response
});

function buildStatus() {
  const courses = activeCourseIds().map((courseId) => {
    const tabIds = Object.entries(state.tabs)
      .filter(([, t]) => t.courseId === courseId)
      .map(([id]) => Number(id));
    const seenCount = Object.keys(state.seen).filter((k) => k.startsWith(courseId + ':')).length;
    return { courseId, channel: channelFor(courseId), tabs: tabIds.length, seenCount };
  });
  return {
    wsState,
    monitoring: courses.length > 0,
    courses,
    lastConnectedAt,
    lastEventAt,
  };
}

// ---------------------------------------------------------------------------
// tab close -> drop course, maybe unsubscribe
// (chrome.tabs.onRemoved works without the "tabs" permission)
// ---------------------------------------------------------------------------
// A reloaded or re-navigated tab gets a fresh content script from the manifest,
// but a tab that leaves the course keeps its entry in state.tabs forever. That
// stale entry kept the worker subscribed to a course the user no longer has
// open and made the popup report "connected" for a tab that cannot answer.
chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (!change.url && change.status !== 'complete') return;
  const onCourse = /^https?:\/\/polls\.la\.utexas\.edu\/course\/\d+\b/.test(tab.url || '');
  if (!onCourse) {
    if (!state.tabs[tabId]) return;
    delete state.tabs[tabId];
    await saveState();
    updateBadge();
    return;
  }
  if (change.status === 'complete') await ensureContentScript(tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!state.tabs[tabId]) return;
  const courseId = state.tabs[tabId].courseId;
  delete state.tabs[tabId];
  await saveState();

  const stillMonitored = activeCourseIds().includes(courseId);
  if (!stillMonitored && wsState === 'connected') {
    send({ event: 'pusher:unsubscribe', data: { channel: channelFor(courseId) } });
  }
  if (activeCourseIds().length === 0) {
    stopKeepalive();
    try { ws && ws.close(); } catch {}
  }
  updateBadge();
});

// ---------------------------------------------------------------------------
// watchdog: wakes the SW after sleep/termination and revives the connection;
// also expires old seen-poll ids
// ---------------------------------------------------------------------------
chrome.alarms.create('watchdog', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'watchdog') return;
  await loadState();

  // expire stale dedup entries
  const now = Date.now();
  let changed = false;
  for (const [k, ts] of Object.entries(state.seen)) {
    if (now - ts > SEEN_TTL_MS) { delete state.seen[k]; changed = true; }
  }
  for (const [k, t] of Object.entries(state.notifs)) {
    if (now - (t.at || 0) > SEEN_TTL_MS) { delete state.notifs[k]; changed = true; }
  }
  if (changed) await saveState();

  await reconcileTabs();
  ensureConnection();
  updateBadge();
});

// ---------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------
// Install/update is the one moment a stale content script from the previous
// version is guaranteed to be sitting in every open course tab.
chrome.runtime.onInstalled.addListener(() => { reloadCourseTabs().then(init, init); });
chrome.runtime.onStartup.addListener(() => { init(); });

async function reconcileTabs() {
  // Drop stored course tabs that no longer exist (e.g. closed while the SW was
  // terminated). chrome.tabs.query returns ids without the "tabs" permission.
  try {
    // Keep only tabs that still exist AND are still on a course page. Matching
    // on existence alone let a tab that navigated elsewhere keep a course armed.
    const live = new Map();
    for (const t of await chrome.tabs.query({})) live.set(t.id, t.url || '');
    let changed = false;
    for (const id of Object.keys(state.tabs)) {
      const url = live.get(Number(id));
      const onCourse = /^https?:\/\/polls\.la\.utexas\.edu\/course\/\d+\b/.test(url || '');
      // An empty url means we cannot see it; keep the entry rather than guess.
      if (url === undefined || (url && !onCourse)) { delete state.tabs[id]; changed = true; }
    }
    if (changed) await saveState();
  } catch { /* ignore */ }
}

async function init() {
  await loadState();
  await reconcileTabs();
  ensureConnection();
  updateBadge();
  // Repair course tabs that were already open when this extension version
  // loaded. Without this they stay permanently unreachable from the popup.
  await healOpenTabs();
}

// Debug hook — call from the service worker's DevTools console to push a
// synthetic poll_released frame through the REAL pipeline (parse + dedup +
// notify + sound). Example:  __simulatePoll(6609, 999001)
// Run it twice with the same id to watch dedup suppress the second alert.
globalThis.__simulatePoll = (courseId, pollId = Date.now()) =>
  handlePollReleased({
    event: 'poll_released',
    channel: `polls_course_${courseId}`,
    data: JSON.stringify({ poll: { id: pollId } }),
  });

// Run on every SW spin-up too (module top-level).
init();
