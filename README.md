# Cricket live-stream overlay + scorer

| Page | What it's for |
|---|---|
| `score.html` | Live scorer for a phone, foldable or iPad. Set up teams, score ball by ball, control the overlay. |
| `overlay.html?ch=CODE&db=URL` | The overlay for PRISM's Web widget. Follows whatever is published on that channel. |
| `overlay.html?demo` | Pretend match with test controls. |

## How the pieces fit

```
 score.html  ─┐                              ┌─> overlay.html (PRISM, streaming phone)
              ├─> Firebase /ch/<code>/live ──┤
 PlayHQ ──────┘    (one shared format)       └─> (any other screen)
 (later, via a small webhook receiver)
```

Everything for one stream lives under `/ch/<code>/` in a Firebase Realtime Database:

| Path | Written by | Contents |
|---|---|---|
| `live` | scorer **or** PlayHQ receiver | `{ setup, tick: { state, event } }`: the only thing the overlay draws from |
| `cmd` | scorer | `{ id, kind }`: show batting / bowling / worm / clear / hide / show |
| `prefs` | scorer | `{ autoCards, autoHype }` |
| `scorer` | scorer | `{ setup, actions, seq }` so another device can carry on the same match |
| `library` | scorer | saved teams |

- `setup` = match title, overs, wide and no-ball runs, teams (name, short code, colours, logo, players, keeper).
- `state` = `toState()` in `engine.js`: innings with batters, bowlers, extras, fall of wickets, worm points, this over.
- `event` = `{ seq, kind: 'ball'|'undo'|'other', boundary, wicket, overComplete, inningsComplete, batter, credited }`. The overlay plays hype screens only when `seq` goes up by exactly one with `kind: 'ball'`.

**PlayHQ plan:** a small function (e.g. AWS Lambda with a function URL) receives PlayHQ's live-game webhooks, maps the scorecard and score events into the same `setup` / `state` / `event` shape, and writes `/ch/<code>/live`. The overlay and the PRISM link don't change.

## One-time Firebase setup (about 5 minutes)

1. Go to <https://console.firebase.google.com>, sign in with Google, **Create a project** (any name, Analytics off).
2. **Build → Realtime Database → Create database.** Pick **Singapore (asia-southeast1)**, start in **locked mode**.
3. **Rules** tab: replace everything with the rules below, then **Publish**.
   ```json
   {
     "rules": {
       "ch": { "$ch": { ".read": true, ".write": true } }
     }
   }
   ```
   Only someone who knows a channel code can read or change that channel, and nobody can list the channels.
4. Copy the database URL from the **Data** tab (`https://…-default-rtdb.asia-southeast1.firebasedatabase.app`).
5. In `score.html`, tap the status pill or ☰ → **Settings**, paste the URL, **Save & test**.
6. Copy the **Overlay link** from Settings into PRISM's Web widget. It stays the same every week.
