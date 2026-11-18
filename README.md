# backroad - a browser you can talk to

An Android app that *is* the browser, a web console that does the thinking, and a relay
that lets an agent reach the phone from outside.

**Status, 18 Nov 2026.** Every file is written; nothing has been compiled or deployed.
The JavaScript is syntax-checked, the APK has never been built. The full tree is
`backroad-browser.zip` in the chat that wrote it and is being pushed here file by file.
Until that finishes this repo is documentation only - do not expect the workflow to run.

```
wap/            the console: transcript, commands, approval gate, settings
android/        the APK: WebView browser, the hands, a mic button
relay/          Cloudflare Worker: rooms over websocket, /sms door, ask expiry
docs/           the brake, and the text-message bridge
.github/        builds the debug APK on every push
```

## The split

```
phone (hands + eyes)  ->  relay (room + gate)  ->  brain (server)
```

The phone opens the websocket outward, because nothing outside can reach a phone.
The relay carries commands in and observations out, and holds the approval gate so a
"yes" can arrive from the app *or* from a text. The brain is server-side, so prompts
and rules change without a new APK.

## The control surface

One call, JSON in, JSON out:

```js
Android.call("observe", {})                              // url, title, nodes, text
Android.call("click",   {selector: "[data-br=b3]"})
Android.call("type",    {selector: "[data-br=b5]", text: "tyres", submit: true})
Android.call("scroll",  {dy: 600})
Android.call("shot",    {})                              // 480px JPEG, base64
```

`observe` stamps every visible control with a stable `data-br` id, so the agent can
name a thing and then act on it. Same loop as the scene builder: look, act, look again.

## The brake

`login`, `money` and `irreversible` never run unattended. The agent sends `ask` and
stops; no answer in the window means **no**, and the relay answers the timeout itself.

## Getting the APK onto the phone without a computer

1. Push the `android/` folder and `.github/workflows/apk.yml`.
2. Actions -> `apk` -> latest run -> Artifacts -> `backroad-debug`.
3. Unzip on the phone, tap the `.apk`, allow "install unknown apps" once.

Debug-signed, so it is for his own phone only - not for Play.

## Getting the console on the phone today

Enable Pages (main, `/` root), then open `https://<user>.github.io/backroad-browser/wap/`
and add it to the home screen. That is the WAP - a control surface and a chat, no install.

## Settings

In the console, tap the cog: **relay** (`wss://.../ws`), **room** (any word, same on both
ends), **token** (the Worker's `PAIR_TOKEN`). Without a token the room is open.

## Not here on purpose

No accounts, no sign-in, no payment code, no analytics, no bundler. No accessibility
hooks: it drives only its own pages.
