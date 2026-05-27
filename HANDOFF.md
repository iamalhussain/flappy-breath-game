# Hummingbird — Project Handoff

Paste this file (or attach it) when starting a new Claude conversation about this project. It contains everything a fresh Claude needs to be useful immediately.

---

## What this is

**Hummingbird** is a voice-controlled Flappy Bird game where players sustain specific phoneme sounds (`s`, `z`, `sh`, `f`, `v`, `m`, `n`) to lift the bird through pipes. Each phoneme trains a different vocal skill (breath control, resonance, voicing coordination). Bilingual: English + Arabic.

It's the flagship game of **Sawtlab** ("sawt" = Arabic for voice/sound + "lab"), a planned platform of voice/communication-training games and tools.

---

## Live state

| Thing | URL / value |
|---|---|
| **Production site** | https://sawtlab.com |
| **Backup URL** | https://hummingbird-erb.pages.dev (same site via Cloudflare's default) |
| **Old URL (deprecated)** | https://iamalhussain.github.io/hummingbird/ (301-redirects to sawtlab.com; will be disabled when repo goes private) |
| **GitHub repo** | https://github.com/iamalhussain/hummingbird (currently **public**, planned to go private) |
| **Local folder** | `/Users/alhussain/Hummingbird/` |
| **Hosting** | Cloudflare Pages (auto-deploys on every push to `main`) |
| **DNS** | Cloudflare nameservers (`rajeev.ns.cloudflare.com`, `lana.ns.cloudflare.com`) — sawtlab.com is registered/managed at Cloudflare |
| **HTTPS** | Auto via Cloudflare |

Push to `main` → Cloudflare builds → live in ~30-90s. There is no build step (no webpack, no bundler) — files are served as-is.

---

## Tech stack

- Plain HTML + JSX (no build step)
- React 18 loaded from CDN (`unpkg.com/react@18.3.1`)
- Babel standalone compiles JSX in-browser
- Web Audio API for mic input + FFT analysis
- Canvas for game rendering
- MediaRecorder + canvas.captureStream for recording
- Web Share API (mobile) / download anchor (desktop) for saving recordings
- Cloudflare Pages for hosting

---

## File structure

```
/Users/alhussain/Hummingbird/
├── index.html              ← Entry. Loads React+Babel from CDN. Meta tags, manifest, PWA setup.
├── app.jsx                 ← All game logic, React components, voice detection. ~1500 lines.
├── tweaks-panel.jsx        ← Reusable in-game tuning panel (sliders, toggles, EN/AR controls).
├── favicon.svg             ← Yellow bird icon
├── og-image.svg            ← Social-share preview (1200×630)
├── manifest.webmanifest    ← PWA install metadata
├── README.md               ← Public-facing README
├── CNAME                   ← Legacy GitHub Pages custom-domain marker; harmless
└── .gitignore
```

---

## Voice detection — the most complex part

Core function: `letterStrength(freqData, sampleRate, fftSize, letter, gateMult)` in app.jsx (~line 60).

### Pipeline
1. Compute 6 frequency bands: **V** (80-350 Hz), **L** (350-800), **LM** (800-2000), **M** (2000-4000), **H** (4000-7000), **VH** (7000-12000)
2. Apply adaptive noise floor (`_noiseFloor` module-level, takes ~3s to settle on ambient)
3. **For nasals (m, n) only**: hard cutoffs that return 0 if shape isn't nasal
4. Compute spectral template match (uniform L1 for most letters; **weighted L1 for f, n, m**)
5. Apply per-letter gates (`voicelessGate`, `voicedGate`, `fricShape`, plus per-letter specialised gates)
6. Final: `match² × energy_term × scale × gate_product`, clamped to [0, 1]

### Per-letter scales (current values)
```js
const scaleByLetter = {
  s: 6.0, z: 2.1, sh: 6.5, f: 7.0, v: 6.3, m: 2.2, n: 8.5,
};
const matchTolByLetter = {
  s: 2.0, z: 1.2, sh: 1.2, f: 4.0, v: 1.8, m: 4.0, n: 4.0,
};
```

### Weighted L1 distance (only for f, n, m — letters with the hardest discrimination problems)
```js
distWeights = {
  f: { V: 1.0, L: 0.5, LM: 1.0, M: 2.0, H: 2.0, VH: 1.5 },
  n: { V: 1.5, L: 1.0, LM: 3.0, M: 1.5, H: 3.5, VH: 4.0 },
  m: { V: 1.5, L: 2.0, LM: 3.0, M: 2.0, H: 3.0, VH: 3.5 },
};
```
Other letters use uniform weights (all 1.0).

### Loudness curve
- Most letters: linear (`totalE^1.0`)
- `f`: `totalE^0.4` (heavy compression — quiet f still produces meaningful score)
- `s`: `totalE^0.5` (sqrt — phone-mic high-freq rolloff mitigation)

### M/N noise rejection (the hardest tuning problem)
Multiple checks because nasals' spectral shape can be mimicked by low-freq noise (AC hum, pink/brown noise from noise machines):

**Hard cutoffs** (early `return 0`):
- `fM + fH + fVH > 0.30` (too much high-freq for a nasal)
- `flatness > 0.82` (spectrum too smooth — noise-like)
- `(fV + fL) / (fM + fH + fVH) < 1.5` (energy not concentrated enough in low bands)
- `max(vPeakiness, lPeakiness) < 1.5` (no formant peaks — noise)

**Soft gates** (multiplied into final score):
- `mGate / nGate` — LM-band-based M-vs-N separator
- `mNasalShape / nNasalShape` — V+L concentration
- `mVoicedGate / nVoicedGate` — voicing required
- `nasalAntiNoise` — softer fM+fH+fVH check
- `nasalRatioGate` — softer V+L vs M+H+VH check
- `nasalPeaked` — softer flatness check
- `nasalPeakiness` — soft scaling on max(V-peak, L-peak)

### `bandPeakRatio` (key insight)
Returns max-bin / mean-bin within a band. Real voice has sharp formant peaks (ratio 2.5-5+); noise has smooth distributions (ratio ~1.0-1.5). **This is the most reliable single-feature voice-vs-noise discriminator.** It cleanly rejects white/pink/brown noise that mimics nasal *overall* spectral shape but lacks formant structure.

---

## Game UI sections

### Permission card (intro screen)
- EN/AR language toggle (top-right corner of card)
- "Your letter: [glyph]" chip
- 3-step "How to play" instructions
- Two buttons: **Play** (just play) / **Play & Record** (play + record + save on game-over)
- Privacy notice ("Video and audio stay on your device")

### Gameplay (in-game HUD)
- Bird (pixel-art canvas character) rises when sound is detected, falls otherwise
- Pipes scroll right-to-left, score = pipes passed
- **Big-score panel** (right side): coin animation + "SCORE" pill + big number + combo chip
- "Say [letter]" banner appears briefly at game start (then fades)
- "Don't let your bird fall" hint appears once after the say-banner clears
- HUD record button (bottom-right; hidden on phones that don't support screen capture)

### Game-over card
- "GAME OVER" label
- Final score (big)
- Best streak
- "**Did you know...**" per-letter educational fact (cyan-tinted block) — see `LETTER_FACTS` in app.jsx
- **"Save recording"** button (mobile only, appears when navigator.share couldn't auto-fire)
- "Play again" button

### Tweaks panel (slides out from bottom-right)
Live tuning sliders for:
- Letter selector (Arabic mode hides `v`, since Arabic lacks that letter)
- Per-letter target strength
- Sensitivity, smoothing, noise gate
- Responsiveness (spring stiffness)
- Visual options (webcam visibility, meter, character variant)
- Game physics (gap size, column spacing, scroll speed)

The panel writes back to the persisted `TWEAK_DEFAULTS` in index.html via a postMessage protocol from `tweaks-panel.jsx`.

---

## Recording

### Two paths depending on platform
**Desktop:**
- Uses `getDisplayMedia` (screen-share picker)
- On game-over, downloads `hummingbird-<timestamp>.mp4` to Downloads folder
- No share sheet — just a direct download

**Mobile (iPhone/iPad/Android):**
- `getDisplayMedia` doesn't exist on iOS Safari, so we use a **composite canvas approach**:
  - An offscreen canvas the size of the viewport
  - rAF loop draws webcam video + game canvas + recreated HUD overlays into it
  - `canvas.captureStream(30)` produces the video stream
  - Mic audio mixed in via MediaStream tracks
- Saves via Web Share API → user picks "Save Video" → goes to Photos

### Auto-stop on game-over
A `useEffect` watches `stats.gameOver` and stops the recorder ~400ms after game-over (so the crash frame is captured). On mobile, since the original "Play & Record" tap gesture has expired by game-over, `navigator.share` fails — we stash the blob in `pendingRecording` state and surface a **"Save recording"** button on the game-over card that the user taps (fresh gesture → share works).

`IS_MOBILE_PLATFORM` constant detects mobile via UA regex + `maxTouchPoints` (catches iPads in Request-Desktop-Site mode).

---

## Key conventions

### Auto-push everything
**Every code change is auto-committed and pushed to `origin/main` without asking.** This is saved in Claude memory at `/Users/alhussain/.claude/projects/-Users-alhussain-Hummingbird/memory/auto_push.md`. The live site updates within ~30-90s of every push.

Don't ask before pushing routine code changes. Do still ask before destructive ops (force push, hard reset, deleting files, repo settings changes, visibility changes).

### Bilingual
Every user-visible string has both EN and AR variants. Arabic uses `dir="rtl"` containers and `Noto Sans Arabic` font. The `LETTER_GLYPHS` and `LETTER_FACTS` objects have parallel `en` and `ar` keys.

### Commit messages
Descriptive (not "hello"). One-line summary + optional body explaining "why" not "what." Always co-authored:
```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

## Pending work

1. **Add www.sawtlab.com** as second custom domain in Cloudflare Pages dashboard.
2. **Switch GitHub repo to private** (Cloudflare Pages still works with private repos via its GitHub App).
3. **Disable GitHub Pages** on the `hummingbird` repo once Cloudflare is the only host.

---

## Hard-won gotchas (don't relearn these)

- **iOS Safari has no `getDisplayMedia`** — phone recording REQUIRES the composite canvas approach.
- **`navigator.share()` needs an active user gesture** — for auto-triggered shares (game-over), defer with a button that the user taps.
- **White/pink/brown noise mimics nasal shape** — formant peakiness (`bandPeakRatio`) is the only reliable discriminator. Shape-based gates alone aren't enough.
- **Phone mics suppress 7+ kHz heavily** — S's VH band (which holds 45% of desktop-S energy) lands at only 15-20% on phones. Weighted L1 with VH down-weighted is the fix.
- **M's `nasalEnergyFloor` over-aggressive** — removed in favor of adaptive noise floor + ratio gate. Don't reintroduce a hard amplitude floor; it kills quiet phone-M.
- **Cloudflare quick tunnels die after a few hours** — was a workaround before Cloudflare Pages; now unused.
- **The user iterates fast and prefers concise responses.** No long preamble. State results directly. Use markdown tables for state summaries.

---

## How to extend (planned features)

Sawtlab's future direction: more games and tools for public speakers / communication skills training. Suggested additions:
- More games using the same voice-detection engine (different mechanics, same letters)
- Drills (specific exercises like sustained note duration, pitch glides)
- Analytics (track which letters the user struggles with over sessions)
- More languages (currently EN + AR; could add ES, FR, etc.)
- Coach mode (real-time feedback on what to improve)

When adding a new game, the voice detection engine in `app.jsx` is the reusable core. Could factor it into a separate module if multiple games coexist.

---

*Last updated: 2026-05-26.*
