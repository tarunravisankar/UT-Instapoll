const $ = (id) => document.getElementById(id);

function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function render(st) {
  const dot = $('dot');
  const label = $('statusLabel');
  const detail = $('statusDetail');

  dot.className = 'dot';
  if (!st.monitoring) {
    dot.classList.add('off');
    label.textContent = 'Idle';
    detail.textContent = 'no course armed';
  } else if (st.wsState === 'connected') {
    dot.classList.add('on');
    label.textContent = 'Connected — listening';
    detail.textContent = `since ${ago(st.lastConnectedAt)}`;
  } else if (st.wsState === 'connecting') {
    dot.classList.add('warn');
    label.textContent = 'Connecting…';
    detail.textContent = '';
  } else {
    dot.classList.add('off');
    label.textContent = 'Disconnected';
    detail.textContent = 'retrying…';
  }

  const wrap = $('courses');
  wrap.innerHTML = '';
  $('empty').hidden = st.courses.length > 0;

  for (const c of st.courses) {
    const el = document.createElement('div');
    el.className = 'course';
    el.innerHTML =
      `<div class="cid">Course ${c.courseId}</div>` +
      `<div class="meta">channel ${c.channel} · ${c.tabs} tab(s) · ${c.seenCount} poll(s) seen</div>`;
    wrap.appendChild(el);
  }
}

async function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (st) => {
    if (chrome.runtime.lastError || !st) return;
    render(st);
  });
}

$('test').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'TEST_ALERT' }, () => void chrome.runtime.lastError);
});
$('reconnect').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RECONNECT_NOW' }, () => void chrome.runtime.lastError);
  setTimeout(refresh, 400);
});

refresh();
setInterval(refresh, 1000);
