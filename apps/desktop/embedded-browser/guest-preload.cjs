const { ipcRenderer } = require('electron');
for (const kind of ['pointer', 'key', 'wheel']) {
  const type = kind === 'pointer' ? 'pointerdown' : kind === 'key' ? 'keydown' : 'wheel';
  addEventListener(type, event => {
    if (event.isTrusted) ipcRenderer.send('mingle.embedded.human-input', { kind, timeStamp: event.timeStamp });
  }, true);
}
