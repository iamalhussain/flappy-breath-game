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
// Module-level adaptive noise floor estimate. Tracks the running average
// of the *quiet* moments (samples whose total energy is in the noise zone)
// so the silence threshold scales with the room: a noisy environment ends
// up with a higher floor and rejects more background bleed.
let _noiseFloor = 0.05;

function letterStrength(freqData, sampleRate, fftSize, letter, gateMult = 2.5) {
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

  // Adaptive noise tracking: when the current sample sits in the "probably
  // noise" zone (less than ~1.8x the current floor), drift the floor toward
  // it slowly. Voice spikes are well above this and don't corrupt the
  // estimate. Slow alpha → ~3 seconds to settle on a new ambient level.
  if (total < _noiseFloor * 1.8) {
    _noiseFloor = _noiseFloor * 0.995 + total * 0.005;
  }
  // Effective silence floor: at least an absolute minimum (so a dead-silent
  // room doesn't drift the gate to ~0 and let mic self-noise through), or
  // gateMult× the learned floor — whichever is higher.
  const floor = Math.max(0.08, _noiseFloor * gateMult);
  if (total < floor) return 0;

  // Normalized fractions — these are the *shape* of the spectrum,
  // independent of how loud the sound is.
  const fV  = V / total;
  const fL  = L / total;
  const fLM = LM / total;
  const fM  = M / total;
  const fH  = H / total;
  const fVH = VH / total;

  // Spectral concentration gate. Broadband noise (fans, AC, hiss) spreads
  // energy roughly evenly — each band lands near 1/6 = 0.167 of the total.
  // Voice always has at least one band well above the average. Per-letter
  // thresholds because nasals (m, n) naturally have flatter low-frequency
  // distributions than fricatives — using a single 0.20 floor would gate
  // out perfectly good n's whose energy spreads across V/L/LM evenly.
  const concentrationMin = { m: 0.16, n: 0.22, v: 0.16, f: 0.12 }[letter] ?? 0.20;
  const maxFrac = Math.max(fV, fL, fLM, fM, fH, fVH);
  if (maxFrac < concentrationMin) return 0;

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
  // Relaxed nasal-shape gate for m: the old 0.55 threshold was tuned to
  // fight noise/breath false positives, but the new adaptive noise floor
  // + spectral concentration gate handle that upstream now. 0.40 lets a
  // typical mid-volume "mmm" fully pass without needing dominant V+L.
  const mNasalShape   = clamp(((fV + fL) - 0.40) * 4.0, 0, 1);
  // n's F2 sits anywhere from 1.5–2 kHz, and on many mics/speakers the LM
  // fraction lands closer to 0.10–0.15 than the template's 0.25. Steeper
  // slope + lower floor so even a typical real-world "nnn" fully opens
  // the gate, while a flat M (fLM ≈ 0.08) still only partially passes.
  const nGate         = clamp((fLM - 0.04) * 9.0, 0, 1);
  const nVoicedGate   = clamp((fV - 0.02) * 8.0, 0, 1);
  // Nasal-shape gate: real n's concentrate energy in V+L heavily (often
  // >0.55 combined). Background noise rarely hits 0.30 combined low-band
  // because its energy spreads across all six bands. Threshold 0.22 sits
  // comfortably above flat-noise distributions (~0.17 per band → V+L ≈
  // 0.34, gated to 0.48) while letting a real "nnn" with V+L ≥ 0.47
  // fully pass.
  const nNasalShape   = clamp(((fV + fL) - 0.22) * 4.0, 0, 1);
  // Coarse shape: separates nasals from fricatives. Loose threshold so v
  // (the quietest voiced fricative) still passes.
  const fricShape     = clamp(((fM + fH + fVH) - 0.15) * 4.0, 0, 1);
  // V-specific shape gate: phone mics roll off high frequencies, so v's
  // M+H+VH fraction lands lower than on desktop. Lower threshold (0.08
  // vs 0.15) keeps phone V's passing while still gating clean vowels
  // (fM+fH+fVH ≈ 0.05) out at ~0.
  const vFricShape    = clamp(((fM + fH + fVH) - 0.08) * 4.0, 0, 1);
  // F-specific shape gate: phones with heavy noise-suppression algorithms
  // can squash f's high-freq airflow down to fM+fH+fVH ≈ 0.10-0.15.
  // Drop the threshold to 0.05 so even a heavily-suppressed f still
  // produces a meaningful gate value. Real vowels rarely top 0.10 here
  // so discrimination holds (their voicedGate hits 0 too).
  const fFricShape    = clamp(((fM + fH + fVH) - 0.05) * 4.0, 0, 1);
  // S-specific shape gate: phones cut VH most aggressively, so s's
  // M+H+VH sum lands lower than its desktop ~0.85. Threshold 0.10
  // accommodates phone-s (typically 0.40-0.60 here) while still
  // rejecting nasals (fM+fH+fVH ≈ 0.05) and quiet breath.
  const sFricShape    = clamp(((fM + fH + fVH) - 0.10) * 4.0, 0, 1);
  // Anti-noise gate for nasals: real m and n have near-zero energy in
  // the M/H/VH bands (mouth is closed → no oral airflow turbulence).
  // Threshold relaxed to 0.32 because phone mics often produce nasals
  // with fM+fH+fVH around 0.15-0.20 (DSP artifacts, breath leakage),
  // and the old 0.25 hard floor was killing legit phone-M/N. Noise
  // (fans, AC, broadband) still lives well above 0.32.
  const nasalAntiNoise = clamp((0.32 - (fM + fH + fVH)) * 6.0, 0, 1);
  // Nasal concentration ratio: real m/n concentrate energy in V+L so
  // hard that the ratio (V+L)/(M+H+VH) sits around 15-20. *Any* noise
  // — even low-freq AC hum where (M+H+VH) is small — never concentrates
  // tighter than ~2-3, because noise by definition has some spread. This
  // catches the low-freq noise that nasalAntiNoise alone misses: AC hum
  // has small M+H+VH so passes nasalAntiNoise, but its (V+L)/(M+H+VH)
  // ratio is only ~2-3 because L/LM energy is also present. Gate fully
  // opens at ratio ≥ 7, fully closes at ratio ≤ 2.
  const nasalRatio = (fV + fL) / Math.max(0.01, fM + fH + fVH);
  const nasalRatioGate = clamp((nasalRatio - 2.0) / 5.0, 0, 1);
  // Spectral flatness — geometric mean / arithmetic mean of band fractions.
  // This is the textbook voice-vs-noise discriminator:
  //   real m  → flatness ≈ 0.36 (very peaked, energy in V+L)
  //   real n  → flatness ≈ 0.61 (peaked, but less than m)
  //   vowel   → flatness ≈ 0.45 (peaked)
  //   low-freq noise (AC) → flatness ≈ 0.85
  //   broadband noise     → flatness ≈ 0.95
  // arithMean is always 1/6 because fractions sum to 1, so flatness =
  // geoMean × 6. Gate fully open at flatness ≤ 0.70, fully closed
  // above 0.80 — clean separator with no false rejections of real
  // nasals even with pronunciation variation.
  const _eps = 0.005;
  const geoMean = Math.pow(
    Math.max(_eps, fV) * Math.max(_eps, fL) * Math.max(_eps, fLM)
    * Math.max(_eps, fM) * Math.max(_eps, fH) * Math.max(_eps, fVH),
    1 / 6,
  );
  const flatness = geoMean * 6;
  // Threshold loosened to 0.85 so phone-M/N with slight extra spread
  // (typical 0.65-0.75 flatness on phones) still passes cleanly.
  // Real noise is still well above 0.85.
  const nasalPeaked = clamp((0.85 - flatness) * 8, 0, 1);

  // Hard cutoffs for nasals: ambient noise must be REJECTED to zero,
  // not just attenuated — even a small fractional score keeps the bird
  // hovering instead of falling, which breaks the game's "silence →
  // fall" contract. Soft gates above let small noise leak through; hard
  // if-returns here ensure ambient produces exactly 0 output.
  // Thresholds calibrated wide enough that even noisy-phone-M/N passes:
  //   real m  → fM+fH+fVH ≈ 0.05, flatness ≈ 0.36, ratio ≈ 17
  //   real n  → fM+fH+fVH ≈ 0.20, flatness ≈ 0.61, ratio ≈ 2.75
  //   phone n with leakage → fM+fH+fVH ≈ 0.25, flatness ≈ 0.75, ratio ≈ 1.8
  //   ambient noise → fM+fH+fVH ≥ 0.30 OR flatness ≥ 0.85 OR ratio ≤ 1.3
  if (letter === 'm' || letter === 'n') {
    if (fM + fH + fVH > 0.30) return 0;
    if (flatness > 0.82) return 0;
    if (nasalRatio < 1.3) return 0;
  }

  // Distance from spectral template. Most letters use uniform L1 (every
  // band contributes equally), but f gets a discriminative-weighted L1:
  // we know in advance that f is defined by its M/H peak, its lack of
  // voicing, and its broadband (not VH-only) high-freq energy — while
  // f's L band carries almost no information. Weighting amplifies the
  // signal-to-noise of the match: a real f against the f template gets
  // a small dist; a near-miss like sh or s gets a much larger dist than
  // uniform L1 would give.
  // Per-band weights for the L1 distance. Bands that strongly
  // discriminate this letter from look-alikes (and from noise) get
  // higher weight; bands that carry little signal get lower weight.
  // Letters without an entry use uniform weights (all 1.0).
  const distWeights = {
    // V weight reduced to 1.0 because voicelessGate (below) already
    // penalizes voicing — double-weighting was making f picky about any
    // breath that contained a hint of vocal-fold vibration. M and H
    // balanced at 2.0 each so neither has to perfectly match the
    // template: f varies a lot in M/H ratio depending on lip/teeth
    // position. VH and LM get modest weights to maintain separation
    // from s (VH-heavy) and sh (LM bleed).
    f: { V: 1.0, L: 0.5, LM: 1.0, M: 2.0, H: 2.0, VH: 1.5 },
    // N is defined by its LM peak (F2) — that's the M-vs-N separator.
    // High-frequency presence is the noise-vs-N separator: room hum,
    // breath, and broadband background bleed all have energy in H/VH
    // that a real n doesn't. Heavy H/VH weights (3.5/4.0) push noise
    // way past the match threshold because noise *always* has some H/VH
    // energy and n has near-zero — the weighted disagreement compounds.
    n: { V: 1.5, L: 1.0, LM: 3.0, M: 1.5, H: 3.5, VH: 4.0 },
    // M is the mirror of N: same heavy H/VH weights to reject noise
    // (M has near-zero high-freq too — mouth is closed). The N-vs-M
    // separator is LM (n has elevated F2, m doesn't), so LM weighted
    // heavily. L is m's signature first-formant peak — weighting it
    // protects against bleed from vowels which have a different L/V
    // balance.
    m: { V: 1.5, L: 2.0, LM: 3.0, M: 2.0, H: 3.0, VH: 3.5 },
    // S is defined by HIGH-frequency airflow, but phone mics aggressively
    // roll off 7+ kHz — so VH (s's signature band) is unreliable on
    // phones. Down-weighting VH (0.5) prevents the phone rolloff from
    // killing the match, while up-weighting H (2.5) and V (2.5, the
    // voicelessness check) keeps discrimination strong. Low bands
    // (L, LM) carry no s information — barely weighted.
    s: { V: 2.5, L: 0.5, LM: 0.5, M: 1.0, H: 2.5, VH: 0.5 },
  };
  const w = distWeights[letter];
  let dist;
  if (w) {
    dist = Math.abs(fV - t.V) * w.V
         + Math.abs(fL - t.L) * w.L
         + Math.abs(fLM - t.LM) * w.LM
         + Math.abs(fM - t.M) * w.M
         + Math.abs(fH - t.H) * w.H
         + Math.abs(fVH - t.VH) * w.VH;
  } else {
    dist = Math.abs(fV - t.V) + Math.abs(fL - t.L) + Math.abs(fLM - t.LM)
         + Math.abs(fM - t.M) + Math.abs(fH - t.H) + Math.abs(fVH - t.VH);
  }
  // Per-letter match tolerance. Higher = more forgiving template (steadier
  // score on phonemes whose spectrum jitters frame-to-frame). Default 1.2.
  //   f: weighted L1 (sum-of-weights = 9.5 vs uniform's 6), so its
  //      tolerance is scaled up proportionally (1.9 × 1.6 ≈ 3.0) — the
  //      ratio of "right" to "wrong" dist is what matters, not absolute.
  //   m, n: F2 / nasal-shape variability across speakers → relaxed.
  const matchTolByLetter = {
    s: 2.0, z: 1.2, sh: 1.2, f: 4.0, v: 1.8, m: 4.0, n: 4.0,
  };
  const matchTol = matchTolByLetter[letter] ?? 1.2;
  const match = Math.max(0, 1 - dist / matchTol);
  const matchSq = match * match;

  // Generic energy used for all letters so the "loudness-to-output" curve
  // is letter-independent — combined with per-letter scale this means a
  // sustained "ssss" and "ffff" at the same mic input produce comparable
  // strengths instead of one being twice the other.
  const totalE = H + VH * 1.2 + M * 0.9 + L * 0.7 + V * 0.7 + LM * 0.6;
  // Per-letter loudness curve. Default is linear (totalE^1.0). f gets a
  // square-root response so quiet f's still produce a meaningful score —
  // a perfect template match at low volume previously vanished because
  // output was linear in amplitude. With sqrt, totalE=0.1 boosts from
  // 0.1 → 0.316 (~3× sensitivity gain at the quiet end), while totalE=1
  // stays at 1 (no change at the loud end).
  const energyCurve = { f: 0.4, s: 0.5 };
  const exp = energyCurve[letter] ?? 1.0;
  const energyTerm = exp === 1.0 ? totalE : Math.pow(totalE, exp);
  const scaleByLetter = {
    // f scale dialed down to 4.5 to compensate for the sqrt expansion;
    // net loud-f output is similar, but quiet-f is dramatically louder.
    s: 6.0, z: 2.1, sh: 6.5, f: 7.0, v: 6.3, m: 1.7, n: 7.5,
  };
  const gateByLetter = {
    s:  voicelessGate * sFricShape,
    z:  voicedGate    * fricShape,
    sh: voicelessGate * fricShape,
    f:  voicelessGate * fFricShape,
    v:  voicedGate    * vFricShape,
    // Nasals additionally require voicing AND must look like voice (not
    // noise). Layered defense:
    //   nasalAntiNoise — absolute M+H+VH must be moderate-or-less
    //   nasalRatioGate — (V+L) must dominate (M+H+VH) by 2×+
    //   nasalPeaked    — spectral flatness must be < 0.85 (peaked)
    // The adaptive noise floor at letterStrength's entry already ensures
    // signal > ambient × gateMult, so no separate energy floor needed
    // (that was killing legit weak phone-M/N).
    m: mGate * mNasalShape * mVoicedGate * nasalAntiNoise * nasalRatioGate * nasalPeaked,
    n: nGate * nNasalShape * nVoicedGate * nasalAntiNoise * nasalRatioGate * nasalPeaked,
  };
  return clamp(
    matchSq * energyTerm * scaleByLetter[letter] * gateByLetter[letter],
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

// Feature detection — `navigator.mediaDevices` is only defined in secure
// contexts (https / localhost). On plain http from a LAN IP it's undefined,
// which is what triggers the cryptic "undefined is not an object" error.
// `getDisplayMedia` is missing on iOS Safari entirely and on most mobile
// browsers, so we use it to hide the screen-record UI on those platforms.
const HAS_MEDIA_DEVICES = typeof navigator !== 'undefined'
  && !!navigator.mediaDevices?.getUserMedia;
const HAS_SCREEN_RECORDING = typeof navigator !== 'undefined'
  && !!navigator.mediaDevices?.getDisplayMedia
  && typeof MediaRecorder !== 'undefined';

// Letter pool by language. v has no native Arabic letter (loanwords write
// it as ف), so we exclude it from Arabic selection entirely. English mode
// still offers all seven.
const ALL_LETTERS = ['s', 'z', 'sh', 'f', 'v', 'm', 'n'];
function lettersFor(lang) {
  return lang === 'ar' ? ALL_LETTERS.filter((l) => l !== 'v') : ALL_LETTERS;
}

// ── per-letter "Did you know..." facts ─────────────────────────────────────
// Shown on the game-over card. Each phoneme group shares one short fact
// (M/N → mask resonance; Z/V → coordination; S/SH/F → breath control).
const LETTER_FACTS = {
  en: {
    m: "M and N vibrate in your face — your lips, nose, and cheekbones. That's mask resonance, the secret behind voices that 'carry' across a room. Weak voices are stuck in the throat; these letters push sound forward where it gets natural amplification.",
    n: "M and N vibrate in your face — your lips, nose, and cheekbones. That's mask resonance, the secret behind voices that 'carry' across a room. Weak voices are stuck in the throat; these letters push sound forward where it gets natural amplification.",
    z: "Z and V are a coordination test — vocal-cord vibration meeting restricted airflow. A steady 'zzz' for 15 seconds without wobbling means your breath and cords are in sync. If it shakes or fades, your support is leaking. A diagnostic disguised as an exercise.",
    v: "Z and V are a coordination test — vocal-cord vibration meeting restricted airflow. A steady 'vvv' for 15 seconds without wobbling means your breath and cords are in sync. If it shakes or fades, your support is leaking. A diagnostic disguised as an exercise.",
    s: "S, SH, and F have no voice — pure air. A clean, steady 'sssss' with no fluctuation means your diaphragm is managing pressure properly. Same skill that lets you finish long sentences without trailing off mid-thought.",
    sh: "S, SH, and F have no voice — pure air. A clean, steady 'shhhh' with no fluctuation means your diaphragm is managing pressure properly. Same skill that lets you finish long sentences without trailing off mid-thought.",
    f: "S, SH, and F have no voice — pure air. A clean, steady 'ffff' with no fluctuation means your diaphragm is managing pressure properly. Same skill that lets you finish long sentences without trailing off mid-thought.",
  },
  ar: {
    m: "أنّ حرفا «م» و«ن» يهتزّان في وجهك، لا في حلقك؟ أطِل صوت «ممم» وستشعر بشفتيك وأنفك وعظام وجنتيك تهتزّ. هذا ما يُسمّى الرنين في القناع الصوتي — وهو السرّ خلف كل صوت غنيّ يصل إلى آخر القاعة. معظم الأصوات الضعيفة تبقى حبيسة الحلق. أمّا هذه الحروف فتدفع الصوت إلى الأمام، حيث يحصل على تضخيم طبيعي.",
    n: "أنّ حرفا «م» و«ن» يهتزّان في وجهك، لا في حلقك؟ أطِل صوت «ننن» وستشعر بشفتيك وأنفك وعظام وجنتيك تهتزّ. هذا ما يُسمّى الرنين في القناع الصوتي — وهو السرّ خلف كل صوت غنيّ يصل إلى آخر القاعة. معظم الأصوات الضعيفة تبقى حبيسة الحلق. أمّا هذه الحروف فتدفع الصوت إلى الأمام، حيث يحصل على تضخيم طبيعي.",
    z: "أنّ حرف «ز» هو اختبار تناسق؟ فهو يجمع بين اهتزاز الحبال الصوتية وتدفّق الهواء المُقيَّد في آنٍ واحد. إذا استطعت إطالة صوت «ززز» لمدّة خمس عشرة ثانية دون اهتزاز، فهذا يعني أنّ نَفَسك وحبالك الصوتية تعملان كفريق واحد. أمّا إذا ارتجف الصوت أو خفت، فإنّ دعمك التنفّسي يتسرّب. إنه تشخيصٌ مُتَنَكِّر في هيئة تمرين.",
    v: "حرفا «ز» و«ف» اختبار تنسيق — اهتزاز الحبال الصوتية مع تيار هواء مقيَّد. ثبات «فــ» لمدة 15 ثانية دون اهتزاز يعني أن نَفَسك وحبالك الصوتية يعملان كفريق. أيُّ ارتجاف أو خفوت يعني أن الدعم يتسرَّب. تشخيص متخفٍّ في صورة تمرين.",
    s: "أنّ حروف «س» و«ش» و«ف» لا تحمل صوتاً إطلاقاً — مجرّد هواء؟ وهذا يجعلها تدريباً صافياً للتحكّم بالنَّفَس. إنّ صوت «ســـــ» نقيّاً وثابتاً دون تذبذب يعني أنّ حجابك الحاجز يُدير الضغط بشكل صحيح. وهذه هي المهارة نفسها التي تُمكّنك من إنهاء الجمل الطويلة دون أن يخفت صوتك.",
    sh: "أنّ حروف «س» و«ش» و«ف» لا تحمل صوتاً إطلاقاً — مجرّد هواء؟ وهذا يجعلها تدريباً صافياً للتحكّم بالنَّفَس. إنّ صوت «شــــ» نقيّاً وثابتاً دون تذبذب يعني أنّ حجابك الحاجز يُدير الضغط بشكل صحيح. وهذه هي المهارة نفسها التي تُمكّنك من إنهاء الجمل الطويلة دون أن يخفت صوتك.",
    f: "أنّ حروف «س» و«ش» و«ف» لا تحمل صوتاً إطلاقاً — مجرّد هواء؟ وهذا يجعلها تدريباً صافياً للتحكّم بالنَّفَس. إنّ صوت «فــــ» نقيّاً وثابتاً دون تذبذب يعني أنّ حجابك الحاجز يُدير الضغط بشكل صحيح. وهذه هي المهارة نفسها التي تُمكّنك من إنهاء الجمل الطويلة دون أن يخفت صوتك.",
  },
};
function factFor(letter, lang) {
  return (LETTER_FACTS[lang] || LETTER_FACTS.en)[letter] || LETTER_FACTS.en[letter] || '';
}

// ── permission gate ─────────────────────────────────────────────────────────
function PermissionCard({ onStart, onStartAndRecord, onLanguageChange, error, requesting, letter, language }) {
  const glyph = glyphFor(letter, language);
  const isAr = language === 'ar';
  const T = isAr ? {
    title: 'الطائر الطنّان',
    body1: 'الحرف الحالي: ',
    cta: 'تشغيل',
    ctaRecord: 'تشغيل وتسجيل',
    requesting: 'جاري طلب الكاميرا والمايك…',
    privacy: 'الفيديو والصوت يبقيان على جهازك — لا يتم رفع شيء.',
    howtoTitle: 'كيفية اللعب',
    steps: [
      'أصدر صوت الحرف لرفع الطائر',
      'خفّض الصوت أو توقّف ليهبط',
      'وجّه الطائر بين الأنابيب!',
    ],
  } : {
    title: 'Humming Bird',
    body1: 'Your letter: ',
    cta: 'Play',
    ctaRecord: 'Play & Record',
    requesting: 'Requesting camera & mic…',
    privacy: 'Video and audio stay on your device — nothing is uploaded.',
    howtoTitle: 'How to play',
    steps: [
      "Hold the letter's sound to lift the bird",
      'Stop or soften the sound to let it drop',
      'Steer between the pipes!',
    ],
  };
  return (
    <div className="center-card" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="lang-switch" dir="ltr">
        <button type="button"
                className={'lang-btn' + (!isAr ? ' on' : '')}
                onClick={() => onLanguageChange?.('en')}
                aria-pressed={!isAr}>EN</button>
        <button type="button"
                className={'lang-btn' + (isAr ? ' on' : '')}
                onClick={() => onLanguageChange?.('ar')}
                aria-pressed={isAr}>AR</button>
      </div>
      <h1>{T.title}</h1>
      <p className="howto__letter-row">
        {T.body1}
        <span className={'letter-chip' + (isAr ? ' ar' : '')}>
          <span className={isAr ? 'ar-glyph' : ''}>{glyph}</span>
        </span>
      </p>
      <div className="howto">
        <div className="howto__title">{T.howtoTitle}</div>
        <ol className="howto__steps">
          {T.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      </div>
      <div className="row">
        <div className="btn-col">
          <button className="btn primary btn--icon" onClick={onStart}
                  disabled={requesting} title={T.cta} aria-label={T.cta}>
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
              <path d="M7 4.5v15l13-7.5z" fill="currentColor" />
            </svg>
          </button>
          <span className="btn-col__lbl">{T.cta}</span>
        </div>
        <div className="btn-col">
          <button className="btn ghost btn--icon" onClick={onStartAndRecord}
                  disabled={requesting} title={T.ctaRecord} aria-label={T.ctaRecord}>
            <svg viewBox="0 0 28 24" width="30" height="26" aria-hidden="true">
              <path d="M5 4.5v15l13-7.5z" fill="currentColor" />
              <circle cx="23" cy="6" r="4" fill="#fe2c55" />
            </svg>
          </button>
          <span className="btn-col__lbl">{T.ctaRecord}</span>
        </div>
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
  // Pick a random letter once on mount so each session starts with a
  // different prompt. Runs in an effect (not at render) so the tweak
  // store and host-postMessage pipeline are ready.
  useEffect(() => {
    const choices = lettersFor(t.language);
    const pick = choices[Math.floor(Math.random() * choices.length)];
    setTweak('letter', pick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the language changes (or starts) as Arabic while 'v' is the active
  // letter, swap to 'f' — v isn't a real Arabic letter and shouldn't appear
  // in the Arabic letter pool.
  useEffect(() => {
    if (t.language === 'ar' && t.letter === 'v') {
      setTweak('letter', 'f');
    }
  }, [t.language, t.letter]);
  const [phase, setPhase] = useState('intro');
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({ score: 0, hits: 0, streak: 0, bestStreak: 0, gameOver: false });
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
  // Visual-only "Say [letter]" intro banner. Independent of calibration
  // / runway — purely a text cue at the start of each round. When it
  // hides, the "Don't let your bird fall" hint flashes after.
  const [showSayBanner, setShowSayBanner] = useState(false);
  const playIntroBanners = useCallback(() => {
    setShowSayBanner(true);
    setShowFallHint(null);
    setTimeout(() => {
      setShowSayBanner(false);
      setShowFallHint(performance.now());
    }, 1500);
  }, []);
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
  // Refs that mirror React state — needed because the composite-recording
  // render loop runs outside React and reads these values every frame.
  const statsRef = useRef({ score: 0, gameOver: false });
  const showSayBannerRef = useRef(false);
  const fallHintAtRef = useRef(null);

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
    gameOver: false,
    initialized: false,
    calibrating: false,
    calRemaining: 0,
    calSamples: [],
  });

  // Reflect language on <html> so Noto Sans Arabic kicks in and any
  // direction-sensitive UI flows the right way.
  useEffect(() => {
    document.documentElement.lang = t.language === 'ar' ? 'ar' : 'en';
  }, [t.language]);

  const tRef = useRef(t);
  tRef.current = t;
  statsRef.current = stats;
  showSayBannerRef.current = showSayBanner;
  fallHintAtRef.current = fallHintAt;

  // ── start: request permissions ───────────────────────────────────────────
  const start = useCallback(async () => {
    setRequesting(true);
    setError(null);
    if (!HAS_MEDIA_DEVICES) {
      // Most common cause on phones: page loaded over plain http://<lan-ip>.
      // navigator.mediaDevices is only exposed in secure contexts.
      setRequesting(false);
      setError(tRef.current?.language === 'ar'
        ? 'يتطلب الوصول للكاميرا والميكروفون اتصالاً آمناً. افتح هذه الصفحة عبر https://'
        : 'Camera & mic access requires HTTPS. Open this page over https:// instead of http://.');
      return;
    }
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
      // iOS Safari starts AudioContext in 'suspended' state even when created
      // from a user gesture; explicitly resume so the analyser runs. Awaited
      // so the rest of the setup doesn't race against a still-suspended ctx.
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {});
      }
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
      const g = gameRef.current;
      g.calibrating = false;
      g.calRemaining = 0;
      g.calSamples = [];
      setPhase('playing');
      playIntroBanners();
    } catch (e) {
      setRequesting(false);
      setError(e.message || 'Permission denied.');
    }
  }, [playIntroBanners]);

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
          tw.noiseGate,
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
          setTweak('targetStrengthByLetter', { ...(tw.targetStrengthByLetter ?? {}), [tw.letter]: captured });
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

      const target = Math.max(0.02, (tw.targetStrengthByLetter?.[tw.letter] ?? 26) / 100);
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
      // Skip spawning during the calibration runway AND once the game is
      // over so the world freezes mid-crash.
      if (!g.calibrating && !g.gameOver) {
        g.spawnTimer += dt;
        // At game start, pre-populate the pipe queue from close-to-bird
        // outward at proper spacing, so the player gets a continuous stream
        // right away instead of watching empty sky scroll past. After this,
        // the normal spawn cadence at offW + 30 takes over and columnSpacing
        // controls cadence.
        if (g.cols.length === 0) {
          g.spawnTimer = 0;
          // Walk backward from the natural spawn position so the rightmost
          // pre-populated pipe lands exactly at offW + 30 — that way the
          // first natural spawn (spawnInterval seconds later) is exactly
          // spacingPx away from it, no gap discontinuity.
          for (let x = offW + 30; x >= offW * 0.55; x -= spacingPx) {
            const wobble = Math.sin((performance.now() + x * 10) * 0.0008) * 0.05;
            const gapCenter = (skyBot - skyTop) * (0.5 + wobble) + skyTop;
            g.cols.push({
              x,
              gapY: gapCenter,
              gapH: (tw.gapSize / 100) * (skyBot - skyTop),
              scored: false,
              hit: false,
            });
          }
        } else if (g.spawnTimer >= spawnInterval) {
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
      // Skip pipe scroll + collision once the round ends.
      if (!g.gameOver) {
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
                g.flashTimer = 0.5;
                g.gameOver = true; // single hit ends the round
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
      }
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
              s.streak === g.streak && s.bestStreak === g.bestStreak &&
              s.gameOver === g.gameOver) return s;
          return {
            score: g.score, hits: g.hits, streak: g.streak,
            bestStreak: g.bestStreak, gameOver: g.gameOver,
          };
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
  // ── screen-record support ─────────────────────────────────────────────
  // Uses getDisplayMedia + MediaRecorder so the saved file includes the
  // webcam, game canvas and HUD exactly as the user sees them. Browser
  // shows its own "select what to share" picker; user chooses tab/window.
  const [isRecording, setIsRecording] = useState(false);
  // Holds the finished recording when auto-stop fires (game-over). Auto-stop
  // happens after the user's original click gesture has expired, so
  // navigator.share() would be rejected. We surface a "Save recording"
  // button instead, and the user's tap on that button is a fresh gesture
  // that lets navigator.share() succeed (Save to Photos on iOS).
  const [pendingRecording, setPendingRecording] = useState(null);

  const savePendingRecording = useCallback(async () => {
    const pr = pendingRecording;
    if (!pr) return;
    setPendingRecording(null);
    if (navigator.canShare && navigator.canShare({ files: [pr.file] })) {
      try {
        await navigator.share({ files: [pr.file], title: 'Humming Bird recording' });
        return;
      } catch (_) { /* user cancelled — fall through to download */ }
    }
    const url = URL.createObjectURL(pr.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = pr.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [pendingRecording]);
  const recorderRef = useRef(null);
  const recChunksRef = useRef([]);
  const recStreamRef = useRef(null);

  // Phone-friendly recording path. iOS Safari (and most mobile browsers)
  // don't expose getDisplayMedia, so we build an offscreen canvas the size
  // of the viewport, redraw the webcam + game canvas + key HUD overlays
  // into it every frame, and captureStream from that. Returns an object
  // { stream, stop } — caller must call stop() when recording ends to
  // cancel the rAF loop and release the offscreen canvas.
  const startCompositeCapture = useCallback(() => {
    const composite = document.createElement('canvas');
    if (typeof composite.captureStream !== 'function') return null;
    const W = composite.width = window.innerWidth;
    const H = composite.height = window.innerHeight;
    composite.style.cssText = 'position:fixed;left:-99999px;top:0;pointer-events:none;';
    document.body.appendChild(composite);
    const cctx = composite.getContext('2d');
    let raf = 0;
    let cancelled = false;

    const drawFrame = () => {
      if (cancelled) return;
      cctx.clearRect(0, 0, W, H);

      // 1. Webcam background (mirrored to match the on-screen scaleX(-1),
      //    cover-fit so the whole canvas is filled).
      const v = videoRef.current;
      if (v && v.videoWidth > 0) {
        const vAR = v.videoWidth / v.videoHeight;
        const cAR = W / H;
        let dw, dh, dx, dy;
        if (vAR > cAR) { dh = H; dw = dh * vAR; dx = (W - dw) / 2; dy = 0; }
        else { dw = W; dh = dw / vAR; dx = 0; dy = (H - dh) / 2; }
        cctx.save();
        cctx.scale(-1, 1);
        cctx.translate(-W, 0);
        cctx.drawImage(v, dx, dy, dw, dh);
        cctx.restore();
      } else {
        cctx.fillStyle = '#05060a';
        cctx.fillRect(0, 0, W, H);
      }

      // 2. Vignette — soft top/bottom fade matching .vignette on screen.
      const grad = cctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, 'rgba(0,0,0,.35)');
      grad.addColorStop(0.18, 'rgba(0,0,0,0)');
      grad.addColorStop(0.6, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(7,9,11,.55)');
      cctx.fillStyle = grad;
      cctx.fillRect(0, 0, W, H);

      // 3. Game canvas, positioned to match where it sits on screen.
      const gc = canvasRef.current;
      if (gc) {
        const r = gc.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          cctx.drawImage(gc, r.left, r.top, r.width, r.height);
        }
      }

      // 4. HUD overlays — recreated with canvas commands.
      const tw = tRef.current;
      const st = statsRef.current;
      const isAr = tw?.language === 'ar';
      const letter = tw?.letter || '?';
      const glyph = isAr
        ? (LETTER_GLYPHS.ar[letter] || letter)
        : (LETTER_GLYPHS.en[letter] || letter);

      const stroke = (text, x, y, lineW) => {
        cctx.lineWidth = lineW;
        cctx.strokeStyle = '#000';
        cctx.strokeText(text, x, y);
        cctx.fillText(text, x, y);
      };

      // Hide the score panel while the "Say [letter]" intro banner is up
      // so the banner has clear space and isn't cut by the panel. Score is
      // 0 at game start anyway.
      if (!st.gameOver && !showSayBannerRef.current) {
        // Big-score panel — matches the live .big-score (right side, biased
        // up). Animated coin scales horizontally to mimic the CSS coinSpin
        // (transform: scaleX(0.18 → 1)).
        const coinR = 22;
        const cx = W - 60;
        const cy = H * 0.18;
        // Coin shimmer / spin: scaleX in [0.18, 1] on a 2.4s cycle.
        const phase = (performance.now() % 2400) / 2400;
        const scaleX = 0.18 + 0.82 * Math.abs(Math.sin(phase * Math.PI));
        cctx.save();
        cctx.translate(cx, cy);
        cctx.scale(scaleX, 1);
        // Coin body with radial gradient (highlight top-left)
        const coinGrad = cctx.createRadialGradient(-coinR * 0.3, -coinR * 0.4, 1,
          0, 0, coinR);
        coinGrad.addColorStop(0, '#fff8c2');
        coinGrad.addColorStop(0.4, '#ffe43e');
        coinGrad.addColorStop(1, '#c89200');
        cctx.fillStyle = coinGrad;
        cctx.beginPath();
        cctx.arc(0, 0, coinR, 0, Math.PI * 2);
        cctx.fill();
        // Coin outline (black ring)
        cctx.lineWidth = 3;
        cctx.strokeStyle = '#000';
        cctx.stroke();
        // Star inside
        cctx.fillStyle = '#5b3c00';
        cctx.font = 'bold 22px Inter, system-ui, sans-serif';
        cctx.textAlign = 'center';
        cctx.textBaseline = 'middle';
        cctx.fillText('★', 0, 1);
        cctx.restore();
        // "SCORE" pill — pink/orange gradient
        const pillW = 64;
        const pillH = 20;
        const pillY = cy + coinR + 8;
        const pillX = cx - pillW / 2;
        const pillGrad = cctx.createLinearGradient(pillX, pillY, pillX + pillW, pillY + pillH);
        pillGrad.addColorStop(0, '#fe2c55');
        pillGrad.addColorStop(1, '#ff8e3d');
        cctx.fillStyle = pillGrad;
        cctx.beginPath();
        cctx.arc(pillX + pillH / 2, pillY + pillH / 2, pillH / 2, Math.PI / 2, -Math.PI / 2);
        cctx.lineTo(pillX + pillW - pillH / 2, pillY);
        cctx.arc(pillX + pillW - pillH / 2, pillY + pillH / 2, pillH / 2, -Math.PI / 2, Math.PI / 2);
        cctx.closePath();
        cctx.fill();
        cctx.fillStyle = '#fff';
        cctx.font = 'bold 11px Inter, system-ui, sans-serif';
        cctx.textAlign = 'center';
        cctx.textBaseline = 'middle';
        cctx.fillText(isAr ? 'النقاط' : 'SCORE', cx, pillY + pillH / 2);
        // Big yellow score number with black outline
        cctx.font = 'bold 64px Inter, system-ui, sans-serif';
        cctx.fillStyle = '#ffe43e';
        cctx.textBaseline = 'top';
        const scoreY = pillY + pillH + 8;
        stroke(String(st.score), cx, scoreY, 6);
        // "×N combo" pill — matches .big-score__combo (cyan-ringed dark
        // chip). Only shows when streak > 1, same as the live UI.
        if (st.streak > 1) {
          const comboText = `×${st.streak} ${isAr ? 'متتالية' : 'combo'}`;
          cctx.font = 'bold 11px Inter, system-ui, sans-serif';
          const tw = cctx.measureText(comboText).width;
          const cbW = tw + 22;
          const cbH = 22;
          const cbY = scoreY + 72;
          const cbX = cx - cbW / 2;
          // Black-translucent rounded chip with cyan outline
          cctx.fillStyle = 'rgba(0,0,0,0.55)';
          cctx.beginPath();
          cctx.arc(cbX + cbH / 2, cbY + cbH / 2, cbH / 2, Math.PI / 2, -Math.PI / 2);
          cctx.lineTo(cbX + cbW - cbH / 2, cbY);
          cctx.arc(cbX + cbW - cbH / 2, cbY + cbH / 2, cbH / 2, -Math.PI / 2, Math.PI / 2);
          cctx.closePath();
          cctx.fill();
          cctx.lineWidth = 1.5;
          cctx.strokeStyle = '#25f4ee';
          cctx.stroke();
          // Cyan text
          cctx.fillStyle = '#25f4ee';
          cctx.textAlign = 'center';
          cctx.textBaseline = 'middle';
          cctx.fillText(comboText, cx, cbY + cbH / 2);
        }
      }

      // "Say [letter]" big banner (intro).
      if (showSayBannerRef.current) {
        cctx.font = `bold ${Math.min(96, W * 0.16)}px Inter, system-ui, sans-serif`;
        cctx.textAlign = 'center';
        cctx.textBaseline = 'middle';
        const text = isAr ? `قل «${glyph}»` : `Say "${glyph}"`;
        cctx.fillStyle = '#fff';
        stroke(text, W / 2, H * 0.36, 10);
      } else if (fallHintAtRef.current != null) {
        // Two-line wrap so the hint doesn't crowd the score panel on
        // narrow phone screens.
        const fontSize = Math.min(48, W * 0.08);
        cctx.font = `bold ${fontSize}px Inter, system-ui, sans-serif`;
        cctx.textAlign = 'center';
        cctx.textBaseline = 'middle';
        const lines = isAr
          ? ['لا تدع', 'طائرك يسقط']
          : ["Don't let", 'your bird fall'];
        cctx.fillStyle = '#fff';
        const lineH = fontSize * 1.1;
        const baseY = H * 0.36;
        lines.forEach((line, i) => {
          stroke(line, W / 2, baseY + (i - (lines.length - 1) / 2) * lineH, 8);
        });
      }

      // Game-over overlay — dim + GAME OVER + big score.
      if (st.gameOver) {
        cctx.fillStyle = 'rgba(0,0,0,.45)';
        cctx.fillRect(0, 0, W, H);
        cctx.textAlign = 'center';
        cctx.textBaseline = 'middle';
        cctx.fillStyle = '#fe2c55';
        cctx.font = 'bold 36px Inter, system-ui, sans-serif';
        stroke(isAr ? 'انتهت اللعبة' : 'GAME OVER', W / 2, H * 0.38, 6);
        cctx.fillStyle = '#fff';
        cctx.font = `bold ${Math.min(160, W * 0.28)}px Inter, system-ui, sans-serif`;
        stroke(String(st.score), W / 2, H * 0.5, 8);
      }

      raf = requestAnimationFrame(drawFrame);
    };
    raf = requestAnimationFrame(drawFrame);

    const stream = composite.captureStream(30);
    const stop = () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (composite.parentNode) composite.parentNode.removeChild(composite);
    };
    return { stream, stop };
  }, []);

  const toggleRecording = useCallback(async (preCapturedScreen) => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      alert('Recording is not supported in this browser.');
      return;
    }
    // Three paths to a video track:
    //   1. preCapturedScreen — Play & Record desktop flow already captured
    //      the screen while user-gesture was fresh.
    //   2. getDisplayMedia — desktop HUD button, opens the share picker.
    //   3. canvas.captureStream — phone fallback (iOS Safari and most mobile
    //      browsers don't expose getDisplayMedia at all). Records just the
    //      game canvas, not the webcam background or HTML HUD.
    let videoStream = preCapturedScreen;
    let isCanvasCapture = false;
    let compositeStop = null;
    if (!videoStream) {
      if (navigator.mediaDevices?.getDisplayMedia) {
        try {
          videoStream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: 30 },
          });
        } catch (e) {
          // User dismissed picker or denied — silent.
          setIsRecording(false);
          return;
        }
      } else {
        const canvas = canvasRef.current;
        if (!canvas || typeof canvas.captureStream !== 'function'
            || typeof document.createElement('canvas').captureStream !== 'function') {
          alert('Recording is not supported in this browser.');
          return;
        }
        const result = startCompositeCapture();
        if (!result) {
          alert('Recording is not supported in this browser.');
          return;
        }
        videoStream = result.stream;
        compositeStop = result.stop;
        isCanvasCapture = true;
      }
    }
    try {
      // Mix the mic stream (user's voice — the actual gameplay audio) into
      // the recording. Lives in streamRef for the duration of the game.
      const micTracks = streamRef.current ? streamRef.current.getAudioTracks() : [];
      const combined = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...micTracks,
      ]);
      recStreamRef.current = videoStream;
      // Prefer MP4 (plays in QuickTime/iMovie/iOS Photos with no conversion)
      // when supported; otherwise fall back to WebM.
      const mimeCandidates = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ];
      const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const isMp4 = mime.startsWith('video/mp4');
      const ext = isMp4 ? 'mp4' : 'webm';
      const blobType = isMp4 ? 'video/mp4' : 'video/webm';
      const mr = new MediaRecorder(combined, { mimeType: mime });
      recChunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recChunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        const blob = new Blob(recChunksRef.current, { type: blobType });
        if (blob.size === 0) {
          alert('Recording finished but no data was captured.');
        } else {
          const filename = `humming-bird-${Date.now()}.${ext}`;
          const file = new File([blob], filename, { type: blobType });
          // Try to share immediately. Works when the user pressed Stop in
          // the HUD (the click gesture is still active for navigator.share).
          // For auto-stop on game-over, the gesture has expired and share
          // will throw — we then stash the blob in pendingRecording so the
          // game-over "Save recording" button can trigger share from a
          // fresh tap. Without that we'd fall back to a file download.
          let shared = false;
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
              await navigator.share({ files: [file], title: 'Humming Bird recording' });
              shared = true;
            } catch (_) { /* user cancelled OR gesture expired */ }
          }
          if (!shared) {
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              // Share is supported but not allowed right now — defer until
              // the user taps the "Save recording" button.
              setPendingRecording({ blob, file, filename, blobType });
            } else {
              // Desktop fallback: trigger download anchor.
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = filename;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
          }
        }
        // Stop the video source. For screen-share we stop the OS-level
        // screen tracks. For composite capture we cancel the rAF loop and
        // remove the offscreen canvas (compositeStop), then stop the
        // captured stream's tracks.
        if (compositeStop) compositeStop();
        videoStream.getTracks().forEach((tr) => tr.stop());
        recStreamRef.current = null;
        setIsRecording(false);
      };
      // For screen capture only: if the user clicks the browser's "Stop
      // sharing" UI, mirror that into stopping the recorder.
      if (!isCanvasCapture) {
        videoStream.getVideoTracks()[0].addEventListener('ended', () => {
          if (mr.state !== 'inactive') mr.stop();
        });
      }
      recorderRef.current = mr;
      mr.start(1000);
      setIsRecording(true);
    } catch (e) {
      if (compositeStop) compositeStop();
      videoStream.getTracks().forEach((tr) => tr.stop());
      alert(`Couldn't start recording: ${e.message || e}`);
      setIsRecording(false);
    }
  }, [startCompositeCapture]);
  // Stop any in-flight recording when the tab tears down.
  useEffect(() => () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop(); } catch (_) { /* ignore */ }
    }
    if (recStreamRef.current) {
      recStreamRef.current.getTracks().forEach((tr) => tr.stop());
    }
  }, []);

  // "Play & Record" path from the permission card.
  //
  // Critical: capture the screen FIRST, while the click's user-gesture is
  // still fresh. Browsers (incl. Chromium-based ones) drop the gesture
  // across an awaited getUserMedia mic prompt — so calling getDisplayMedia
  // AFTER start() would silently reject and produce no recording. By
  // capturing the screen up front and handing it to toggleRecording, the
  // share picker reliably appears.
  //
  // Auto-stop on game-over is handled by the effect below, same as for
  // a recording started from the HUD button.
  const startAndRecord = useCallback(async () => {
    let screenStream = null;
    if (navigator.mediaDevices?.getDisplayMedia) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 },
        });
      } catch (_) {
        // User dismissed the share picker. Fall back to starting the game
        // without recording — same outcome as clicking plain Play.
        screenStream = null;
      }
    }
    await start();
    if (!streamRef.current) {
      if (screenStream) screenStream.getTracks().forEach((tr) => tr.stop());
      return;
    }
    if (screenStream) {
      // Desktop path: hand the pre-captured screen stream to the recorder.
      await toggleRecording(screenStream);
    } else if (!navigator.mediaDevices?.getDisplayMedia) {
      // Phone path: no screen-capture API. Wait for the game canvas to mount
      // after setPhase('playing'), then start canvas-based recording.
      for (let i = 0; i < 30 && !canvasRef.current; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (canvasRef.current) {
        await toggleRecording();
      }
    }
  }, [start, toggleRecording]);

  // Auto-stop any in-flight recording the moment the round ends, so the
  // saved file is exactly one round (intro → lose). Defer slightly so the
  // game-over UI paints into the recording's final frame.
  useEffect(() => {
    if (!stats.gameOver) return;
    const mr = recorderRef.current;
    if (!mr || mr.state === 'inactive') return;
    const t = setTimeout(() => {
      if (mr.state !== 'inactive') {
        try { mr.stop(); } catch (_) { /* ignore */ }
      }
    }, 400);
    return () => clearTimeout(t);
  }, [stats.gameOver]);

  const resetScore = () => {
    const g = gameRef.current;
    g.score = 0; g.hits = 0; g.streak = 0; g.bestStreak = 0; g.cols = [];
    g.gameOver = false;
    g.spawnTimer = 0;
    g.birdVy = 0;
    g.initialized = false; // re-center bird on next frame
    // Pick a NEW random letter — distinct from the current one — so each
    // "Play again" run challenges a different sound. Arabic mode excludes
    // 'v' (no native glyph).
    const choices = lettersFor(tRef.current.language);
    const current = tRef.current.letter;
    let pick = current;
    while (pick === current) {
      pick = choices[Math.floor(Math.random() * choices.length)];
    }
    setTweak('letter', pick);
    setStats({ score: 0, hits: 0, streak: 0, bestStreak: 0, gameOver: false });
    setPendingRecording(null);
    playIntroBanners();
  };

  // Bar normalisation: target sits ~middle (50%) so user can see deviation.
  const meterPct = clamp((hudStrength / Math.max(0.02, (t.targetStrengthByLetter?.[t.letter] ?? 26) / 100)) * 50, 0, 100);
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
            <div className="stat stat--streak">
              <div className="lbl">{t.language === 'ar' ? 'أفضل نتيجة' : 'Best Score'}</div>
              <div className="val">{stats.bestStreak}</div>
            </div>
          </div>
        )}
      </div>

      {/* Side meter and bottom game-info pills removed by request —
          the on-canvas big-score panel + game-over card cover all
          essential feedback. */}

      {/* Center cards */}
      {phase === 'intro' && (
        <PermissionCard onStart={start} onStartAndRecord={startAndRecord}
          onLanguageChange={(lang) => setTweak('language', lang)}
          error={error} requesting={requesting}
          letter={t.letter} language={t.language} />
      )}
      {phase === 'playing' && showSayBanner && (
        <div className="runway-banner">
          <div className="runway-banner__say"
               dir={t.language === 'ar' ? 'rtl' : 'ltr'}>
            {t.language === 'ar'
              ? <span className="ar-glyph">قل <b>«{glyphFor(t.letter, 'ar')}»</b></span>
              : <>Say <b>“{glyphFor(t.letter, 'en')}”</b></>}
          </div>
        </div>
      )}
      {/* Persistent "Say [letter]" badge on the left edge during gameplay
          (hidden during runway and game-over since those have their own
          letter callouts). */}
      {phase === 'playing' && !runway.active && !stats.gameOver && (
        <div className="say-indicator">
          <div className="say-indicator__label">
            {t.language === 'ar' ? 'قل' : 'Say'}
          </div>
          <div className={'say-indicator__glyph' + (t.language === 'ar' ? ' ar-glyph' : '')}>
            {glyphFor(t.letter, t.language)}
          </div>
        </div>
      )}
      {/* Right-side gamified score panel: spinning coin + popping score number + streak pill */}
      {phase === 'playing' && !runway.active && !stats.gameOver && (
        <div className="big-score">
          <div className="big-score__coin">★</div>
          <div className="big-score__label">
            {t.language === 'ar' ? 'النقاط' : 'Score'}
          </div>
          <div className="big-score__num" key={stats.score}>{stats.score}</div>
          {stats.streak > 1 && (
            <div className="big-score__combo" key={`combo-${stats.streak}`}>
              ×{stats.streak} {t.language === 'ar' ? 'متتالية' : 'combo'}
            </div>
          )}
        </div>
      )}
      {/* Game-over card */}
      {/* Screen-record button: starts/stops a screen capture via the
          browser's getDisplayMedia API and downloads a .webm when stopped. */}
      {phase === 'playing' && (
        <button className={'record-btn' + (isRecording ? ' is-on' : '')}
                onClick={() => toggleRecording()}
                title={isRecording ? 'Stop & save' : 'Record'}>
          {isRecording ? <span className="record-btn__square" /> : <span className="record-btn__dot" />}
          <span className="record-btn__lbl">
            {isRecording
              ? (t.language === 'ar' ? 'إيقاف وحفظ' : 'Stop & save')
              : (t.language === 'ar' ? 'تسجيل' : 'Record')}
          </span>
        </button>
      )}
      {phase === 'playing' && stats.gameOver && (
        <div className={'gameover-card' + (t.language === 'ar' ? ' is-rtl' : '')}
             dir={t.language === 'ar' ? 'rtl' : 'ltr'}>
          <div className="gameover-card__label">
            {t.language === 'ar' ? 'انتهت اللعبة' : 'Game Over'}
          </div>
          <div className="gameover-card__score">{stats.score}</div>
          <div className="gameover-card__sub">
            {t.language === 'ar' ? 'أفضل سلسلة' : 'Best streak'} ·{' '}
            <b>{stats.bestStreak}</b>
          </div>
          <div className="gameover-card__fact">
            <div className="gameover-card__fact-label">
              {t.language === 'ar' ? 'هل تعلم...' : 'Did you know...'}
            </div>
            <div className={'gameover-card__fact-text' + (t.language === 'ar' ? ' ar-glyph' : '')}>
              {factFor(t.letter, t.language)}
            </div>
          </div>
          {pendingRecording && (
            <button className="btn ghost gameover-card__save"
                    onClick={savePendingRecording}>
              {t.language === 'ar' ? 'حفظ الفيديو' : 'Save recording'}
            </button>
          )}
          <button className="btn primary" onClick={resetScore}>
            {t.language === 'ar' ? 'العب مرة أخرى' : 'Play again'}
          </button>
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
          <div className="game-shell">
            <canvas ref={canvasRef}></canvas>
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
            ].filter((o) => lettersFor(t.language).includes(o.value))}
            onChange={(v) => setTweak('letter', v)} />
          <TweakSlider label={`Target strength (${t.letter})`}
            value={t.targetStrengthByLetter?.[t.letter] ?? 26} min={2} max={80} step={1}
            onChange={(v) => setTweak('targetStrengthByLetter', { ...(t.targetStrengthByLetter ?? {}), [t.letter]: v })} />
          <TweakSlider label="Sensitivity" value={t.sensitivity} min={0.01} max={2.5} step={0.01}
            onChange={(v) => setTweak('sensitivity', v)} />
          <TweakSlider label="Smoothing" value={t.smoothing} min={0} max={95} step={1} unit="%"
            onChange={(v) => setTweak('smoothing', v)} />
          <TweakSlider label="Noise gate" value={t.noiseGate ?? 2.5} min={1} max={5} step={0.1}
            onChange={(v) => setTweak('noiseGate', v)} />
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
  if (gapTop > 0) drawPipeBody(ctx, x, 0, pipeW, gapTop, 'down', c.hit);
  if (gapBot < playH) drawPipeBody(ctx, x, gapBot, pipeW, playH - gapBot, 'up', c.hit);
}

function drawPipeBody(ctx, x, y, w, h, capSide, hit) {
  if (h <= 0) return;
  const cols = makePipeColumns(w, hit);
  const capH = 5;
  const bodyTop = capSide === 'up' ? y + capH : y;
  const bodyBot = capSide === 'down' ? y + h - capH : y + h;
  for (let i = 0; i < cols.length; i++) {
    ctx.fillStyle = cols[i];
    ctx.fillRect(x + i, bodyTop, 1, Math.max(0, bodyBot - bodyTop));
  }
  ctx.fillStyle = hit ? '#8a2020' : PIPE_DARK;
  if (capSide === 'up') ctx.fillRect(x, bodyBot - 1, w, 1);
  else ctx.fillRect(x, bodyTop, w, 1);
  const capX = x - 1;
  const capW = w + 2;
  const capY = capSide === 'up' ? y : y + h - capH;
  const capCols = makePipeColumns(capW, hit);
  for (let i = 0; i < capCols.length; i++) {
    ctx.fillStyle = capCols[i];
    ctx.fillRect(capX + i, capY + 1, 1, capH - 2);
  }
  ctx.fillStyle = hit ? '#8a2020' : PIPE_DARK;
  ctx.fillRect(capX, capY, capW, 1);
  ctx.fillRect(capX, capY + capH - 1, capW, 1);
}

function makePipeColumns(w, hit) {
  const D = hit ? '#8a2020' : PIPE_DARK;
  const L = hit ? '#ff9a8a' : PIPE_LIGHT;
  const B = hit ? '#d75050' : PIPE_BODY;
  const S = hit ? '#7a1f1f' : PIPE_SHADOW;
  const out = new Array(w);
  out[0] = D; out[1] = L; out[2] = L;
  for (let i = 3; i < w - 3; i++) out[i] = B;
  if (w >= 6) { out[w - 3] = S; out[w - 2] = S; }
  out[w - 1] = D;
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
