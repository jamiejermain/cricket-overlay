// ─────────────────────────────────────────────────────────────
//  Cricket overlay settings — edit this file to change teams,
//  colours, logos and timings. No other file needs touching.
// ─────────────────────────────────────────────────────────────
window.OVERLAY_CONFIG = {
  match: {
    title: 'U12 DIVISION 2 · ROUND 5',   // shown on the scorecards
    oversPerInnings: 20,
    playersPerSide: 11,
    maxOversPerBowler: 4,
  },

  // Colours are hex codes. `logo` can be an image URL or file path
  // (e.g. 'logos/tigers.png'); leave it '' to use a generated badge.
  // `keeper` is the position (0 = first) of the wicketkeeper in `players`.
  teams: {
    home: {
      name: 'Tigers', short: 'TIG',
      primary: '#f47b20', accent: '#ffd166',
      logo: '', keeper: 1,
      players: ['Liam Carter', 'Noah Bennett', 'Oliver Hayes', 'Jack Murphy', 'William Ross',
                'Henry Walsh', 'Lucas Grant', 'Harry Doyle', 'Charlie Reid', 'Leo Fraser', 'Archie Quinn'],
    },
    away: {
      name: 'Hawks', short: 'HAW',
      primary: '#1f4fd1', accent: '#7cc4ff',
      logo: '', keeper: 1,
      players: ['Ethan Brooks', 'Mason Kelly', 'Cooper Lane', 'Hudson Price', 'Max Turner',
                'Riley Shaw', 'Lachlan Ward', 'Hunter Black', 'Xavier Cole', 'Flynn Hart', 'Toby Nash'],
    },
  },
  battingFirst: 'home',

  // How long each graphic stays up (milliseconds)
  timings: {
    hype: 5000,          // FOUR! / SIX!
    wicket: 7000,        // WICKET! with the batter's innings and the fall of wicket
    battingCard: 10000,  // end of over
    bowlingCard: 10000,  // end of over
    worm: 20000,         // end of over, replaces the two cards…
    wormEvery: 5,        // …every 5th over
    breakCard: 10000,    // each card during a drinks break (Break button in the scorer)
    summaryCard: 15000,  // end of match: the summary (both innings, top batters and bowlers)…
    endCard: 12000,      // …then each scorecard and the worm, on a loop until "Back to score bar"
    manualHold: 60000,   // cards shown from the scorer stay up until "Back to score bar", or this long
  },
  hype: { fours: true, sixes: true, wickets: true, milestones: true },  // milestones = FIFTY! / CENTURY!

  showLiveTag: false,      // "● LIVE" tag in the top-left corner (off: viewers know it's live)
  statusRotateMs: 6000,    // score bar status line cycles: status → run rate → partnership

  demo: { ballIntervalMs: 2500 },  // simulated match speed
};
