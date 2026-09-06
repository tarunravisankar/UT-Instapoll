// Requests run in the signed-in course tab so its normal session and CSRF
// protection apply. No credentials or student responses are stored.
(() => {
  // Reloading the extension does NOT detach this script: the previous copy stays
  // bound to the page with its listeners live but every chrome.* call dead, and
  // the worker then injects a fresh copy into the same isolated world. So retire
  // the old copy and take over. Refusing to start when one is present would hand
  // the page to a copy that can no longer reach the worker, which is exactly the
  // stranded-tab failure this script is supposed to prevent.
  try { globalThis.__instapollContent?.dispose?.(); } catch { /* already dead */ }

  // Instapoll routes client-side, so the course id is read at call time rather
  // than captured at injection time: a tab injected on /course/6609 and then
  // routed to /course/6609/student must keep answering for the current URL.
  const currentCourseId = () => location.pathname.match(/^\/course\/(\d+)\b/)?.[1] || null;
  const pending = new Set();
  let armed = null;
  let disposed = false;

  // An orphaned context reads chrome.runtime.id as undefined and throws
  // "Extension context invalidated" from every chrome.* call.
  function connected() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }
  function dispose() {
    disposed = true;
    document.removeEventListener('visibilitychange', onVisible);
    try { globalThis.navigation?.removeEventListener?.('navigate', onNavigate); } catch {}
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* context gone */ }
  }
  function arm() {
    const courseId = currentCourseId();
    if (disposed || !courseId) return;
    if (!connected()) { dispose(); return; }
    try {
      chrome.runtime.sendMessage({ type: 'COURSE_ACTIVE', courseId, url: location.href },
        () => void chrome.runtime.lastError);
      armed = courseId;
    } catch {
      // The extension reloaded under us. Stand down and let the fresh copy work.
      dispose();
    }
  }
  function onVisible() {
    if (document.visibilityState === 'visible') arm();
  }
  // Re-arm after client-side navigation so the worker never holds a stale course.
  function onNavigate() {
    setTimeout(() => { if (currentCourseId() !== armed) arm(); }, 0);
  }

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

  function onMessage(msg, sender, respond) {
    if (disposed || !msg || sender.id !== chrome.runtime.id || sender.tab ||
        !['GET_POLLS', 'SUBMIT_POLL', 'PING'].includes(msg.type)) return;
    const courseId = currentCourseId();
    if (msg.type === 'PING') { respond({ ok: true, courseId }); return; }
    if (msg.courseId !== courseId || !/^\/course\/\d+\/student\/?$/.test(location.pathname)) {
      respond({ ok: false, error: 'Open the student course page to answer polls.' });
      return;
    }
    const base = '/api/v1/student/course/' + courseId + '/poll';
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
    })().then(reply, error => reply({ ok: false, error: error.message }));
    return true;

    // The popup can close, and the extension can reload, while a request is in
    // flight. Responding into a closed port throws; it is not worth surfacing.
    function reply(value) {
      try { respond(value); } catch { /* nobody is listening any more */ }
    }
  }

  document.addEventListener('visibilitychange', onVisible);
  try { globalThis.navigation?.addEventListener?.('navigate', onNavigate); } catch {}
  chrome.runtime.onMessage.addListener(onMessage);
  globalThis.__instapollContent = { dispose };
  arm();
})();
