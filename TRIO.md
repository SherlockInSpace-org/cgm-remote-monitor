# Trio integration brief — Pixelalarm arm/disarm toggle

This document specifies everything needed to add the **SugarPixel remote
alarm** admin control to a Trio fork. It is written for an implementing agent
working in the Trio repository (github.com/nightscout/Trio); the server side
is already implemented in Nightscout (see [PIXELALARM.md](PIXELALARM.md) for
the full feature description).

## What the feature does (user's perspective)

The looper (Trio user, admin of the Nightscout site) decides *whether* his
caregiver can remotely fire the bedside SugarPixel's LOW alarm. Arming the
feature blanks the data served to the SugarPixel (so the display visibly goes
stale — that's the "armed" tell) and allows the caregiver's LoopFollow app to
trigger a fake LOW at any moment. Disarming restores live data to the display
and blocks triggering.

## What to build in Trio

A small settings section (or home-screen control) with:

1. **An Arm/Disarm toggle** reflecting the server state (`mode != "off"` =
   armed). Include a brief warning when arming: "While armed, the SugarPixel
   shows no live data until an alarm is triggered."
2. **A state line** showing the current mode; when `mode == "triggered"`,
   show who triggered it (`triggeredBy`) and when (`triggeredAt`).
3. **Refresh** of the state when the view appears and after each toggle
   (every response already returns the fresh status object).
4. **Visibility**: only show the section when the status endpoint answers
   200 (auto-detection below), or behind a feature flag in settings.

## Credentials

Trio already stores the Nightscout **URL** and the **API_SECRET** (it is the
site's master uploader). The pixelalarm admin endpoints authenticate exactly
like the v1 endpoints Trio already calls: send the header

```
api-secret: <SHA-1 hex digest of the API_SECRET string>
```

i.e. the same hashed-secret header Trio's existing Nightscout client code
uses for v1 uploads. (The server also accepts `Authorization: Bearer <JWT>`
if Trio's Nightscout client has moved to v3-style JWT auth — the admin secret
resolves to full permissions either way it is presented.)

No new credential entry UI is needed.

## API

Base path: `<nightscoutURL>/api/v1/pixelalarm`. All responses are JSON.

### `GET /api/v1/pixelalarm/status`

Header: `api-secret: <sha1(API_SECRET)>`

200 response body:

```json
{
  "enabled": true,
  "mode": "off" | "armed" | "triggered",
  "armedAt": "2026-07-23T21:04:11.000Z",
  "triggeredAt": null,
  "triggeredBy": null,
  "firstServedAt": null,
  "expiresAt": null,
  "config": {
    "subject": "sugarpixel",
    "value": 40,
    "triggerDurationSeconds": 60,
    "triggerTimeoutSeconds": 600,
    "safetyThreshold": 55,
    "leadinValue": 130
  }
}
```

All timestamps are ISO-8601 UTC strings or `null`.

### `POST /api/v1/pixelalarm/arm` and `POST /api/v1/pixelalarm/disarm`

Header: `api-secret: <sha1(API_SECRET)>`, empty body.

Both are idempotent and return **200** with the fresh status object
(`mode` = `"armed"` / `"off"`). Disarming while `triggered` is valid and
immediately cancels the alarm window.

Error mapping:

- **401** — the secret hash is wrong. Surface as a credentials problem.
- **404** — the server doesn't have the feature or `pixelalarm` is missing
  from the site's `ENABLE` env var. Hide the section.

### Reference curl calls

```bash
HASH=$(echo -n "$API_SECRET" | sha1sum | cut -d' ' -f1)
curl -s -H "api-secret: $HASH"          "https://SITE/api/v1/pixelalarm/status"
curl -s -H "api-secret: $HASH" -X POST  "https://SITE/api/v1/pixelalarm/arm"
curl -s -H "api-secret: $HASH" -X POST  "https://SITE/api/v1/pixelalarm/disarm"
```

## Behavioral details worth reflecting in UX

- Arming clears any in-flight trigger; the caregiver must trigger anew.
- While armed, the looper's own Trio uploads and every other Nightscout
  consumer are completely unaffected — only the SugarPixel's token subject
  receives modified data, and only for reads.
- The server auto-reverts `triggered` → `armed` after the trigger window
  (default 60 s from the SugarPixel's first fetch of the fake value), so a
  status showing `triggered` is transient.
- Safety passthrough: if the real glucose is at/below
  `config.safetyThreshold` (mg/dL), the SugarPixel receives real data even
  while armed, so genuine lows still alarm on the display.
