/**
 * 責務: RendererからMainへ届くIPCの送信元を、現在のメインウィンドウのmainFrameだけへ限定する。
 * 変更ルール: IPC業務処理やチャンネル固有の値検証を持たず、送信元検証と安全な登録ラッパーだけを提供する。拒否時は同期IPCへnullを返し、非同期IPCは分類可能な例外で失敗させる。
 */

'use strict';

function isTrustedMainFrame(event, mainWindow) {
  const webContents = mainWindow?.webContents;
  if (!webContents || typeof webContents.isDestroyed !== 'function' || webContents.isDestroyed()) return false;
  return event?.sender === webContents && event?.senderFrame === webContents.mainFrame;
}

function untrustedIpcSenderError() {
  const error = new Error('許可されていないIPC送信元です。');
  error.code = 'UNTRUSTED_IPC_SENDER';
  return error;
}

function createTrustedIpcRegistrar(ipcMain, getMainWindow) {
  if (!ipcMain || typeof ipcMain.on !== 'function' || typeof ipcMain.handle !== 'function') {
    throw new TypeError('有効なipcMainが必要です。');
  }
  if (typeof getMainWindow !== 'function') {
    throw new TypeError('メインウィンドウ取得関数が必要です。');
  }

  return Object.freeze({
    onSync(channel, listener) {
      ipcMain.on(channel, (event, ...args) => {
        if (!isTrustedMainFrame(event, getMainWindow())) {
          event.returnValue = null;
          return;
        }
        listener(event, ...args);
      });
    },

    handle(channel, listener) {
      ipcMain.handle(channel, async (event, ...args) => {
        if (!isTrustedMainFrame(event, getMainWindow())) throw untrustedIpcSenderError();
        return listener(event, ...args);
      });
    },
  });
}

module.exports = {
  createTrustedIpcRegistrar,
  isTrustedMainFrame,
};
