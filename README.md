# UT Instapoll Notifier

A Chrome (Manifest V3) extension that alerts you the instant a poll is released
on a UT Austin Instapoll course page — with a desktop notification **and** a
sound — even when the Instapoll tab is in the background and you're working in
another tab. Clicking the notification jumps you to the course tab so you can
answer.

Open the toolbar popup to view active poll questions and submit your own answers. It supports multiple choice, text entry, and attendance. Answers are sent only when you click **Submit answer** (or **Update answer**).

---

## How it works (and why this design)

Instapoll course pages talk to a Pusher/WebSocket server and subscribe to a
public per-course channel, `polls_course_<id>`. When the instructor releases a
poll, the server pushes an event:

```
{"event":"poll_released","channel":"polls_course_6609","data":"{\"poll\":{\"id\":229271}}"}
```

The obvious approach is to "sniff" the page's own WebSocket. **We deliberately
don't do that**, because Chrome throttles JavaScript timers in background tabs.
That throttling can slow the page's Pusher heartbeat enough that the server
silently drops the connection after a few minutes — and the reconnect timer is
throttled too. In other words, the naive approach is most likely to fail in
*exactly* the situation you care about: the tab sitting in the background during
class.

Instead, the **service worker opens its own WebSocket** to the same public
Pusher endpoint and subscribes to each open course's channel. Service-worker
timers are not throttled like background-tab timers, and a 20-second keepalive
ping keeps both the Pusher connection and the service worker alive (supported in
Chrome 116+). This is still true realtime — not page polling.

An open course tab is what "arms" a course: the content script reads the course
ID from the URL and registers it. After that you can switch tabs, minimize the
window, whatever — alerts come from the service worker regardless of focus.

```
polls.la.utexas.edu/course/6609/…   ──content.js──►  service worker
   (tab, any focus state)              "course 6609 is open"   │
                                                               │ owns ONE WebSocket to
                                                               ▼ wss://pusher-ws.la.utexas.edu
                                              subscribe polls_course_6609 (+ any other open courses)
                                                               │
                                            poll_released ──────┤ parse id, dedup,
                                                               ▼ notify + chime, click→focus tab
```

**Multiple courses:** open several course tabs and each channel is added to the
same connection. **Duplicates:** every poll is remembered by `courseId:pollId`
in storage, so page reloads, reconnects, sleep/wake, or two tabs of the same
course never double-alert.

---

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `ut-instapoll-notifier` folder.
4. (First run) Chrome may ask to allow notifications — accept.
5. Open your Instapoll course page, e.g. `https://polls.la.utexas.edu/course/6609/student#`.
6. Click the extension's toolbar icon. You should see **Connected — listening**
   and your course listed. The toolbar badge shows a green ● when the realtime
   connection is live.

Requires Chrome 116 or newer.

> **Sound note:** the chime is synthesized in an offscreen document, so it plays
> even if the course tab is muted/backgrounded. If you never hear it, check that
> Chrome itself isn't muted at the OS level.

## What happens when a poll drops

You do not need to be on the Instapoll tab — the WebSocket lives in the service
worker, not the page, so all of this fires from any tab, any window:

1. **The chime plays** immediately, from the offscreen document.
2. **A desktop notification appears** with two actions — *Answer here* opens the
   extension popup, *Open course page* focuses (or reopens) the course tab.
   Clicking the notification body does the same as *Open course page*.
3. **The question text is filled into the notification** a moment later. The
   worker has no Instapoll session of its own, so it asks a course tab to fetch
   the poll. This is deliberately *after* the alert — the alert is never delayed
   by a network round trip, and a poll with no reachable tab still alerts, just
   with the generic "a poll is open" wording.
4. **A card opens on the course page** with the question and, for multiple
   choice, the answer choices — for an open-ended poll, just the question and a
   text box. It stays put while you click around, scroll, or let the page route
   itself, and closes on its ✕ button or Escape. A poll you close stays closed.
5. **The popup opens by itself** if Chrome already has focus, showing the same
   question and answer form. This is best effort: `chrome.action.openPopup()`
   needs a focused Chrome window and Chrome 127+. When it can't run, the
   notification and the in-page card are still there.

> **Why a card in the page and not just the popup?** Chrome closes an action
> popup the instant it loses focus — clicking anything on the page dismisses it,
> and that is enforced by the browser, not by this extension. A node in the page
> is the only kind of panel that can survive a click. It lives in a shadow root
> so Instapoll's stylesheet cannot reach in and ours cannot leak out.

> **macOS note:** Chrome hands notifications to the system Notification Center,
> which does not honour `requireInteraction` — the banner auto-dismisses into
> Notification Center instead of staying on screen, and the two action buttons
> only appear when you expand the banner. The chime and the auto-opened popup
> are the reliable signals there.

---

## Testing without waiting for a professor

You have three independent checks:

1. **Is the realtime pipe alive?** Open the popup. **Connected — listening**
   means the extension completed the real Pusher handshake and channel
   subscription against UT's server. If it says *Connecting…* or *Disconnected*,
   click **Reconnect**.

2. **Does the alert fire?** Click **Send test alert** in the popup. This runs the
   full notify path — desktop notification, chime, and click-to-focus — using a
   fake poll. Click the notification; it should focus your course tab.

3. **Does frame parsing + dedup work?** Run the offline unit test against the
   real captured event:
   ```
   for f in test/*.mjs; do node "$f"; done
   ```
   It asserts that the captured frame yields course `6609` / poll `229271`, that
   a repeat is rejected, and that distinct polls/courses are kept separate.

Between #1 (real connection) and #2 (real notification), the only thing not
exercised live is an actual inbound `poll_released` — which #3 covers offline.

---

## Reliability — honest caveats

- **In-class, laptop awake, tab backgrounded:** this is the target case and it's
  reliable. Keepalive holds the connection open; alerts fire regardless of which
  tab is focused.
- **Laptop sleeps:** the WebSocket drops during sleep. A 1-minute watchdog alarm
  re-establishes it on wake. A poll released in the first few seconds after wake
  (before reconnect finishes) could be missed — but you're not mid-class while
  the lid is shut.
- **This uses an internal UT realtime endpoint** with a public channel and empty
  auth (as observed). If UT ever changes the endpoint, channel naming, or starts
  requiring auth on that channel, the connection would need updating.
- **Not a phone push service.** This is laptop-only by design (the MVP). Phone
  push would require a hosted relay and is out of scope here.

---

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, minimal permissions |
| `background.js` | Service worker: owns the WebSocket, dedup, notifications, click-to-focus, watchdog |
| `content.js` | Arms monitoring, and fetches/submits polls from the signed-in tab |
| `overlay.js` | The in-page poll card (shadow DOM), shown when a poll is released |
| `offscreen.html` / `offscreen.js` | Plays the alert chime (service workers can't) |
| `popup.html` / `popup.js` | Status view + test/reconnect buttons |
| `poll-model.js` | Shared poll parsing/validation used by the popup and content script |
| `test/parse-test.mjs` | Offline test of parsing + dedup |
| `test/poll-api-test.mjs` | Content-script request/validation tests |
| `test/popup-test.mjs` | Popup rendering and submit-flow tests |
| `test/recovery-test.mjs` | Orphaned-tab repair, re-injection guard, no submit replay |
| `test/alert-test.mjs` | Runs the real worker: chime, notification, question text, buttons |
| `test/overlay-test.mjs` | The in-page card: choices, open ended, survives clicks, close, submit |
| `icons/` | Toolbar & notification icons |

**Permissions used:** `notifications`, `storage`, `alarms`, `offscreen`,
`scripting`, and host access to `polls.la.utexas.edu` and
`pusher-ws.la.utexas.edu`. No `tabs` permission — tab focusing uses the sender's
own tab id, and `scripting` is scoped to the two hosts above.

## Answer polls from the extension

Reload the extension at chrome://extensions and it repairs itself: the service
worker re-injects the content script into course tabs that were already open.

Chrome injects a manifest content script only when a page loads, so installing,
updating or reloading the extension leaves every open course tab without one.
That used to strand the popup on *"Reload your signed-in Instapoll course tab,
then refresh polls"* — the tab was still visible to `tabs.query` and the status
dot still read green from stored state, but no message could reach it. The
worker now re-injects on install, startup and tab load, and the popup asks it to
repair a silent tab before giving up.

Reloading the extension does not detach the old content script either. The
previous copy stays bound to the page with its listeners live and every
`chrome.*` call dead, so it threw *"Extension context invalidated"* into the
page on the next tab switch. A fresh copy is injected into the same isolated
world, so `content.js` now hands over explicitly: the incoming copy calls
`dispose()` on the outgoing one, which detaches its listeners, and any orphaned
copy stands down on its own the first time it notices the context is gone.
Exactly one live listener per frame, and a dead copy can never keep the tab.

Injecting a fresh copy does not silence an old one, and a copy from before that
handover left no handle to retire it by — it just keeps throwing on every tab
switch for as long as the page lives. So the worker reloads open course tabs on
**install/update only**, which is the one moment a stale script is guaranteed to
be sitting in them. It never reloads a page on a worker restart or browser
start.

1. Open your course through Canvas and keep the student course tab open.
2. Click the extension icon and select your course.
3. Read the question, select or type your answer, then click **Submit answer**.
4. Wait for **Answer submitted successfully.** You can update an answer while
   the poll remains open. Attendance requires explicitly confirming that you are
   present and following your instructor's attendance policy.

The popup refreshes active polls every five seconds while open. Refreshes preserve
your draft unless the question changes. Drafts are discarded when you close the
popup or switch courses. If submission cannot be confirmed, check the course page
before trying again; the extension never automatically retries a submission.

Requests use the signed-in tab's session and CSRF token. No new permissions are
required and answers are not saved in extension storage. Closed/recalled polls,
changed questions, invalid answers, expired sessions, and server errors are handled.
Instructor-hidden prompts remain hidden. Basic prompt formatting and HTTPS images
are supported; math markup is displayed as source text, so use **Open course page**
for full MathJax rendering. Existing desktop notifications still open the course tab.

### API verification and tests

The adapter follows UT's publicly served student client:
https://polls.la.utexas.edu/build/manifest.json
(student entry inspected September 6, 2026). It uses these same-origin endpoints:

- GET /api/v1/student/course/{courseId}/poll
- GET /api/v1/student/course/{courseId}/poll/{pollId}
- POST /api/v1/student/course/{courseId}/poll/{pollId}/response

Responses use response_text: a zero-based choice index as a string, free text,
or "present" for attendance. Only a matching saved server response is shown as
success. The server remains authoritative for course access and poll availability.

Run the offline checks:

    node test/parse-test.mjs
    node test/poll-api-test.mjs
    node test/popup-test.mjs

The API test executes the actual content script with mocked Chrome and fetch APIs;
it does not contact UT or submit live answers. Live verification still requires a
signed-in course and an active poll. Check each answer type, updating an answer,
closing/recalling a poll, multiple courses, expired login, and loss of connectivity.

New files: poll-model.js (shared validation) and popup.css (popup styling).
content.js now handles authenticated poll loading/submission as well as arming alerts.
