/**
 * 責務: Main IPCが現在のメインウィンドウmainFrameだけを受理し、同期・非同期の拒否経路を固定する。
 * 変更ルール: Electron実体へ依存せず、送信元境界と登録ラッパーの公開契約だけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTrustedIpcRegistrar,
  isTrustedMainFrame,
} = require('../../../app/main/ipcSenderGuard.js');

function fixture() {
  const handlers = new Map();
  const listeners = new Map();
  const mainFrame = { id: 'main-frame' };
  const webContents = {
    mainFrame,
    isDestroyed: () => false,
  };
  const mainWindow = { webContents };
  const ipcMain = {
    handle: (channel, listener) => handlers.set(channel, listener),
    on: (channel, listener) => listeners.set(channel, listener),
  };
  const registrar = createTrustedIpcRegistrar(ipcMain, () => mainWindow);
  return { handlers, listeners, mainFrame, webContents, mainWindow, registrar };
}

test('IPC送信元は現在のメインウィンドウmainFrameだけを信頼する', () => {
  const { mainFrame, webContents, mainWindow } = fixture();
  assert.equal(isTrustedMainFrame({ sender: webContents, senderFrame: mainFrame }, mainWindow), true);
  assert.equal(isTrustedMainFrame({ sender: {}, senderFrame: mainFrame }, mainWindow), false);
  assert.equal(isTrustedMainFrame({ sender: webContents, senderFrame: {} }, mainWindow), false);
  assert.equal(isTrustedMainFrame({ sender: webContents, senderFrame: mainFrame }, null), false);

  webContents.isDestroyed = () => true;
  assert.equal(isTrustedMainFrame({ sender: webContents, senderFrame: mainFrame }, mainWindow), false);
});

test('非同期IPCは不正送信元を分類済み例外で拒否し正規送信元だけを実行する', async () => {
  const { handlers, mainFrame, webContents, registrar } = fixture();
  let callCount = 0;
  registrar.handle('desktop:test', async (_event, value) => {
    callCount += 1;
    return value * 2;
  });

  const handler = handlers.get('desktop:test');
  assert.equal(await handler({ sender: webContents, senderFrame: mainFrame }, 4), 8);
  assert.equal(callCount, 1);

  await assert.rejects(
    () => handler({ sender: webContents, senderFrame: {} }, 5),
    (error) => error?.code === 'UNTRUSTED_IPC_SENDER',
  );
  assert.equal(callCount, 1);
});

test('同期IPCは不正送信元へnullを返し保存処理を実行しない', () => {
  const { listeners, mainFrame, webContents, registrar } = fixture();
  let callCount = 0;
  registrar.onSync('desktop:load', (event) => {
    callCount += 1;
    event.returnValue = { ok: true };
  });

  const listener = listeners.get('desktop:load');
  const trustedEvent = { sender: webContents, senderFrame: mainFrame, returnValue: undefined };
  listener(trustedEvent);
  assert.deepEqual(trustedEvent.returnValue, { ok: true });
  assert.equal(callCount, 1);

  const untrustedEvent = { sender: {}, senderFrame: mainFrame, returnValue: undefined };
  listener(untrustedEvent);
  assert.equal(untrustedEvent.returnValue, null);
  assert.equal(callCount, 1);
});
