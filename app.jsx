/* global React, ReactDOM */
/* global useTweaks, TweaksPanel, TweakSection, TweakSlider, TweakToggle, TweakSelect, TweakRadio, TweakButton */

const { useState, useEffect, useRef, useCallback } = React;

// ── helpers ─────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

// Compute RMS amplitude from time-domain bytes (0..255 centered at 128).
function computeRMS(timeData) {
  let sum = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = (timeData[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / timeData.length);
}

// Average normalized magnitude (0..1) of a frequency band.
function bandEnergy(freqData, sampleRate, fftSize, loHz, hiHz) {
  const nyquist = sampleRate / 2;
  const bins = freqData.length;
  const lo = clamp(Math.floor((loHz / nyquist) * bins), 0, bins - 1);
  const hi = clamp(Math.ceil((hiHz / nyquist) * bins), 0, bins - 1);
  let sum = 0;
  let n = 0;
  for (let i = lo; i <= hi; i++) {
    sum += freqData[i];
    n++;
  }
  return n > 0 ? (sum / n) / 255 : 0;
}

// Score how strongly the input matches the target letter, in 0..1.
// Fricatives (s, z, sh, f, v) are high-frequency continuants — their energy
// concentrates above 2-3 kHz with almost nothing below. Nasals (m, n) are
// voiced hums with low/low-mid formant energy and very little above ~2 kHz.
// Per-letter scoring. We split the spectrum into 6 bands and compare the
// input's *shape* (normalized fractions per band) against a target shape
// for the selected letter. Then we multiply by that letter's own signal
// energy, plus a per-letter scale so a strong "m" and a strong "s"
// produce similar output strengths instead of "m" dominating because
// nasals naturally pack more raw energy than fricatives.
function letterStrength(freqData, sampleRate, fftSize, letter) {
  // 6 bands tuned to the phonetic landmarks we care about.
  //   V  = voicing fundamental (vocal-fold pitch)
  //   L  = first nasal/vowel formant
  //   LM = second formant zone
  //   M  = "sh" peak region
  //   H  = "s/f" peak region
  //   VH = pure-hiss region (s above ~7 kHz)
  const V  = bandEnergy(freqData, sampleRate, fftSize, 80, 350);
  const L  = bandEnergy(freqData, sampleRate, fftSize, 350, 800);
  const LM = bandEnergy(freqData, sampleRate, fftSize, 800, 2000);
  const M  = bandEnergy(freqData, sampleRate, fftSize, 2000, 4000);
  const H  = bandEnergy(freqData, sampleRate, fftSize, 4000, 7000);
  const VH = bandEnergy(freqData, sampleRate, fftSize, 7000, 12000);
  const total = V + L + LM + M + H + VH;
  if (total < 0.12) return 0; // silence floor

  // Normalized fractions — these are the *shape* of the spectrum,
  // independent of how loud the sound is.
  const fV  = V / total;
  const fL  = L / total;
  const fLM = LM / total;
  const fM  = M / total;
  const fH  = H / total;
  const fVH = VH / total;

  // Spectral templates: target fraction per band for each letter.
  // Tuned empirically — the *contrast* between similar letters (s vs sh,
  // s vs z, m vs n) is what matters, so each template emphasizes the
  // band where that letter's energy actually peaks.
  const T = {
    s:  { V: 0.02, L: 0.03, LM: 0.05, M: 0.15, H: 0.30, VH: 0.45 },
    z:  { V: 0.25, L: 0.07, LM: 0.05, M: 0.10, H: 0.28, VH: 0.25 },
    sh: { V: 0.02, L: 0.04, LM: 0.08, M: 0.45, H: 0.32, VH: 0.09 },
    f:  { V: 0.03, L: 0.05, LM: 0.12, M: 0.30, H: 0.35, VH: 0.15 },
    v:  { V: 0.28, L: 0.12, LM: 0.10, M: 0.22, H: 0.20, VH: 0.08 },
    // m vs n: both nasals, both voiced — the key separator is F2.
    // m has lips closed, longer oral cavity → F2 ~1.1kHz (LM low).
    // n has tongue on alveolar ridge → F2 ~1.7-2kHz (LM elevated).
    // n's LM template is moderated from 0.35 to a more realistic 0.25 so
    // the L1 distance for a typical "nnnn" doesn't blow up at this band.
    m:  { V: 0.45, L: 0.42, LM: 0.08, M: 0.03, H: 0.01, VH: 0.01 },
    n:  { V: 0.30, L: 0.25, LM: 0.25, M: 0.15, H: 0.04, VH: 0.01 },
  };
  const t = T[letter];
  if (!t) return total;

  // ── per-letter gates ────────────────────────────────────────────────────
  // L1-distance template matching alone doesn't reliably separate letter
  // pairs that differ in a single spectral feature (s/z & f/v differ only
  // in voicing; m/n differ only in F2). Multiplicative gates on the
  // discriminating band drop a wrong-letter score to ~0.
  const voicelessGate = clamp(1 - fV * 3.2, 0, 1);          // s, sh, f
  const voicedGate    = clamp((fV - 0.02) * 8.0, 0, 1);     // z, v
  // m and n each get their own gates / shape filters so tuning one nasal
  // never affects the other.
  const mGate         = clamp(1 - Math.max(0, fLM - 0.14) * 6, 0, 1);
  const mVoicedGate   = clamp((fV - 0.02) * 8.0, 0, 1);
  const mNasalShape   = clamp(((fV + fL) - 0.45) * 4.0, 0, 1);
  // n's F2 sits anywhere from 1.5–2 kHz; broaden the floor and soften the
  // slope further so a quieter "nnn" doesn't get gated to 0.
  const nGate         = clamp((fLM - 0.06) * 4.0, 0, 1);
  const nVoicedGate   = clamp((fV - 0.02) * 8.0, 0, 1);
  const nNasalShape   = clamp(((fV + fL) - 0.25) * 4.0, 0, 1);
  // Coarse shape: separates nasals from fricatives. Loose threshold so v
  // (the quietest voiced fricative) still passes.
  const fricShape     = clamp(((fM + fH + fVH) - 0.15) * 4.0, 0, 1);

  const dist = Math.abs(fV - t.V) + Math.abs(fL - t.L) + Math.abs(fLM - t.LM)
             + Math.abs(fM - t.M) + Math.abs(fH - t.H) + Math.abs(fVH - t.VH);
  const match = Math.max(0, 1 - dist / 1.2);
  const matchSq = match * match;

  // Generic energy used for all letters so the "loudness-to-output" curve
  // is letter-independent — combined with per-letter scale this means a
  // sustained "ssss" and "ffff" at the same mic input produce comparable
  // strengths instead of one being twice the other.
  const totalE = H + VH * 1.2 + M * 0.9 + L * 0.7 + V * 0.7 + LM * 0.6;
  const scaleByLetter = {
    s: 2.4, z: 1.5, sh: 2.6, f: 4.9, v: 5.5, m: 1.7, n: 6.0,
  };
  const gateByLetter = {
    s:  voicelessGate * fricShape,
    z:  voicedGate    * fricShape,
    sh: voicelessGate * fricShape,
    f:  voicelessGate * fricShape,
    v:  voicedGate    * fricShape,
    // Nasals additionally require voicing — without it, low-amplitude
    // background noise was passing the m gate and flying the bird up.
    m:  mGate         * mNasalShape * mVoicedGate,
    n:  nGate         * nNasalShape * nVoicedGate,
  };
  return clamp(
    matchSq * totalE * scaleByLetter[letter] * gateByLetter[letter],
    0, 1,
  );
}

// ── letter → glyph mapping ──────────────────────────────────────────────────
// User picks a phoneme; we display whichever script they chose. Detection
// always uses the English code internally — only the glyph swaps.
//   s↔س   z↔ز   sh↔ش   f↔ف   m↔م   n↔ن
//   v has no direct Arabic letter (loanwords use ف with diacritics); we map
//   to ف since its sound is closest.
const LETTER_GLYPHS = {
  en: { s: 's', z: 'z', sh: 'sh', f: 'f', v: 'v', m: 'm', n: 'n' },
  ar: { s: 'س', z: 'ز', sh: 'ش', f: 'ف', v: 'ف', m: 'م', n: 'ن' },
};
function glyphFor(letter, lang) {
  return (LETTER_GLYPHS[lang] || LETTER_GLYPHS.en)[letter] || letter;
}

// ── permission gate ─────────────────────────────────────────────────────────
function PermissionCard({ onStart, error, requesting, letter, language }) {
  const glyph = glyphFor(letter, language);
  const isAr = language === 'ar';
  const T = isAr ? {
    title: 'فلابي بيرد · بالنفس',
    body1: 'استمر بإصدار حرف ',
    body2: ' لإبقاء الطائر طائرًا. توقّف فيسقط.',
    cta: 'السماح بالكاميرا والمايك',
    requesting: 'جاري طلب الكاميرا والمايك…',
    privacy: 'الفيديو والصوت يبقيان على جهازك — لا يتم رفع شيء.',
  } : {
    title: 'Flappy Bird · Breath Control',
    body1: 'Sustain a steady ',
    body2: ' to keep the bird in the air. Stop, and it falls.',
    cta: 'Allow camera & mic',
    requesting: 'Requesting camera & mic…',
    privacy: 'Video and audio stay on your device — nothing is uploaded.',
  };
  return (
    <div className="center-card" dir={isAr ? 'rtl' : 'ltr'}>
      <h1>{T.title}</h1>
      <p>
        {T.body1}
        <span className={'letter-chip' + (isAr ? ' ar' : '')}>
          <span className={isAr ? 'ar-glyph' : ''}>{glyph}</span>
        </span>
        {T.body2}
      </p>
      <div className="row">
        <button className="btn primary" onClick={onStart} disabled={requesting}>
          {requesting ? T.requesting : T.cta}
        </button>
      </div>
      {error && <div className="error">⚠ {error}</div>}
      <div className="priv">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d="M5 7V5a3 3 0 0 1 6 0v2" />
        </svg>
        {T.privacy}
      </div>
    </div>
  );
}

// ── calibration ─────────────────────────────────────────────────────────────
function CalibrationOverlay({ progress, currentStrength, letter }) {
  const R = 60;
  const C = 2 * Math.PI * R;
  return (
    <div className="calibrating">
      <div className="cal-card">
        <div className="cal-ring-wrap">
          <svg viewBox="0 0 140 140">
            <circle cx="70" cy="70" r={R} fill="none"
              className="ring-track" strokeWidth="6" />
            <circle cx="70" cy="70" r={R} fill="none"
              className="ring-fill" strokeWidth="6"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - progress)} />
          </svg>
          <div className="center-num">{Math.ceil((1 - progress) * 3) || 0}</div>
        </div>
        <h2>Hold your "<span style={{ color: 'var(--accent)' }}>{letter}</span>"</h2>
        <p>Sustain the letter at a comfortable, steady level — we're learning the energy that should keep your bird centered.</p>
        <div className="cal-hint">
          Live strength · <span className="mono">{(currentStrength * 100).toFixed(0)}</span>
        </div>
      </div>
    </div>
  );
}

// ── main app ────────────────────────────────────────────────────────────────
function App() {
  const [t, setTweak] = useTweaks(window.TWEAK_DEFAULTS);
  const [phase, setPhase] = useState('intro');
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({ score: 0, hits: 0, streak: 0, bestStreak: 0 });
  const [hudStrength, setHudStrength] = useState(0);
  const [calProgress, setCalProgress] = useState(0);
  const [calStrength, setCalStrength] = useState(0);
  // Inline-runway calibration state. Mirrors gameRef.calibrating / calRemaining
  // so the banner UI can render. Updated in the throttled HUD publish below.
  const [runway, setRunway] = useState({ active: true, remaining: 0.2 });
  // Tracks the transition from runway → game so we can flash the
  // "Don't let your bird fall" hint right after the first pipe arrives.
  // Holds the timestamp when runway ended; null otherwise.
  const [fallHintAt, setShowFallHint] = useState(null);
  const prevRunwayActiveRef = useRef(true);
  useEffect(() => {
    if (prevRunwayActiveRef.current && !runway.active) {
      // Just ended.
      setShowFallHint(performance.now());
    }
    prevRunwayActiveRef.current = runway.active;
  }, [runway.active]);
  useEffect(() => {
    if (fallHintAt == null) return undefined;
    const id = setTimeout(() => setShowFallHint(null), 2200);
    return () => clearTimeout(id);
  }, [fallHintAt]);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const audioRef = useRef(null);
  const rafRef = useRef(0);
  const offCanvasRef = useRef(null);

  const gameRef = useRef({
    smoothed: 0,
    strengthRaw: 0,
    birdY: 0,
    birdVy: 0,
    cols: [],
    spawnTimer: 0,
    flashTimer: 0,
    bgScroll: 0,
    groundScroll: 0,
    wingPhase: 0,
    score: 0,
    hits: 0,
    streak: 0,
    bestStreak: 0,
    initialized: false,
    // Inline calibration runway: when active, no pipes spawn and we keep
    // sampling the user's letterStrength. Calibration ends when calRemaining
    // hits 0, the median sample becomes targetStrength, and the first pipe
    // arrives a moment later.
    calibrating: true,
    calRemaining: 5,
    calSamples: [],
  });

  // Reflect language on <html> so Noto Sans Arabic kicks in and any
  // direction-sensitive UI flows the right way.
  useEffect(() => {
    document.documentElement.lang = t.language === 'ar' ? 'ar' : 'en';
  }, [t.language]);

  const tRef = useRef(t);
  tRef.current = t;

  // ── start: request permissions ───────────────────────────────────────────
  const start = useCallback(async () => {
    setRequesting(true);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;
      const v = videoRef.current;
      v.srcObject = stream;
      await v.play().catch(() => {});

      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.2;
      src.connect(analyser);
      audioRef.current = {
        ctx,
        analyser,
        sampleRate: ctx.sampleRate,
        timeData: new Uint8Array(analyser.fftSize),
        freqData: new Uint8Array(analyser.frequencyBinCount),
      };
      setRequesting(false);
      // Skip the standalone calibration phase — calibration now runs inside
      // the game itself for the first few seconds ("runway").
      const g = gameRef.current;
      g.calibrating = true;
      g.calRemaining = 0.2;
      g.calSamples = [];
      setPhase('playing');
    } catch (e) {
      setRequesting(false);
      setError(e.message || 'Permission denied.');
    }
  }, []);

  // ── game loop ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'playing') return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');

    // Offscreen low-res canvas: classic pixel-art look via nearest-neighbor upscale.
    const PIXEL = 4;
    let offCanvas = offCanvasRef.current;
    if (!offCanvas) {
      offCanvas = document.createElement('canvas');
      offCanvasRef.current = offCanvas;
    }

    const resize = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      offCanvas.width = Math.max(60, Math.round(cssW / PIXEL));
      offCanvas.height = Math.max(40, Math.round(cssH / PIXEL));
      const g = gameRef.current;
      if (!g.initialized) {
        g.birdY = offCanvas.height * 0.5;
        g.initialized = true;
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let lastT = performance.now();
    const tick = (now) => {
      const dt = Math.min(50, now - lastT) / 1000;
      lastT = now;
      const tw = tRef.current;
      const g = gameRef.current;

      // ── audio analysis ────────────────────────────────────────────────
      const a = audioRef.current;
      if (a) {
        a.analyser.getByteFrequencyData(a.freqData);
        g.strengthRaw = letterStrength(
          a.freqData, a.sampleRate, a.analyser.fftSize, tw.letter,
        );
        const sm = clamp(tw.smoothing / 100, 0, 0.97);
        g.smoothed = g.smoothed * sm + g.strengthRaw * (1 - sm);
      }

      // ── inline calibration runway ─────────────────────────────────────
      // While `calibrating` is true we sample letterStrength into a buffer
      // and hold off on spawning pipes. When the runway timer expires we
      // compute the captured median, write it to targetStrength, and let
      // normal play begin.
      if (g.calibrating) {
        g.calSamples.push(g.strengthRaw);
        g.calRemaining = Math.max(0, g.calRemaining - dt);
        if (g.calRemaining <= 0) {
          const sorted = [...g.calSamples].sort((a, b) => a - b);
          const upper = sorted.slice(Math.floor(sorted.length / 2));
          const median = upper[Math.floor(upper.length / 2)] || 0.1;
          const captured = Math.max(8, Math.round(median * 100));
          setTweak('targetStrength', captured);
          g.calibrating = false;
          g.calSamples = [];
          g.spawnTimer = 0;
        }
      }

      // ── physics: gravity + lift from sound ────────────────────────────
      // strength / targetStrength = 1.0 when user matches their calibration;
      // we want lift = gravity at that point so the bird hovers.
      // Power curve: lift = gravity * ratio^sensitivity.
      // Crucially this means ratio=1 (user matched their calibration) ALWAYS
      // produces lift==gravity → exact hover, regardless of sensitivity.
      // Sensitivity is now the curve's exponent — low (e.g. 0.2) flattens
      // the response so big level swings move the bird gently; high (e.g.
      // 1.5) makes it twitchy. ratio=0 (silence) → lift=0 → free fall.
      // Lift cap prevents loud bursts from yeeting the bird.
      // Spring physics: the bird is pulled toward a target position derived
      // from the strength ratio. Holding a steady level → constant target →
      // bird settles there. No drift. The earlier acceleration-based model
      // accumulated velocity whenever the ratio was even slightly above 1,
      // which is exactly what was making sustained hisses creep upward.
      const offW = offCanvas.width;
      const offH = offCanvas.height;
      const groundH = 10;
      const skyTop = 0;
      const skyBot = offH - groundH;
      const playH = skyBot - skyTop;
      const centerY = (skyTop + skyBot) / 2;
      const birdR = 6;

      const target = Math.max(0.02, tw.targetStrength / 100);
      const ratio = Math.max(0, g.smoothed / target);
      const above = Math.max(0, ratio - 1);
      const below = Math.max(0, 1 - ratio);
      // Rise: linear in `above`, scaled by sensitivity. Caps at 1 so the
      // bird reaches the ceiling once the user is loud enough — with low
      // sensitivity it takes a much louder input to get there.
      // Use a saturating curve so even loud bursts can reach the ceiling
      // without sensitivity having to be cranked up. above=0 → 0, above=1
      // (2x target) → ~0.6, above=3 (4x target) → ~0.9, plateau near 1.
      const riseAmount = 1 - Math.exp(-above * tw.sensitivity * 1.5);
      // Fall: curve from 0 (matched) to 1 (silent). The exponent flattens
      // the curve near the matched level for forgiving feel while still
      // guaranteeing that ratio=0 always produces fall=1 → floor.
      const fallExp = 1 / Math.max(0.3, tw.sensitivity * 2);
      const fallAmount = Math.pow(below, fallExp);
      // Deviation in [-1, +1]: -1 = floor, 0 = center, +1 = ceiling.
      const deviation = clamp(riseAmount - fallAmount, -1, 1);
      const desiredY = centerY - deviation * (playH * 0.5 - birdR);
      const targetY = clamp(desiredY, skyTop + birdR, skyBot - birdR);

      // The Tweaks "Responsiveness" slider (`gravity` key for back-compat)
      // controls spring stiffness. Damping is set to critical so the bird
      // doesn't oscillate around the target.
      const K = Math.max(1, tw.gravity / 90);
      const damping = 2 * Math.sqrt(K);
      const accel = (targetY - g.birdY) * K - g.birdVy * damping;
      g.birdVy += accel * dt;
      g.birdVy = clamp(g.birdVy, -250, 250);
      g.birdY += g.birdVy * dt;
      if (g.birdY < skyTop + birdR) { g.birdY = skyTop + birdR; g.birdVy = Math.max(0, g.birdVy); }
      if (g.birdY > skyBot - birdR) { g.birdY = skyBot - birdR; g.birdVy = Math.min(0, g.birdVy); }

      g.wingPhase += dt * 14;

      // ── parallax bg ───────────────────────────────────────────────────
      const speedOffPx = tw.scrollSpeed / PIXEL;
      g.bgScroll = (g.bgScroll + dt * speedOffPx * 0.15) % 1000;
      g.groundScroll = (g.groundScroll + dt * speedOffPx * 1.0) % 1000;

      // ── pipes ─────────────────────────────────────────────────────────
      const spacingPx = tw.columnSpacing / PIXEL;
      const spawnInterval = spacingPx / speedOffPx;
      if (!g.calibrating) {
        g.spawnTimer += dt;
        if (g.spawnTimer >= spawnInterval || g.cols.length === 0) {
          g.spawnTimer = 0;
          const wobble = Math.sin(performance.now() * 0.0008) * 0.05;
          const gapCenter = (skyBot - skyTop) * (0.5 + wobble) + skyTop;
          g.cols.push({
            x: offW + 30,
            gapY: gapCenter,
            gapH: (tw.gapSize / 100) * (skyBot - skyTop),
            scored: false,
            hit: false,
          });
        }
      }

      const colW = tw.columnWidth; // already in offscreen pixels (chunky)
      const birdX = Math.round(offW * 0.22);
      // birdR already declared above in the physics block
      for (const c of g.cols) {
        c.x -= speedOffPx * dt;
        const left = c.x - colW / 2;
        const right = c.x + colW / 2;
        const gapTop = c.gapY - c.gapH / 2;
        const gapBot = c.gapY + c.gapH / 2;
        const horiz = birdX + birdR > left && birdX - birdR < right;
        if (horiz) {
          if (g.birdY - birdR < gapTop || g.birdY + birdR > gapBot) {
            if (!c.hit) {
              c.hit = true;
              g.hits++;
              g.streak = 0;
              g.flashTimer = 0.3;
            }
          }
        }
        if (!c.scored && c.x < birdX - colW / 2 - birdR) {
          c.scored = true;
          if (!c.hit) {
            g.score++;
            g.streak++;
            if (g.streak > g.bestStreak) g.bestStreak = g.streak;
          }
        }
      }
      g.cols = g.cols.filter((c) => c.x > -colW);
      if (g.flashTimer > 0) g.flashTimer = Math.max(0, g.flashTimer - dt);

      // ── publish HUD state (throttled) ─────────────────────────────────
      if (!tick.lastHud || now - tick.lastHud > 80) {
        tick.lastHud = now;
        setHudStrength(g.smoothed);
        setRunway((prev) => {
          if (prev.active === g.calibrating &&
              Math.abs(prev.remaining - g.calRemaining) < 0.1) return prev;
          return { active: g.calibrating, remaining: g.calRemaining };
        });
        setStats((s) => {
          if (s.score === g.score && s.hits === g.hits &&
              s.streak === g.streak && s.bestStreak === g.bestStreak) return s;
          return { score: g.score, hits: g.hits, streak: g.streak, bestStreak: g.bestStreak };
        });
      }

      // ── draw ──────────────────────────────────────────────────────────
      drawScene(offCanvas, g, tw, birdX, groundH);
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      ctx.drawImage(offCanvas, 0, 0, canvas.clientWidth, canvas.clientHeight);

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [phase]);

  // Cleanup media
  useEffect(() => () => {
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (audioRef.current && audioRef.current.ctx) {
      audioRef.current.ctx.close().catch(() => {});
    }
  }, []);

  const recalibrate = () => {
    const g = gameRef.current;
    g.calibrating = true;
    g.calRemaining = 0.2;
    g.calSamples = [];
    g.cols = [];
    g.spawnTimer = 0;
    setCalProgress(0);
    setCalStrength(0);
    setShowFallHint(performance.now());
  };
  const resetScore = () => {
    const g = gameRef.current;
    g.score = 0; g.hits = 0; g.streak = 0; g.bestStreak = 0; g.cols = [];
    setStats({ score: 0, hits: 0, streak: 0, bestStreak: 0 });
  };

  // Bar normalisation: target sits ~middle (50%) so user can see deviation.
  const meterPct = clamp((hudStrength / Math.max(0.02, t.targetStrength / 100)) * 50, 0, 100);
  const targetMarker = 50;
  const sideMeterTargetPct = 100 - targetMarker;
  const sideMeterFillPct = clamp(meterPct, 0, 100);

  return (
    <div className="stage" data-screen-label="Breath trainer">
      <div className={`vid-wrap ${phase !== 'intro' ? '' : 'idle'}`}>
        <video ref={videoRef} muted playsInline
               style={{ opacity: t.showWebcam ? 1 : 0.04 }} />
        <div className="vignette"></div>
      </div>

      {/* Top HUD: just score stats, no brand */}
      <div className="hud-top">
        <div></div>
        {phase === 'playing' && !runway.active && (
          <div className="stat-rail">
            <div className="stat">
              <div className="lbl">Cleared</div>
              <div className="val good">{stats.score}</div>
            </div>
            <div className="stat">
              <div className="lbl">Hits</div>
              <div className={`val ${stats.hits > 0 ? 'warn' : ''}`}>{stats.hits}</div>
            </div>
            <div className="stat">
              <div className="lbl">Streak</div>
              <div className="val">{stats.streak}<span style={{
                color: 'var(--muted)', fontSize: 11, marginLeft: 4,
              }}>/ {stats.bestStreak}</span></div>
            </div>
          </div>
        )}
      </div>

      {/* Side meter */}
      {phase === 'playing' && t.showMeter && (
        <div className="meter">
          <div className="cap">Strong</div>
          <div className="col">
            <div className="band" style={{
              top: `${sideMeterTargetPct - 4}%`, height: '8%',
            }} />
            <div className="fill" style={{ height: `${sideMeterFillPct}%` }} />
          </div>
          <div className="cap">Quiet</div>
        </div>
      )}

      {/* Center cards */}
      {phase === 'intro' && (
        <PermissionCard onStart={start} error={error} requesting={requesting}
          letter={t.letter} language={t.language} />
      )}
      {phase === 'playing' && runway.active && (
        <div className="runway-banner">
          <div className="runway-banner__say">
            {t.language === 'ar'
              ? <>قل <b className="ar-glyph">“{glyphFor(t.letter, 'ar')}”</b></>
              : <>Say <b>“{glyphFor(t.letter, 'en')}”</b></>}
          </div>
        </div>
      )}
      {phase === 'playing' && !runway.active && fallHintAt != null && (
        <div className="runway-banner runway-banner--exit">
          <div className="runway-banner__say runway-banner__say--soft">
            {t.language === 'ar'
              ? 'لا تدع طائرك يسقط'
              : 'Don’t let your bird fall'}
          </div>
        </div>
      )}
      {phase === 'calibrating' && (
        <CalibrationOverlay progress={calProgress} currentStrength={calStrength} letter={t.letter} />
      )}

      {phase === 'playing' && (
        <>
          <div className="game-info">
            <div className="pill">
              <span>Letter</span>
              <span className={'letter-chip' + (t.language === 'ar' ? ' ar' : '')}>
                <span className={t.language === 'ar' ? 'ar-glyph' : ''}>
                  {glyphFor(t.letter, t.language)}
                </span>
              </span>
              <span style={{ color: 'var(--dim)' }}>·</span>
              <span>match</span>
              <div className="strength-bar">
                <i style={{ width: `${Math.min(100, meterPct)}%` }} />
                <em style={{ left: `${targetMarker}%` }} />
              </div>
            </div>
            <div className="pill">
              <span>Target</span>
              <b>{Math.round(t.targetStrength)}</b>
              <span style={{ color: 'var(--dim)' }}>·</span>
              <span>now</span>
              <b>{Math.round(hudStrength * 100)}</b>
            </div>
          </div>
          <div className="game-shell">
            <canvas ref={canvasRef}></canvas>
          </div>
          <div className="footnote">
            Hold a steady "<b style={{ color: 'var(--accent)' }}>{t.letter}</b>" — the bird falls when you stop.
          </div>
        </>
      )}

      <TweaksPanel title="Tweaks">
        <TweakSection label="Language">
          <TweakRadio label="Display" value={t.language}
            options={[
              { value: 'en', label: 'EN' },
              { value: 'ar', label: 'عر' },
            ]}
            onChange={(v) => setTweak('language', v)} />
        </TweakSection>
        <TweakSection label="Character">
          <TweakSelect label="Bird" value={t.character}
            options={[
              { value: 'yellow', label: 'Sunny — yellow, big eyes' },
              { value: 'cyan', label: 'Splash — cyan, small eyes' },
              { value: 'pink', label: 'Rosie — pink, blue wing' },
            ]}
            onChange={(v) => setTweak('character', v)} />
        </TweakSection>
        <TweakSection label="Breath letter">
          <TweakSelect label="Letter" value={t.letter}
            options={[
              { value: 's', label: 's — sustained hiss' },
              { value: 'z', label: 'z — voiced s' },
              { value: 'sh', label: 'sh — soft hush' },
              { value: 'f', label: 'f — breathy f' },
              { value: 'v', label: 'v — voiced f' },
              { value: 'm', label: 'm — humming m' },
              { value: 'n', label: 'n — humming n' },
            ]}
            onChange={(v) => setTweak('letter', v)} />
          <TweakSlider label="Target strength" value={t.targetStrength} min={2} max={80} step={1}
            onChange={(v) => setTweak('targetStrength', v)} />
          <TweakSlider label="Sensitivity" value={t.sensitivity} min={0.01} max={2.5} step={0.01}
            onChange={(v) => setTweak('sensitivity', v)} />
          <TweakSlider label="Smoothing" value={t.smoothing} min={0} max={95} step={1} unit="%"
            onChange={(v) => setTweak('smoothing', v)} />
          <TweakButton label="Recalibrate" onClick={recalibrate} />
        </TweakSection>
        <TweakSection label="Physics">
          <TweakSlider label="Responsiveness" value={t.gravity} min={100} max={1800} step={20}
            onChange={(v) => setTweak('gravity', v)} />
        </TweakSection>
        <TweakSection label="Pipes">
          <TweakSlider label="Gap size" value={t.gapSize} min={25} max={75} step={1} unit="%"
            onChange={(v) => setTweak('gapSize', v)} />
          <TweakSlider label="Pipe spacing" value={t.columnSpacing} min={140} max={500} step={10} unit="px"
            onChange={(v) => setTweak('columnSpacing', v)} />
          <TweakSlider label="Scroll speed" value={t.scrollSpeed} min={40} max={250} step={5} unit="px/s"
            onChange={(v) => setTweak('scrollSpeed', v)} />
          <TweakSlider label="Pipe width" value={t.columnWidth} min={10} max={32} step={1} unit="px"
            onChange={(v) => setTweak('columnWidth', v)} />
          <TweakButton label="Reset score" onClick={resetScore} secondary />
        </TweakSection>
        <TweakSection label="Display">
          <TweakToggle label="Show webcam" value={t.showWebcam}
            onChange={(v) => setTweak('showWebcam', v)} />
          <TweakToggle label="Show strength meter" value={t.showMeter}
            onChange={(v) => setTweak('showMeter', v)} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

// ── pixel-art scene drawing ─────────────────────────────────────────────────
// Renders to a low-res offscreen canvas; the main canvas upscales with nearest-
// neighbor for the classic chunky-pixel feel.

const SKY_TOP = '#79d4f5';
const SKY_BOT = '#bce8ff';
const CLOUD = '#fbfff4';
const CITY_FAR = '#7ec7d9';
const CITY_NEAR = '#5ab8cc';
const PIPE_DARK = '#0b3d1e';
const PIPE_BODY = '#5fcb5f';
const PIPE_LIGHT = '#a8e87a';
const PIPE_SHADOW = '#2f8a3a';
const GROUND = '#dec170';
const GROUND_DARK = '#b89243';
const GRASS = '#7fcb56';

function drawScene(off, g, tw, birdX, groundH) {
  const ctx = off.getContext('2d');
  const w = off.width;
  const h = off.height;
  ctx.imageSmoothingEnabled = false;

  // Sky gradient (drawn as 6 horizontal bands for that flat retro look)
  const bands = [SKY_TOP, '#8edcf7', '#a4e3f9', '#b9eafb', '#c8eefc', SKY_BOT];
  for (let i = 0; i < bands.length; i++) {
    ctx.fillStyle = bands[i];
    const y0 = Math.round((i / bands.length) * (h - groundH));
    const y1 = Math.round(((i + 1) / bands.length) * (h - groundH));
    ctx.fillRect(0, y0, w, y1 - y0);
  }

  // Clouds (far parallax)
  drawClouds(ctx, w, h - groundH, g.bgScroll);

  // City silhouette (mid parallax)
  drawCity(ctx, w, h - groundH, g.bgScroll * 2.2);

  // Pipes
  for (const c of g.cols) {
    drawPipe(ctx, c, w, h - groundH, tw.columnWidth);
  }

  // Ground
  drawGround(ctx, w, h, groundH, g.groundScroll);

  // Bird
  drawBird(ctx, birdX, Math.round(g.birdY), g.birdVy, g.wingPhase, tw.character);

  // Collision flash overlay
  if (g.flashTimer > 0) {
    ctx.fillStyle = `rgba(255, 80, 80, ${g.flashTimer * 0.35})`;
    ctx.fillRect(0, 0, w, h);
  }
}

function drawClouds(ctx, w, h, scroll) {
  // A few procedural clouds — same fluffy chunky look at any width.
  ctx.fillStyle = CLOUD;
  const xs = [10, 90, 180, 260, 340, 420, 510, 600];
  const ys = [8, 14, 6, 18, 10, 16, 6, 12];
  const sizes = [3, 4, 3, 5, 4, 3, 4, 3];
  for (let i = 0; i < xs.length; i++) {
    const x = ((xs[i] - scroll * 0.5) % (w + 80) + w + 80) % (w + 80) - 40;
    const y = ys[i] % h;
    const r = sizes[i];
    drawCloudSprite(ctx, Math.round(x), Math.round(y), r);
  }
}

function drawCloudSprite(ctx, x, y, r) {
  // Bubbly cloud built from chunky rounded rects (cell-shaded style).
  ctx.fillStyle = CLOUD;
  ctx.fillRect(x, y + r, r * 6, r * 2);
  ctx.fillRect(x + r, y, r * 4, r * 4);
  ctx.fillRect(x + r * 2, y - r, r * 2, r * 2);
  // Shadow base line
  ctx.fillStyle = '#dff2f7';
  ctx.fillRect(x, y + r * 2 + 1, r * 6, 1);
}

function drawCity(ctx, w, h, scroll) {
  // Stylized 8-bit skyline silhouette across the bottom third.
  const baseY = h - 12;
  ctx.fillStyle = CITY_FAR;
  for (let x = -scroll % 24; x < w; x += 24) {
    const ix = Math.round(x);
    ctx.fillRect(ix, baseY - 6, 8, 6);
    ctx.fillRect(ix + 10, baseY - 10, 6, 10);
    ctx.fillRect(ix + 18, baseY - 4, 5, 4);
  }
  ctx.fillStyle = CITY_NEAR;
  for (let x = -((scroll * 1.3) % 30); x < w; x += 30) {
    const ix = Math.round(x);
    ctx.fillRect(ix, baseY - 4, 12, 4);
    ctx.fillRect(ix + 6, baseY - 8, 6, 8);
    ctx.fillRect(ix + 16, baseY - 6, 8, 6);
    // window pixel
    ctx.fillStyle = '#7fd5e6';
    ctx.fillRect(ix + 8, baseY - 6, 1, 1);
    ctx.fillStyle = CITY_NEAR;
  }
}

// Vertical pipe column (Mario-style two-tone with cap at the gap end).
function drawPipe(ctx, c, w, playH, pipeW) {
  const x = Math.round(c.x - pipeW / 2);
  const gapTop = Math.round(c.gapY - c.gapH / 2);
  const gapBot = Math.round(c.gapY + c.gapH / 2);
  // Top pipe (extends from 0 down to gapTop)
  if (gapTop > 0) drawPipeBody(ctx, x, 0, pipeW, gapTop, 'down', c.hit);
  // Bottom pipe (extends from gapBot to playH)
  if (gapBot < playH) drawPipeBody(ctx, x, gapBot, pipeW, playH - gapBot, 'up', c.hit);
}

function drawPipeBody(ctx, x, y, w, h, capSide, hit) {
  if (h <= 0) return;
  // Body: vertical stripes (light highlight, body, body, body, shadow, outline)
  const cols = makePipeColumns(w, hit);
  // Determine cap height & body extent
  const capH = 5;
  const bodyTop = capSide === 'up' ? y + capH : y;
  const bodyBot = capSide === 'down' ? y + h - capH : y + h;
  // Draw body
  for (let i = 0; i < cols.length; i++) {
    ctx.fillStyle = cols[i];
    ctx.fillRect(x + i, bodyTop, 1, Math.max(0, bodyBot - bodyTop));
  }
  // Outline body top/bottom edges
  ctx.fillStyle = hit ? '#8a2020' : PIPE_DARK;
  if (capSide === 'up') {
    // Top of body sits against the cap (no edge needed)
    ctx.fillRect(x, bodyBot - 1, w, 1);
  } else {
    ctx.fillRect(x, bodyTop, w, 1);
  }
  // Draw cap (wider by 1 px each side)
  const capX = x - 1;
  const capW = w + 2;
  const capY = capSide === 'up' ? y : y + h - capH;
  const capCols = makePipeColumns(capW, hit);
  for (let i = 0; i < capCols.length; i++) {
    ctx.fillStyle = capCols[i];
    ctx.fillRect(capX + i, capY + 1, 1, capH - 2);
  }
  // Cap top & bottom outline
  ctx.fillStyle = hit ? '#8a2020' : PIPE_DARK;
  ctx.fillRect(capX, capY, capW, 1);
  ctx.fillRect(capX, capY + capH - 1, capW, 1);
}

function makePipeColumns(w, hit) {
  // Build a per-column color array for the pipe body.
  // Left:  [outline, highlight, highlight, body, body, body, ..., shadow, shadow, outline]
  const D = hit ? '#8a2020' : PIPE_DARK;
  const L = hit ? '#ff9a8a' : PIPE_LIGHT;
  const B = hit ? '#d75050' : PIPE_BODY;
  const S = hit ? '#7a1f1f' : PIPE_SHADOW;
  const out = new Array(w);
  out[0] = D;
  out[1] = L;
  out[2] = L;
  for (let i = 3; i < w - 3; i++) out[i] = B;
  if (w >= 6) {
    out[w - 3] = S;
    out[w - 2] = S;
  }
  out[w - 1] = D;
  // For very narrow pipes (rare), fall back to mostly body
  for (let i = 0; i < w; i++) if (!out[i]) out[i] = B;
  return out;
}

// Ground band at the bottom — stripes that scroll with the pipes.
function drawGround(ctx, w, h, gh, scroll) {
  const y = h - gh;
  // Grass strip
  ctx.fillStyle = GRASS;
  ctx.fillRect(0, y, w, 2);
  // Earth body
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, y + 2, w, gh - 2);
  // Diagonal hatch pattern that scrolls
  ctx.fillStyle = GROUND_DARK;
  const off = Math.floor(scroll) % 6;
  for (let x = -off; x < w + 6; x += 6) {
    ctx.fillRect(Math.round(x), y + 4, 2, 1);
    ctx.fillRect(Math.round(x) + 3, y + 6, 2, 1);
  }
  // Top edge highlight
  ctx.fillStyle = '#f1d98a';
  ctx.fillRect(0, y + 2, w, 1);
}

// ── original pixel bird sprite ──────────────────────────────────────────────
// 18 columns × 12 rows. A chubby cyan/teal bird with a cream belly — clearly
// our own character, not a tribute to a specific copyrighted sprite.
// ── bird characters ─────────────────────────────────────────────────────────
// Each character is { palette, frames }. All sprites share the same
// 16×12 grid and the same wing-DOWN/MID/UP cycle, so swapping is purely
// a render-time concern. Palette letters are pure rendering hints — each
// sprite gets its own palette so 'Y' can mean cyan in one bird, yellow
// in another.

const CHARACTERS = {
  // Big-eyed yellow bird — most recent revision, currently selected by
  // default. Yellow body, red wing, orange beak; 2×2 black pupil sits in
  // a rounded white sclera.
  yellow: {
    label: 'Sunny',
    palette: {
      D: '#000000', // outline
      Y: '#f7c930', // body yellow
      L: '#fde47a', // body highlight
      W: '#ffffff', // eye white
      E: '#000000', // pupil
      K: '#ff9a1a', // beak orange
      R: '#e53b3b', // wing red
      H: '#8a1f1f', // wing red shadow
    },
    frames: [
      [
        '....DDDDDD......',
        '...DYYLLLLDDD...',
        '..DYLLWWWWWDDD..',
        '..DYLLWWEEWWDDK.',
        '.DYLLLWWEEWWDDKK',
        '.DYLLLLWWWWDLDKK',
        '.DYLLLLLLLLLLDDD',
        '.DYYYYYYYYYYYDD.',
        '.DRRRRRRRRRYYDD.',
        '.DRHHHHHHRRYYD..',
        '..DDRHHHRRYYD...',
        '...DDRRRRYYD....',
        '....DDDDDDD.....',
      ],
      [
        '....DDDDDD......',
        '...DYYLLLLDDD...',
        '..DYLLWWWWWDDD..',
        '..DYLLWWEEWWDDK.',
        '.DYLLLWWEEWWDDKK',
        '.DYRRRRWWWWLLDKK',
        '.DRRRRRRRRRRRDDD',
        '.DDRHHHRRRRYYD..',
        '..DDRRRRRRYYYD..',
        '...DYYYYYYYYD...',
        '....DDDDDDDD....',
        '................',
        '................',
      ],
      [
        '....DDDDDD......',
        '...DYRRLLLLDDD..',
        '..DYRRWWWWWDDD..',
        '..DYRRWWEEWWDDK.',
        '.DRRHHWWEEWWDDKK',
        '.DRRRRRRWWWLLDKK',
        '.DYYYYYYYYYYYDDD',
        '.DYYYYYYYYYYYYD.',
        '..DDYYYYYYYYYYD.',
        '...DYYYYYYYYYD..',
        '....DDDDDDDD....',
        '................',
        '................',
      ],
    ],
  },

  // Small-eyed cyan/teal bird — the earliest design with a cream belly
  // and a small black eye dot. Compact, friendlier silhouette.
  cyan: {
    label: 'Splash',
    palette: {
      D: '#0c2a3a',
      B: '#5fc8e3', // body cyan
      L: '#a8e6f5', // body highlight
      W: '#fff5d1', // cream belly
      K: '#ff9a3c', // beak
      E: '#1a1a1a', // eye
      I: '#ffffff', // eye glint
    },
    frames: [
      [
        '....DDDDDDDD....',
        '...DBBBLLLLBBD..',
        '..DBLLLLLLLLBBD.',
        '.DBLLLLLLLLLLBDD',
        '.DBLLLLLLLLLLBDI',
        '.DBLLLLBBBBLLBDE',
        '.DBLLBBBBBBBBLDD',
        '.DBBWWWWWWWWBBDK',
        '..DBWWWWWWWWBBDK',
        '..DWWWWWWWWBBD..',
        '...DDDDDDDDDD...',
        '................',
        '................',
      ],
      [
        '....DDDDDDDD....',
        '...DBBBLLLLBBD..',
        '..DBLLLLLLLLBBD.',
        '.DBLLLLLLLLLLBDD',
        '.DBLLLLLLLLLLBDI',
        '.DBLLLLLLLBBLLBDE',
        '.DBBBBBBBBBBBBLD',
        '.DBWWWWWWWWWWBBD',
        '..DBWWWWWWWWBBDK',
        '..DWWWWWWWWBBD..',
        '...DDDDDDDDDD...',
        '................',
        '................',
      ],
      [
        '..BBBBBBBB......',
        '.DBLLLLLLBD.....',
        '.DBLLLLLLLBD....',
        '..DBLLLLLLBD.IDD',
        '...DBLLBBBBDIEID',
        '...DBLBBBBLBDIID',
        '...DBBBBBBBBLDDD',
        '...DBWWWWWWWBDD.',
        '...DBWWWWWWWBD..',
        '...DWWWWWWWWD...',
        '....DDDDDDDD....',
        '................',
        '................',
      ],
    ],
  },

  // Pink/magenta bird — round body, blue wing, large dark eye with a
  // shiny highlight. New variant for variety.
  pink: {
    label: 'Rosie',
    palette: {
      D: '#000000',
      P: '#ff7aa8', // body pink
      L: '#ffb8d0', // body highlight
      W: '#ffffff', // eye white
      E: '#000000', // pupil
      K: '#ffce3a', // beak yellow
      B: '#5fa9ff', // wing blue
      H: '#1f4f9c', // wing blue shadow
    },
    frames: [
      [
        '....DDDDDD......',
        '...DPPLLLLDDD...',
        '..DPLLWWWWWDDD..',
        '..DPLLWWEEWWDDK.',
        '.DPLLLWWEEWWDDKK',
        '.DPLLLLWWWWDLDKK',
        '.DPLLLLLLLLLLDDD',
        '.DPPPPPPPPPPPDD.',
        '.DBBBBBBBBPPPDD.',
        '.DBHHHHHHBBPPD..',
        '..DDBHHHBBPPD...',
        '...DDBBBBPPD....',
        '....DDDDDDD.....',
      ],
      [
        '....DDDDDD......',
        '...DPPLLLLDDD...',
        '..DPLLWWWWWDDD..',
        '..DPLLWWEEWWDDK.',
        '.DPLLLWWEEWWDDKK',
        '.DPBBBBWWWWLLDKK',
        '.DBBBBBBBBBBBDDD',
        '.DDBHHHBBBBPPD..',
        '..DDBBBBBBPPPD..',
        '...DPPPPPPPPD...',
        '....DDDDDDDD....',
        '................',
        '................',
      ],
      [
        '....DDDDDD......',
        '...DPBBLLLLDDD..',
        '..DPBBWWWWWDDD..',
        '..DPBBWWEEWWDDK.',
        '.DBBHHWWEEWWDDKK',
        '.DBBBBBBWWWLLDKK',
        '.DPPPPPPPPPPPDDD',
        '.DPPPPPPPPPPPPD.',
        '..DDPPPPPPPPPPD.',
        '...DPPPPPPPPPD..',
        '....DDDDDDDD....',
        '................',
        '................',
      ],
    ],
  },
};

function drawBird(ctx, cx, cy, vy, wingPhase, character) {
  const c = CHARACTERS[character] || CHARACTERS.yellow;
  const sprite = c.frames[Math.floor(wingPhase) % c.frames.length];
  const tilt = clamp(vy / 600, -0.4, 0.7);
  const rows = sprite.length;
  const cols = sprite[0].length;
  const ox = Math.round(cx - cols / 2);
  const oy = Math.round(cy - rows / 2);
  const shear = tilt * 0.8;
  for (let r = 0; r < rows; r++) {
    const row = sprite[r];
    const dy = (r - rows / 2) * shear;
    for (let col = 0; col < cols; col++) {
      const ch = row[col];
      if (ch === '.' || ch === ' ') continue;
      const color = c.palette[ch];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(ox + col + Math.round(dy), oy + r, 1, 1);
    }
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
