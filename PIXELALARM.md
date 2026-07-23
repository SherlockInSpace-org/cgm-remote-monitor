# Pixelalarm — remote SugarPixel wake-up alarm

Pixelalarm lets a caregiver remotely force a SugarPixel display to fire its
LOW alarm. The Nightscout server serves modified glucose data **to one
specific access-token subject only** (the SugarPixel); every other consumer —
Trio, LoopFollow, the web UI, reports — keeps seeing real data. Nothing fake
is ever written to the database; all interception happens at read time.

## State machine

| Mode | What the SugarPixel sees | Everyone else |
|---|---|---|
| `off` | Real live CGM data | Real data |
| `armed` | An empty feed (display goes stale/blank) | Real data |
| `triggered` | A fake LOW entry (default 40 mg/dL) with a fresh timestamp on every poll | Real data |

- **Arm / disarm** requires the `pixelalarm:admin` permission (the admin
  `API_SECRET` always has it). Intended for a button in Trio — see
  [TRIO.md](TRIO.md).
- **Trigger** requires the `pixelalarm:trigger` permission — granted to the
  caregiver's existing token. Intended for a button in LoopFollow — see
  [LOOPFOLLOW.md](LOOPFOLLOW.md).
- The **trigger window** (default 60 s) starts counting when the SugarPixel
  *first fetches* the fake value, not when the trigger was sent — the device
  may poll as rarely as every 5 minutes, so a short window anchored to the
  button press could expire before the device ever saw the LOW. When the
  window elapses, the state reverts to `armed` and can be triggered again.
- If the device never fetches the fake value, a failsafe timeout (default
  10 min) reverts to `armed` — a trigger never stays latched indefinitely.
- Triggering while already `triggered` restarts the window (re-fires the
  alarm).
- **Safety passthrough**: while `armed` or `triggered`, if the latest real
  CGM reading (less than 15 min old) is at/below `PIXELALARM_SAFETY_THRESHOLD`
  (default 55 mg/dL), the SugarPixel receives **real** data so it still
  alarms on a genuine low. Set the threshold to `0` to disable.

## What is intercepted

For requests authenticated with the configured subject's token, and only for
`GET`s:

- `/api/v1/entries*` in all variants (`/entries.json`,
  `/entries/sgv.json?count=1`, `/entries/current`, `/times/*`, `/slice/*`) —
  including the in-memory cache fast path and csv/tsv/txt output formats.
  `If-Modified-Since` is ignored while intercepting so a 304 can't suppress
  the fake value. The same paths under `/api/v2` are covered automatically
  (v2 re-mounts v1).
- `/pebble` — empty `bgs` while armed, one fake bg while triggered.
- `/api/v2/properties` — `{}` while armed; a minimal synthetic
  `bgnow`/`delta`/`direction` while triggered (built from scratch so real
  glucose can't leak through other plugin properties).
- `/api/v3/entries*` — `{status:200, result:[]}` while armed,
  `{status:200, result:[fake entry]}` while triggered.
- `/api/v2/summary` — empty summary while armed, one fake `{sgv, mills}`
  while triggered.
- `/api/v2/ddata/at` — minimal empty ddata payload while armed, one fake
  ddata-shaped sgv while triggered.
- `/api/v1/count/*` — `[]` (aggregate counts over real entries would reveal
  real data activity).

**Socket.IO**: streaming rooms broadcast real data to all readers, so
per-subject masking is impossible there. While the feature is enabled, the
configured subject's token is **refused streaming read access entirely**
(both the classic websocket and the API v3 storage socket). The SugarPixel
polls HTTP, where masking works.

If your device ever shows real data while armed, check the server log —
every interception logs a `pixelalarm:` line with the path served, so you
can see exactly which endpoint the device polls.

Uploads (`POST /api/v1/entries` from Trio etc.) are never touched.

## Configuration (environment variables)

Add `pixelalarm` to `ENABLE`. Without it the feature is completely dormant:
no endpoints, no interception, zero request overhead.

| Variable | Default | Meaning |
|---|---|---|
| `PIXELALARM_SUBJECT` | `sugarpixel` | Name of the access-token subject whose reads are intercepted (case-insensitive) |
| `PIXELALARM_VALUE` | `40` | Fake glucose value in mg/dL served while triggered |
| `PIXELALARM_TRIGGER_DURATION` | `60` | Seconds the fake value keeps being served, counted from the device's first fetch |
| `PIXELALARM_TRIGGER_TIMEOUT` | `600` | Seconds to wait for the device to fetch before giving up and reverting to armed |
| `PIXELALARM_SAFETY_THRESHOLD` | `55` | Real-glucose passthrough threshold in mg/dL; `0` disables |
| `MONGO_PIXELALARM_COLLECTION` | `pixelalarm` | Mongo collection holding the single state document (state survives restarts) |

## One-time Nightscout setup

1. **SugarPixel subject** — in the Nightscout admin UI (`/admin`), create a
   Subject named `sugarpixel` (or whatever `PIXELALARM_SUBJECT` is set to)
   with role `readable`, and configure the SugarPixel Hub app with that
   subject's access token. If your SugarPixel already uses its own dedicated
   token, just set `PIXELALARM_SUBJECT` to that subject's name. **The
   SugarPixel must not share the admin secret or any other person's token** —
   the subject name is how the server decides who gets the fake data.
2. **Caregiver role** — in `/admin`, create a Role named `pixelalarm-remote`
   with permissions: `pixelalarm:read pixelalarm:trigger`. Then edit the
   caregiver's **existing** Subject and add that role. Access tokens are
   derived from the subject's id, so adding a role does **not** change her
   token — LoopFollow keeps working unchanged.
3. **On the SugarPixel device** (Hub app):
   - Turn **off** the "No Data" alert — otherwise the armed (blank) state
     itself would fire alarms.
   - Make sure the Low alert is enabled and its threshold is **at or above**
     `PIXELALARM_VALUE` (40 works with any reasonable Low threshold).

## API

All endpoints live under `/api/v1/pixelalarm` (also reachable as
`/api/v2/pixelalarm`). Authentication: any mechanism Nightscout v1 accepts —
`api-secret: <SHA1 of API_SECRET>` header, `?token=<accessToken>` query
parameter, or `Authorization: Bearer <JWT>`.

Permissions are deliberately two-segment and lowercase, so the default
`readable` role (`*:*:read`) matches none of them — anonymous visitors on an
open site can neither see nor touch alarm state.

### `GET /api/v1/pixelalarm/status` — permission `pixelalarm:read`

```json
{
  "enabled": true,
  "mode": "triggered",
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

`firstServedAt`/`expiresAt` are `null` until the SugarPixel fetches the fake
value. All timestamps are ISO-8601 UTC.

### `POST /api/v1/pixelalarm/arm` / `POST /api/v1/pixelalarm/disarm` — permission `pixelalarm:admin`

Both are idempotent and return the new status object.

### `POST /api/v1/pixelalarm/trigger` — permission `pixelalarm:trigger`

Returns the new status (mode `triggered`). While mode is `off` it returns
**409** with `{ "status": 409, "message": "pixelalarm is not armed",
"current": { ...status... } }` — the alarm can only be fired when the admin
has armed it.

### curl examples

```bash
NS=https://your-site.example.com
HASH=$(echo -n "$API_SECRET" | sha1sum | cut -d' ' -f1)

curl -s -H "api-secret: $HASH" -X POST $NS/api/v1/pixelalarm/arm      # admin: arm
curl -s -H "api-secret: $HASH" -X POST $NS/api/v1/pixelalarm/disarm   # admin: disarm
curl -s "$NS/api/v1/pixelalarm/status?token=WIFE_TOKEN"               # caregiver: status
curl -s -X POST "$NS/api/v1/pixelalarm/trigger?token=WIFE_TOKEN"      # caregiver: fire!
```

## Safety notes

- **While armed, the SugarPixel is not a functional CGM display** (it shows
  stale/blank data). Real lows still break through via the safety
  passthrough, but keep primary alarms (phone, pump) active regardless.
- The fake value is only ever served to the configured subject, is never
  stored, and never appears in reports or to other followers.
- The safety passthrough needs a real reading younger than 15 minutes in the
  server's in-memory data. Right after a server restart (before the first
  data load completes) and during CGM data gaps it cannot see a real low —
  another reason primary alarms stay on.
- After **disarming**, a device that uses `If-Modified-Since` could keep
  displaying the last fake LOW for up to one CGM cycle (~5 min) until a
  newer real reading arrives. Self-heals; device-dependent.
- The feature assumes a **single Node process** (the standard
  one-VM/one-process Nightscout deployment). Alarm state is held in memory
  and persisted to Mongo for restarts; multiple load-balanced instances
  would each keep their own copy.
- A single-document `GET /api/v3/entries/<identifier>` from the target
  subject receives the search-shaped (array) envelope instead of a single
  object — intentional; no known display device reads individual historical
  documents by identifier.

## Deployment (Google Compute Engine VM, plain node)

The feature adds code, two config surfaces (env vars, one new Mongo
collection that is auto-created) and nothing else. **Your existing database,
`API_SECRET`, and all access tokens are untouched.**

1. Merge the `wip/pixelalarm` branch into the branch your server deploys
   from, and push to your repository.
2. SSH into the VM: `gcloud compute ssh <instance> --zone <zone>` (or plain
   ssh).
3. Find the running server and its directory:
   ```bash
   pgrep -af "node .*server.js"                 # note the PID
   readlink /proc/<PID>/cwd                     # the app directory
   ```
   Find out what supervises it (check in this order):
   ```bash
   systemctl status | grep -B2 -A2 node         # systemd service?
   pm2 list 2>/dev/null                         # pm2?
   crontab -l | grep -i node                    # @reboot cron / start script?
   ```
4. Record the current commit for rollback: `cd <appdir> && git rev-parse HEAD`.
5. Update the code:
   ```bash
   git fetch origin && git merge --ff-only origin/<your-branch>
   npm install          # also rebuilds the client bundle (postinstall)
   ```
6. Add the new environment variables **wherever the existing ones
   (`MONGODB_URI`, `API_SECRET`, …) are defined** — a systemd unit's
   `Environment=`/`EnvironmentFile=`, a start script, or an env file. Append
   `pixelalarm` to the existing `ENABLE` list and add the `PIXELALARM_*`
   variables you want to override. Do not modify any existing variable.
7. Restart the server (`sudo systemctl restart <service>`, `pm2 restart
   <name>`, or kill the PID and let the supervisor respawn it).
8. Verify:
   ```bash
   grep pixelalarm /path/to/server.log     # expect: "pixelalarm: feature enabled with config …"
   curl -s -H "api-secret: $HASH" https://your-site/api/v1/pixelalarm/status
   ```
9. Rollback if needed: `git checkout <old-commit> && npm install` and
   restart. (The `pixelalarm` Mongo collection is inert to older code and can
   stay.)
