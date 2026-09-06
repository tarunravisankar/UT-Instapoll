// Tests the in-page poll card against a hand-rolled DOM.
//
// The point of this card is that it is NOT the action popup: Chrome closes a
// popup as soon as it loses focus, so these tests pin the behaviour that
// difference exists for -- it survives clicking around the page, and it closes
// when, and only when, the reader asks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

class El {
  constructor(tag) {
    this.tag = tag; this.tagName = String(tag).toUpperCase();
    this.children = []; this.listeners = {}; this.attrs = {};
    this._text = ''; this.shadow = null; this.parent = null;
  }
  append(...kids) {
    for (const kid of kids) {
      if (!kid) continue;
      if (kid.isFragment) { this.append(...kid.children); continue; }
      kid.parent = this; this.children.push(kid);
    }
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn);
  }
  setAttribute(name, value) { this.attrs[name] = value; }
  getAttribute(name) { return this.attrs[name]; }
  attachShadow() { this.shadow = new El('#shadow'); return this.shadow; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
    this.parent = null;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    return this._text || this.children.map(c => c.textContent).join('');
  }
  fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
  walk(out = []) {
    for (const child of this.children) { out.push(child); child.walk(out); }
    if (this.shadow) this.shadow.walk(out);
    return out;
  }
  find(pred) { return this.walk().filter(pred); }
}

function makeDom() {
  const documentElement = new El('html');
  const document = {
    documentElement,
    listeners: {},
    createElement: tag => new El(tag),
    createTextNode: text => { const el = new El('#text'); el.textContent = text; return el; },
    createDocumentFragment: () => { const f = new El('#fragment'); f.isFragment = true; return f; },
    addEventListener(type, fn) { (document.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      document.listeners[type] = (document.listeners[type] || []).filter(f => f !== fn);
    },
    querySelectorAll(selector) {
      const id = selector.replace('#', '');
      return documentElement.find(el => el.id === id);
    },
  };
  return { document, documentElement };
}

function load(dom) {
  const context = vm.createContext({
    console, Date, Set, Map, String, Number, Array, Object, Promise, Error, JSON,
    document: dom.document,
  });
  vm.runInContext(source('poll-model.js'), context);
  // The sanitiser needs DOMParser and is covered by the model's own tests; here
  // it only has to prove the prompt reaches the card.
  vm.runInContext(
    'Instapoll.promptFragment = html => document.createTextNode("PROMPT:" + html);',
    context);
  vm.runInContext(source('overlay.js'), context);
  return context;
}

const mc = {
  id: '1', name: 'Warm-up', prompt: 'What is 2+2?', type: 'multiplechoice',
  state: 'sent', finish: null, choices: ['Three', 'Four', 'Five'],
  answer: '', submitted: false,
};
const open = { id: '2', name: 'Reflection', prompt: 'Why?', type: 'textentry',
  state: 'sent', finish: null, choices: [], answer: '', submitted: false };

const cardOf = dom => dom.documentElement.children.find(el => el.id === 'ut-instapoll-notifier-overlay');

// ---------------------------------------------------------------------------
// Multiple choice: the question, then one row per choice.
// ---------------------------------------------------------------------------
{
  const dom = makeDom();
  const ctx = load(dom);
  ctx.InstapollOverlay.show(mc, {});
  const host = cardOf(dom);
  assert.ok(host, 'the card must be attached to the page');

  const all = host.walk();
  assert.ok(all.some(el => el.tag === 'h2' && el.textContent === 'Warm-up'),
    'the poll name must be shown');
  assert.ok(all.some(el => el.textContent === 'PROMPT:What is 2+2?'),
    'the question prompt must be shown');

  const radios = all.filter(el => el.tag === 'input' && el.type === 'radio');
  assert.equal(radios.length, 3, 'one radio per choice');
  const labels = all.filter(el => el.tag === 'span').map(el => el.textContent);
  for (const choice of mc.choices) {
    assert.ok(labels.includes(choice), 'choice must be listed: ' + choice);
  }
}

// ---------------------------------------------------------------------------
// Open ended: the question and a box, and no choice rows at all.
// ---------------------------------------------------------------------------
{
  const dom = makeDom();
  const ctx = load(dom);
  ctx.InstapollOverlay.show(open, {});
  const all = cardOf(dom).walk();
  assert.ok(all.some(el => el.textContent === 'PROMPT:Why?'), 'the question must be shown');
  assert.equal(all.filter(el => el.tag === 'textarea').length, 1, 'one answer box');
  assert.equal(all.filter(el => el.tag === 'input').length, 0,
    'an open-ended poll must not render choice inputs');
}

// ---------------------------------------------------------------------------
// It must survive clicking around the page -- the whole reason it is not the
// action popup. Nothing may dismiss it on an outside click or a lost focus.
// ---------------------------------------------------------------------------
{
  const dom = makeDom();
  const ctx = load(dom);
  ctx.InstapollOverlay.show(mc, {});
  for (const type of ['click', 'mousedown', 'focusout', 'blur', 'visibilitychange']) {
    assert.equal((dom.document.listeners[type] || []).length, 0,
      'the card must not dismiss itself on ' + type);
  }
  dom.documentElement.fire('click');
  assert.ok(cardOf(dom), 'clicking the page must leave the card open');
  assert.equal(ctx.InstapollOverlay.isOpen(), true);
}

// ---------------------------------------------------------------------------
// The reader can close it: the X button and Escape both work.
// ---------------------------------------------------------------------------
{
  const dom = makeDom();
  const ctx = load(dom);
  let closed = 0;
  ctx.InstapollOverlay.show(mc, { onClose: () => { closed++; } });
  const button = cardOf(dom).walk().find(el => el.tag === 'button' && el.textContent === '×');
  assert.ok(button, 'there must be a close button');
  button.fire('click');
  assert.equal(cardOf(dom), undefined, 'the close button must remove the card');
  assert.equal(closed, 1, 'closing must report back so the poll is not re-shown');
  assert.equal(ctx.InstapollOverlay.isOpen(), false);
}
{
  const dom = makeDom();
  const ctx = load(dom);
  ctx.InstapollOverlay.show(mc, {});
  const onKey = dom.document.listeners.keydown[0];
  onKey({ key: 'a', stopPropagation() {} });
  assert.ok(cardOf(dom), 'other keys must not close the card');
  onKey({ key: 'Escape', stopPropagation() {} });
  assert.equal(cardOf(dom), undefined, 'Escape must close the card');
}

// ---------------------------------------------------------------------------
// Submitting reports the selected answer, once.
// ---------------------------------------------------------------------------
{
  const dom = makeDom();
  const ctx = load(dom);
  const sent = [];
  ctx.InstapollOverlay.show(mc, {
    submit: async answer => { sent.push(answer); return { ...mc, submitted: true, answer }; },
  });
  const all = cardOf(dom).walk();
  all.filter(el => el.type === 'radio')[1].checked = true;   // "Four"
  const submit = all.find(el => el.tag === 'button' && el.textContent === 'Submit answer');
  submit.fire('click');
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(sent, ['1'], 'the chosen index must be submitted exactly once');
  assert.ok(cardOf(dom).walk().some(el => el.textContent === 'Answer submitted successfully.'),
    'the reader must be told it worked');
}

// ---------------------------------------------------------------------------
// A second poll replaces the first rather than stacking cards.
// ---------------------------------------------------------------------------
{
  const dom = makeDom();
  const ctx = load(dom);
  ctx.InstapollOverlay.show(mc, {});
  ctx.InstapollOverlay.show(open, {});
  const hosts = dom.documentElement.children.filter(el => el.id === 'ut-instapoll-notifier-overlay');
  assert.equal(hosts.length, 1, 'cards must never stack');
  assert.ok(hosts[0].walk().some(el => el.textContent === 'PROMPT:Why?'), 'the newest poll wins');
}

// ---------------------------------------------------------------------------
// End to end: the worker's SHOW_POLL opens the card, and a poll the reader
// closed is not forced back on them the next time the worker nudges.
// ---------------------------------------------------------------------------
{
  const dom = makeDom();
  dom.document.querySelector = () => ({ content: 'csrf' });
  dom.document.visibilityState = 'visible';
  let listener;
  const raw = {
    id: 229271, name: 'Live question', prompt: 'Pick one', type: 'multiplechoice',
    state: 'sent', finish_timestamp: Math.floor(Date.now() / 1000) + 3600,
    released_at: '2026-09-06T12:00:00Z',
    config_json: { choices: [{ text: 'Alpha' }, { text: 'Beta' }] },
  };
  const context = vm.createContext({
    console, Date, Set, Map, String, Number, Array, Object, Promise, Error, JSON,
    RegExp, AbortSignal, URL, setTimeout,
    document: dom.document,
    location: { pathname: '/course/6609/student', href: 'https://polls.la.utexas.edu/course/6609/student' },
    chrome: {
      runtime: {
        id: 'ext',
        sendMessage(_m, cb) { cb?.(); },
        onMessage: { addListener: fn => { listener = fn; }, removeListener() {} },
      },
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => [raw] }),
  });
  vm.runInContext(source('poll-model.js'), context);
  vm.runInContext(
    'Instapoll.promptFragment = html => document.createTextNode("PROMPT:" + html);',
    context);
  vm.runInContext(source('overlay.js'), context);
  vm.runInContext(source('content.js'), context);

  const showPoll = () => new Promise(resolve =>
    listener({ type: 'SHOW_POLL', courseId: '6609', pollId: '229271' }, { id: 'ext' }, resolve));

  const first = await showPoll();
  assert.equal(first.ok, true);
  const host = cardOf(dom);
  assert.ok(host, 'a released poll must open the card on the course page');
  assert.ok(host.walk().some(el => el.tag === 'h2' && el.textContent === 'Live question'));
  assert.equal(host.walk().filter(el => el.type === 'radio').length, 2, 'both choices listed');

  // The reader closes it.
  host.walk().find(el => el.tag === 'button' && el.textContent === '×').fire('click');
  assert.equal(cardOf(dom), undefined);

  // The worker nudges again for the same poll; it must stay closed.
  await showPoll();
  assert.equal(cardOf(dom), undefined,
    'a poll the reader dismissed must not reopen itself');
}

console.log('Overlay tests passed (choices, open ended, survives page clicks, close, '
  + 'submit, no stacking, SHOW_POLL, dismissal sticks).');
