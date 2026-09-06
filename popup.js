const $ = id => document.getElementById(id);
let courses = new Map();
let cards = new Map();
let generation = 0;
let loading = false;
let submitting = false;

function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function message(text, error = false) {
  $('message').textContent = text;
  $('message').className = error ? 'error' : '';
}
// Prompt sanitising lives in poll-model.js so the popup and the in-page
// overlay render the same markup through the same allowlist.
const promptFragment = html => Instapoll.promptFragment(html);
async function status() {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (!st) return;
    $('dot').className = 'dot ' + (st.wsState === 'connected' ? 'on' : !st.monitoring ? 'off' : '');
    $('statusLabel').textContent = !st.monitoring ? 'Open a course tab to enable alerts'
      : st.wsState === 'connected' ? 'Connected \u2014 listening for polls' : 'Reconnecting alerts\u2026';
  } catch { $('statusLabel').textContent = 'Alerts unavailable. Reload the extension.'; }
}
async function discover() {
  const tabs = await chrome.tabs.query({ url: '*://polls.la.utexas.edu/course/*' });
  const next = new Map();
  for (const tab of tabs) {
    const match = new URL(tab.url).pathname.match(/^\/course\/(\d+)\/student\/?$/);
    if (!match) continue;
    if (!next.has(match[1])) next.set(match[1], []);
    next.get(match[1]).push(tab);
  }
  const previous = $('course').value;
  courses = next;
  $('course').replaceChildren();
  for (const [id] of courses) {
    const option = element('option', 'Course ' + id);
    option.value = id; $('course').append(option);
  }
  if (courses.has(previous)) $('course').value = previous;
  const empty = courses.size === 0;
  $('course').disabled = empty;
  $('open').disabled = empty;
  if (previous !== $('course').value) {
    generation++;
    cards.clear(); $('polls').replaceChildren();
  }
}
// Ask the service worker to re-inject the content script into a tab that has
// stopped answering. Manifest content scripts only load with the page, so a tab
// that was already open when the extension installed, updated or reloaded has
// none, and every message to it fails until the tab is reloaded by hand.
async function heal(tabId) {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT', tabId });
    return !!(result && result.ok);
  } catch { return false; }
}
async function sendToCourse(courseId, payload, preferredTab) {
  const tabs = courses.get(courseId) || [];
  if (preferredTab !== undefined) {
    // Never retry a POST in another tab: it could already have been accepted.
    return chrome.tabs.sendMessage(preferredTab, { ...payload, courseId });
  }
  for (const tab of tabs) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { ...payload, courseId });
      if (result) return { ...result, tabId: tab.id };
    } catch {}
  }
  // Only reads are retried. A write that went unanswered may still have been
  // accepted by Instapoll, so it must never be replayed automatically.
  if (payload.type === 'GET_POLLS') {
    for (const tab of tabs) {
      if (!await heal(tab.id)) continue;
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { ...payload, courseId });
        if (result) return { ...result, tabId: tab.id };
      } catch {}
    }
  }
  throw new Error('Reload your signed-in Instapoll course tab, then refresh polls.');
}
function updateCard(card, poll) {
  card.poll = poll;
  const isOpen = Instapoll.open(poll);
  const supported = Instapoll.supported(poll.type);
  let info = isOpen ? 'Open' : 'Closed';
  if (poll.submitted) info += ' \u00b7 Answer submitted';
  if (isOpen && poll.finish) info += ' \u00b7 Ends ' + new Date(poll.finish * 1000).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  card.meta.textContent = info;
  card.fieldset.disabled = !isOpen || !supported || card.busy;
  card.button.disabled = !isOpen || !supported || card.busy;
  card.button.textContent = card.busy ? 'Submitting\u2026' : poll.submitted ? 'Update answer' : 'Submit answer';
}
function makeCard(poll, courseId, tabId) {
  const article = element('article', undefined, 'poll');
  article.append(element('h2', poll.name));
  const meta = element('p', '', 'meta');
  const prompt = element('div', undefined, 'prompt');
  if (poll.prompt) prompt.append(promptFragment(poll.prompt));
  else prompt.textContent = 'No question prompt was shared. Refer to your instructor\u2019s display.';
  const form = element('form');
  const fieldset = element('fieldset');
  fieldset.append(element('legend', poll.type === 'multiplechoice' ? 'Select one answer' : 'Your answer'));
  const inputs = [];
  if (poll.type === 'multiplechoice') {
    poll.choices.forEach((text, index) => {
      const label = element('label', undefined, 'choice');
      const input = element('input');
      input.type = 'radio'; input.name = 'answer-' + poll.id; input.value = String(index);
      input.required = true; input.checked = poll.answer === String(index);
      inputs.push(input); label.append(input, element('span', text)); fieldset.append(label);
    });
  } else if (poll.type === 'textentry') {
    const input = element('textarea');
    input.setAttribute('aria-label', 'Your answer'); input.required = true; input.value = poll.answer;
    inputs.push(input); fieldset.append(input);
  } else if (poll.type === 'attendance') {
    const label = element('label', undefined, 'choice');
    const input = element('input'); input.type = 'checkbox'; input.required = true;
    inputs.push(input);
    label.append(input, element('span', 'I certify that I am present in class and following my instructor\u2019s attendance policy.'));
    fieldset.append(label);
  } else {
    fieldset.append(element('p', 'Answer this poll type on the course page.'));
  }
  const button = element('button', 'Submit answer', 'primary'); button.type = 'submit';
  const feedback = element('p', '', 'feedback'); feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  form.append(fieldset, button, feedback);
  article.append(meta, prompt, form);
  const card = { article, meta, fieldset, button, feedback, poll, busy:false,
    revision:Instapoll.revision(poll), tabId };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (card.busy || submitting) return;
    let answer = poll.type === 'multiplechoice' ? inputs.find(input => input.checked)?.value
      : poll.type === 'attendance' ? (inputs[0].checked ? 'present' : '') : inputs[0]?.value;
    try { Instapoll.validate(card.poll, answer); }
    catch (error) { feedback.textContent = error.message; feedback.className = 'feedback error'; return; }
    card.busy = true; submitting = true;
    $('course').disabled = true; $('refresh').disabled = true;
    updateCard(card, card.poll); feedback.textContent = ''; feedback.className = 'feedback';
    try {
      const result = await sendToCourse(courseId, {
        type:'SUBMIT_POLL', pollId:card.poll.id, revision:card.revision, answer,
      }, card.tabId);
      if (!result?.ok) throw new Error(result?.error || 'Submission could not be confirmed. Check the course page.');
      card.poll = result.poll;
      feedback.textContent = 'Answer submitted successfully.';
      feedback.className = 'feedback success';
    } catch (error) {
      feedback.textContent = error.message || 'Submission could not be confirmed. Check the course page.';
      feedback.className = 'feedback error';
    } finally {
      card.busy = false; submitting = false;
      $('course').disabled = courses.size === 0; $('refresh').disabled = false;
      updateCard(card, card.poll);
    }
  });
  updateCard(card, poll);
  return card;
}
async function refresh() {
  if (loading || submitting) return;
  loading = true; $('refresh').disabled = true;
  try {
    await discover();
    const courseId = $('course').value;
    if (!courseId) { message('Open Instapoll through Canvas and keep the student course tab open.'); return; }
    const version = generation;
    if (!cards.size) message('Loading polls\u2026');
    const result = await sendToCourse(courseId, { type:'GET_POLLS' });
    if (version !== generation || submitting) return;
    if (!result.ok) throw new Error(result.error);
    const polls = result.polls.filter(p => p.state === 'sent');
    const ids = new Set(polls.map(p => p.id));
    for (const [id, card] of cards) {
      if (!ids.has(id)) { card.article.remove(); cards.delete(id); }
    }
    for (const poll of polls) {
      let card = cards.get(poll.id);
      if (!card || card.revision !== Instapoll.revision(poll)) {
        const replacement = makeCard(poll, courseId, result.tabId);
        if (card) card.article.replaceWith(replacement.article);
        else $('polls').append(replacement.article);
        cards.set(poll.id, replacement);
      } else {
        card.tabId = result.tabId;
        updateCard(card, poll);
      }
    }
    message(polls.length ? 'Choose an answer below, then submit.' : 'No active polls. New polls appear here automatically.');
  } catch (error) {
    message(error.message, true);
    // Keep drafts, but block submission until the current state is loaded again.
    for (const card of cards.values()) { card.fieldset.disabled = true; card.button.disabled = true; }
  } finally { loading = false; $('refresh').disabled = false; }
}
$('course').addEventListener('change', () => {
  generation++; cards.clear(); $('polls').replaceChildren(); refresh();
});
$('refresh').addEventListener('click', refresh);
$('open').addEventListener('click', async () => {
  const tab = courses.get($('course').value)?.[0];
  if (!tab) return;
  try {
    await chrome.tabs.update(tab.id, { active:true });
    await chrome.windows.update(tab.windowId, { focused:true });
  } catch { message('The course tab closed. Open it through Canvas again.', true); }
});
$('test').addEventListener('click', () =>
  chrome.runtime.sendMessage({ type:'TEST_ALERT', courseId:$('course').value }).catch(() => message('Could not send a test alert.', true)));
$('reconnect').addEventListener('click', () =>
  chrome.runtime.sendMessage({ type:'RECONNECT_NOW' }).then(status).catch(() => message('Could not reconnect.', true)));
status(); refresh();
setInterval(status, 1000);
setInterval(refresh, 5000);
