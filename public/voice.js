export function createVoiceInput(button, textarea, { onStart, onEnd } = {}) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    button.disabled = true;
    button.title = 'Voice not supported in this browser';
    return { supported: false };
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  let listening = false;
  let baseText = '';

  recognition.onstart = () => {
    listening = true;
    baseText = textarea.value;
    button.classList.add('recording');
    button.setAttribute('aria-pressed', 'true');
    onStart?.();
  };

  recognition.onend = () => {
    listening = false;
    button.classList.remove('recording');
    button.setAttribute('aria-pressed', 'false');
    onEnd?.();
  };

  recognition.onresult = (e) => {
    let interim = '';
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    textarea.value = (baseText + ' ' + final + interim).trim();
    textarea.dispatchEvent(new Event('input'));
  };

  button.addEventListener('click', () => {
    if (listening) recognition.stop();
    else recognition.start();
  });

  return { supported: true, recognition };
}

export async function typewriter(el, text, speed = 18) {
  el.textContent = '';
  for (let i = 0; i < text.length; i++) {
    el.textContent += text[i];
    await new Promise((r) => setTimeout(r, speed));
  }
}
