const { ipcRenderer } = require('electron');
let pointerHeld = false;
function report(event, kind, phase) {
  // The relay stamps its synthetic input with zero. It must never affect native drag state.
  if (!event.isTrusted || !(event.timeStamp > 0)) return;
  if (phase === 'down') pointerHeld = true;
  if (phase === 'up') pointerHeld = false;
  ipcRenderer.send('mingle.embedded.human-input', { kind, timeStamp: event.timeStamp, ...(phase ? { phase } : {}) });
}
for (const kind of ['key', 'wheel']) {
  const type = kind === 'key' ? 'keydown' : 'wheel';
  addEventListener(type, event => {
    report(event, kind);
  }, true);
}
addEventListener('pointerdown', event => report(event, 'pointer', 'down'), true);
addEventListener('pointerup', event => report(event, 'pointer', 'up'), true);
addEventListener('pointercancel', event => report(event, 'pointer', 'up'), true);
addEventListener('blur', event => { if (pointerHeld) report(event, 'pointer', 'up'); }, true);
