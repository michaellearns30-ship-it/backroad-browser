# The brake, and the text bridge

Two separate things, often confused:

1. **The brake** — the agent stops and asks *before* it does something that cannot be
   undone. This is the whole point: an agent holding your sessions with no brake is a
   bad trade even when it is your own agent.
2. **The bridge** — how the question reaches you when the app is closed or your hands
   are busy, and how your answer gets back.

## 1. The brake

Every action passes through a gate. Three categories never run unattended:

| tag | examples | default on timeout |
| --- | --- | --- |
| `login` | signing in, a 2FA code, "this device is new" | deny |
| `money` | checkout, card, subscription, tip, bid | deny |
| `irreversible` | send / post / publish / delete / leave / accept terms | deny |

Everything else — open a page, scroll, read, fill a search box, click "next" — runs
without asking. If it turns out to matter, add a tag rather than asking about
everything; an agent that asks about every click is worse than no agent.

The agent sends this and then **stops**. It does not poll, retry or "work around" a
missing answer:

```json
{ "type": "ask", "id": "a7f3",
  "risk": "money",
  "question": "Checkout is at \u00a342.19 for the tyre. Pay it?",
  "detail": "halfords.com \u00b7 card ending 4417",
  "expires_in": 120,
  "escalate": true }
```

You answer with:

```json
{ "type": "answer", "id": "a7f3", "answer": "yes" }
```

`answer` is `yes`, `no`, or free text (a code, a choice, a corrected instruction).
No answer by `expires_in` means **no** — the relay sends `{"type":"answer","id":"a7f3",
"answer":"timeout"}` itself so the agent is never left hanging.

In the console, an open question blocks the queue and shows a card with big Yes / No
buttons, vibrates, and puts a dot in the tab title. That is the "notify me before you
do it" function you asked for.

## 2. The bridge — where the question goes

The relay will POST the question to whatever `ALERT_WEBHOOK` is set to. Options, in
the order I would try them:

### a. ntfy.sh — free, two minutes, no account

Install **ntfy** on the phone, subscribe to a hard-to-guess topic, and set:

```
ALERT_WEBHOOK = https://ntfy.sh/<long-random-topic>
```

The relay POSTs the question as the notification body; you get a push even with the
app closed and the browser shut. Tapping it opens the console with the card already
there. Downside: the reply has to be in the console, not in the notification.

Very good for "tell me something happened". Not a conversation.

### b. Tasker — real SMS, both directions, free

This is the one you meant, and it does work. Two profiles:

**Out (relay → your SMS):** Tasker reacts to an HTTP request. Either give the relay a
Tasker webhook URL (`ALERT_WEBHOOK = https://tasker.example/hook`) or have Tasker poll
the relay every minute. Action: **Send SMS**, to your own number, text `%http_data`.

**In (your SMS reply → relay):** Profile → Event → **Received Text**, sender = your
own number. Action: **HTTP Request**, POST to

```
https://backroad-relay.<you>.workers.dev/sms
Content-Type: application/json

{"token":"<PAIR_TOKEN>","room":"michael","body":"%SMSRB"}
```

The relay parses the reply into an `answer` and pushes it to the room, so the agent
carries on before you have even opened the app.

Honest limits:

- Tasker is a paid app (~£3), and `Send SMS` needs SMS permission — Play may warn you
  about it, which is expected for an SMS-automation app.
- Texts to your own number can be delayed or filtered by the carrier. Test it.
- If the phone is off, in a tunnel, or out of signal, nothing arrives. SMS is not a
  guaranteed channel from a server's point of view.
- A relay sending an SMS is Tasker *on the phone* sending it. That is why it is free.

### c. Telegram bot — free, two-way, no SMS

A bot token, one `sendMessage` to your chat id, and a webhook back. Better than SMS
in every way except that it is not your text messages. Best if you want a
conversation rather than a notification.

### d. Twilio — real server-side SMS, costs money

A real number, a paid account, and in the US a 10DLC registration. Inbound webhooks
work properly. This is the "it always arrives" option, and the only one that costs
money every month. Carrier email-to-SMS gateways are being retired, so do not build
on them.

### What I would pick

ntfy now (five minutes, tells you when the gate opens), Telegram next week (you can
answer from the notification), Tasker only if you specifically want it to look like a
text message, Twilio if this ever stops being a personal project.

## 3. What is built

| Piece | State |
| --- | --- |
| gate in the protocol (`ask` / `answer`, expiry, default no) | in `wap/app.js` and `relay/src/index.js` |
| blocking card, vibration, title dot | in `wap/` |
| `/sms` inbound door | in `relay/src/index.js` |
| outbound `ALERT_WEBHOOK` | in `relay/src/index.js` |
| Tasker profile files | not written — they are ten minutes in the Tasker UI, and the exact JSON is above |
| Twilio | not written |
