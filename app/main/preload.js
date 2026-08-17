/**
 * 責務: Rendererへ許可済みのデスクトップ機能、AI使用量の参照・範囲指定リセット、外観設定の読込・保存、独立チャットルームと独立観戦ルームの読込・保存、外部LLMデータ送信確認状態の読込・保存、キャラクターライブラリ読込とユーザーデータ・使用状態・グループ順・キャラクター順の更新だけを型の狭いAPIとして公開する。
 * 変更ルール: ipcRenderer本体、Node.js API、任意チャンネル送信を公開しない。引数はMain側でも再検証する。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let autosaveFlushHandler = null;
ipcRenderer.on('desktop:flush-autosave-request', async (event) => {
  const port = event.ports?.[0];
  if (!port) return;
  try {
    if (typeof autosaveFlushHandler === 'function') await autosaveFlushHandler();
    port.postMessage({ ok: true });
  } catch (error) {
    port.postMessage({
      ok: false,
      error: {
        code: String(error?.code ?? 'AUTOSAVE_RENDERER_FLUSH_FAILED'),
        message: String(error?.message ?? error ?? 'Rendererの自動保存送信に失敗しました。'),
      },
    });
  } finally {
    port.close?.();
  }
});

contextBridge.exposeInMainWorld('desktopWerewolf', Object.freeze({
  isDesktop: true,
  loadAutosaveSync: () => ipcRenderer.sendSync('desktop:load-autosave-sync'),
  loadShutdownWarningSync: () => ipcRenderer.sendSync('desktop:load-shutdown-warning-sync'),
  loadChatRoomSync: () => ipcRenderer.sendSync('desktop:load-chat-room-sync'),
  loadSpectatorRoomSync: () => ipcRenderer.sendSync('desktop:load-spectator-room-sync'),
  loadCharacterCatalogSync: () => ipcRenderer.sendSync('desktop:load-character-catalog-sync'),
  loadAppearanceSync: () => ipcRenderer.sendSync('desktop:load-appearance-sync'),
  loadExternalDataNoticeStatusSync: () => ipcRenderer.sendSync('desktop:load-external-data-notice-status-sync'),
  saveUserCharacterLibrary: (library, options = {}) => ipcRenderer.invoke('desktop:save-user-character-library', library, options),
  setBuiltinCharacterGroupEnabled: (groupId, enabled) => ipcRenderer.invoke('desktop:set-builtin-character-group-enabled', groupId, enabled),
  setBuiltinCharacterEnabled: (characterId, enabled) => ipcRenderer.invoke('desktop:set-builtin-character-enabled', characterId, enabled),
  setCharacterGroupOrder: (groupIds) => ipcRenderer.invoke('desktop:set-character-group-order', groupIds),
  setCharacterOrder: (groupId, characterIds) => ipcRenderer.invoke('desktop:set-character-order', groupId, characterIds),
  saveAutosave: (state) => ipcRenderer.invoke('desktop:save-autosave', state),
  saveChatRoom: (state) => ipcRenderer.invoke('desktop:save-chat-room', state),
  saveSpectatorRoom: (state) => ipcRenderer.invoke('desktop:save-spectator-room', state),
  registerAutosaveFlushHandler: (handler) => {
    if (typeof handler !== 'function') throw new TypeError('自動保存flushハンドラーは関数で指定してください。');
    autosaveFlushHandler = handler;
  },
  getSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('desktop:save-settings', settings),
  saveAppearance: (appearance) => ipcRenderer.invoke('desktop:save-appearance', appearance),
  acceptExternalDataNotice: (version) => ipcRenderer.invoke('desktop:accept-external-data-notice', version),
  getUsageSummary: () => ipcRenderer.invoke('desktop:get-usage-summary'),
  resetUsageSummary: (scope) => ipcRenderer.invoke('desktop:reset-usage-summary', scope),
  resetProfileUsage: (profileId) => ipcRenderer.invoke('desktop:reset-profile-usage', profileId),
  writeClipboard: (text) => ipcRenderer.invoke('desktop:write-clipboard', text),
  generate: (request) => ipcRenderer.invoke('desktop:generate', request),
  cancelRequest: (requestId) => ipcRenderer.invoke('desktop:cancel-request', requestId),
  testProfile: (profileId) => ipcRenderer.invoke('desktop:test-profile', profileId),
  listProfileModels: (profileId) => ipcRenderer.invoke('desktop:list-profile-models', profileId),
}));
