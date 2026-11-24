const { ipcRenderer } = require('electron');
// Mouse and keyboard are attributed in the browser process before dispatch.
// Electron does not expose a corresponding native event for touch pointers.
function reportTouch(event, phase) {
  if (!event.isTrusted || event.pointerType !== 'touch' || !event.isPrimary || !(event.timeStamp > 0)) return;
  ipcRenderer.send('mingle.embedded.human-input', { kind: 'pointer', timeStamp: event.timeStamp, phase });
}
addEventListener('wheel', event => {
  if (event.isTrusted) ipcRenderer.send('mingle.embedded.human-input', { kind: 'wheel', timeStamp: event.timeStamp });
}, { capture: true, passive: true });
addEventListener('pointerdown', event => reportTouch(event, 'down'), true);
addEventListener('pointerup', event => reportTouch(event, 'up'), true);
addEventListener('pointercancel', event => reportTouch(event, 'up'), true);
