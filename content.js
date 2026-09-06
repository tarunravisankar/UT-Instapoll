// Requests run in the signed-in course tab so its normal session and CSRF
// protection apply. No credentials or student responses are stored.
(() => {
  const match = location.pathname.match(/^\/course\/(\d+)\b/);
  if (!match) return;
  const courseId = match[1];
  const base = '/api/v1/student/course/' + courseId + '/poll';
  const pending = new Set();
  function arm() {
    chrome.runtime.sendMessage({ type: 'COURSE_ACTIVE', courseId, url: location.href },
      () => void chrome.runtime.lastError);
  }
  arm();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') arm();
  });

  async function request(path, body) {
    const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    if (body) {
      const token = document.querySelector('meta[name="csrf-token"]')?.content;
      if (!token) throw new Error('Reload the Instapoll course page to renew your session.');
      headers['X-CSRF-TOKEN'] = token;
      headers['Content-Type'] = 'application/json';
    }
    let response;
    try {
      response = await fetch(path, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', headers,
        cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(15000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(body
        ? 'Submission could not be confirmed. Check the course page before trying again.'
        : 'Could not reach Instapoll. Check your connection and course tab.');
    }
    if ([401, 403, 419].includes(response.status)) {
      throw new Error('Your session expired or access is restricted. Open the course page to continue.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(
      typeof data?.message === 'string' ? data.message : 'Instapoll rejected the request. Refresh and try again.');
    if (!data) throw new Error('Unexpected response. Open the course page and sign in again.');
    return data;
  }

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab ||
        !['GET_POLLS', 'SUBMIT_POLL'].includes(msg.type)) return;
    if (msg.courseId !== courseId || !/^\/course\/\d+\/student\/?$/.test(location.pathname)) {
      respond({ ok: false, error: 'Open the student course page to answer polls.' });
      return;
    }
    (async () => {
      if (msg.type === 'GET_POLLS') {
        const data = await request(base);
        if (!Array.isArray(data)) throw new Error('Unexpected poll list. Open the course page.');
        return { ok: true, polls: data.map(Instapoll.normalize) };
      }
      if (!/^\d+$/.test(String(msg.pollId))) throw new Error('Invalid poll.');
      const id = String(msg.pollId);
      if (pending.has(id)) throw new Error('This answer is already being submitted.');
      pending.add(id);
      try {
        const current = Instapoll.normalize(await request(base + '/' + id));
        if (current.id !== id || Instapoll.revision(current) !== msg.revision) {
          throw new Error('This question changed. Refresh before answering.');
        }
        const body = Instapoll.validate(current, msg.answer);
        const saved = Instapoll.normalize(await request(base + '/' + id + '/response', body));
        if (saved.id !== id || !saved.submitted || saved.answer !== msg.answer) {
          throw new Error('Submission could not be confirmed. Check the course page before trying again.');
        }
        return { ok: true, poll: saved };
      } finally { pending.delete(id); }
    })().then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  });
})();
