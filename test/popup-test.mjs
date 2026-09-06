// Popup interaction smoke test using a minimal DOM and mocked Chrome.
// This checks application logic; it does not replace browser/layout QA.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.value = ''; }
  append(...children) {
    for (const child of children) { child.parent = this; this.children.push(child); }
    if (this.tag === 'select' && !this.value) this.value = this.children[0]?.value || '';
  }
  replaceChildren(...children) { this.children = []; this.value = ''; this.append(...children); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, fn) { this.events[name] = fn; }
  remove() { this.parent.children = this.parent.children.filter(c => c !== this); }
  replaceWith(el) { el.parent = this.parent; this.parent.children[this.parent.children.indexOf(this)] = el; }
}
const html = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
const ids = new Map([...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\w+)[^>]*id="([^"]+)"/g)].map(m => [m[2], new Element(m[1])]));
const popupSource = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
// Every literal DOM lookup must resolve to a real, non-commented HTML element.
for (const match of popupSource.matchAll(/\$\('([^']+)'\)/g)) {
  assert.ok(ids.has(match[1]), 'Missing popup element: ' + match[1]);
}
assert.doesNotMatch(popupSource, /[^\x00-\x7f]/, 'Keep UI punctuation escaped to prevent encoding corruption');
const tabs = [{ id:1, windowId:1, url:'https://polls.la.utexas.edu/course/6609/student' },
  { id:2, windowId:1, url:'https://polls.la.utexas.edu/course/1234/student' }];
let list = tabs, fail = false, submits = 0;
const intervals = [];
const context = vm.createContext({
  console, URL, Date, Map, Set,
  document: { getElementById:id => ids.get(id) ?? null, createElement:tag => new Element(tag) },
  setInterval(fn) { intervals.push(fn); },
  chrome: {
    runtime: { sendMessage:async () => ({ monitoring:true, wsState:'connected' }) },
    tabs: {
      query:async () => list,
      async sendMessage(_tab, msg) {
        if (fail) throw new Error('Tab unavailable');
        if (msg.type === 'GET_POLLS') return { ok:true, polls:polls };
        submits++;
        return { ok:true, poll:{ ...polls[0], submitted:true, answer:msg.answer } };
      },
    },
  },
});
for (const name of ['poll-model.js', 'popup.js']) {
  if (name === 'popup.js') break;
  vm.runInContext(readFileSync(new URL('../' + name, import.meta.url), 'utf8'), context);
}
let polls = [context.Instapoll.normalize({
  id:1, name:'Question', prompt:'', type:'textentry', state:'sent',
  finish_timestamp:Date.now()/1000 + 3600,
})];
vm.runInContext(readFileSync(new URL('../popup.js', import.meta.url), 'utf8'), context);
const settle = () => new Promise(resolve => setImmediate(resolve));
const current = () => vm.runInContext('cards.get("1")', context);
await settle();
assert.equal(ids.get('statusLabel').textContent, 'Connected \u2014 listening for polls');
assert.equal(ids.get('course').children.length, 2);
assert.equal(ids.get('polls').children.length, 1);
let card = current();
const form = card.article.children[3];
const textarea = card.fieldset.children[1];
textarea.value = 'My draft';
await vm.runInContext('refresh()', context);
assert.equal(current(), card, 'Refresh must preserve the existing input/focus');
assert.equal(textarea.value, 'My draft');
await form.events.submit({ preventDefault() {} });
assert.equal(submits, 1);
assert.match(card.feedback.textContent, /successfully/);
assert.equal(card.button.textContent, 'Update answer');

polls = [{ ...polls[0], finish:1 }];
await vm.runInContext('refresh()', context);
assert.equal(card.button.disabled, true);
assert.equal(card.fieldset.disabled, true);
polls = [];
await vm.runInContext('refresh()', context);
assert.equal(ids.get('polls').children.length, 0);
assert.match(ids.get('message').textContent, /No active polls/);

fail = true;
await vm.runInContext('refresh()', context);
assert.equal(ids.get('message').className, 'error');
assert.match(ids.get('message').textContent, /Reload/);
fail = false;
list = [];
await vm.runInContext('refresh()', context);
assert.equal(ids.get('course').disabled, true);
assert.equal(ids.get('open').disabled, true);
assert.match(ids.get('message').textContent, /Canvas/);
console.log('Popup smoke tests passed (course discovery, rendering, draft preservation, submit, closure, recall, errors, empty state).');
