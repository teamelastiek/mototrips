// Gesproken instructies via de spraaksynthese van de browser (Nederlands).

let voice: SpeechSynthesisVoice | null = null;
let enabled = true;

function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  voice =
    voices.find((v) => v.lang === 'nl-NL' && /google|neural|natural/i.test(v.name)) ||
    voices.find((v) => v.lang === 'nl-NL') ||
    voices.find((v) => v.lang.startsWith('nl')) ||
    null;
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

export function setVoiceEnabled(on: boolean) {
  enabled = on;
  if (!on && 'speechSynthesis' in window) speechSynthesis.cancel();
}

export function isVoiceEnabled() {
  return enabled;
}

// Eén gedeelde audiocontext voor korte signaaltonen
let audio: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    return audio;
  } catch {
    return null;
  }
}

/** Moet vanuit een tik/klik worden aangeroepen zodat iOS spraak (en geluid) toestaat. */
export function unlockVoice() {
  audioCtx();
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

/**
 * Kort "ding-dong" vóór een groepsbericht, zodat je zonder te kijken hoort
 * dat het een bericht van je maten is en geen afslag. Dringend = drie hoge tonen.
 */
export function chime(kind: 'group' | 'urgent' = 'group') {
  const ctx = audioCtx();
  if (!ctx || !enabled) return;
  const notes = kind === 'urgent' ? [988, 988, 988] : [784, 1175];
  notes.forEach((f, i) => {
    const t = ctx.currentTime + i * (kind === 'urgent' ? 0.16 : 0.18);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.3);
  });
}

/**
 * Gesproken melding (bijv. van de groep): eerst een signaaltoon, dan de tekst.
 * Wordt de melding onderbroken door een afslag-instructie, dan volgt hij daarna alsnog.
 */
export function announce(text: string, opts: { urgent?: boolean; chime?: boolean } = {}) {
  if (!enabled || !('speechSynthesis' in window)) return;
  if (opts.chime !== false) chime(opts.urgent ? 'urgent' : 'group');
  const say = (retry: boolean) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'nl-NL';
    if (voice) u.voice = voice;
    u.rate = 1.05;
    u.onerror = (e) => {
      // Onderbroken door een (belangrijkere) afslag-instructie: straks nog een keer
      if (retry && (e.error === 'interrupted' || e.error === 'canceled')) setTimeout(() => say(false), 2500);
    };
    if (opts.urgent) speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };
  setTimeout(() => say(true), opts.chime === false ? 0 : 420);
}

export function speak(text: string, priority = false) {
  if (!enabled || !('speechSynthesis' in window)) return;
  if (priority) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'nl-NL';
  if (voice) u.voice = voice;
  u.rate = 1.05;
  speechSynthesis.speak(u);
}
