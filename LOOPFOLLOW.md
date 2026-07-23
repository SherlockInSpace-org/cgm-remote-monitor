# LoopFollow integration brief — Pixelalarm trigger button

This document specifies everything needed to add the **SugarPixel remote
alarm** feature to a LoopFollow fork. It is written for an implementing agent
working in the LoopFollow repository (github.com/loopandlearn/LoopFollow);
the server side is already implemented in Nightscout (see
[PIXELALARM.md](PIXELALARM.md) for the full feature description).

## What the feature does (user's perspective)

The caregiver (LoopFollow user) watches the looper's glucose. When she needs
to wake him and he isn't responding, she presses a **Trigger SugarPixel
alarm** button in LoopFollow. The Nightscout server then serves a fake LOW
glucose value to the bedside SugarPixel display — and only to it — which
fires its loud alarm/vibration. The looper (admin) controls *whether* this is
possible by arming/disarming the feature from Trio.

## What to build in LoopFollow

1. **A status indicator** showing the current pixelalarm mode:
   - `off` — feature disarmed by the admin; trigger button hidden or greyed
     out with the hint "Not armed".
   - `armed` — ready; trigger button enabled.
   - `triggered` — alarm in flight; show since when (`triggeredAt`), by whom
     (`triggeredBy`), and — once `expiresAt` is non-null — a countdown until
     the window closes. The button may stay enabled: pressing it again
     restarts the window (re-fires the alarm).
2. **The trigger button**, with a confirmation step (this wakes someone up).
   On success show the returned mode; on failure show the error cases below.
3. **Visibility**: only show the whole UI section when the status endpoint
   answers 200 (see auto-detection below).

Polling: fetch the status endpoint on app foreground and roughly every 60 s
while the screen showing the indicator is visible. There is no websocket for
this; plain HTTP polling is the intended mechanism.

## Credentials

LoopFollow already stores the Nightscout **URL** and a **token**. The same
token the caregiver already uses keeps working — the Nightscout admin adds a
role (`pixelalarm-remote`, permissions `pixelalarm:read pixelalarm:trigger`)
to her existing token subject, which does not change the token string. No new
credential entry UI is needed.

Send the token exactly as LoopFollow already does for other Nightscout calls:
either `?token=<accessToken>` as a query parameter, or exchange it for a JWT
via `GET /api/v2/authorization/request/<accessToken>` and send
`Authorization: Bearer <jwt>`.

## API

Base path: `<nightscoutURL>/api/v1/pixelalarm` (also available under
`/api/v2/pixelalarm`). All responses are JSON.

### `GET /api/v1/pixelalarm/status?token=<token>`

200 response body:

```json
{
  "enabled": true,
  "mode": "off" | "armed" | "triggered",
  "armedAt": "2026-07-23T21:04:11.000Z",
  "triggeredAt": "2026-07-23T21:10:02.000Z",
  "triggeredBy": "wife",
  "firstServedAt": "2026-07-23T21:11:40.000Z",
  "expiresAt": "2026-07-23T21:12:40.000Z",
  "config": {
    "subject": "sugarpixel",
    "value": 40,
    "triggerDurationSeconds": 60,
    "triggerTimeoutSeconds": 600,
    "safetyThreshold": 55
  }
}
```

Field notes:

- All timestamps are ISO-8601 UTC strings, `null` when not applicable.
- While `triggered`, `firstServedAt`/`expiresAt` stay `null` **until the
  SugarPixel actually fetches the fake value** (it may poll only every few
  minutes). UI copy for that phase: "waiting for SugarPixel to poll…".
  Once `expiresAt` is set, show a countdown; after it passes, the server
  reverts to `armed` (re-fetch status to confirm).
- `config` is informational (server-side settings echo).

### `POST /api/v1/pixelalarm/trigger?token=<token>` (empty body)

- **200** — accepted; body is the same status object, `mode` = `"triggered"`.
- **409** — the feature is not armed. Body:
  `{ "status": 409, "message": "pixelalarm is not armed", "current": { …status… } }`.
  Show "The alarm is not armed — ask the looper to arm it from Trio."
- **401** — token missing/invalid or lacking the `pixelalarm:trigger`
  permission. Show "Your Nightscout token is not authorized for this —
  the pixelalarm-remote role must be added to it in Nightscout admin."

### Auto-detection / error mapping for the status call

- **200** → feature present; render the section.
- **404** → server doesn't have the feature or `pixelalarm` is not in
  `ENABLE`; hide the section.
- **401** → server has default-deny or the token lacks `pixelalarm:read`;
  hide the section, optionally surface a settings hint.

### Reference curl calls

```bash
curl -s "https://SITE/api/v1/pixelalarm/status?token=TOKEN"
curl -s -X POST "https://SITE/api/v1/pixelalarm/trigger?token=TOKEN"
```

## Behavioral details worth reflecting in UX

- Triggering while already `triggered` is valid and **restarts** the window —
  the alarm keeps sounding on the next SugarPixel poll cycle.
- After the window elapses the server goes back to `armed` automatically; the
  caregiver can immediately trigger again.
- If the SugarPixel never fetches the fake value (offline, WiFi drop), the
  trigger auto-cancels after `config.triggerTimeoutSeconds` (default 10 min)
  and the mode returns to `armed`. While waiting, status shows `triggered`
  with `firstServedAt: null`.
- Safety passthrough: if the looper's *real* glucose is at/below the
  configured threshold (`config.safetyThreshold`, mg/dL), the server serves
  real data to the SugarPixel regardless of mode — a triggered fake may
  therefore be superseded by an equally-alarming real value. No special UI
  needed; mentioned for completeness.
- While `armed`, the SugarPixel display intentionally shows stale/blank data.
  That is how the looper knows the system is armed.
