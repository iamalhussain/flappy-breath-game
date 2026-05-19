# Flappy Breath Game

A Flappy Bird–style game controlled by your **voice and breath**, built to help people train sustained phonation, breath support, and consonant articulation. The bird stays alive while you hold a steady sound. Drop your breath or volume and you crash into the pipes.

Built as a coaching tool for shy speakers, singers, and anyone working on vocal control. Supports English and Arabic prompts.

## How it works

- The browser captures your microphone with the Web Audio API.
- RMS amplitude (loudness) and frequency-band energy drive the bird's lift.
- On-screen prompts cue specific letters or sounds to sustain.
- The game gives real-time feedback on whether you're holding the target sound long enough.

## Tech stack

- **HTML / CSS** — UI, layout, theming (TikTok-style neon palette).
- **React 18** — loaded from CDN, no build step.
- **Babel Standalone** — compiles JSX in the browser at runtime.
- **Web Audio API** — microphone capture and analysis.

No npm install, no bundler, no dependencies to manage. Just open it in a browser.

## Project structure

```
flappy-breath-game/
├── Breath Trainer.html    # Entry point — open this in the browser
├── app.jsx                # Main game logic, audio analysis, render loop
├── tweaks-panel.jsx       # Reusable controls panel (sliders, toggles, etc.)
├── uploads/               # Sprites and reference images
├── README.md
└── .gitignore
```

## Running locally

Because the HTML loads `app.jsx` and `tweaks-panel.jsx` via `<script src="…">`, browsers block this when you open the file directly (`file://`). You need a tiny local server.

The simplest option, from inside the project folder:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/Breath%20Trainer.html> in Chrome or Safari.

Alternative if you have Node installed:

```bash
npx serve .
```

When the page loads, grant microphone permission. Speak or hum into the mic to fly.

## Browser support

Tested on the latest Chrome and Safari. Requires:

- Microphone permission
- A modern browser with Web Audio API support
- HTTPS or `localhost` (microphone access is blocked on `file://` and plain HTTP from non-local origins)

## Development workflow

1. Edit `app.jsx` or `tweaks-panel.jsx` in your editor.
2. Refresh the browser — Babel recompiles on load.
3. Commit your change with a clear message:

   ```bash
   git add .
   git commit -m "Tune lift sensitivity for soft consonants"
   git push
   ```

## Roadmap

- [ ] Difficulty curve tuned for breath length goals
- [ ] Arabic letter prompts with Iraqi-dialect phonetic hints
- [ ] Session stats: longest sustained note, accuracy per phoneme
- [ ] Coach mode for live sessions
- [ ] Mobile/iOS support

## License

Private — all rights reserved.

## Author

**Alhussain Aljewad** — engineer, performance coach, content creator.
