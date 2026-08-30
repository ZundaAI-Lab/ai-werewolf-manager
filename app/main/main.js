/**
 * 責務: Electronウィンドウ、秘密情報を扱うIPC、AI設定の読込・保存・起動時読込通知IPC、外観設定IPC、組み込み/ユーザーキャラクターライブラリ、人狼ゲームとは独立した自由チャットルーム保存・観戦ルーム保存、構造化プロンプトEnvelopeのLLM要求、外部LLMデータ送信確認とプロファイル利用上限の送信前ガード、API使用量・実績料金集計、自動保存を提供する。
 * 変更ルール: ゲーム規則とDOM操作を持たず、現在のメインウィンドウmainFrameから届く固定IPCだけを受理する。Web権限はpermissionPolicy.jsで全拒否し、必要な権限をMain側で暗黙許可しない。通常生成ではRendererが渡した固定完全応答契約をプロバイダーのsystem指示へ分離して送り、本文プロンプトへ再結合しない。プロファイルの一時上書きはOllama投票再試行のthinking=noneだけを厳密条件下で許可し、保存設定を変更しない。LLM失敗は構造化して返し、HTTP分類はproviderClients.js、料金計算・プロファイル上限判定はllm/usageCostCalculator.js、並行要求の上限予約はprofileBudgetReservation.js、ローカルモデル発見はlocalLlmClient.js、自動保存順序はautosaveStore.jsを正本とする。アプリ終了時はゲーム自動保存・自由チャット保存・観戦ルーム保存を期限付きで完了待機してから終了する。外部ナビゲーションと任意ファイルアクセスは許可せず、Clipboard書込もMain IPC境界でUTF-8バイト上限を検証する。組み込みキャラクターは固定ディレクトリから読み、ユーザー作成分・使用状態・表示順だけをuserDataへ保存する。
 */

'use strict';

const { app, BrowserWindow, clipboard, ipcMain, MessageChannelMain, session, shell } = require('electron');
const { createHash, randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { AutosaveStore } = require('./autosaveStore.js');
const { ChatRoomStore } = require('./chatRoomStore.js');
const { SpectatorRoomStore } = require('./spectatorRoomStore.js');
const { SettingsStore } = require('./settingsStore.js');
const { AppearanceStore } = require('./appearanceStore.js');
const { PrivacyNoticeStore } = require('./privacyNoticeStore.js');
const { generateWithProvider, isLocalProvider, ProviderRequestError } = require('./providerClients.js');
const { normalizePromptEnvelope } = require('./llm/promptEnvelopeValidator.js');
const { promptHashForNormalizedEnvelope } = require('./llm/promptHashPolicy.js');
const { calculateUsageCostUsd } = require('./llm/usageCostCalculator.js');
const { listLocalModels } = require('./localLlmClient.js');
const { connectionTestPromptEnvelope, testProfileConnection } = require('./profileConnectionTest.js');
const { flushAutosaveForShutdown } = require('./shutdownAutosaveCoordinator.js');
const { settleWithin } = require('./promiseDeadline.js');
const { createProfileBudgetReservationManager } = require('./profileBudgetReservation.js');
const { requestRendererAutosaveFlush } = require('./rendererAutosaveFlush.js');
const { createTrustedIpcRegistrar } = require('./ipcSenderGuard.js');
const { UserCharacterDataStore } = require('./userCharacterDataStore.js');
const { CharacterLibraryService } = require('./characterLibraryService.js');
const { runExternalDataOperation } = require('./externalDataNoticeGate.js');
const { installPermissionDenyPolicy } = require('./permissionPolicy.js');

let mainWindow = null;
let settingsStore = null;
let appearanceStore = null;
let privacyNoticeStore = null;
let autosaveStore = null;
let chatRoomStore = null;
let spectatorRoomStore = null;
let characterLibraryService = null;
let profileBudgetReservations = null;
let quittingAfterPersistenceFlush = false;
let quitFlushInProgress = false;
const activeRequests = new Map();
const CHAT_ROOM_FLUSH_TIMEOUT_MS = 5000;
const SPECTATOR_ROOM_FLUSH_TIMEOUT_MS = 5000;
const MAX_CLIPBOARD_BYTES = 8 * 1024 * 1024;

function requestHash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function serializeProviderError(error, provider = '') {
  if (error instanceof ProviderRequestError) {
    return {
      code: error.code,
      message: error.message,
      provider: error.provider ?? provider,
      status: error.status,
      retryable: error.retryable === true,
      deliveryUnknown: error.deliveryUnknown === true,
      retryAfterMs: Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : null,
    };
  }
  return {
    code: error instanceof RangeError ? 'CONFIGURATION_ERROR' : 'UNKNOWN',
    message: error?.message ?? String(error),
    provider,
    status: null,
    retryable: false,
    deliveryUnknown: false,
    retryAfterMs: null,
  };
}

function safeRecordRequest(entry) {
  try {
    settingsStore.recordRequest(entry);
  } catch (error) {
    console.error('API使用量またはログの保存に失敗しました。', error);
  }
}


function profileForGenerateRequest(profile, request) {
  const override = request?.thinkingLevelOverride;
  if (override === null || override === undefined || override === '') return profile;
  const allowed = override === 'none'
    && String(request?.taskType ?? '') === 'vote'
    && profile?.localServerPreset === 'ollama';
  if (!allowed) {
    throw new ProviderRequestError('この要求ではThinking設定の一時上書きを使用できません。', {
      provider: profile?.provider ?? '',
      code: 'INVALID_REQUEST_OVERRIDE',
    });
  }
  return { ...profile, thinkingLevel: 'none' };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#11151c',
    title: 'AI人狼マネージャー',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            preload: undefined,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
          },
        },
      };
    }
    if (/^https:\/\//u.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== event.sender.getURL()) event.preventDefault();
  });
}

function registerIpc() {
  const trustedIpc = createTrustedIpcRegistrar(ipcMain, () => mainWindow);

  trustedIpc.onSync('desktop:load-autosave-sync', (event) => {
    event.returnValue = autosaveStore.loadSync();
  });

  trustedIpc.onSync('desktop:load-shutdown-warning-sync', (event) => {
    event.returnValue = autosaveStore.loadShutdownFlushFailureSync();
  });

  trustedIpc.onSync('desktop:load-chat-room-sync', (event) => {
    event.returnValue = chatRoomStore.loadSync();
  });

  trustedIpc.onSync('desktop:load-spectator-room-sync', (event) => {
    event.returnValue = spectatorRoomStore.loadSync();
  });

  trustedIpc.onSync('desktop:load-character-catalog-sync', (event) => {
    event.returnValue = characterLibraryService.loadCatalog();
  });

  trustedIpc.onSync('desktop:load-appearance-sync', (event) => {
    event.returnValue = appearanceStore.publicSettings();
  });

  trustedIpc.onSync('desktop:load-external-data-notice-status-sync', (event) => {
    event.returnValue = privacyNoticeStore.status();
  });

  trustedIpc.handle('desktop:save-user-character-library', (_event, library, options) => {
    return characterLibraryService.replaceUserLibrary(library, {
      validateCharacterIds: Array.isArray(options?.validateCharacterIds) ? options.validateCharacterIds : [],
    });
  });

  trustedIpc.handle('desktop:set-builtin-character-group-enabled', (_event, groupId, enabled) => {
    return characterLibraryService.setBuiltinGroupEnabled(groupId, enabled === true);
  });

  trustedIpc.handle('desktop:set-builtin-character-enabled', (_event, characterId, enabled) => {
    return characterLibraryService.setBuiltinCharacterEnabled(characterId, enabled === true);
  });

  trustedIpc.handle('desktop:set-character-group-order', (_event, groupIds) => {
    return characterLibraryService.setGroupOrder(groupIds);
  });

  trustedIpc.handle('desktop:set-character-order', (_event, groupId, characterIds) => {
    return characterLibraryService.setCharacterOrder(groupId, characterIds);
  });

  trustedIpc.handle('desktop:save-autosave', async (_event, state) => {
    await autosaveStore.save(state);
    return { ok: true };
  });

  trustedIpc.handle('desktop:save-chat-room', async (_event, state) => {
    return chatRoomStore.save(state);
  });

  trustedIpc.handle('desktop:save-spectator-room', async (_event, state) => {
    return spectatorRoomStore.save(state);
  });

  trustedIpc.handle('desktop:get-settings', () => settingsStore.publicSettings());
  trustedIpc.handle('desktop:get-settings-startup-notices', () => settingsStore.consumeStartupNotices());
  trustedIpc.handle('desktop:save-appearance', (_event, appearance) => appearanceStore.savePublicSettings(appearance));
  trustedIpc.handle('desktop:accept-external-data-notice', (_event, version) => privacyNoticeStore.accept(version));
  trustedIpc.handle('desktop:save-settings', (_event, settings) => settingsStore.savePublicSettings(settings));
  trustedIpc.handle('desktop:get-usage-summary', () => settingsStore.getUsageSummary());
  trustedIpc.handle('desktop:reset-usage-summary', (_event, scope) => settingsStore.resetUsageSummary(scope));
  trustedIpc.handle('desktop:reset-profile-usage', (_event, profileId) => settingsStore.resetUsageSummary('profile', profileId));
  trustedIpc.handle('desktop:write-clipboard', (_event, text) => {
    const value = String(text ?? '');
    const byteLength = Buffer.byteLength(value, 'utf8');
    if (byteLength > MAX_CLIPBOARD_BYTES) {
      return { ok: false, code: 'CLIPBOARD_TEXT_TOO_LARGE', maxBytes: MAX_CLIPBOARD_BYTES };
    }
    clipboard.writeText(value);
    return { ok: true };
  });

  trustedIpc.handle('desktop:generate', async (_event, request) => {
    const requestId = String(request?.requestId || randomUUID());
    if (activeRequests.has(requestId)) {
      return {
        ok: false,
        requestId,
        error: serializeProviderError(new ProviderRequestError('同じ要求IDが実行中です。', {
          code: 'DUPLICATE_REQUEST',
        })),
      };
    }

    const profileId = String(request?.profileId ?? '');
    let profile = null;
    let controller = null;
    let releaseBudgetReservation = () => {};
    let promptHash = null;
    const startedAt = Date.now();
    try {
      const promptEnvelope = normalizePromptEnvelope(request?.promptEnvelope);
      promptHash = promptHashForNormalizedEnvelope(promptEnvelope);
      profile = settingsStore.profileById(profileId);
      releaseBudgetReservation = profileBudgetReservations.reserve(profile, promptEnvelope);
      const apiKey = profile.provider === 'demo' ? '' : settingsStore.decryptApiKey(profileId);
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort({ code: 'REQUEST_TIMEOUT' }), profile.timeoutMs);
      activeRequests.set(requestId, controller);
      try {
        const result = await runExternalDataOperation({
          profile,
          privacyNoticeStore,
          operation: () => generateWithProvider({
          profile: profileForGenerateRequest(profile, request),
          apiKey,
          promptEnvelope,
          taskType: String(request?.taskType ?? ''),
          playerName: String(request?.playerName ?? ''),
          requestPurpose: String(request?.requestPurpose ?? 'normal'),
          signal: controller.signal,
          }),
        });
        const usage = { ...(result.usage ?? {}), costUsd: calculateUsageCostUsd(profile, result.usage) };
        safeRecordRequest({
          timestamp: new Date().toISOString(),
          requestId,
          profileId,
          label: profile.label,
          provider: profile.provider,
          model: profile.model,
          taskType: String(request?.taskType ?? ''),
          playerName: String(request?.playerName ?? ''),
          gameId: String(request?.gameId ?? ''),
          retryIndex: Number(request?.retryIndex ?? 0),
          publicHistoryMode: String(request?.publicHistoryMode ?? ''),
          generationStage: String(request?.generationStage ?? 'direct'),
          requestPurpose: String(request?.requestPurpose ?? 'normal'),
          isTaskCall: request?.isTaskCall === true,
          taskStart: request?.taskStart === true,
          regeneratedTask: request?.regeneratedTask === true,
          promptHash,
          providerDiagnostics: result.providerDiagnostics ?? null,
          responseHash: requestHash(result.text),
          usage,
          elapsedMs: Date.now() - startedAt,
          status: 'completed',
        });
        return {
          ok: true,
          requestId,
          ...result,
          usage,
          profile: { label: profile.label, provider: profile.provider, model: profile.model },
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const structured = serializeProviderError(error, profile?.provider ?? '');
      safeRecordRequest({
        timestamp: new Date().toISOString(),
        requestId,
        profileId,
        label: profile?.label ?? '',
        provider: profile?.provider ?? '',
        model: profile?.model ?? '',
        taskType: String(request?.taskType ?? ''),
        playerName: String(request?.playerName ?? ''),
        gameId: String(request?.gameId ?? ''),
        retryIndex: Number(request?.retryIndex ?? 0),
        publicHistoryMode: String(request?.publicHistoryMode ?? ''),
        requestPurpose: String(request?.requestPurpose ?? 'normal'),
        generationStage: String(request?.generationStage ?? 'direct'),
        isTaskCall: request?.isTaskCall === true,
        taskStart: request?.taskStart === true,
        regeneratedTask: request?.regeneratedTask === true,
        promptHash,
        elapsedMs: Date.now() - startedAt,
        status: 'failed',
        error: structured.message,
        errorCode: structured.code,
        statusCode: structured.status,
        retryable: structured.retryable,
        deliveryUnknown: structured.deliveryUnknown,
      });
      return { ok: false, requestId, error: structured };
    } finally {
      releaseBudgetReservation();
      if (controller) activeRequests.delete(requestId);
    }
  });

  trustedIpc.handle('desktop:cancel-request', (_event, requestId) => {
    const controller = activeRequests.get(String(requestId));
    if (!controller) return { ok: false, message: '実行中の要求がありません。' };
    controller.abort({ code: 'CANCELLED' });
    return { ok: true };
  });

  trustedIpc.handle('desktop:list-profile-models', async (_event, profileId) => {
    let profile = null;
    const controller = new AbortController();
    let timeout = null;
    try {
      profile = settingsStore.profileById(profileId);
      if (!isLocalProvider(profile)) {
        throw new ProviderRequestError('モデル一覧取得はローカルLLMプロファイルだけ利用できます。', {
          provider: profile?.provider,
          code: 'LOCAL_PROVIDER_REQUIRED',
        });
      }
      const apiKey = settingsStore.decryptApiKey(profileId);
      timeout = setTimeout(() => controller.abort({ code: 'REQUEST_TIMEOUT' }), Math.min(profile.timeoutMs, 30000));
      const result = await listLocalModels({ profile, apiKey, signal: controller.signal });
      return { ok: true, ...result, profile: { label: profile.label, provider: profile.provider, model: profile.model } };
    } catch (error) {
      return { ok: false, error: serializeProviderError(error, profile?.provider ?? '') };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  });

  trustedIpc.handle('desktop:test-profile', async (_event, profileId) => {
    let profile = null;
    const requestId = `connection-test-${randomUUID()}`;
    const startedAt = Date.now();
    let releaseBudgetReservation = () => {};
    try {
      profile = settingsStore.profileById(profileId);
      const promptEnvelope = connectionTestPromptEnvelope();
      releaseBudgetReservation = profileBudgetReservations.reserve(profile, promptEnvelope);
      const apiKey = profile.provider === 'demo' ? '' : settingsStore.decryptApiKey(profileId);
      const result = await runExternalDataOperation({
        profile,
        privacyNoticeStore,
        operation: () => testProfileConnection({ profile, apiKey, serializeError: serializeProviderError }),
      });
      const usage = { ...(result.usage ?? {}), costUsd: calculateUsageCostUsd(profile, result.usage) };
      safeRecordRequest({
        timestamp: new Date().toISOString(), requestId, profileId: profile.id, label: profile.label, provider: profile.provider, model: profile.model,
        taskType: 'connection-test', playerName: '接続確認', gameId: '', retryIndex: 0, requestPurpose: 'diagnostic', generationStage: 'direct',
        isTaskCall: false, taskStart: false, regeneratedTask: false, usage, elapsedMs: Date.now() - startedAt, status: 'completed',
      });
      return { ...result, usage };
    } catch (error) {
      const structured = serializeProviderError(error, profile?.provider ?? '');
      const usage = error?.usage ? { ...error.usage, costUsd: calculateUsageCostUsd(profile, error.usage) } : undefined;
      if (profile) {
        safeRecordRequest({
          timestamp: new Date().toISOString(), requestId, profileId: profile.id, label: profile.label, provider: profile.provider, model: profile.model,
          taskType: 'connection-test', playerName: '接続確認', gameId: '', retryIndex: 0, requestPurpose: 'diagnostic', generationStage: 'direct',
          isTaskCall: false, taskStart: false, regeneratedTask: false, usage, elapsedMs: Date.now() - startedAt, status: 'failed',
          error: structured.message, errorCode: structured.code, statusCode: structured.status, retryable: structured.retryable, deliveryUnknown: structured.deliveryUnknown,
        });
      }
      return { ok: false, error: structured };
    } finally {
      releaseBudgetReservation();
    }
  });
}

app.whenReady().then(() => {
  installPermissionDenyPolicy(session);
  const userDataPath = app.getPath('userData');
  settingsStore = new SettingsStore(userDataPath);
  profileBudgetReservations = createProfileBudgetReservationManager({
    getProfileUsage: (profileId) => settingsStore.getProfileUsage(profileId),
  });
  appearanceStore = new AppearanceStore(userDataPath);
  privacyNoticeStore = new PrivacyNoticeStore(userDataPath);
  autosaveStore = new AutosaveStore(userDataPath);
  chatRoomStore = new ChatRoomStore(userDataPath);
  spectatorRoomStore = new SpectatorRoomStore(userDataPath);
  characterLibraryService = new CharacterLibraryService({
    builtinDataRoot: join(__dirname, '..', 'renderer', 'data', 'characters'),
    userStore: new UserCharacterDataStore(userDataPath),
  });
  registerIpc();
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', (event) => {
  try {
    settingsStore?.flushUsageSummary();
  } catch (error) {
    console.error('終了前のAPI使用量保存に失敗しました。', error);
  }
  if (quittingAfterPersistenceFlush || !autosaveStore) return;
  event.preventDefault();
  if (quitFlushInProgress) return;
  quitFlushInProgress = true;
  const autosaveFlush = flushAutosaveForShutdown(autosaveStore, {
    prepareLatestState: () => requestRendererAutosaveFlush(mainWindow, {
      createMessageChannel: () => new MessageChannelMain(),
    }),
  });
  const chatRoomFlush = chatRoomStore
    ? settleWithin(
        chatRoomStore.flush(),
        CHAT_ROOM_FLUSH_TIMEOUT_MS,
        `終了前のチャットルーム保存が${CHAT_ROOM_FLUSH_TIMEOUT_MS}ms以内に完了しませんでした。`,
        { code: 'CHAT_ROOM_FLUSH_TIMEOUT' },
      ).then(() => ({ ok: true })).catch((error) => ({ ok: false, error }))
    : Promise.resolve({ ok: true });
  const spectatorRoomFlush = spectatorRoomStore
    ? settleWithin(
        spectatorRoomStore.flush(),
        SPECTATOR_ROOM_FLUSH_TIMEOUT_MS,
        `終了前の観戦ルーム保存が${SPECTATOR_ROOM_FLUSH_TIMEOUT_MS}ms以内に完了しませんでした。`,
        { code: 'SPECTATOR_ROOM_FLUSH_TIMEOUT' },
      ).then(() => ({ ok: true })).catch((error) => ({ ok: false, error }))
    : Promise.resolve({ ok: true });
  const primaryPersistenceFlush = Promise.all([autosaveFlush, chatRoomFlush]);
  Promise.all([primaryPersistenceFlush, spectatorRoomFlush])
    .then(([[autosaveOutcome, chatRoomOutcome], spectatorRoomOutcome]) => {
      if (!autosaveOutcome.ok) console.error('終了前の自動保存完了待機に失敗しました。', autosaveOutcome.error);
      if (!chatRoomOutcome.ok) console.error('終了前のチャットルーム保存完了待機に失敗しました。', chatRoomOutcome.error);
      if (!spectatorRoomOutcome.ok) console.error('終了前の観戦ルーム保存完了待機に失敗しました。', spectatorRoomOutcome.error);
    })
    .finally(() => {
      quittingAfterPersistenceFlush = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

module.exports = {
  serializeProviderError,
};
