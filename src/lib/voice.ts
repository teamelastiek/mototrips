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

/** Moet vanuit een tik/klik worden aangeroepen zodat iOS spraak toestaat. */
export function unlockVoice() {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
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
