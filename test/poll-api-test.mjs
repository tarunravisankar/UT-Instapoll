// Runs the actual extension scripts with a mocked Chrome/session transport.
// No requests are made to UT and no answers are submitted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
let listener, token = 'test-csrf', requests = [], handler;
const context = vm.createContext({
  console, URL, AbortSignal, Set, Date,
  location: { pathname:'/course/6609/student', href:'https://polls.la.utexas.edu/course/6609/student' },
  document: {
    addEventListener() {},
    querySelector() { return token ? { content:token } : null; },
  },
  chrome: {
    runtime: {
      id:'extension-test',
      sendMessage(_msg, callback) { callback?.(); },
      onMessage: { addListener(fn) { listener = fn; } },
    },
  },
  async fetch(path, options) {
    requests.push({ path, options });
    return handler(path, options);
  },
});
vm.runInContext(source('poll-model.js'), context);
vm.runInContext(source('content.js'), context);
const model = context.Instapoll;
const raw = (overrides = {}) => ({
  id:229271, name:'Test poll', prompt:'<p>Question?</p>', type:'multiplechoice',
  state:'sent', finish_timestamp:Math.floor(Date.now()/1000)+3600,
  released_at:'2026-09-06T12:00:00Z',
  config_json:{ choices:[{ text:'Zero' },{ text:'One' }] },
  ...overrides,
});
const json = (data, status = 200) => ({ ok:status >= 200 && status < 300, status, json:async () => data });
const send = msg => new Promise(resolve => listener(
  { courseId:'6609', ...msg }, { id:'extension-test' }, resolve));
const submit = (poll, answer) => send({
  type:'SUBMIT_POLL', pollId:String(poll.id), revision:model.revision(model.normalize(poll)), answer,
});

handler = () => json([raw()]);
let result = await send({ type:'GET_POLLS' });
assert.equal(result.ok, true);
assert.equal(result.polls[0].choices[0], 'Zero');
assert.equal(requests[0].path, '/api/v1/student/course/6609/poll');
assert.equal(requests[0].options.credentials, 'same-origin');
assert.equal(requests[0].options.method, 'GET');

for (const [poll, answer] of [
  [raw(), '0'],
  [raw({ type:'textentry' }), 'My typed answer'],
  [raw({ type:'attendance' }), 'present'],
]) {
  requests = [];
  handler = (_path, opts) => json(opts.method === 'POST'
    ? { ...poll, response:{ response_text:answer, created_at:'now' } } : poll);
  result = await submit(poll, answer);
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].path, '/api/v1/student/course/6609/poll/229271/response');
  assert.deepEqual(JSON.parse(requests[1].options.body), { response_text:answer });
  assert.equal(requests[1].options.headers['X-CSRF-TOKEN'], 'test-csrf');
}

for (const [current, answer, expected] of [
  [raw({ state:'finished' }), '0', /closed/],
  [raw({ finish_timestamp:1 }), '0', /closed/],
  [raw(), '2', /available choices/],
  [raw(), '', /Enter or select/],
  [raw({ type:'textentry' }), '  ', /Enter or select/],
  [raw({ type:'attendance' }), 'absent', /Confirm attendance/],
  [raw({ type:'unsupported' }), '0', /course page/],
]) {
  requests = []; handler = () => json(current);
  result = await submit(current, answer);
  assert.equal(result.ok, false);
  assert.match(result.error, expected);
  assert.equal(requests.length, 1, 'Invalid answers must never reach POST');
}
requests = []; handler = () => json(raw({ prompt:'Changed question' }));
result = await submit(raw(), '0');
assert.match(result.error, /changed/);
assert.equal(requests.length, 1);

for (const status of [401, 403, 419]) {
  handler = () => json({}, status);
  assert.match((await send({ type:'GET_POLLS' })).error, /session expired or access is restricted/);
}
handler = () => json({ message:'Poll locked by instructor.' }, 422);
assert.match((await send({ type:'GET_POLLS' })).error, /locked by instructor/);
handler = () => { throw new Error('offline'); };
assert.match((await send({ type:'GET_POLLS' })).error, /connection/);
handler = () => json({});
assert.equal((await send({ type:'GET_POLLS' })).ok, false);
handler = () => json(null);
assert.equal((await send({ type:'GET_POLLS' })).ok, false);

requests = []; token = '';
handler = () => json(raw());
result = await submit(raw(), '0');
assert.match(result.error, /renew your session/);
assert.equal(requests.length, 1);
token = 'test-csrf';

requests = [];
handler = (_path, opts) => {
  if (opts.method === 'POST') throw new Error('network lost after sending');
  return json(raw());
};
result = await submit(raw(), '0');
assert.match(result.error, /could not be confirmed/);
assert.equal(requests.filter(r => r.options.method === 'POST').length, 1);

handler = (_path, opts) => json(opts.method === 'POST'
  ? raw({ response:{ created_at:'now', response_text:'1' } }) : raw());
assert.match((await submit(raw(), '0')).error, /could not be confirmed/);

// Duplicate submissions are rejected while the first request is in flight.
let release;
handler = () => new Promise(resolve => { release = resolve; });
const first = submit(raw(), '0');
const second = await submit(raw(), '0');
assert.match(second.error, /already being submitted/);
handler = () => json(raw({ response:{ created_at:'now', response_text:'0' } }));
release(json(raw()));
assert.equal((await first).ok, true);

// Only extension pages may request the student adapter, on the right course.
let answered = false;
assert.equal(listener({ type:'GET_POLLS' }, { id:'other' }, () => { answered = true; }), undefined);
assert.equal(answered, false);
assert.equal((await send({ type:'GET_POLLS', courseId:'1234' })).ok, false);
context.location.pathname = '/course/6609/teacher';
assert.equal((await send({ type:'GET_POLLS' })).ok, false);

console.log('Poll API tests passed (all three types, validation, stale polls, auth, errors, and duplicate submission).');
