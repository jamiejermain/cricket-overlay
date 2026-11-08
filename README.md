# Cricket live-stream overlay + scorer

| Page | What it's for |
|---|---|
| `score.html` | Live scorer for a phone, foldable or iPad. Set up teams (colours, logos, players), score ball by ball, control the overlay. |
| `overlay.html?ch=CODE` | The overlay for PRISM's Web widget. Follows whatever is published on that channel. Get the exact link from the scorer's Settings. |
| `overlay.html?demo` | Pretend match with test controls. |
| `relay.html` | Follows a game on PlayHQ's live scoring and publishes it to the channel instead of the scorer (see below). |

## PlayHQ relay (no webhook needed)

PlayHQ's game page reads a public "spectator" feed (`spectator.playhq.com/graphql`) with the scorecard and ball-by-ball. PlayHQ only lets its own pages read it (other servers get a 403, other sites are refused by CORS), and its pages can't send data to other sites (CSP). So the relay runs in the user's own browser:

1. The **📡 Cricket relay** bookmarklet, tapped on the playhq.com game page, opens `relay.html` in a small window and answers that window's requests by fetching PlayHQ's feed (as the page itself does).
2. `relay.html` polls every 4 s, converts PlayHQ's data with `phq.js` into the same `setup` / `state` / `event` shape, and publishes to `/ch/<code>/live` with the scorer key.

Totals, figures, dismissals and FOW come from PlayHQ's structured scorecard; the ball-by-ball text gives this over, the worm, strike and hype events. Needs the PlayHQ page open with the screen on (laptop or iPad). Don't score the same match in the scorer at the same time.

## How the pieces fit

```
 score.html ──PUT (scorer key)──┐
                                ├─> AWS: API Gateway → Lambda → DynamoDB ──poll 1/s──> overlay.html (PRISM)
 PlayHQ webhooks ──POST─────────┘    (stack "cricket-live", ap-southeast-2)
```

Everything runs in the personal AWS account **730335344374** (profile `songbook`, region `ap-southeast-2`). It's one CloudFormation stack called `cricket-live`, and every resource is tagged `project=cricket-live`.

| Resource | Purpose |
|---|---|
| `cricket-live-api` Lambda | the whole backend (`backend/index.mjs`) |
| HTTP API | `GET /ch/{code}/feed` (overlay), `GET/PUT /ch/{code}/doc/{path}` (scorer), `POST /playhq/{secret}` (PlayHQ), `GET /health` |
| `cricket-live` DynamoDB table | channel documents + raw PlayHQ events (kept 30 days) |
| `cricket-live-artifacts-…` S3 bucket | private; holds the packaged Lambda code for deploys |

### Channel documents (`/ch/<code>/…`)

| Doc | Written by | Contents |
|---|---|---|
| `live` | scorer **or** PlayHQ receiver | `{ setup, tick: { state, event } }`: the only thing the overlay draws from |
| `cmd` | scorer | `{ id, kind }`: batting / bowling / worm / break / clear / hide / show |
| `prefs` | scorer | `{ autoCards, autoHype }` |
| `scorer` | scorer | `{ setup, actions, seq }` so another device can carry on (needs key to read) |
| `library` | scorer | saved teams (needs key to read) |

- `setup` = match title, overs, wide and no-ball runs, teams (name, short code, colours, logo, players, keeper).
- `state` = `toState()` in `engine.js`.
- `event` = `{ seq, kind: 'ball'|'undo'|'other', boundary, wicket, overComplete, inningsComplete, batter, credited }`.

**Security:** the first scorer key that writes to a channel claims it; after that only that key can write. The overlay link (channel code only) is read-only. The "score on another device" link includes the key, so keep it private.

**PlayHQ plan:** PlayHQ's webhooks go to `POST /playhq/<secret>`. Raw events are already stored (`pk = playhq#raw`) so we can see the real payloads. Next step: link a PlayHQ game ID to a channel, convert their scorecard and score events into the same `setup` / `state` / `event` shape, and write `/ch/<code>/live`. The overlay and the PRISM link don't change. The webhook URL is in the Lambda's `PLAYHQ_SECRET` environment variable:
`aws --profile songbook lambda get-function-configuration --function-name cricket-live-api --query Environment.Variables.PLAYHQ_SECRET`

## Deploying backend changes

```bash
infra/deploy.sh
```

It refuses to run unless the `songbook` profile is account 730335344374, packages `backend/`, deploys the stack and rewrites `backend.js` with the API address. Then commit and push to update GitHub Pages.
