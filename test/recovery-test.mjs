// Regression tests for the failure this extension kept hitting in real use:
// an open course tab that has no content script, because manifest content
// scripts are injected only when a page loads. Installing, updating or
// reloading the extension orphans every tab that was already open, and the
// popup then reports "Reload your signed-in Instapoll course tab" forever.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// content.js survives being injected twice
// ---------------------------------------------------------------------------
{
  const listeners = [];
  const context = vm.createContext({
    console, URL, AbortSignal, Set, Date, setTimeout,
    location: { pathname: '/course/6609/student', href: 'https://polls.la.utexas.edu/course/6609/student' },
    document: { addEventListener() {}, querySelector: () => ({ content: 'csrf' }) },
    chrome: {
      runtime: {
        id: 'ext',
        sendMessage(_msg, callback) { callback?.(); },
        onMessage: { addListener: fn => listeners.push(fn) },
      },
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => [] }),
  });
  vm.runInContext(source('poll-model.js'), context);
  vm.runInContext(source('content.js'), context);
  vm.runInContext(source('content.js'), context); // service worker re-injects
  assert.equal(listeners.length, 1,
    're-injection must not register a second message listener');

  // A re-injected tab answers PING, which is how the worker verifies health.
  const ping = await new Promise(resolve =>
    listeners[0]({ type: 'PING' }, { id: 'ext' }, resolve));
  assert.equal(ping.ok, true);
  assert.equal(ping.courseId, '6609');
}

// ---------------------------------------------------------------------------
// content.js reads the course id at call time, not at injection time
// ---------------------------------------------------------------------------
{
  let listener;
  const location = { pathname: '/course/6609', href: 'https://polls.la.utexas.edu/course/6609' };
  const context = vm.createContext({
    console, URL, AbortSignal, Set, Date, setTimeout,
    location,
    document: { addEventListener() {}, querySelector: () => ({ content: 'csrf' }) },
    chrome: {
      runtime: { id: 'ext', sendMessage(_m, cb) { cb?.(); }, onMessage: { addListener: fn => { listener = fn; } } },
    },
    fetch: async path => {
      assert.equal(path, '/api/v1/student/course/7777/poll', 'must use the current course');
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  vm.runInContext(source('poll-model.js'), context);
  vm.runInContext(source('content.js'), context);
  // Instapoll routes client-side; the tab is now on a different course page.
  location.pathname = '/course/7777/student';
  location.href = 'https://polls.la.utexas.edu/course/7777/student';
  const result = await new Promise(resolve =>
    listener({ type: 'GET_POLLS', courseId: '7777' }, { id: 'ext' }, resolve));
  assert.equal(result.ok, true);
  assert.equal(result.polls.length, 0);
}

// ---------------------------------------------------------------------------
// popup.js repairs an unreachable tab on refresh, and never replays a submit
// ---------------------------------------------------------------------------
{
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.value = ''; }
    append(...kids) {
      for (const k of kids) { k.parent = this; this.children.push(k); }
      if (this.tag === 'select' && !this.value) this.value = this.children[0]?.value || '';
    }
    replaceChildren(...kids) { this.children = []; this.value = ''; this.append(...kids); }
    setAttribute(n, v) { this[n] = v; }
    addEventListener(n, fn) { this.events[n] = fn; }
    remove() { this.parent.children = this.parent.children.filter(c => c !== this); }
    replaceWith(el) { el.parent = this.parent; this.parent.children[this.parent.children.indexOf(this)] = el; }
  }
  const html = source('popup.html');
  const ids = new Map([...html.matchAll(/<(\w+)[^>]*id="([^"]+)"/g)].map(m => [m[2], new Element(m[1])]));

  let injected = false;          // has the worker re-injected the content script?
  let ensureCalls = 0;
  let tabSends = [];
  const context = vm.createContext({
    console, URL, Date, Map, Set,
    document: { getElementById: id => ids.get(id) ?? null, createElement: t => new Element(t) },
    setInterval() {},
    chrome: {
      runtime: {
        async sendMessage(msg) {
          if (msg.type === 'ENSURE_CONTENT') {
            ensureCalls++; injected = true;
            return { ok: true };
          }
          return { monitoring: true, wsState: 'connected' };
        },
      },
      tabs: {
        query: async () => [{ id: 1, windowId: 1, url: 'https://polls.la.utexas.edu/course/6609/student' }],
        async sendMessage(tabId, msg) {
          tabSends.push(msg.type);
          // Before the repair the tab has no listener at all.
          if (!injected) throw new Error('Could not establish connection.');
          if (msg.type === 'GET_POLLS') return { ok: true, polls: [] };
          return { ok: true, poll: null };
        },
      },
    },
  });
  vm.runInContext(source('poll-model.js'), context);
  vm.runInContext(source('popup.js'), context);
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(ensureCalls, 1, 'refresh must ask the worker to repair the tab');
  assert.equal(
    ids.get('message').textContent,
    'No active polls. New polls appear here automatically.',
    'after repair the popup must recover instead of showing the reload error');

  // A submit that goes unanswered must never be retried: Instapoll may already
  // have accepted it, and replaying would double-submit an answer.
  injected = false;
  tabSends = [];
  await assert.rejects(
    () => vm.runInContext(
      'sendToCourse("6609", { type:"SUBMIT_POLL", pollId:"1", revision:"r", answer:"0" })', context),
    /Reload your signed-in Instapoll course tab/);
  assert.deepEqual(tabSends, ['SUBMIT_POLL'], 'a submit must be attempted exactly once');
}

console.log('Recovery tests passed (re-injection guard, live course id, tab repair, no submit replay).');
