/**
 * 責務: デスクトップ自動化の起動、ES Moduleとして静的に解決した正式依存の生成、各Coordinator／Controllerの接続だけを所有する。
 * 変更ルール: 自動進行、手動生成、人間入力、設定保存、AI管理、進行表示の処理本体はautomation配下の専用モジュールを正本とし、このFacadeへ戻さない。観戦画面から人狼卓を1手進める場合もAI管理ControllerのrunSingleAutomaticStepへ委譲する公開橋だけを提供し、進行規則をFacadeへ複製しない。初期設定読込後の進行卓表示方式もliveProgressControllerへ委譲し、executionModeと表示方式を同期する。循環する生成時依存だけを単一の遅延解決レジストリで接続し、automation内部をwindowグローバル経由で参照しない。個別APIごとの代理関数を追加しない。機密表示はAppUIの専用イベントから表示フラグだけを受け取り、完全状態の秘密情報をFacadeで加工しない。ゲーム準備の局所入力通知は自動保存と明示要求された装飾だけを処理し、割り当て整合・実況・全体ステータス再計算を起動しない。
 */

import { escapeHtml } from '../shared/utils.js';
import * as runtimeAccess from './runtimeAccess.js';
import * as automationRunControl from './automationRunControl.js';
import * as automaticAiExecutorApi from './automaticAiExecutor.js';
import { createDesktopAutomationConfig } from './desktopAutomationConfig.js';
import { createManagementView } from './desktopAutomationManagementView.js';
import { createAutomationStatusController } from './automationStatusController.js';
import { createLiveProgressController } from './liveProgressController.js';
import { createAutomaticRunCoordinator } from './automaticRunCoordinator.js';
import { createSettingsPersistenceCoordinator } from './settingsPersistenceCoordinator.js';
import { createHumanTaskCoordinator } from './humanTaskCoordinator.js';
import { createManualTaskCoordinator } from './manualTaskCoordinator.js';
import { createProfileEditorController } from './profileEditorController.js';
import { createAiProfileTransferController } from './aiProfileTransferController.js';
import { createAssignmentController } from './assignmentController.js';
import { createGenerationTestController } from './generationTestController.js';
import { createAiManagementController } from './aiManagementController.js';
import { createSetupDecorationController } from './setupDecorationController.js';
import { createPostgameAnalysisAdapter } from './postgameAnalysisAdapter.js';

(function startDesktopAutomation() {
  'use strict';

  const apiRetryPolicy = window.AiWerewolfApiRetryPolicy;
  if (!apiRetryPolicy) throw new Error('API再試行ポリシーを読み込めませんでした。');
  const responseRetryPolicy = window.AiWerewolfResponseRetryPolicy;
  if (!responseRetryPolicy) throw new Error('AI応答修復ポリシーを読み込めませんでした。');
  const localLlmConfig = window.AiWerewolfLocalLlmConfig;
  if (!localLlmConfig) throw new Error('ローカルLLM共通設定を読み込めませんでした。');
  const providerDefaults = window.AiWerewolfProviderDefaults;
  if (!providerDefaults) throw new Error('LLMプロバイダー既定値を読み込めませんでした。');
  const endpointPolicy = window.AiWerewolfEndpointPolicy;
  if (!endpointPolicy) throw new Error('共通エンドポイント検証Policyを読み込めませんでした。');
  const settingsSchema = window.AiWerewolfSettingsSchema;
  if (!settingsSchema) throw new Error('AI設定schemaを読み込めませんでした。');
  const dataTransmissionPolicy = window.AiWerewolfDataTransmissionPolicy;
  if (!dataTransmissionPolicy) throw new Error('AIデータ送信Policyを読み込めませんでした。');
  const {
    DEFAULT_OLLAMA_THINKING_LEVEL,
    LOCAL_OPENAI_PROVIDER,
    LOCAL_SERVER_PRESETS,
    OLLAMA_THINKING_LEVELS,
  } = localLlmConfig;

  let controller = null;
  const desktopConfig = createDesktopAutomationConfig({
    localLlmConfig,
    providerDefaults,
    settingsSchema,
    getController: () => controller,
    getProfileById: (profileId) => profileById(profileId),
    escapeHtml: (value) => escapeHtml(value),
    endpointPolicy,
  });
  const {
    PROVIDER_LABELS,
    OLLAMA_THINKING_LEVEL_LABELS,
    PROVIDER_DEFAULTS,
    GENERATION_TASK_OVERRIDE_DEFS,
    GENERATION_DEPTH_DEFS,
    GENERATION_STAGE_LABELS,
    COPY_BOUNDARY_STOP_CODES,
    generationFailureIssueCodes,
    generationFailureRequiresStop,
    defaultGenerationSettings,
    normalizeGenerationSettings,
    generationDepthDef,
    generationStagesForTask,
    effectiveGenerationDepthForTask,
    generationTaskPlans,
    generationSummary,
    generationFlowHtml,
    generationProfileOptions,
    generationDepthOptionsHtml,
    generationTaskOverrideHtml,
    generationRequiredStages,
    generationExecutorProfile,
    generationMaximumNormalCalls,
    generationCallBreakdown,
    generationExecutionPhrase,
    naturalGenerationSummary,
    generationSectionHtml,
    updateGenerationCardUi,
    defaultSettings,
    emptyUsage,
    addUsage,
  } = desktopConfig;

  const fallbackState = { settings: defaultSettings() };
  const bridge = window.desktopWerewolf ?? Object.freeze({
    isDesktop: false,
    getSettings: async () => structuredClone(fallbackState.settings),
    saveSettings: async (settings) => {
      fallbackState.settings = structuredClone(settings);
      return structuredClone(fallbackState.settings);
    },
    saveSettingsWithProfileDeletion: async (settings, _profileId) => {
      fallbackState.settings = structuredClone(settings);
      return structuredClone(fallbackState.settings);
    },
    saveAssignments: async (assignments) => {
      fallbackState.settings = { ...fallbackState.settings, assignments: structuredClone(assignments) };
      return structuredClone(fallbackState.settings);
    },
    getUsageSummary: async () => ({ totals: emptyUsage(), totalCostUsd: 0, profiles: {} }),
    resetUsageSummary: async () => ({ totals: emptyUsage(), totalCostUsd: 0, profiles: {} }),
    resetProfileUsage: async () => ({ totals: emptyUsage(), totalCostUsd: 0, profiles: {} }),
    saveAutosave: async () => ({ ok: true }),
    registerAutosaveFlushHandler: () => {},
    generate: async (request) => {
      const demoAi = window.AiWerewolfDemoAi;
      if (!demoAi || typeof demoAi.generate !== 'function') {
        throw new Error('デモAIを初期化できませんでした。');
      }
      return {
        ok: true,
        requestId: request.requestId,
        text: demoAi.generate(request),
        usage: emptyUsage(),
        profile: { label: 'デモAI', provider: 'demo', model: 'demo-balanced' },
      };
    },
    cancelRequest: async () => ({ ok: false }),
    testProfile: async () => ({ ok: true, text: '{"ok":true}', profile: { label: 'デモAI' } }),
    listProfileModels: async () => ({ ok: true, models: ['demo-balanced'], modelsEndpoint: '' }),
  });

  controller = {
    settings: defaultSettings(),
    settingsLoadState: bridge.isDesktop ? 'pending' : 'loaded',
    running: false,
    stepping: false,
    runSession: null,
    completedSteps: 0,
    usage: emptyUsage(),
    persistedUsage: { totals: emptyUsage(), totalCostUsd: 0, profiles: {} },
    managementScrollTop: 0,
    liveView: false,
    showConfidential: false,
    automationMode: 'idle',
    automationDetail: null,
    waitingHuman: false,
    pendingHumanTask: null,
    resumeAfterHuman: false,
    resumeAfterManualAi: false,
    pendingManualAiTask: null,
    statusMessage: '自動実行を初期化しています。',
    statusType: 'idle',
    lastLiveEventCount: 0,
    setupDecorationTimer: null,
    contentMutationRefreshPending: false,
    discoveredModels: new Map(),
    generationTestResults: new Map(),
    selectedProfileId: null,
    profileEditorTab: 'connection',
    bulkAssignmentProfileId: null,
    managementSectionOpen: {
      profiles: true,
      assignments: false,
      options: false,
      usage: false,
    },
  };

  const automationModules = Object.create(null);
  function lateControllerMethod(moduleName, methodName) {
    return (...args) => {
      const module = automationModules[moduleName];
      const method = module?.[methodName];
      if (typeof method !== 'function') throw new Error(`自動化Controller未接続: ${moduleName}.${methodName}`);
      return method(...args);
    };
  }

  const refreshUsageSummary = lateControllerMethod('settingsPersistenceCoordinator', 'refreshUsageSummary');
  const delay = lateControllerMethod('automaticRunCoordinator', 'delay');
  const structuredApiError = lateControllerMethod('automaticRunCoordinator', 'structuredApiError');
  const apiErrorAsException = lateControllerMethod('automaticRunCoordinator', 'apiErrorAsException');
  const waitFor = lateControllerMethod('automaticRunCoordinator', 'waitFor');
  const waitForRevisionChange = lateControllerMethod('automaticRunCoordinator', 'waitForRevisionChange');
  const refreshLiveView = lateControllerMethod('liveProgressController', 'refreshLiveView');
  const enableLiveView = lateControllerMethod('liveProgressController', 'enableLiveView');
  const syncExecutionModeWorkbenchView = lateControllerMethod('liveProgressController', 'syncExecutionModeWorkbenchView');
  const hideLiveView = lateControllerMethod('liveProgressController', 'hideLiveView');
  const prepareLiveWorkbench = lateControllerMethod('liveProgressController', 'prepareLiveWorkbench');
  const setAutomationMode = lateControllerMethod('automationStatusController', 'setAutomationMode');
  const refreshAutomationStatus = lateControllerMethod('automationStatusController', 'refreshAutomationStatus');
  const isAutomationMutationLocked = lateControllerMethod('automationStatusController', 'isAutomationMutationLocked');
  const isAutomationAiRequestLocked = lateControllerMethod('automationStatusController', 'isAutomationAiRequestLocked');
  const setStatus = lateControllerMethod('automationStatusController', 'setStatus');
  const updateButtons = lateControllerMethod('liveProgressController', 'updateButtons');
  const performOneStep = lateControllerMethod('automaticRunCoordinator', 'performOneStep');
  const runLoop = lateControllerMethod('automaticRunCoordinator', 'runLoop');
  const stopLoop = lateControllerMethod('automaticRunCoordinator', 'stopLoop');
  const persistSettings = lateControllerMethod('settingsPersistenceCoordinator', 'persistSettings');
  const setManagementDirty = lateControllerMethod('settingsPersistenceCoordinator', 'setManagementDirty');
  const testProfile = lateControllerMethod('profileEditorController', 'testProfile');
  const listProfileModels = lateControllerMethod('profileEditorController', 'listProfileModels');
  const resumeAutomaticAfterHuman = lateControllerMethod('humanTaskCoordinator', 'resumeAutomaticAfterHuman');
  const openHumanTask = lateControllerMethod('humanTaskCoordinator', 'openHumanTask');
  const openManualAiTask = lateControllerMethod('manualTaskCoordinator', 'openManualAiTask');
  const showPendingManualAiTask = lateControllerMethod('manualTaskCoordinator', 'showPendingManualAiTask');
  const handleManualAiCommitResult = lateControllerMethod('manualTaskCoordinator', 'handleManualAiCommitResult');
  const refreshVisibleUi = lateControllerMethod('setupDecorationController', 'refreshVisibleUi');
  const managementView = createManagementView({
    controller,
    bridge,
    config: desktopConfig,
    localLlmConfig,
    currentGameState: () => currentGameState(),
    profileById: (profileId) => profileById(profileId),
    assignedProfileId: (playerId) => assignedProfileId(playerId),
    runtime: () => runtime(),
    responseRetryPolicy,
    responseRecoveryModeOptions: (value) => responseRecoveryModeOptions(value),
    getPhaseLabels: () => PHASE_LABELS,
    escapeHtml: (value) => escapeHtml(value),
    endpointPolicy,
    dataTransmissionPolicy,
  });
  const {
    createProfileId,
    providerOptions,
    isLocalProvider,
    isCustomEndpointProvider,
    localServerPresetOptions,
    discoveredModels,
    modelDatalistHtml,
    enabledProfiles,
    firstEnabledProfileId,
    bulkAssignmentProfileId,
    compatibleEndpointValidationMessage,
    assignmentValidation,
    playerProfileSelectHtml,
    renderAssignmentValidation,
    canStartWithAiProfiles,
    isCompatibleEndpointProvider,
    ollamaThinkingOptionsHtml,
    profileConfigurationStatus,
    providerDataRouteMeta,
    reorderedProfiles,
    activeProfileId,
    profileListItemHtml,
    profileEditorTabButton,
    generationTestStageCardHtml,
    generationTestResultHtml,
    profileCard,
    profileWorkspaceHtml,
    assignmentCellHtml,
    assignmentRows,
    formatUsage,
    usageMetricHtml,
    managementSectionOpenAttribute,
    captureManagementSectionState,
    usagePanelHtml,
    historyStatusRows,
    assignmentSummary,
    optionSummary,
    readinessHtml,
    renderManagementPage,
    collectVisibleAssignments,
    collectManagementForm,
  } = managementView;

  const originalConfirm = window.confirm.bind(window);
  window.confirm = (message) => controller.running && controller.settings.autoRun.autoConfirmWarnings
    ? true
    : originalConfirm(message);

  function runtime() {
    return runtimeAccess.getRuntime();
  }

  function activeTab() {
    return runtime().getActiveTab() ?? '';
  }

  function isManagementTabActive() {
    return activeTab() === 'ai-management';
  }





  const executeAiStep = automaticAiExecutorApi.createAutomaticAiExecutor({
    apiRetryPolicy,
    responseRetryPolicy,
    runControl: automationRunControl,
    controller,
    bridge,
    runtime,
    currentGameState,
    profileForPlayer,
    profileById,
    playerName,
    addUsage,
    refreshUsageSummary,
    setStatus,
    waitFor,
    structuredApiError,
    apiErrorAsException,
    generationFailureRequiresStop,
  });

  function responseRecoveryModeOptions(selectedValue) {
    const selected = responseRetryPolicy.normalizeRecoveryMode(selectedValue);
    return [
      ['stop', '停止して手動対応'],
      ['repair', '失敗JSONを1回だけ部分修復'],
      ['repair-regenerate', '部分修復後、元の応答形式で再生成（推奨）'],
    ].map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
  }


  const PHASE_LABELS = Object.freeze({
    setup: 'ゲーム準備', briefing: '役職通知', night: '夜', dawn: '夜明け', discussion: '昼議論',
    vote: '投票', runoff: '決選投票', execution: '処刑', result: '結果確認', ended: 'ゲーム終了',
  });


  /*
   * 公開実況スクロール責務:
   * 全再描画で外側スクロール位置を失わないようにし、新しい公開イベントが追加された時だけ最新位置へ移動する。
   * scrollIntoViewは親画面まで動かす可能性があるため使用しない。
   */


  function currentGameState() {
    try {
      return runtime().getState() ?? null;
    } catch {
      return null;
    }
  }

  function profileById(profileId) {
    return controller.settings.profiles.find((profile) => profile.id === profileId) ?? null;
  }

  function assignedProfileId(playerId) {
    const profileId = controller.settings.assignments?.[playerId];
    return typeof profileId === 'string' && profileId ? profileId : null;
  }

  function usesManualAiGeneration(playerId) {
    return !assignedProfileId(playerId);
  }

  function profileForPlayer(playerId) {
    const profileId = assignedProfileId(playerId);
    const profile = profileById(profileId);
    if (!profileId || !profile) throw new Error(`${playerName(playerId)}に利用可能なAIプロファイルが設定されていません。`);
    if (!profile.enabled) throw new Error(`${playerName(playerId)}のAIプロファイル「${profile.label}」は無効です。`);
    return profile;
  }

  function playerName(playerId) {
    return currentGameState()?.players?.find((player) => player.id === playerId)?.name ?? 'AIプレイヤー';
  }

  function taskSignature() {
    const state = currentGameState();
    if (!state) return 'state:none';
    const request = runtime().getCurrentAiTaskRequest?.() ?? {};
    return [
      state.revision,
      state.game?.phase ?? '',
      request.taskType ?? '',
      request.playerId ?? '',
      request.slotId ?? '',
    ].join(':');
  }


  function dispatchInput(control, value) {
    control.value = value;
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function dialogError() {
    const dialog = document.querySelector('#modal-dialog[open]');
    if (!dialog) return null;
    const text = dialog.textContent?.trim() ?? '';
    if (text.includes('AI応答を登録できません')) return text.replace(/\s+/gu, ' ').slice(0, 1000);
    return null;
  }

  const AI_COMMIT_RESULT_EVENT = 'ai-werewolf-ai-commit-result';

  const controllerContext = {
    AI_COMMIT_RESULT_EVENT,
    DEFAULT_OLLAMA_THINKING_LEVEL,
    GENERATION_STAGE_LABELS,
    LOCAL_OPENAI_PROVIDER,
    LOCAL_SERVER_PRESETS,
    PHASE_LABELS,
    PROVIDER_DEFAULTS,
    PROVIDER_LABELS,
    activeTab,
    apiErrorAsException,
    apiRetryPolicy,
    assignmentSummary,
    assignmentValidation,
    automationRunControl,
    bridge,
    bulkAssignmentProfileId,
    captureManagementSectionState,
    collectManagementForm,
    controller,
    createProfileId,
    currentGameState,
    defaultGenerationSettings,
    dataTransmissionPolicy,
    delay,
    dialogError,
    discoveredModels,
    dispatchInput,
    emptyUsage,
    escapeHtml,
    enableLiveView,
    syncExecutionModeWorkbenchView,
    executeAiStep,
    firstEnabledProfileId,
    handleManualAiCommitResult,
    hideLiveView,
    isAutomationAiRequestLocked,
    isAutomationMutationLocked,
    isCustomEndpointProvider,
    isLocalProvider,
    isManagementTabActive,
    isMatchingAiCommitResult,
    normalizeGenerationSettings,
    openHumanTask,
    openManualAiTask,
    performOneStep,
    persistSettings,
    playerName,
    playerProfileSelectHtml,
    prepareLiveWorkbench,
    profileById,
    profileConfigurationStatus,
    providerDataRouteMeta,
    readinessHtml,
    refreshLiveView,
    refreshVisibleUi,
    reorderedProfiles,
    resumeAutomaticAfterHuman,
    runLoop,
    runtime,
    setAutomationMode,
    setManagementDirty,
    setStatus,
    stopLoop,
    taskSignature,
    showPendingManualAiTask,
    updateButtons,
    updateGenerationCardUi,
    usesManualAiGeneration,
    waitForRevisionChange,
  };
  const automationStatusController = automationModules.automationStatusController = createAutomationStatusController(controllerContext);
  const liveProgressController = automationModules.liveProgressController = createLiveProgressController(controllerContext);
  const automaticRunCoordinator = automationModules.automaticRunCoordinator = createAutomaticRunCoordinator(controllerContext);
  const settingsPersistenceCoordinator = automationModules.settingsPersistenceCoordinator = createSettingsPersistenceCoordinator(controllerContext);
  const humanTaskCoordinator = automationModules.humanTaskCoordinator = createHumanTaskCoordinator(controllerContext);
  const manualTaskCoordinator = automationModules.manualTaskCoordinator = createManualTaskCoordinator(controllerContext);
  const profileEditorController = automationModules.profileEditorController = createProfileEditorController(controllerContext);
  const aiProfileTransferController = automationModules.aiProfileTransferController = createAiProfileTransferController(controllerContext);
  const assignmentController = automationModules.assignmentController = createAssignmentController(controllerContext);
  const generationTestController = automationModules.generationTestController = createGenerationTestController(controllerContext);
  const aiManagementController = automationModules.aiManagementController = createAiManagementController({
    ...controllerContext,
    profileEditorController,
    aiProfileTransferController,
    assignmentController,
    generationTestController,
  });
  const setupDecorationController = automationModules.setupDecorationController = createSetupDecorationController(controllerContext);
  const postgameAnalysisAdapter = automationModules.postgameAnalysisAdapter = createPostgameAnalysisAdapter({
    bridge,
    controller,
    profileById,
    addUsage,
    refreshUsageSummary,
  });

  function isMatchingAiCommitResult(detail, expected) {
    return String(detail?.playerId ?? '') === String(expected?.playerId ?? '')
      && String(detail?.taskType ?? '') === String(expected?.taskType ?? '')
      && String(detail?.slotId ?? '') === String(expected?.slotId ?? '');
  }

  function waitForAiCommitResult(expected, { timeoutMs = 12000 } = {}) {
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener(AI_COMMIT_RESULT_EVENT, handleResult);
        reject(new Error('AI応答の登録結果を画面から取得できませんでした。'));
      }, timeoutMs);
      function handleResult(event) {
        if (!isMatchingAiCommitResult(event.detail, expected)) return;
        window.clearTimeout(timeoutId);
        window.removeEventListener(AI_COMMIT_RESULT_EVENT, handleResult);
        resolve(event.detail);
      }
      window.addEventListener(AI_COMMIT_RESULT_EVENT, handleResult);
    });
  }


  window.AiWerewolfDesktopAutomation = Object.freeze({
    renderManagementPage,
    playerProfileSelectHtml,
    renderAssignmentValidation,
    canStartWithAiProfiles,
    publishedPublicEvents: liveProgressController.publishedPublicEvents,
    publicEventText: liveProgressController.publicEventText,
    renderLiveView: liveProgressController.renderLiveView,
    resolveLiveScrollTop: liveProgressController.resolveLiveScrollTop,
    responseRecoveryModeOptions,
    runSingleGameStep: (options = {}) => aiManagementController.runSingleAutomaticStep({ persistForm: false, showLiveView: false, ...options }),
    isMatchingAiCommitResult,
    maskAutomaticNightActorNames: automationStatusController.maskAutomaticNightActorNames,
    reorderedProfiles,
  });

  async function initialize() {
    runtime().registerTabView('ai-management', {
      render: ({ state }) => renderManagementPage(state),
      beforeRender: aiManagementController.beforeManagementTabRender,
      afterRender: aiManagementController.afterManagementTabRender,
    });
    runtime().setPostgameAnalysisAdapter(postgameAnalysisAdapter);
    aiManagementController.bindManagementEvents();
    window.addEventListener('ai-werewolf-confidential-visibility-changed', (event) => {
      controller.showConfidential = Boolean(event.detail?.visible);
      liveProgressController.refreshLiveView();
    });

    if (bridge.isDesktop) {
      try {
        controller.settings = await bridge.getSettings();
        controller.settingsLoadState = 'loaded';
      } catch (error) {
        controller.settingsLoadState = 'failed';
        const wrapped = new Error(`AI設定の読み込みに失敗したため、既定設定への置換保存を防ぐ目的でAI管理の初期化を停止しました: ${error?.message ?? error}`);
        wrapped.code = 'SETTINGS_INITIAL_LOAD_FAILED';
        throw wrapped;
      }
    } else {
      controller.settings = await bridge.getSettings();
      controller.settingsLoadState = 'loaded';
    }
    const settingsStartupNotices = bridge.isDesktop && typeof bridge.getSettingsStartupNotices === 'function'
      ? await bridge.getSettingsStartupNotices().catch(() => [])
      : [];
    settingsPersistenceCoordinator.reportStartupSettingsNotices(settingsStartupNotices);
    liveProgressController.syncExecutionModeWorkbenchView({ refresh: false });
    settingsPersistenceCoordinator.applyPromptHistorySetting();
    settingsPersistenceCoordinator.applyAiExecutionSettings();
    controller.persistedUsage = await bridge.getUsageSummary().catch(() => ({ totals: emptyUsage(), totalCostUsd: 0, profiles: {} }));
    const environment = document.querySelector('#desktop-environment');
    if (environment) environment.textContent = bridge.isDesktop ? 'Electronスタンドアロン' : 'ブラウザ・デモモード';
    const keyStatus = document.querySelector('#desktop-environment-detail');
    if (keyStatus) keyStatus.textContent = bridge.isDesktop ? 'AIプロファイル・API鍵暗号化' : 'APIキー不要のデモAI対応';

    if (bridge.isDesktop && typeof bridge.writeClipboard === 'function') {
      window.__AI_WEREWOLF_CLIPBOARD_WRITE__ = async (text) => {
        const result = await bridge.writeClipboard(text);
        if (result?.ok !== true) {
          if (result?.code === 'CLIPBOARD_TEXT_TOO_LARGE') throw new Error('コピー対象が大きすぎるため、デスクトップのクリップボードへ書き込めません。');
          throw new Error('デスクトップのクリップボードへ書き込めませんでした。');
        }
      };
    } else {
      delete window.__AI_WEREWOLF_CLIPBOARD_WRITE__;
    }

    const contentRoot = document.querySelector('#app-content');
    if (contentRoot) {
      // 監視対象は正式タブ描画領域だけとし、refreshLiveViewの出力先はdocument.body直下に保つ。
      // 準備画面の局所同期先だけが変わった場合は、正式タブの再描画ではないため装飾・全体状態更新を起動しない。
      const setupLocalMutationSelector = '[data-setup-validation], [data-setup-role-summary], .character-card-select';
      const isSetupLocalMutation = (record) => {
        if (activeTab() !== 'setup') return false;
        if (record.target instanceof Element && record.target.closest(setupLocalMutationSelector)) return true;
        const changedNodes = [...record.addedNodes, ...record.removedNodes];
        return changedNodes.length > 0
          && changedNodes.every((node) => node instanceof Element && node.matches('[data-ai-profile-player-id]'));
      };
      // 将来ライブビューを#app-content配下へ移す場合も再入しないよう、同一microtask内の更新を一度へ集約する。
      new MutationObserver((records) => {
        if (records.length && records.every(isSetupLocalMutation)) return;
        if (controller.contentMutationRefreshPending) return;
        controller.contentMutationRefreshPending = true;
        queueMicrotask(() => {
          controller.contentMutationRefreshPending = false;
          if (activeTab() === 'setup') setupDecorationController.scheduleSetupDecoration();
          if (controller.liveView) refreshLiveView();
          refreshAutomationStatus();
        });
      }).observe(contentRoot, { childList: true, subtree: true });
    }
    window.addEventListener('ai-werewolf-usage-updated', () => {
      refreshUsageSummary().catch(() => {});
    });
    window.addEventListener('ai-werewolf-state-ready', async () => {
      settingsPersistenceCoordinator.applyPromptHistorySetting();
      await refreshUsageSummary();
      await settingsPersistenceCoordinator.reconcileAssignments().catch((error) => runtime().toast(`AI割り当て初期化失敗: ${error.message}`, 'error'));
      refreshVisibleUi();
      refreshLiveView();
      refreshAutomationStatus();
      settingsPersistenceCoordinator.scheduleAutosave();
    });
    window.addEventListener('ai-werewolf-state-changed', async (event) => {
      const setupInputChange = event.detail?.scope === 'setup-input';
      if (setupInputChange) {
        if (event.detail?.decorateSetup) setupDecorationController.scheduleSetupDecoration();
      } else {
        await settingsPersistenceCoordinator.reconcileAssignments().catch(() => {});
        if (activeTab() === 'setup') setupDecorationController.scheduleSetupDecoration();
        refreshLiveView();
        refreshAutomationStatus();
      }
      settingsPersistenceCoordinator.scheduleAutosave();
    });
    await settingsPersistenceCoordinator.reconcileAssignments();
    refreshVisibleUi();
    liveProgressController.refreshLiveView();
    settingsPersistenceCoordinator.scheduleAutosave();
    updateButtons();
    setAutomationMode('idle');
    setStatus(bridge.isDesktop ? 'AI管理で実行方式・接続・進行を設定できます。' : 'AI管理でデモAIの自動進行または手動プロンプトを選べます。', 'idle');
  }

  function initializeSafely() {
    Promise.resolve().then(initialize).catch(runtimeAccess.reportInitializationFailure);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeSafely, { once: true });
  else initializeSafely();
}());

// bundle側のside-effect ES Moduleとして到達させ、HTMLのscript順序へ依存しない。
export {};
