// Runs on https://polls.la.utexas.edu/course/<id>/...
// Its only job: tell the service worker "this course is open in a tab."
// The service worker does the actual realtime listening.

(function () {
  const m = location.pathname.match(/\/course\/(\d+)\b/);
  const courseId = m ? m[1] : null;
  if (!courseId) return;

  function arm() {
    chrome.runtime.sendMessage(
      { type: 'COURSE_ACTIVE', courseId, url: location.href },
      () => void chrome.runtime.lastError // ignore "receiving end" during SW spin-up
    );
  }

  arm();
  // Re-arm when the tab regains focus (cheap way to wake/re-register the SW).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') arm();
  });
})();
