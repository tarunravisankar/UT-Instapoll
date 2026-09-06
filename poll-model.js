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
  // Rebuild a small allowlist of markup; never insert remote HTML directly.
  // Keep question images and basic formatting; TeX is displayed as source text.
  // Shared so the popup and the in-page overlay render prompts identically.
  function promptFragment(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const allowed = new Set(['P','BR','STRONG','B','EM','I','U','SUB','SUP','UL','OL','LI',
      'BLOCKQUOTE','PRE','CODE','TABLE','TBODY','TR','TH','TD','DIV','SPAN']);
    const dropped = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','INPUT','BUTTON','SVG','MATH']);
    function copy(node, parent) {
      if (node.nodeType === Node.TEXT_NODE) { parent.append(document.createTextNode(node.textContent)); return; }
      if (node.nodeType !== Node.ELEMENT_NODE || dropped.has(node.tagName)) return;
      if (node.tagName === 'IMG') {
        try {
          const url = new URL(node.getAttribute('src'), 'https://polls.la.utexas.edu');
          if (url.protocol !== 'https:') return;
          const img = document.createElement('img');
          img.src = url.href; img.alt = node.getAttribute('alt') || 'Question image';
          img.referrerPolicy = 'no-referrer';
          parent.append(img);
        } catch {}
        return;
      }
      const target = allowed.has(node.tagName) ? document.createElement(node.tagName.toLowerCase()) : parent;
      if (target !== parent) parent.append(target);
      for (const child of node.childNodes) copy(child, target);
    }
    const fragment = document.createDocumentFragment();
    for (const child of doc.body.childNodes) copy(child, fragment);
    return fragment;
  }
  return { normalize, open, validate, revision, promptFragment, supported: type => types.has(type) };
})();
