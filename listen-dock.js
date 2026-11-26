const bridge = window.simpleCloud;
const dock = document.getElementById('dock');

dock.addEventListener('click', () => bridge.action('close'));
bridge.onFocusListenDock(() => dock.focus());
