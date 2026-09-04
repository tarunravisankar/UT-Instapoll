// Offline unit test for the parse + dedup logic in background.js.
// Run:  node test/parse-test.mjs
// This exercises the one code path that the in-app "Send test alert" button
// cannot: turning a real Pusher `poll_released` frame into a (courseId, pollId)
// and rejecting duplicates. Mirrors the logic in handlePollReleased().

import assert from 'node:assert';

function courseIdFromChannel(channel) {
  const m = /^polls_course_(\d+)$/.exec(channel || '');
  return m ? m[1] : null;
}

function parseFrame(frame, seen) {
  if (frame.event !== 'poll_released') return { ignored: true };
  const courseId = courseIdFromChannel(frame.channel) || 'unknown';
  let pollId = 'unknown';
  try {
    const data = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data;
    if (data && data.poll && data.poll.id != null) pollId = String(data.poll.id);
  } catch {}
  const key = `${courseId}:${pollId}`;
  if (pollId !== 'unknown' && seen.has(key)) return { duplicate: true, courseId, pollId };
  seen.add(key);
  return { courseId, pollId };
}

const seen = new Set();

// 1) The exact frame captured from a live release.
const real = { event: 'poll_released', channel: 'polls_course_6609', data: '{"poll":{"id":229271}}' };
let r = parseFrame(real, seen);
assert.deepStrictEqual({ courseId: r.courseId, pollId: r.pollId }, { courseId: '6609', pollId: '229271' });

// 2) The same frame again -> must be recognized as a duplicate (no re-alert).
r = parseFrame(real, seen);
assert.strictEqual(r.duplicate, true);

// 3) A different poll on the same course -> alerts.
r = parseFrame({ event: 'poll_released', channel: 'polls_course_6609', data: '{"poll":{"id":229272}}' }, seen);
assert.deepStrictEqual({ courseId: r.courseId, pollId: r.pollId }, { courseId: '6609', pollId: '229272' });

// 4) Same poll id, different course -> distinct, alerts.
r = parseFrame({ event: 'poll_released', channel: 'polls_course_1234', data: '{"poll":{"id":229271}}' }, seen);
assert.deepStrictEqual({ courseId: r.courseId, pollId: r.pollId }, { courseId: '1234', pollId: '229271' });

// 5) Non-poll frames are ignored.
assert.strictEqual(parseFrame({ event: 'pusher:pong', data: {} }, seen).ignored, true);

console.log('All parse/dedup tests passed ✅');
