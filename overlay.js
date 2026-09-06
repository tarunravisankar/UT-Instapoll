// In-page poll card.
//
// The extension's action popup cannot be used for this: Chrome closes a popup
// the moment it loses focus, so clicking anywhere on the page would dismiss it.
// A node in the page survives clicks, scrolling and client-side navigation, and
// closes only when the reader closes it.
//
// Everything lives inside a shadow root so the Instapoll page's stylesheet
// cannot reach in and ours cannot leak out.
globalThis.InstapollOverlay = (() => {
  const HOST_ID = 'ut-instapoll-notifier-overlay';

  const CSS = `
:host { all: initial; }
.card {
  position: fixed; top: 16px; right: 16px; z-index: 2147483647;
  width: 380px; max-width: calc(100vw - 32px); max-height: 80vh;
  display: flex; flex-direction: column;
  background: #fff; color: #222; border: 1px solid #ddd;
  border-top: 4px solid #bf5700; border-radius: 12px;
  box-shadow: 0 12px 34px rgba(0,0,0,.22);
  font: 13px/1.5 system-ui, sans-serif;
}
.head { display: flex; align-items: flex-start; gap: 8px; padding: 12px 12px 0; }
.title { flex: 1; min-width: 0; }
h2 { font-size: 15px; margin: 0; overflow-wrap: anywhere; }
.meta { color: #666; font-size: 11px; margin: 3px 0 0; }
.close {
  flex-shrink: 0; width: 26px; height: 26px; padding: 0; cursor: pointer;
  border: 1px solid #ddd; border-radius: 6px; background: #fafafa;
  color: #444; font: 600 15px/1 system-ui, sans-serif;
}
.body { padding: 10px 12px 12px; overflow-y: auto; }
.prompt { overflow-wrap: anywhere; margin: 8px 0; }
.prompt img { max-width: 100%; height: auto; }
.prompt pre { white-space: pre-wrap; }
.prompt table { max-width: 100%; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
legend { font-weight: 600; margin-bottom: 6px; }
.choice {
  display: flex; align-items: flex-start; gap: 8px; padding: 8px; margin: 5px 0;
  background: #f7f7f7; border-radius: 6px; overflow-wrap: anywhere; cursor: pointer;
}
.choice input { flex-shrink: 0; margin-top: 3px; }
textarea {
  width: 100%; padding: 8px; font: inherit; min-height: 84px; resize: vertical;
  border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box;
}
button.primary {
  width: 100%; margin-top: 10px; padding: 9px 10px; cursor: pointer;
  border: 1px solid #bf5700; border-radius: 7px;
  background: #bf5700; color: #fff; font: 600 12px system-ui, sans-serif;
}
button:disabled { opacity: .55; cursor: default; }
:focus-visible { outline: 2px solid #bf5700; outline-offset: 2px; }
.feedback { margin: 8px 0 0; font-size: 12px; overflow-wrap: anywhere; }
.error { color: #b42318; }
.success { color: #1a7f37; }
@media (prefers-color-scheme: dark) {
  .card { background: #1f1f1f; color: #eee; border-color: #3a3a3a; }
  .meta { color: #aaa; }
  .close { background: #2a2a2a; border-color: #3a3a3a; color: #ddd; }
  .choice { background: #2a2a2a; }
  textarea { background: #2a2a2a; color: #eee; border-color: #3a3a3a; }
}
`;

  // A copy from a previous injection may still be on the page.
  function removeExisting() {
    for (const node of document.querySelectorAll('#' + HOST_ID)) node.remove();
  }

  let host = null;
  let onClose = null;

  function close() {
    removeExisting();
    host = null;
    const notify = onClose;
    onClose = null;
    if (notify) notify();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && host) { close(); event.stopPropagation(); }
  }

  // poll: a normalised poll from poll-model.js
  // handlers.submit(answer) -> Promise resolving to the saved poll
  function show(poll, handlers = {}) {
    removeExisting();
    onClose = handlers.onClose || null;

    host = document.createElement('div');
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;

    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Instapoll question');

    const head = document.createElement('div');
    head.className = 'head';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'title';
    const h2 = document.createElement('h2');
    h2.textContent = poll.name || 'Instapoll';
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = poll.finish
      ? 'Open · Ends ' + new Date(poll.finish * 1000)
        .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : 'Open';
    titleWrap.append(h2, meta);

    const closeButton = document.createElement('button');
    closeButton.className = 'close';
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.title = 'Close (Esc)';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.addEventListener('click', close);
    head.append(titleWrap, closeButton);

    const body = document.createElement('div');
    body.className = 'body';
    const prompt = document.createElement('div');
    prompt.className = 'prompt';
    if (poll.prompt) prompt.append(Instapoll.promptFragment(poll.prompt));
    else prompt.textContent = 'No question prompt was shared. Refer to your instructor’s display.';
    body.append(prompt);

    const supported = Instapoll.supported(poll.type);
    const fieldset = document.createElement('fieldset');
    const inputs = [];

    if (poll.type === 'multiplechoice') {
      const legend = document.createElement('legend');
      legend.textContent = 'Select one answer';
      fieldset.append(legend);
      poll.choices.forEach((text, index) => {
        const label = document.createElement('label');
        label.className = 'choice';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'instapoll-answer';
        input.value = String(index);
        input.checked = poll.answer === String(index);
        const span = document.createElement('span');
        span.textContent = text;
        inputs.push(input);
        label.append(input, span);
        fieldset.append(label);
      });
    } else if (poll.type === 'textentry') {
      // Open ended: the question and a box, no choices to list.
      const legend = document.createElement('legend');
      legend.textContent = 'Your answer';
      const input = document.createElement('textarea');
      input.setAttribute('aria-label', 'Your answer');
      input.value = poll.answer || '';
      inputs.push(input);
      fieldset.append(legend, input);
    } else if (poll.type === 'attendance') {
      const legend = document.createElement('legend');
      legend.textContent = 'Attendance';
      const label = document.createElement('label');
      label.className = 'choice';
      const input = document.createElement('input');
      input.type = 'checkbox';
      const span = document.createElement('span');
      span.textContent = 'I certify that I am present in class and following my '
        + 'instructor’s attendance policy.';
      inputs.push(input);
      label.append(input, span);
      fieldset.append(legend, label);
    } else {
      const note = document.createElement('p');
      note.textContent = 'Answer this poll type on the course page.';
      fieldset.append(note);
    }

    const submit = document.createElement('button');
    submit.className = 'primary';
    submit.type = 'button';
    submit.textContent = poll.submitted ? 'Update answer' : 'Submit answer';
    submit.disabled = !supported;

    const feedback = document.createElement('p');
    feedback.className = 'feedback';
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');

    function readAnswer() {
      if (poll.type === 'multiplechoice') return inputs.find(i => i.checked)?.value || '';
      if (poll.type === 'attendance') return inputs[0].checked ? 'present' : '';
      return inputs[0]?.value || '';
    }

    let busy = false;
    submit.addEventListener('click', async () => {
      if (busy || !handlers.submit) return;
      const answer = readAnswer();
      try { Instapoll.validate(poll, answer); }
      catch (error) {
        feedback.textContent = error.message;
        feedback.className = 'feedback error';
        return;
      }
      busy = true;
      submit.disabled = true;
      submit.textContent = 'Submitting…';
      feedback.textContent = '';
      feedback.className = 'feedback';
      try {
        const saved = await handlers.submit(answer);
        poll = saved || poll;
        feedback.textContent = 'Answer submitted successfully.';
        feedback.className = 'feedback success';
        submit.textContent = 'Update answer';
      } catch (error) {
        feedback.textContent = error.message
          || 'Submission could not be confirmed. Check the course page.';
        feedback.className = 'feedback error';
        submit.textContent = 'Submit answer';
      } finally {
        busy = false;
        submit.disabled = !supported;
      }
    });

    body.append(fieldset, submit, feedback);
    card.append(head, body);
    root.append(style, card);
    // documentElement, not body: this must survive a page that rewrites <body>.
    document.documentElement.append(host);
    document.addEventListener('keydown', onKeyDown, true);
    return { close };
  }

  function destroy() {
    document.removeEventListener('keydown', onKeyDown, true);
    onClose = null;
    removeExisting();
    host = null;
  }

  removeExisting();
  return { show, close, destroy, isOpen: () => !!host, HOST_ID };
})();
