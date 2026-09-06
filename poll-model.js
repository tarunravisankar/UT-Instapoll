// Shared by the popup and the isolated course content script.
// API contract: UT's student-wQ8rRyzd.js (verified September 2026).
globalThis.Instapoll = (() => {
  const types = new Set(['multiplechoice', 'textentry', 'attendance']);
  function normalize(raw) {
    if (!raw || !/^\d+$/.test(String(raw.id))) throw new Error('Invalid poll received from Instapoll.');
    return {
      id: String(raw.id), name: String(raw.name || 'Instapoll'),
      prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
      type: raw.type, state: raw.state,
      finish: Number(raw.finish_timestamp) || null,
      released: String(raw.released_at || ''),
      choices: Array.isArray(raw.config_json?.choices)
        ? raw.config_json.choices.map(c => String(c.text ?? '')) : [],
      answer: String(raw.response?.response_text ?? ''),
      submitted: !!raw.response?.created_at,
    };
  }
  function open(poll, now = Date.now()) {
    return poll.state === 'sent' && (!poll.finish || poll.finish * 1000 > now);
  }
  function validate(poll, answer, now = Date.now()) {
    if (!open(poll, now)) throw new Error('This poll has closed. Refresh to see the latest polls.');
    if (!types.has(poll.type)) throw new Error('Please answer this poll type on the course page.');
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('Enter or select an answer first.');
    if (poll.type === 'multiplechoice' &&
        !poll.choices.some((_, i) => String(i) === answer)) throw new Error('Select one of the available choices.');
    if (poll.type === 'attendance' && answer !== 'present') throw new Error('Confirm attendance before submitting.');
    return { response_text: answer };
  }
  function revision(poll) {
    return JSON.stringify([poll.id, poll.released, poll.type, poll.prompt, poll.choices]);
  }
  return { normalize, open, validate, revision, supported: type => types.has(type) };
})();
