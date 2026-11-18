// backroad relay — the bit that lets something outside reach the phone.
//
//   wss://<worker>/ws?room=R&token=T&role=phone|agent   the live connection
//   POST /sms                                          Tasker: a text reply, in
//   GET  /health                                       is it up
//
// It carries messages and enforces the brake. It does not think.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true, at: Date.now() });

    if (url.pathname === "/ws") {
      const token = url.searchParams.get("token") || request.headers.get("x-token") || "";
      if (env.PAIR_TOKEN && token !== env.PAIR_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }
      const room = url.searchParams.get("room") || "phone";
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request);
    }

    if (url.pathname === "/sms" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "body must be JSON" }, 400);
      }
      const token = body.token || url.searchParams.get("token") || "";
      if (env.PAIR_TOKEN && token !== env.PAIR_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }
      if (!body.body) return json({ ok: false, error: "no text in body" }, 400);

      const room = body.room || "phone";
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch("https://room/sms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    return new Response(
      "backroad relay. /health, /ws?room=&token=&role=, POST /sms",
      { status: 404 }
    );
  },
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ---- a text message coming back in (Tasker) -------------------------
    if (url.pathname === "/sms") {
      const body = await request.json().catch(() => ({}));
      const text = String(body.body || "").trim();
      const open = await this.asks();
      const ids = Object.keys(open);

      // "YES" or "NO" answers the most recent question with no other preamble;
      // anything else is the free-text answer to it.
      const lower = text.toLowerCase();
      const pick = (lower === "yes" || lower === "y" || lower === "ok")
        ? "yes"
        : (lower === "no" || lower === "n" || lower === "stop")
          ? "no"
          : text;

      if (!ids.length) {
        this.broadcast({ type: "system", text: `Text arrived with nothing open: ${text}` });
        return json({ ok: true, answered: null });
      }

      const id = ids.sort((a, b) => open[b].at - open[a].at)[0];
      await this.closeAsk(id);
      this.broadcast({ type: "answer", id, answer: pick, via: "sms" });
      return json({ ok: true, answered: id, answer: pick });
    }

    // ---- the live connection --------------------------------------------
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(obj, except) {
    const text = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(text); } catch { /* gone */ }
    }
  }

  async webSocketMessage(ws, message) {
    let m;
    try {
      m = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (!m || typeof m.type !== "string") return;

    if (m.type === "ask") {
      await this.registerAsk(m);
    }
    if (m.type === "answer") {
      await this.closeAsk(m.id);
    }

    // Everything is echoed to the other side of the room. The sender already
    // showed its own half locally, so it does not need it back.
    this.broadcast(m, ws);
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* already gone */ }
  }

  async webSocketError(ws) {
    try { ws.close(); } catch { /* already gone */ }
  }

  // ---- the brake --------------------------------------------------------

  async asks() {
    return (await this.state.storage.get("asks")) || {};
  }

  async registerAsk(m) {
    const all = await this.asks();
    const id = m.id || crypto.randomUUID().slice(0, 8);
    const seconds = Math.max(10, Number(m.expires_in) || 120);
    all[id] = {
      at: Date.now(),
      expires: Date.now() + seconds * 1000,
      risk: m.risk || "irreversible",
      question: m.question || "",
      text: `[${m.risk || "confirm"}] ${m.question || "Can I do this?"}`,
    };
    await this.state.storage.put("asks", all);
    await this.scheduleNext();

    if (m.escalate) await this.escalate(all[id], id);
    return id;
  }

  async closeAsk(id) {
    const all = await this.asks();
    if (!all[id]) return;
    delete all[id];
    await this.state.storage.put("asks", all);
    await this.scheduleNext();
  }

  async scheduleNext() {
    const all = await this.asks();
    const times = Object.values(all).map((a) => a.expires);
    if (!times.length) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.min(...times));
  }

  async alarm() {
    const all = await this.asks();
    const now = Date.now();
    let changed = false;
    for (const [id, ask] of Object.entries(all)) {
      if (ask.expires > now) continue;
      delete all[id];
      changed = true;
      // Silence is a no. Never leave the agent hanging on a question.
      this.broadcast({ type: "answer", id, answer: "timeout", via: "relay" });
      this.broadcast({ type: "system", text: `No answer to "${ask.question}" — timed out, so: no.` });
    }
    if (changed) await this.state.storage.put("asks", all);
    await this.scheduleNext();
  }

  // ---- the text bridge --------------------------------------------------

  async escalate(ask, id) {
    const hook = this.env.ALERT_WEBHOOK;
    if (!hook) return;
    const body = [
      `backroad needs you (${id})`,
      ask.text,
      `Reply YES or NO within ${Math.round((ask.expires - Date.now()) / 1000)}s.`,
    ].join("\n\n");

    try {
      await this.state.waitUntil(
        fetch(hook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "backroad needs you",
            message: ask.question,
            id,
            risk: ask.risk,
            text: body,
            // ntfy reads `topic` from the URL and the rest from this body;
            // Tasker reads whatever it likes out of it.
          }),
        })
      );
    } catch {
      // An unreachable webhook is not a reason to block the question; it is
      // already on screen in the console.
    }
  }
}
