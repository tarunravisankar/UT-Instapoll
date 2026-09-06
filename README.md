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
   node test/parse-test.mjs
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
| `content.js` | Reads the course ID from the tab URL and arms monitoring |
| `offscreen.html` / `offscreen.js` | Plays the alert chime (service workers can't) |
| `popup.html` / `popup.js` | Status view + test/reconnect buttons |
| `test/parse-test.mjs` | Offline test of parsing + dedup |
| `icons/` | Toolbar & notification icons |

**Permissions used:** `notifications`, `storage`, `alarms`, `offscreen`, and host
access to `polls.la.utexas.edu` and `pusher-ws.la.utexas.edu`. No `tabs`
permission — tab focusing uses the sender's own tab id.

## Answer polls from the extension

After updating the extension, reload it at chrome://extensions, then reload your
signed-in Instapoll student course tabs so the new content script is available.

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
