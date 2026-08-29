let enabled = localStorage.getItem('fgf-tts') !== 'off';

export function isTtsEnabled() {
  return enabled;
}

export function toggleTts() {
  enabled = !enabled;
  localStorage.setItem('fgf-tts', enabled ? 'on' : 'off');
  if (!enabled) speechSynthesis.cancel();
  return enabled;
}

export function speak(text) {
  if (!enabled || !text || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.95;
  u.pitch = 1.05;
  speechSynthesis.speak(u);
}

export function wireTtsToggle(btn) {
  const sync = () => {
    btn.classList.toggle('active', enabled);
    btn.title = enabled ? 'Voice readout on' : 'Voice readout off';
  };
  sync();
  btn.addEventListener('click', () => {
    toggleTts();
    sync();
  });
}
