/** Only the trusted main workspace may read or change device-local window decorations. */
export function registerWindowDecorationIpc({ ipcMain, preference, isAllowed }) {
  ipcMain.handle('mingle.window-decoration.state', event => isAllowed(event) ? preference.getState() : null);
  ipcMain.handle('mingle.window-decoration.set', async (event, titleBar) => {
    if (!isAllowed(event)) return null;
    if (titleBar !== 'system' && titleBar !== 'hidden') throw new Error('Invalid title bar choice.');
    try { return await preference.setTitleBar(titleBar); }
    catch { throw new Error('Could not save the title bar choice.'); }
  });
}
