// backroad console — the control surface.
//
// Runs in two places, same file:
//   in Chrome on the phone  -> chat + approvals, no hands
//   inside the backroad APK -> chat + approvals + hands (window.Android)
//
// The brain is not here. Commands arrive over the relay; this page executes them
// against the page the browser is showing and reports what it saw.

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const logEl = $("#log");
const hintEl = $("#hint");
const cmdEl = $("#cmd");
const chipEl = $("#chip");
const micEl = $("#btnMic");

const NATIVE = typeof window.Android !== "undefined" && window.Android && typeof window.Android.call === "function";

const CFG_KEY = "backroad.cfg.v1";
const state = {
  ws: null,
  tries: 0,
  retryAt: 0,
  queue: [],
  asks: new Map(),      // id -> { node, timer, seconds }
  lastSeen: "",         // "url|title" to avoid repeating an identical observation
  watchTimer: null,
};

/* ------------------------------------------------------------------ config */

function loadCfg() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveCfg(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}
let cfg = loadCfg();

/* ------------------------------------------------------------- transcript */

function add(node) {
  hintEl?.remove();
  logEl.appendChild(node);
  logEl.scrollTop = logEl.scrollHeight;
  return node;
}

function say(who, text) {
  return add(el("div", "msg " + who, text));
}

function note(text) {
  return add(el("div", "msg sys", text));
}

function act(method, ok, detail) {
  const n = el("div", "act");
  n.dataset.ok = ok ? "1" : "0";
  const b = el("b", null, (ok ? "✓ " : "✗ ") + method);
  n.appendChild(b);
  if (detail) n.appendChild(document.createTextNode("  " + detail));
  return add(n);
}

/* ------------------------------------------------------------ the socket */

function setChip(text, stateName) {
  chipEl.textContent = text;
  chipEl.dataset.state = stateName;
}

function connect() {
  if (!cfg.url) {
    setChip("no relay", "off");
    note("Set the relay address in ⚙ to go live.");
    return;
  }
  disconnect(false);
  let ws;
  try {
    const u = new URL(cfg.url);
    if (cfg.room) u.searchParams.set("room", cfg.room);
    if (cfg.token) u.searchParams.set("token", cfg.token);
    u.searchParams.set("role", "phone");
    ws = new WebSocket(u.toString());
  } catch (e) {
    setChip("bad url", "bad");
    note("That relay address will not open: " + e.message);
    return;
  }

  state.ws = ws;
  setChip("connecting", "off");

  ws.onopen = () => {
    state.tries = 0;
    setChip("live", "on");
    send({ type: "hello", role: "phone", hands: NATIVE, ua: navigator.userAgent });
    flush();
    watch(true);
  };

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };

  ws.onclose = () => {
    setChip("offline", "off");
    watch(false);
    if (state.ws !== ws) return;      // superseded by a newer socket
    state.ws = null;
    state.tries += 1;
    const wait = Math.min(30000, 1000 * Math.pow(2, Math.min(state.tries, 5)));
    state.retryAt = Date.now() + wait;
    setTimeout(() => { if (!state.ws) connect(); }, wait);
  };

  ws.onerror = () => setChip("error", "bad");
}

function disconnect(announce = true) {
  const ws = state.ws;
  state.ws = null;
  watch(false);
  if (ws) { try { ws.close(); } catch {} }
  setChip("offline", "off");
  if (announce) note("Disconnected.");
}

function send(obj) {
  const ws = state.ws;
  if (!ws || ws.readyState !== 1) {
    state.queue.push(obj);
    if (state.queue.length > 50) state.queue.shift();
    return false;
  }
  ws.send(JSON.stringify(obj));
  return true;
}

function flush() {
  const q = state.queue.splice(0);
  q.forEach(send);
}

/* -------------------------------------------------------------- messages */

function handle(m) {
  switch (m.type) {
    case "agent":
      say("agent", m.text || "");
      break;

    case "system":
      note(m.text || "");
      break;

    case "ask":
      openAsk(m);
      break;

    case "action":
      runAction(m);
      break;

    case "clear":
      state.asks.forEach((a) => clearTimeout(a.timer));
      state.asks.clear();
      logEl.replaceChildren();
      note("Transcript cleared by the agent.");
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------- the hands */

// Called by the native side when the browser page has loaded.
function exec(method, args) {
  if (!NATIVE) return { error: "no hands — this page is not inside the app" };
  try {
    const raw = window.Android.call(method, JSON.stringify(args || {}));
    return raw ? JSON.parse(raw) : { ok: true };
  } catch (e) {
    return { error: String(e) };
  }
}

function runAction(m) {
  const result = exec(m.method, m.args);
  const ok = !result.error && result.ok !== false;
  const detail = result.error ? result.error : (m.summary || result.summary || "");
  act(m.method, ok, detail);

  send({
    type: "action_result",
    id: m.id,
    method: m.method,
    ok,
    result,
  });

  // Anything that changed the page deserves a fresh look, and bypasses the
  // "nothing changed" shortcut because the screen has just moved.
  if (ok && ["click", "type", "goto", "back", "press"].includes(m.method)) {
    state.lastSeen = "";
    setTimeout(observe, 900);
  }
}

/* --------------------------------------------------------- observations */

function observe() {
  if (!NATIVE) return;
  const seen = exec("observe", {});
  if (seen.error) return;
  push(seen);
}

function push(seen) {
  const stamp = [seen.url, seen.title, seen.scroll, (seen.text || "").length,
    (seen.nodes || []).length].join("|");
  if (stamp === state.lastSeen) return;
  state.lastSeen = stamp;
  send({ type: "state", at: Date.now(), ...seen });
}

// The app calls this itself after a page loads, so the console does not have to
// wait for the next poll to show where you are.
window.backroadState = function (raw) {
  let s;
  try { s = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }
  if (!s || s.ok === false) return;
  push(s);
};

function watch(on) {
  clearInterval(state.watchTimer);
  state.watchTimer = null;
  if (!on) return;
  state.watchTimer = setInterval(() => {
    if (document.hidden) return;
    observe();
  }, 4000);
}

/* ------------------------------------------------------- the brake (ask) */

function openAsk(m) {
  const card = el("div", "ask");
  card.dataset.risk = m.risk || "irreversible";

  card.appendChild(el("span", "ask-tag", m.risk || "confirm"));
  const q = el("q", null, m.question || "Can I do this?");
  card.appendChild(q);
  if (m.detail) card.appendChild(el("div", "detail", m.detail));

  const row = el("div", "row");
  const yes = el("button", "primary", "Yes, go");
  const no = el("button", "danger", "No");
  row.append(yes, no);
  card.appendChild(row);

  const free = document.createElement("input");
  free.type = "text";
  free.placeholder = "or type the answer / code";
  free.enterKeyHint = "send";
  card.appendChild(free);

  const clock = el("div", "clock", "");
  card.appendChild(clock);

  add(card);

  const seconds = Math.max(10, Number(m.expires_in) || 120);
  let left = seconds;
  clock.textContent = `no answer in ${left}s = no`;

  const timer = setInterval(() => {
    left -= 1;
    clock.textContent = `no answer in ${Math.max(left, 0)}s = no`;
    if (left <= 0) answer(m.id, "timeout");
  }, 1000);

  state.asks.set(m.id, { node: card, timer, seconds });

  // get his attention: this is the whole point of the brake
  try { navigator.vibrate?.([40, 60, 40, 60, 120]); } catch {}
  document.title = "● needs you — backroad";
  beep();

  yes.onclick = () => answer(m.id, "yes");
  no.onclick = () => answer(m.id, "no");
  free.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && free.value.trim()) answer(m.id, free.value.trim());
  });
}

function answer(id, value) {
  const a = state.asks.get(id);
  if (!a) return;
  clearInterval(a.timer);
  state.asks.delete(id);
  a.node.classList.add("done");
  a.node.appendChild(el("div", "detail", "answered: " + value));
  send({ type: "answer", id, answer: value });
  if (state.asks.size === 0) document.title = "backroad";
}

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 660;
    g.gain.value = 0.06;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.12);
  } catch {}
}

/* --------------------------------------------------------------- typing */

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = cmdEl.value.trim();
  if (!text) return;
  say("you", text);
  send({ type: "user", text });
  cmdEl.value = "";
  if (!state.ws) note("Saved and queued — it goes out when the relay reconnects.");
});

/* ------------------------------------------------------------------ mic */

micEl.addEventListener("click", () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (NATIVE && window.Android.startVoice) {
    micEl.dataset.live = "1";
    window.Android.startVoice();
    return;
  }
  if (!SR) {
    note("This browser has no speech recognition. The app's mic button works without it.");
    return;
  }
  const rec = new SR();
  rec.lang = navigator.language || "en-GB";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  micEl.dataset.live = "1";
  rec.onresult = (ev) => {
    const text = ev.results[0][0].transcript;
    cmdEl.value = text;
    $("#composer").requestSubmit();
  };
  rec.onend = () => { micEl.dataset.live = "0"; };
  rec.onerror = () => { micEl.dataset.live = "0"; };
  rec.start();
});

// The native side calls this with what it heard.
window.onVoice = function (text) {
  micEl.dataset.live = "0";
  if (!text) return;
  cmdEl.value = text;
  $("#composer").requestSubmit();
};

window.androidVoiceFailed = function (why) {
  micEl.dataset.live = "0";
  note("Mic: " + (why || "nothing heard"));
};

/* ------------------------------------------------------------- settings */

const sheet = $("#settings");
$("#btnSettings").onclick = () => {
  $("#cfgUrl").value = cfg.url || "";
  $("#cfgRoom").value = cfg.room || "";
  $("#cfgToken").value = cfg.token || "";
  $("#nativeNote").textContent = NATIVE
    ? "Hands: yes — this page is inside the app and can drive the page you are on."
    : "Hands: no — opened in a normal browser. Chat and approvals work; browsing needs the app.";
  sheet.hidden = false;
};
$("#btnCloseSettings").onclick = () => { sheet.hidden = true; };

$("#btnConnect").onclick = () => {
  cfg = {
    url: $("#cfgUrl").value.trim(),
    room: $("#cfgRoom").value.trim() || "phone",
    token: $("#cfgToken").value.trim(),
  };
  saveCfg(cfg);
  sheet.hidden = true;
  connect();
};

$("#btnDisconnect").onclick = () => { disconnect(); };

/* ----------------------------------------------------------------- boot */

if (NATIVE) {
  note("Hands connected. This page is inside the app.");
} else {
  note("Standalone console. Chat and approvals only.");
}

if (cfg.url) connect();

// Reconnect when the phone wakes up or comes back to the foreground.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (!state.ws && cfg.url) connect();
});
window.addEventListener("online", () => { if (!state.ws && cfg.url) connect(); });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
