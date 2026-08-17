/**
 * 責務: アプリ起動、モジュール接続、外観設定の初期読込とdialog接続、正式タブ登録、グローバルUI操作、ゲームデータJSON入出力、新規ゲームと設定引継ぎ再開始の確認、デスクトップ自動保存、自動進行通知制御、AI項目単位回収後の自動代替登録APIの公開窓口を担当する。
 * 変更ルール: ゲーム規則・AI代替規則・画面描画・通知表示ポリシー・インポート参照検査・設定引継ぎ対象の選別は各専用モジュールへ委譲する。ゲームデータ転送の実処理は本モジュールを正本とし、ゲーム準備／記録・管理の表示層から送られる要求だけを受ける。破棄確認は同期ブラウザモーダルを使わず専用dialogを閉じた次フレームで初期化する。自動夜進行の通知秘匿スコープもAppUIへ委譲し、進行層へ人物名置換規則を複製しない。ゲーム準備の局所入力変更はイベント詳細を付け、不要な自動化側の全体更新を起動しない。ブラウザストレージへは読み書きしない。デスクトップ自動保存もゲームデータ読込と同じ製品schema互換ポリシーを通し、旧schemaは一方向migration、未来schemaは拒否する。現在扱えないゲーム事実は補修せず拒否し、利用不能な履歴エントリだけは個別除外して警告する。
 */

import { APP_VERSION, PROMPT_SPEC_VERSION } from '../config/constants.js';
import { BUILD_ID } from '../../generated/buildInfo.js';
import { createInitialState, StateStore } from '../state/stateStore.js';
import { createAutosaveState } from '../state/autosaveState.js';
import { prepareImportedState } from '../state/stateImport.js';
import { AppUI } from '../ui/AppUI.js';
import { defaultAppearanceSettings, normalizeAppearanceSettings } from '../appearance/appearanceModel.js';
import { applyManagementAppearance } from '../appearance/appearanceTheme.js';
import { createAppearanceController } from '../ui/appearance/appearanceController.js';
import { downloadJson, readFileText } from '../shared/utils.js';
import { resolveGenerationPlan } from '../services/generationDepthPolicy.js';
import { runGenerationPipeline } from '../services/generationPipeline.js';
import { createGenerationPipelineTestTask } from '../services/generationPipelineTestFixture.js';
import { resolveGenerationStagePromptPolicy } from '../prompts/stages/generationStagePromptPolicy.js';
import { buildDraftStagePrompt, buildProofreadStagePrompt, buildRenderStagePrompt } from '../prompts/stages/generationStagePromptBuilder.js';
import { mergeTextPatch, parseTextPatchResponse, validateTextPatchForStage } from '../prompts/stages/generationStageResponse.js';
import { createRuntimeFacade, publishRuntimeContract } from './runtimeFacade.js';
import { resolveAutomaticAction } from '../domain/game/automaticActionPolicy.js';
import '../privacy/dataTransmissionNotice.js';
import '../automation/automationEntry.js';

function resolveInitialState() {
  const loadAutosave = window.desktopWerewolf?.loadAutosaveSync;
  if (typeof loadAutosave !== 'function') return { state: createInitialState(), restored: false };
  try {
    const saved = loadAutosave();
    if (!saved) return { state: createInitialState(), restored: false };
    return { state: prepareImportedState(saved), restored: true };
  } catch (error) {
    console.warn('デスクトップ自動保存を復元できないため、新規状態で起動します。', error);
    return { state: createInitialState(), restored: false };
  }
}

function startApplication(initialState, { restored = false, appearanceSettings: initialAppearance = defaultAppearanceSettings() } = {}) {
  const store = new StateStore(initialState);
  let appearanceSettings = normalizeAppearanceSettings(initialAppearance);
  const ui = new AppUI(store, { getAppearance: () => appearanceSettings });
  const appearanceController = createAppearanceController({
    dialog: document.querySelector('#appearance-dialog'),
    initialSettings: appearanceSettings,
    saveSettings: (settings) => window.desktopWerewolf?.saveAppearance?.(settings) ?? Promise.resolve(settings),
    toast: (message, type) => ui.toast(message, type),
    onChange: (next) => {
      appearanceSettings = next;
      ui.refreshAppearance();
    },
  });
  document.querySelector('#appearance-button')?.addEventListener('click', () => appearanceController.open());

  publishRuntimeContract(window);
  window.__AI_WEREWOLF_RUNTIME__ = createRuntimeFacade({
    getState: () => store.getState(),
    getAutosaveState: () => createAutosaveState(store.getState()),
    getCurrentWorkbenchTask: () => ui.getCurrentWorkbenchTask(),
    getPublicSnapshot: (options) => ui.getPublicSnapshot(options),
    getRoleDisplayName: (roleId) => ui.getRoleDisplayName(roleId),
    isWorkbenchPlayerFrozen: (playerId) => ui.isWorkbenchPlayerFrozen(playerId),
    toast: (message, type, options) => ui.toast(message, type, options),
    dismissToast: (key) => ui.dismissToast(key),
    beginAutomaticNotifications: () => ui.beginAutomaticNotifications(),
    endAutomaticNotifications: () => ui.endAutomaticNotifications(),
    beginNightActorPrivacy: () => ui.beginNightActorPrivacy(),
    endNightActorPrivacy: () => ui.endNightActorPrivacy(),
    setTab: (tab) => ui.setTab(tab),
    getActiveTab: () => ui.getActiveTab(),
    registerTabView: (tab, view) => ui.registerTabView(tab, view),
    refreshTab: (tab) => ui.refreshTab(tab),
    setAutomationUiState: (state) => ui.setAutomationUiState(state),
    setPublicHistoryTransmissionMode: (mode) => ui.setPublicHistoryTransmissionMode(mode),
    setAiExecutionSettings: (settings) => ui.setAiExecutionSettings(settings),
    setPostgameAnalysisAdapter: (adapter) => ui.setPostgameAnalysisAdapter(adapter),
    scheduleFullPublicHistory: (playerIds) => ui.scheduleFullPublicHistory(playerIds),
    getAiHistoryStatus: () => ui.getAiHistoryStatus(),
    getCurrentAiTaskRequest: () => ui.getCurrentAiTaskRequest(),
    resolveAutomaticAction: (options) => resolveAutomaticAction(store.getState(), options),
    executeAutomaticAction: (action) => ui.executeAutomaticAction(action),
    prepareAiTask: (request) => ui.prepareAiTask(request),
    evaluateAiTaskCandidate: (request) => ui.evaluateAiTaskCandidate(request),
    commitAiTaskCandidate: (request) => ui.commitAiTaskCandidate(request),
    commitAiTaskFallback: (request) => ui.commitAiTaskFallback(request),
    resolveGenerationPlan,
    runGenerationPipeline,
    createGenerationPipelineTestTask,
    resolveGenerationStagePromptPolicy,
    buildDraftStagePrompt,
    buildRenderStagePrompt,
    buildProofreadStagePrompt,
    parseTextPatchResponse,
    validateTextPatchForStage,
    mergeTextPatch,
  });

  store.subscribe(() => {
    const changeDetail = ui.handleStoreStateChange();
    window.dispatchEvent(new CustomEvent('ai-werewolf-state-changed', changeDetail ? { detail: changeDetail } : undefined));
  });
  ui.render();
  window.dispatchEvent(new CustomEvent('ai-werewolf-state-ready'));
  if (restored) ui.toast('前回終了時の自動保存データを復元しました。', 'success');
  const shutdownWarning = window.desktopWerewolf?.loadShutdownWarningSync?.();
  if (shutdownWarning) {
    ui.toast(`前回終了時に自動保存の完了を確認できませんでした。必要に応じて保存内容を確認してください。（${shutdownWarning.message ?? '詳細不明'}）`, 'warning');
  }

  function rejectAutomationMutation() {
    if (!ui.isAutomationMutationLocked()) return false;
    ui.toast('自動実行中はこの変更操作を実行できません。一時停止してから操作してください。', 'warning');
    return true;
  }

  document.querySelector('#confidential-toggle').addEventListener('click', () => {
    ui.setConfidential(!ui.showConfidential);
  });

  document.querySelector('#undo-button').addEventListener('click', () => {
    if (rejectAutomationMutation()) return;
    if (!ui.canUseGlobalHistory()) return ui.toast('モーダルを閉じてから元に戻してください。', 'error');
    ui.resetTransientState();
    if (!store.undo()) ui.toast('元に戻せる非公開変更はありません。公開済み情報は訂正モードで修正してください。');
  });

  document.querySelector('#redo-button').addEventListener('click', () => {
    if (rejectAutomationMutation()) return;
    if (!ui.canUseGlobalHistory()) return ui.toast('モーダルを閉じてからやり直してください。', 'error');
    ui.resetTransientState();
    if (!store.redo()) ui.toast('やり直せる変更はありません。');
  });

  function exportGameData() {
    const state = store.getState();
    const safeTitle = (state.game.title || 'ai-werewolf').replace(/[\/:*?"<>|]/g, '_');
    downloadJson(`${safeTitle}-revision-${state.revision}.json`, state);
    ui.toast('履歴・復元ポイントを含むゲームデータを出力しました。', 'success');
  }

  const importInput = document.querySelector('#game-data-import-file');
  window.addEventListener('ai-werewolf-game-data-export-request', exportGameData);
  window.addEventListener('ai-werewolf-game-data-import-request', () => {
    if (rejectAutomationMutation()) return;
    importInput.click();
  });
  importInput.addEventListener('change', async () => {
    if (rejectAutomationMutation()) { importInput.value = ''; return; }
    const [file] = importInput.files;
    importInput.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await readFileText(file));
      const importWarnings = [];
      const prepared = prepareImportedState(parsed, {
        onWarning: (warnings) => importWarnings.push(...warnings),
      });
      ui.resetTransientState();
      store.replace('ゲームデータ読込', prepared, { preserveProvidedHistory: true });
      ui.toast('製品schema互換・構造・型・参照整合性を確認してゲームデータを読み込みました。', 'success');
      if (importWarnings.length) {
        ui.toast(`利用不能な履歴または補助情報を${importWarnings.length}件除外しました。`, 'warning');
        console.warn('ゲームデータ読込警告:', ...importWarnings);
      }
    } catch (error) {
      ui.toast(`ゲームデータ読込失敗: ${error.message}`, 'error');
    }
  });

  const newGameDialog = document.querySelector('#new-game-dialog');
  newGameDialog.addEventListener('close', () => {
    const action = newGameDialog.returnValue;
    if (!['confirm', 'restart-current-setup'].includes(action)) return;
    if (rejectAutomationMutation()) return;
    newGameDialog.returnValue = 'cancel';
    requestAnimationFrame(() => {
      ui.resetTransientState({ closeModal: false });
      if (action === 'restart-current-setup') store.restartWithCurrentSetup();
      else store.reset(8);
      ui.setTab('setup');
      document.querySelector('#app-content')?.focus({ preventScroll: true });
      ui.toast(
        action === 'restart-current-setup'
          ? '現在のキャラクター設定・配役・ルールを引き継いで、最初から始めます。'
          : 'すべての設定を初期化して新規ゲームを作成しました。',
        'success',
      );
    });
  });

  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === 'z' && !event.shiftKey) {
      event.preventDefault();
      if (rejectAutomationMutation()) return;
      if (!ui.canUseGlobalHistory()) return ui.toast('モーダルを閉じてから元に戻してください。', 'error');
      ui.resetTransientState();
      if (!store.undo()) ui.toast('公開済み情報は通常の元に戻す操作では変更できません。');
    } else if (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey)) {
      event.preventDefault();
      if (rejectAutomationMutation()) return;
      if (!ui.canUseGlobalHistory()) return ui.toast('モーダルを閉じてからやり直してください。', 'error');
      ui.resetTransientState();
      store.redo();
    }
  });
}

const initialAppearance = normalizeAppearanceSettings(
  window.desktopWerewolf?.loadAppearanceSync?.() ?? defaultAppearanceSettings(),
);
applyManagementAppearance(initialAppearance);
const initial = resolveInitialState();
startApplication(initial.state, { restored: initial.restored, appearanceSettings: initialAppearance });

console.info(`AI人狼マネージャー v${APP_VERSION} / ${BUILD_ID} / Prompt ${PROMPT_SPEC_VERSION}`);
