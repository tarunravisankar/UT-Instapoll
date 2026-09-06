// Plays a short, attention-grabbing chime using Web Audio.
// No audio file needed — the tone is synthesized, so nothing binary to ship.

let ctx = null;

function beep(startAt, freq, durationMs, gainPeak) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;

  const t = ctx.currentTime + startAt;
  const dur = durationMs / 1000;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(gainPeak, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

async function playAlert() {
  if (!ctx) ctx = new (self.AudioContext || self.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();

  // A rising three-note chime, played twice so it's hard to miss.
  const pattern = [
    [0.00, 880], [0.16, 1175], [0.32, 1568],
    [0.70, 880], [0.86, 1175], [1.02, 1568],
  ];
  for (const [at, f] of pattern) beep(at, f, 220, 0.25);
}

// Acknowledge the message. Without a response the worker's sendMessage rejects
// with "message port closed" even though the chime played, which makes a
// delivery failure indistinguishable from success and breaks any retry.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'PLAY_ALERT') return false;
  playAlert();
  sendResponse({ ok: true });
  return false;
});
