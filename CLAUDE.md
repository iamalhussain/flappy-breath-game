# Claude Code project notes — Flappy Breath Game

This file is read automatically by Claude Code when you start it in this folder. It tells the assistant what this project is, how it's built, and how to make changes without breaking things.

## What this project is

A breath-and-voice-controlled Flappy Bird clone used as a vocal training tool. The bird's lift is driven by live microphone amplitude. Players are prompted to sustain specific letters or phonemes; failing to hold the sound causes the bird to drop into the pipes.

Target users: shy/introverted speakers, singers, language learners (English and Arabic).

## Stack and constraints

- Pure client-side. **No build step. No bundler. No npm install required.**
- React 18 and Babel Standalone are loaded from CDN in `Breath Trainer.html`.
- JSX files are compiled in the browser at runtime via `<script type="text/babel">`.
- Web Audio API is used for microphone capture and FFT analysis.
- Must be served over `localhost` or HTTPS — `file://` will not work because of `<script src>` and microphone permissions.

## Files

- `Breath Trainer.html` — entry HTML, CSS, CDN script tags. Loads `tweaks-panel.jsx` first, then `app.jsx`.
- `app.jsx` — game loop, audio analysis (RMS + band energy), bird physics, pipe spawning, prompts, rendering.
- `tweaks-panel.jsx` — reusable settings panel: `useTweaks`, `TweaksPanel`, `TweakSlider`, `TweakToggle`, `TweakSelect`, `TweakRadio`, `TweakButton`.
- `uploads/` — image assets (bird sprite, reference screenshots).

## Conventions

- Keep everything browser-runnable without a build step. Do **not** introduce Webpack, Vite, or `import`/`export` ES modules — Babel Standalone with `<script type="text/babel">` won't resolve them.
- Prefer functional React components with hooks (`useState`, `useEffect`, `useRef`, `useCallback`). The existing code already uses this style.
- Audio code lives in `app.jsx`. Helper functions like `computeRMS`, `bandEnergy`, `clamp`, and `lerp` are at the top of that file — reuse them, don't duplicate.
- Tweaks/settings UI should use the components from `tweaks-panel.jsx`, not hand-rolled `<input>` elements.
- Bilingual support: when adding user-facing text, provide both English and Arabic strings, and respect `html[lang="ar"]` for RTL layout.
- Arabic content target: clear Iraqi dialect that stays understandable across the Arab world ("white" Iraqi).

## How to run

```bash
python3 -m http.server 8000
# then open http://localhost:8000/Breath%20Trainer.html
```

## Common tasks you might ask Claude Code to do

- Adjust difficulty (pipe gap size, scroll speed, lift sensitivity).
- Add new prompts (specific letters, words, phrases) in English or Arabic.
- Tune audio thresholds (RMS gate, frequency band weighting).
- Add a stats overlay (longest sustained note, sessions completed).
- Improve mobile layout and touch interactions.

## What to avoid

- Don't add a package.json + bundler unless explicitly asked. It would force a rewrite of how scripts are loaded.
- Don't commit secrets or API keys.
- Don't change the visual identity (TikTok-style neon palette in `:root` CSS variables) without asking.
- Don't strip the Arabic support.
