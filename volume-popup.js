const bridge = window.simpleCloud;
const slider = document.getElementById('volume');
const levelText = document.getElementById('volume-level');

function updateLabel() {
  const level = `${slider.value}%`;
  levelText.textContent = slider.disabled ? '–' : level;
  slider.setAttribute('aria-valuetext', level);
  slider.style.setProperty('--volume-fill', level);
}

bridge.onVolume(level => {
  slider.disabled = !Number.isFinite(level);
  if (!slider.matches(':active') && !slider.disabled) slider.value = Math.round(level * 100);
  updateLabel();
});
bridge.onFocusVolume(() => slider.focus());
slider.addEventListener('input', () => {
  updateLabel();
  bridge.action('volume', slider.valueAsNumber / 100);
});
slider.addEventListener('pointerdown', () => bridge.action('volumeHold', true));
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  document.addEventListener(type, () => bridge.action('volumeHold', false), true);
}
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' && event.key !== 'Tab') return;
  event.preventDefault();
  bridge.action('volumeDismiss');
});
bridge.ready();
