# Hummingbird 🐤

A voice-controlled Flappy Bird that trains your breath, resonance, and projection.

**[▶ Play it now](https://iamalhussain.github.io/flappy-breath-game/)**

## What it is

Pick one of seven phonemes — `s`, `z`, `sh`, `f`, `v`, `m`, `n` (or their Arabic equivalents) — and sustain that sound to lift the bird through the pipes. The louder and steadier you go, the higher you fly. Stop and the bird drops.

Each letter trains something different:

- **M, N** — *mask resonance.* Voice in the face, not the throat.
- **Z, V** — *coordination.* Vocal-cord vibration meeting restricted airflow.
- **S, SH, F** — *breath control.* Pure airflow without voicing.

After each round you get a one-liner about the speech-mechanics fact behind your letter — the game is a small disguised vocal exercise.

## How it works

The browser captures your microphone, runs an FFT, and scores the spectral shape against per-letter templates. The detector uses:

- **Discriminative-weighted L1 distance** — each band is weighted by how much it actually discriminates the letter from look-alikes.
- **Per-letter shape gates** — voicing presence/absence, formant location (F2), high-freq concentration.
- **Spectral flatness + formant peakiness** — discriminate voice from background noise (fans, AC, white noise).
- **Adaptive noise floor** — the silence threshold auto-tunes to your room.
- **Per-letter loudness curves** — sqrt response for quiet phonemes so you don't have to shout.

All processing is local. Camera and mic stay on your device. Nothing is uploaded.

## Tech

- **React 18** (via Babel-standalone, no build step)
- **Web Audio API** — `AnalyserNode` + `Uint8Array` FFT data
- **Canvas 2D** — pixel-art game rendering
- **MediaRecorder + canvas.captureStream** — in-game gameplay recording
- **Web Share API** — saves recordings to your phone's Photos
- **GitHub Pages** — static hosting

Three files. No bundler. No npm. Edit `app.jsx`, push, and 30 seconds later it's live.

```
index.html         host page + styles
app.jsx            game logic + detection algorithm
tweaks-panel.jsx   reusable dev-tweaks UI shell
```

## Run locally

```bash
git clone https://github.com/iamalhussain/flappy-breath-game.git
cd flappy-breath-game
python3 -m http.server 8000
# Open http://localhost:8000
```

Camera/mic require either `localhost` or HTTPS. For phone testing on the same WiFi, use [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/) to get a free HTTPS tunnel.

## Credits

Designed and built by [Alhussain Aljewad](https://github.com/iamalhussain) with [Claude](https://claude.com/claude-code).

## License

MIT
