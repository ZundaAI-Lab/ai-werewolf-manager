/**
 * 責務: Renderer全体の描画ライフサイクル、正式依存の接続、外観設定参照を伴う公開表示プレビュー更新、人狼進行と独立した自由チャット/人狼観戦Hub Controllerへの描画・DOMイベント委譲だけを所有する。
 * 変更ルール: 各画面操作・AI登録・訂正・人間プレイヤー操作・公開表示の処理本体はui/controllers配下を正本とし、このFacadeへ戻さない。人間操作は公開・非公開を問わず進行卓内の操作カードを使用し、役職通知だけ共通ダイアログで表示する。ゲーム準備の入力変更は状態保存と全画面再描画を分離し、setupViewの局所同期へ委譲する。自動実行状態は表示タブから独立した一時UI状態として受け取り、競合する変更操作の無効化とロック解除時の復元だけを担当する。機密表示の切替は描画後に専用イベントで通知し、automation側へ表示状態そのものを直接参照させない。AI設定同期の変更検知には、Rendererが表示・利用可否判定で参照するプロファイル属性を含める。手動多段生成のセッション遷移・プロンプトコピー・工程回答検証・フォールバック・最終登録ワークフローはManualGenerationControllerへ委譲し、このFacadeへ再実装しない。AI管理画面表示中の設定同期は画面を直接再描画せず、保存操作ごとの再描画可否はAI管理Controllerを正本とする。自由チャットと人狼観戦の状態・会話順・AI通信はchatRoomHub配下の各Controllerを正本とし、このFacadeへ実装しない。観戦側へはStore変更通知だけを渡し、公開情報の抽出・秘密境界はspectatorRoomControllerへ委譲する。キャラクターカタログ変更時の整合もHubへコールバック接続するだけとし、このFacadeで状態解釈しない。
 */

import { isNormalSpeechTask } from '../config/discussionAiTaskTypes.js';
import { APP_VERSION, PROMPT_SPEC_VERSION, ROLE_DEFINITIONS } from '../config/constants.js';
import { BUILD_ID } from '../../generated/buildInfo.js';
import { validatePlayerDisplayName } from '../domain/policies/playerIdentityPolicy.js';
import { buildAbilityClaimTiming } from '../domain/policies/abilityClaimTimingPolicy.js';
import { CHARACTER_TEXT_LIMITS } from '../characters/config/characterTextPolicyAdapter.js';

import { findLatestNormalAiRegistrationTurn } from '../domain/game/aiTurnRegistrationPolicy.js';



import { getWolfConversationEligibleSpeakerIds } from '../domain/night/wolfConversationPolicy.js';
import { getGraveyardConversationEligibleSpeakerIds } from '../domain/night/graveyardConversationPolicy.js';
import { getMasonConversationEligibleSpeakerIds } from '../domain/night/masonConversationPolicy.js';


import { composeManualAiPrompt, evaluateAiTaskCandidate as evaluateAiTaskCandidateService, prepareAiTask as prepareAiTaskService, resolveAiTaskValidTargetIds } from '../services/aiTaskService.js';


import { parseAiResponse } from '../prompts/response/responseParser.js';
import { getAttackCandidates, getNightActionCandidates, getPlayer, getVoteCandidates, roleSummary, validateComposition } from '../domain/game/standardRules.js';
import { getActiveGraveyardConversation, getActiveMasonConversation, getActiveWolfConversation, getPlayerName, getRoleName } from '../state/selectors.js';
import { buildPublicSnapshot } from '../public/publicSnapshot.js';
import { resolvePublicAppearance } from '../appearance/appearanceModel.js';


import { getCurrentGmTask } from '../domain/game/workflow.js';
import { copyText, createId, escapeHtml, shuffle } from '../shared/utils.js';

import { option, playerOptions, roleOptions } from './components/components.js';


import { refreshSetupViewDom, renderSetupView } from './views/setup/setupView.js';
import { renderPlayerConversationSeedRow, renderPlayerDetailForm } from './views/setup/playerDetailView.js';
import { renderRecordsView } from './views/records/recordsView.js';
import { renderPublicSnapshot } from './views/public/publicView.js';
import { renderRoleHelp } from './views/help/roleHelpView.js';
import { renderLicenseView } from './views/license/licenseView.js';
import { renderCharacterLibraryView } from './views/characters/characterLibraryView.js';
import { captureRenderFocusState, restoreRenderFocusState } from './renderFocusState.js';
import { beginRenderComposition, createRenderCompositionState, deferRenderWhileComposing, endRenderComposition } from './renderCompositionState.js';

import { isPersonalNightAction, nightActionLabel, nightActionTargetLabel, shouldHighlightFrozenPlayerPanel } from './controllers/uiStateFormatters.js';
import { WorkbenchTaskRenderer } from './views/workbench/workbenchTaskRenderer.js';
import { renderAiResponseBox, renderPromptDiagnostics } from './views/workbench/aiResponseBoxView.js';
import { ManualGenerationController } from './ai/manualGenerationController.js';
import { createTabController } from './controllers/tabController.js';
import { createNotificationController } from './controllers/notificationController.js';
import { createSetupActionController } from './controllers/setupActionController.js';
import { createAiTaskCommitController } from './controllers/aiTaskCommitController.js';
import { createWorkbenchActionController } from './controllers/workbenchActionController.js';
import { createCorrectionController } from './controllers/correctionController.js';
import { createHumanPlayerActionController } from './controllers/handoffController.js';
import { createPublicWindowController } from './controllers/publicWindowController.js';
import { createAutomaticActionController } from './controllers/automaticActionController.js';
import { createPostgameAnalysisController } from './controllers/postgameAnalysisController.js';
import { createRelationshipDialogController } from './controllers/relationshipDialogController.js';
import { createActionDispatchController } from './controllers/actionDispatchController.js';
import { createCharacterLibraryController } from './controllers/characterLibraryController.js';
import { createChatRoomHubController } from './controllers/chatRoomHubController.js';

export { shouldHighlightFrozenPlayerPanel, formatDecisionUpdatePreview } from './controllers/uiStateFormatters.js';

export class AppUI {
  constructor(store, { getAppearance = () => ({}) } = {}) {
    this.store = store;
    this.getAppearance = typeof getAppearance === 'function' ? getAppearance : () => ({});
    this.root = document.querySelector('#app-content');
    this.modal = document.querySelector('#modal-dialog');
    this.characterAiGenerationDialog = document.querySelector('#character-ai-generation-dialog');
    this.relationshipDialog = document.querySelector('#relationship-dialog');
    const toastRegion = document.querySelector('#toast-region');
    this.activeTab = 'workbench';
    this.registeredTabViews = new Map();
    this.automationUiState = { mode: 'idle', mutationLocked: false };
    this.showConfidential = false;
    this.promptCache = new Map();
    this.drafts = new Map();
    this.aiExecutionSettings = { executionMode: 'automatic', profiles: [], assignments: {} };
    this.aiExecutionSettingsSignature = '';
    this.manualGenerationSessions = new Map();
    this.publicHistoryTransmissionMode = 'delta';
    this.forceFullPublicHistoryPlayerIds = new Set();
    this.selectedWolfSpeakerId = null;
    this.selectedMasonSpeakerId = null;
    this.selectedGraveyardSpeakerId = null;
    this.lastTaskIdentity = null;
    this.recordsViewMode = 'correction';
    this.relationshipSelectedPlayerId = '';
    this.relationshipSnapshotId = '';
    this.relationshipVisibleRelationTypes = new Set([
      'suspicion',
      ...Object.values(ROLE_DEFINITIONS)
        .filter((role) => role.publicAbilityClaim)
        .map((role) => `ability:${role.id}`),
    ]);
    this.recordsCorrectionMode = 'restore';
    this.recordsCorrectionSelectionId = '';
    this.renderCompositionState = createRenderCompositionState();
    this.lastRenderedSurfaceKey = '';
    this.suppressStoreRenderDuringSetupCommit = false;
    this.pendingSetupStoreChangeDetail = null;
    this.manualGenerationController = new ManualGenerationController({
      aiExecutionSettings: () => this.aiExecutionSettings,
      drafts: () => this.drafts,
      manualGenerationSessions: () => this.manualGenerationSessions,
      promptCache: () => this.promptCache,
      promptKey: (...args) => this._promptKey(...args),
      getState: () => this.store.getState(),
      prepareAiTask: (request) => this.prepareAiTask(request),
      evaluateAiTaskCandidate: (request) => this.evaluateAiTaskCandidate(request),
      commitAiTaskCandidate: (request) => this.commitAiTaskCandidate(request),
      showValidation: (errors, warnings) => this._showValidation(errors, warnings),
      toast: (message, type, options) => this.toast(message, type, options),
      render: () => this.render(),
    });
    this.tabController = createTabController({ ui: this });
    this.notificationController = createNotificationController({
      store: this.store,
      toastRegion,
    });
    this.setupActionController = createSetupActionController({
      store: this.store,
      toast: (message, type, options) => this.toast(message, type, options),
      render: () => this.render(),
      commitSetupMutation: (label, mutator, options) => this._commitSetupMutation(label, mutator, options),
      refreshSetupView: (refresh) => this._refreshSetupView(refresh),
    });
    this.humanPlayerActionController = createHumanPlayerActionController({
      store: this.store,
      modal: this.modal,
      toast: (message, type, options) => this.toast(message, type, options),
      runEngine: (label, command, options) => this.setupActionController._runEngine(label, command, options),
    });
    this.workbenchActionController = createWorkbenchActionController({
      store: this.store,
      toast: (message, type, options) => this.toast(message, type, options),
      drafts: this.drafts,
      root: this.root,
      controlValue: (key, fallback) => this._controlValue(key, fallback),
      runEngine: (label, command, options) => this.setupActionController._runEngine(label, command, options),
      humanPlayerActions: this.humanPlayerActionController,
      getHumanCoOperation: (playerId, draftScope) => this._getHumanCoOperation(playerId, draftScope),
      getHumanPriorityAbilityClaims: (state, questionEventId) => this._getHumanPriorityAbilityClaims(state, questionEventId),
      getHumanTestamentAbilityClaims: (state, playerId) => this._getHumanTestamentAbilityClaims(state, playerId),
    });
    this.aiTaskCommitController = createAiTaskCommitController({
      store: this.store,
      toast: (message, type, options) => this.toast(message, type, options),
      drafts: this.drafts,
      promptCache: this.promptCache,
      promptKey: (state, taskType, playerId, slotId) => this._promptKey(state, taskType, playerId, slotId),
      freshPromptState: (state, playerId, taskType, slotId) => this._freshPromptState(state, playerId, taskType, slotId),
      showValidation: (errors, warnings) => this._showValidation(errors, warnings),
      manualPlan: (playerId, taskType) => this.manualGenerationController.manualPlan(playerId, taskType),
      manualDirectGenerationRun: (taskArtifact, rawResponse, evaluation) => this.manualGenerationController.manualDirectGenerationRun(taskArtifact, rawResponse, evaluation),
      runEngine: (label, command, options) => this.setupActionController._runEngine(label, command, options),
      clearSpeechMetadata: (playerId) => this.workbenchActionController._clearSpeechMetadata(playerId),
      completeFullPublicHistorySync: (playerId) => this.completeFullPublicHistorySync(playerId),
    });
    this.correctionController = createCorrectionController({
      store: this.store,
      toast: (message, type, options) => this.toast(message, type, options),
      modal: this.modal,
      controlValue: (key, fallback) => this._controlValue(key, fallback),
      runEngine: (label, command, options) => this.setupActionController._runEngine(label, command, options),
      resetTransientState: (options) => this.resetTransientState(options),
      setActiveTab: (tab) => { this.activeTab = tab; },
      render: () => this.render(),
      isAutomationMutationLocked: () => this.isAutomationMutationLocked(),
    });
    this.publicWindowController = createPublicWindowController({
      store: this.store,
      getConfidential: () => this.showConfidential,
      toast: (message, type, options) => this.toast(message, type, options),
    });
    this.publicWindowController.setAppearance(this.getAppearance());
    this.automaticActionController = createAutomaticActionController({ ui: this });
    this.postgameAnalysisController = createPostgameAnalysisController({ ui: this });
    this.relationshipDialogController = createRelationshipDialogController({ ui: this });
    this.actionDispatchController = createActionDispatchController({ ui: this });
    this.characterLibraryController = createCharacterLibraryController({
      render: () => this.render(),
      modal: this.modal,
      aiGenerationDialog: this.characterAiGenerationDialog,
      toast: (message, type, options) => this.toast(message, type, options),
      getAiProfiles: () => this.aiExecutionSettings.profiles,
      onCatalogChanged: () => this.chatRoomController?.reconcileCharacters() ?? Promise.resolve(),
    });
    this.chatRoomController = createChatRoomHubController({ ui: this, gameStore: this.store });
    this.workbenchRenderer = new WorkbenchTaskRenderer({
      showConfidential: () => this.showConfidential,
      executionMode: () => this.aiExecutionSettings.executionMode,
      automationMode: () => this.automationUiState.mode,
      drafts: () => this.drafts,
      selectedWolfSpeakerId: () => this.selectedWolfSpeakerId,
      setSelectedWolfSpeakerId: (playerId) => { this.selectedWolfSpeakerId = playerId; },
      selectedMasonSpeakerId: () => this.selectedMasonSpeakerId,
      setSelectedMasonSpeakerId: (playerId) => { this.selectedMasonSpeakerId = playerId; },
      selectedGraveyardSpeakerId: () => this.selectedGraveyardSpeakerId,
      setSelectedGraveyardSpeakerId: (playerId) => { this.selectedGraveyardSpeakerId = playerId; },
      freshPromptState: (...args) => this._freshPromptState(...args),
      renderAiBox: (...args) => this._renderAiBox(...args),
      renderAiPromptOnly: (...args) => this._renderAiPromptOnly(...args),
    });
    this._bind();
    this.characterLibraryController.bind();
  }


  setAiExecutionSettings(settings = {}) {
    const next = {
      executionMode: settings?.executionMode === 'manual' ? 'manual' : 'automatic',
      profiles: structuredClone(Array.isArray(settings?.profiles) ? settings.profiles : []),
      assignments: structuredClone(settings?.assignments ?? {}),
    };
    const signature = JSON.stringify({
      executionMode: next.executionMode,
      assignments: next.assignments,
      profiles: next.profiles.map((profile) => ({ id: profile.id, label: profile.label, provider: profile.provider, model: profile.model, enabled: profile.enabled, generation: profile.generation })),
    });
    if (signature === this.aiExecutionSettingsSignature) return;
    this.aiExecutionSettings = next;
    this.aiExecutionSettingsSignature = signature;
    this.chatRoomController?.setAiProfiles(next.profiles);
    this.manualGenerationSessions.clear();
    this.promptCache.clear();
    [...this.drafts.keys()].filter((key) => key.startsWith('manual-stage-response:')).forEach((key) => this.drafts.delete(key));
    // AI管理画面は保存操作ごとのrefresh方針をAI管理Controllerが所有する。
    // ここで再描画するとプロファイル削除など一覧構造変更時に同一操作内で二重描画となり、編集中DOMを置換してしまう。
    if (this.activeTab !== 'ai-management') this.render();
  }

  setPostgameAnalysisAdapter(adapter) {
    return this.postgameAnalysisController.setAdapter(adapter);
  }

  setPublicHistoryTransmissionMode(mode) {
    const next = ['full', 'compact', 'delta'].includes(mode) ? mode : 'delta';
    if (this.publicHistoryTransmissionMode === next) return;
    this.publicHistoryTransmissionMode = next;
    this.promptCache.clear();
    // AI管理画面の再描画責務はAI管理Controllerだけが持つ。
    // 設定保存の途中でAppUI側から同じ画面を置換すると、操作中DOMの参照切れや入力不能を再発させる。
    if (this.activeTab !== 'ai-management') this.render();
  }

  scheduleFullPublicHistory(playerIds = []) {
    playerIds.filter(Boolean).forEach((playerId) => this.forceFullPublicHistoryPlayerIds.add(String(playerId)));
    this.promptCache.clear();
    // AI管理画面では呼び出し元が必要な局所/正式更新を行うため、ここから重複再描画しない。
    if (this.activeTab !== 'ai-management') this.render();
  }

  completeFullPublicHistorySync(playerId) {
    const normalizedPlayerId = String(playerId ?? '');
    if (!normalizedPlayerId || !this.forceFullPublicHistoryPlayerIds.delete(normalizedPlayerId)) return false;
    this.promptCache.clear();
    // 自動実行中にAI管理を閲覧・編集中でも、バックグラウンドの履歴同期完了でフォームDOMを置換しない。
    if (this.activeTab !== 'ai-management') this.render();
    return true;
  }


  executeAutomaticAction(action) {
    return this.automaticActionController.executeAutomaticAction(action);
  }

  getCurrentAiTaskRequest() {
    const state = this.store.getState();
    const task = getCurrentGmTask(state);
    let playerId = task.playerId ?? null;
    if (task.type === 'wolf-conversation') {
      const session = getActiveWolfConversation(state);
      const eligible = getWolfConversationEligibleSpeakerIds(session);
      playerId = eligible.includes(this.selectedWolfSpeakerId) ? this.selectedWolfSpeakerId : eligible[0] ?? null;
    } else if (task.type === 'mason-conversation') {
      const session = getActiveMasonConversation(state);
      const eligible = getMasonConversationEligibleSpeakerIds(session);
      playerId = eligible.includes(this.selectedMasonSpeakerId) ? this.selectedMasonSpeakerId : eligible[0] ?? null;
    } else if (task.type === 'graveyard-conversation') {
      const session = getActiveGraveyardConversation(state);
      const eligible = getGraveyardConversationEligibleSpeakerIds(session);
      playerId = eligible.includes(this.selectedGraveyardSpeakerId) ? this.selectedGraveyardSpeakerId : eligible[0] ?? null;
    }
    const player = playerId ? getPlayer(state, playerId) : null;
    if (!player || player.controller !== 'ai') return null;
    try {
      resolveAiTaskValidTargetIds(state, task.type, playerId);
    } catch {
      return null;
    }
    return { playerId, taskType: task.type, slotId: task.slotId ?? '' };
  }

  getCurrentWorkbenchTask() {
    return structuredClone(getCurrentGmTask(this.store.getState()));
  }

  getPublicSnapshot(options = {}) {
    return buildPublicSnapshot(this.store.getState(), {
      includeConfidential: Boolean(options.includeConfidential),
    });
  }

  getRoleDisplayName(roleId) {
    return getRoleName(roleId);
  }

  isWorkbenchPlayerFrozen(playerId) {
    return shouldHighlightFrozenPlayerPanel(this.store.getState(), playerId);
  }

  getAiHistoryStatus() {
    const state = this.store.getState();
    return state.players.map((player) => {
      const turn = findLatestNormalAiRegistrationTurn(state, player.id);
      return {
        playerId: player.id,
        playerName: player.name,
        lastPublicSequence: turn?.publicSequenceAtRegistration ?? null,
        forceFullNext: this.forceFullPublicHistoryPlayerIds.has(player.id),
      };
    });
  }

  resetTransientState({ closeModal = true } = {}) {
    this.promptCache.clear();
    this.drafts.clear();
    this.manualGenerationSessions.clear();
    this.selectedWolfSpeakerId = null;
    this.selectedMasonSpeakerId = null;
    this.selectedGraveyardSpeakerId = null;
    this.lastTaskIdentity = null;
    this.relationshipSelectedPlayerId = '';
    this.relationshipSnapshotId = '';
    this.postgameAnalysisController.reset();
    if (closeModal && this.modal?.open) this.modal.close();
    if (closeModal && this.characterAiGenerationDialog?.open) this.characterAiGenerationDialog.close();
    if (closeModal && this.relationshipDialog?.open) this.relationshipDialog.close();
  }

  canUseGlobalHistory() {
    // 共通モーダルだけでなく、外観・新規ゲーム・キャラクターAI生成・相関図を含む全modal dialogを対象にする。
    // モーダル表示中に背後だけUndo/Redoすると、閉じた後のDOMと状態が食い違い操作不能に見えるため禁止する。
    return !document.querySelector('dialog[open]');
  }
  registerTabView(...args) {
    return this.tabController.registerTabView(...args);
  }
  getActiveTab(...args) {
    return this.tabController.getActiveTab(...args);
  }
  requestTab(...args) {
    return this.tabController.requestTab(...args);
  }


  refreshTab(...args) {
    return this.tabController.refreshTab(...args);
  }
  setTab(...args) {
    return this.tabController.setTab(...args);
  }

  setAutomationUiState(state = {}) {
    const next = {
      mode: String(state?.mode ?? 'idle'),
      mutationLocked: Boolean(state?.mutationLocked),
    };
    const changed = next.mode !== this.automationUiState.mode || next.mutationLocked !== this.automationUiState.mutationLocked;
    this.automationUiState = next;
    document.body.classList.toggle('automation-session-locked', next.mutationLocked);
    if (changed) this.render();
  }

  isAutomationMutationLocked() {
    return Boolean(this.automationUiState?.mutationLocked);
  }

  _setAutomationDisabled(control, disabled) {
    if (!control) return;
    const marker = control.dataset.automationLockDisabled;
    if (disabled) {
      if (!marker) control.dataset.automationLockDisabled = control.disabled ? 'preserve' : 'managed';
      control.disabled = true;
      return;
    }
    if (!marker) return;
    if (marker === 'managed') control.disabled = false;
    delete control.dataset.automationLockDisabled;
  }

  _applyAutomationInteractionLock() {
    const mutationLocked = this.isAutomationMutationLocked();
    const mode = this.automationUiState?.mode ?? 'idle';
    this.root.querySelectorAll('button[data-action]').forEach((button) => {
      const shouldDisable = mutationLocked && !this.actionDispatchController.canDispatchDuringAutomation(button.dataset.action, mode);
      this._setAutomationDisabled(button, shouldDisable);
    });
    const lockFormControls = mutationLocked && (this.activeTab === 'setup' || (this.activeTab === 'workbench' && mode === 'running'));
    this.root.querySelectorAll('input, select, textarea').forEach((control) => {
      this._setAutomationDisabled(control, lockFormControls);
    });
  }

  setConfidential(value) {
    this.showConfidential = Boolean(value);
    document.querySelector('#confidential-toggle').textContent = this.showConfidential ? '機密情報を隠す' : '機密情報を表示';
    // 機密表示に依存しない設定画面を再描画すると、AIプロファイル等の未保存フォームDOMを置換してしまう。
    // 実際に表示内容が変わる画面だけを更新し、自動進行用ライブビューは専用イベント側で更新する。
    if (['workbench', 'records', 'public'].includes(this.activeTab)) this.render();
    else this.relationshipDialogController.refresh();
    window.dispatchEvent(new CustomEvent('ai-werewolf-confidential-visibility-changed', {
      detail: { visible: this.showConfidential },
    }));
  }
  beginAutomaticNotifications(...args) {
    return this.notificationController.beginAutomaticNotifications(...args);
  }
  endAutomaticNotifications(...args) {
    return this.notificationController.endAutomaticNotifications(...args);
  }
  beginNightActorPrivacy(...args) {
    return this.notificationController.beginNightActorPrivacy(...args);
  }
  endNightActorPrivacy(...args) {
    return this.notificationController.endNightActorPrivacy(...args);
  }

  dismissToast(...args) {
    return this.notificationController.dismissToast(...args);
  }
  toast(...args) {
    return this.notificationController.toast(...args);
  }

  handleStoreStateChange() {
    this.chatRoomController?.handleGameStateChange?.();
    if (!this.suppressStoreRenderDuringSetupCommit) {
      this.render();
      return null;
    }
    this._refreshGlobalControls(this.store.getState());
    return this.pendingSetupStoreChangeDetail ? { ...this.pendingSetupStoreChangeDetail } : { scope: 'setup-input' };
  }

  _commitSetupMutation(label, mutator, options = {}) {
    const { refresh = {}, decorateSetup = false, ...commitOptions } = options;
    const canKeepSetupDom = this.activeTab === 'setup';
    if (!canKeepSetupDom) return this.store.commit(label, mutator, commitOptions);
    this.suppressStoreRenderDuringSetupCommit = true;
    this.pendingSetupStoreChangeDetail = { scope: 'setup-input', decorateSetup: Boolean(decorateSetup) };
    let state;
    try {
      state = this.store.commit(label, mutator, commitOptions);
    } finally {
      this.suppressStoreRenderDuringSetupCommit = false;
      this.pendingSetupStoreChangeDetail = null;
    }
    this._refreshSetupView(refresh);
    return state;
  }

  _refreshSetupView(refresh = {}) {
    if (this.activeTab !== 'setup') return false;
    const state = this.store.getState();
    const refreshed = refreshSetupViewDom({
      root: this.root,
      state,
      locked: state.game.phase !== 'setup',
      validation: validateComposition(state),
      roleSummaryText: roleSummary(state),
      refresh,
    });
    if (refreshed) this._applyAutomationInteractionLock();
    return refreshed;
  }

  _restoreSetupInputValue(control) {
    const state = this.store.getState();
    const setup = control.closest('[data-setup]');
    if (setup?.dataset.setup === 'title') setup.value = state.game.title;
    if (setup?.dataset.setup === 'player-count') setup.value = String(state.players.length);
    const characterCard = control.closest('[data-character-card]');
    if (characterCard) characterCard.value = getPlayer(state, characterCard.dataset.playerId)?.characterCardId ?? '';
    const playerField = control.closest('[data-player-field]');
    if (playerField) {
      const player = getPlayer(state, playerField.dataset.playerId);
      if (player) playerField.value = player[playerField.dataset.playerField] ?? '';
    }
    if (control.closest('[data-rule]')) this._refreshSetupView({ rules: true });
  }

  _refreshGlobalControls(state) {
    const automationLocked = this.isAutomationMutationLocked();
    const undo = document.querySelector('#undo-button');
    const redo = document.querySelector('#redo-button');
    if (undo) {
      const canUndo = this.store.canUndo();
      const undoLabel = canUndo ? this.store.getUndoLabel() : '';
      undo.disabled = automationLocked || !canUndo || state.game.correctionMode.enabled;
      undo.textContent = '元に戻す';
      undo.title = undoLabel ? `${undoLabel}を取り消す` : '元に戻す';
      undo.setAttribute('aria-label', undo.title);
    }
    if (redo) {
      const canRedo = this.store.canRedo();
      const redoLabel = canRedo ? this.store.getRedoLabel() : '';
      redo.disabled = automationLocked || !canRedo || state.game.correctionMode.enabled;
      redo.textContent = 'やり直す';
      redo.title = redoLabel ? `${redoLabel}をやり直す` : 'やり直す';
      redo.setAttribute('aria-label', redo.title);
    }
  }

  render() {
    if (deferRenderWhileComposing(this.renderCompositionState)) return;
    const renderSurfaceKey = `tab:${this.activeTab}`;
    const focusState = captureRenderFocusState(this.root, document.activeElement, this.lastRenderedSurfaceKey);
    const state = this.store.getState();
    this._synchronizeTransientState(state);
    document.querySelectorAll('[data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === this.activeTab));
    const runtimeVersion = document.querySelector('#runtime-version');
    if (runtimeVersion) runtimeVersion.textContent = `v${APP_VERSION} / ${BUILD_ID.slice(0, 8)} / Prompt ${PROMPT_SPEC_VERSION}`;

    this._refreshGlobalControls(state);

    const registeredView = this.registeredTabViews.get(this.activeTab) ?? null;
    registeredView?.beforeRender?.({ root: this.root, state, tab: this.activeTab });
    if (registeredView) this.root.innerHTML = String(registeredView.render({ state, tab: this.activeTab }) ?? '');
    else if (this.activeTab === 'setup') this.root.innerHTML = this._renderSetup(state);
    else if (this.activeTab === 'records') this.root.innerHTML = this._renderRecords(state);
    else if (this.activeTab === 'public') this.root.innerHTML = this._renderPublic(state);
    else if (this.activeTab === 'character-library') this.root.innerHTML = renderCharacterLibraryView();
    else if (this.activeTab === 'chat-room') this.root.innerHTML = this.chatRoomController.render();
    else if (this.activeTab === 'license') this.root.innerHTML = renderLicenseView({ appVersion: APP_VERSION, buildId: BUILD_ID });
    else this.root.innerHTML = this.workbenchRenderer.renderWorkbench(state);
    this._applyAutomationInteractionLock();
    restoreRenderFocusState(this.root, focusState, renderSurfaceKey);
    this.lastRenderedSurfaceKey = renderSurfaceKey;
    registeredView?.afterRender?.({ root: this.root, state, tab: this.activeTab });
    if (this.activeTab === 'chat-room') this.chatRoomController.afterRender();
    this.relationshipDialogController.refresh();
    this.publicWindowController._updatePublicWindow();
  }

  _currentTaskIdentity(state) {
    const task = getCurrentGmTask(state);
    const discussion = state.discussion;
    const vote = state.voteSession;
    const conversation = getActiveWolfConversation(state);
    const masonConversation = getActiveMasonConversation(state);
    const graveyardConversation = getActiveGraveyardConversation(state);
    return JSON.stringify({
      gameId: state.game.id,
      day: state.game.day,
      phase: state.game.phase,
      type: task.type,
      playerId: task.playerId ?? null,
      slotId: task.slotId ?? null,
      discussionRound: discussion?.round ?? null,
      discussionIndex: discussion?.currentIndex ?? null,
      designatedPlayerId: discussion?.designatedPlayerId ?? null,
      voteSessionId: vote?.id ?? null,
      voteRound: vote?.round ?? null,
      voteIndex: vote?.currentVoterIndex ?? null,
      voteStatus: vote?.status ?? null,
      conversationId: conversation?.id ?? null,
      masonConversationId: masonConversation?.id ?? null,
      graveyardConversationId: graveyardConversation?.id ?? null,
      attackVoteCount: Object.values(state.night?.wolfAttack?.voteByWolfId ?? {}).filter(Boolean).length,
      attackFinalTargetId: state.night?.wolfAttack?.finalTargetId ?? null,
    });
  }

  _synchronizeTransientState(state) {
    const identity = this._currentTaskIdentity(state);
    if (this.lastTaskIdentity !== null && identity !== this.lastTaskIdentity) {
      this.promptCache.clear();
      this.drafts.clear();
      this.manualGenerationSessions.clear();
      this.selectedWolfSpeakerId = null;
      this.selectedMasonSpeakerId = null;
      this.selectedGraveyardSpeakerId = null;
    }
    this.lastTaskIdentity = identity;
  }

  _promptTaskInstanceId(state, taskType, playerId, slotId = '') {
    const discussion = state.discussion;
    const vote = state.voteSession;
    const conversation = getActiveWolfConversation(state);
    const masonConversation = getActiveMasonConversation(state);
    const graveyardConversation = getActiveGraveyardConversation(state);
    if (taskType === 'briefing') return `briefing:${state.game.id}:${playerId}`;
    if (isNormalSpeechTask(taskType)) return `${taskType}:${state.game.day}:${discussion?.round ?? 0}:${discussion?.mode ?? ''}:${discussion?.currentIndex ?? -1}:${playerId}`;
    if (taskType === 'priority-answer') return `priority-answer:${state.game.day}:${slotId}:${playerId}`;
    if (taskType === 'vote') return `vote:${vote?.id ?? ''}:${vote?.round ?? 0}:${vote?.currentVoterIndex ?? -1}:${playerId}`;
    if (taskType === 'wolf-conversation') return `wolf-chat:${conversation?.id ?? ''}:${playerId}`;
    if (taskType === 'mason-conversation') return `mason-chat:${masonConversation?.id ?? ''}:${playerId}`;
    if (taskType === 'graveyard-conversation') return `graveyard-chat:${graveyardConversation?.id ?? ''}:${playerId}`;
    if (taskType === 'wolf-attack') return `wolf-attack:${state.night?.day ?? 0}:${playerId}`;
    if (isPersonalNightAction(taskType)) return `${taskType}:${state.night?.day ?? 0}:${slotId}:${playerId}`;
    return `${taskType}:${state.game.day}:${state.game.phase}:${slotId}:${playerId}`;
  }

  _promptKey(state, taskType, playerId, slotId = '') {
    return this._promptTaskInstanceId(state, taskType, playerId, slotId);
  }

  _freshPromptState(state, playerId, taskType, slotId = '') {
    const key = this._promptKey(state, taskType, playerId, slotId);
    try {
      const current = prepareAiTaskService(state, {
        playerId,
        taskType,
        slotId,
        publicHistoryTransmissionMode: this.publicHistoryTransmissionMode,
        forceFullPublicHistory: this.forceFullPublicHistoryPlayerIds.has(playerId),
      });
      let cache = this.promptCache.get(key) ?? null;
      if (cache && cache.fingerprint !== current.fingerprint) {
        this.promptCache.delete(key);
        this.drafts.delete(`ai-response:${key}`);
        cache = null;
      }
      return { key, cache, current, validTargetIds: current.validTargetIds, error: null };
    } catch (error) {
      this.promptCache.delete(key);
      this.drafts.delete(`ai-response:${key}`);
      return { key, cache: null, current: null, validTargetIds: [], error };
    }
  }

  prepareAiTask({ playerId, taskType, slotId = '', forceRefresh = false, forceFullPublicHistory = false } = {}) {
    const state = this.store.getState();
    const key = this._promptKey(state, taskType, playerId, slotId);
    if (forceRefresh) {
      this.promptCache.delete(key);
      this.drafts.delete(`ai-response:${key}`);
    }
    const artifact = prepareAiTaskService(state, {
      playerId,
      taskType,
      slotId,
      publicHistoryTransmissionMode: this.publicHistoryTransmissionMode,
      forceFullPublicHistory: Boolean(forceFullPublicHistory) || this.forceFullPublicHistoryPlayerIds.has(playerId),
    });
    const cached = this.promptCache.get(key);
    if (cached?.fingerprint === artifact.fingerprint && !forceRefresh) return cached;
    this.promptCache.set(key, artifact);
    return artifact;
  }

  evaluateAiTaskCandidate({ taskArtifact, rawResponse } = {}) {
    if (!taskArtifact) throw new TypeError('AIタスク成果物がありません。');
    return evaluateAiTaskCandidateService(this.store.getState(), taskArtifact, rawResponse);
  }

  _controlValue(key, fallback = '') {
    const selector = `[data-draft="${CSS.escape(key)}"]`;
    const control = this.root?.querySelector(selector) ?? this.modal?.querySelector(selector);
    if (control) return control.type === 'checkbox' ? control.checked : control.value;
    return this.drafts.has(key) ? this.drafts.get(key) : fallback;
  }

  _renderPromptDiagnostics(built) {
    return renderPromptDiagnostics(built);
  }

  _renderAiPromptOnly(state, player, taskType, validTargetIds, slotId = '') {
    const { cache, error } = this._freshPromptState(state, player.id, taskType, slotId);
    if (error) {
      return `<div class="ai-box prompt-error"><strong>プロンプト生成を停止しました</strong><p>${escapeHtml(error.message)}</p><button class="button primary" type="button" disabled>プロンプトをコピー</button></div>`;
    }
    return `<div class="ai-box"><div class="ai-actions"><button class="button primary" data-action="copy-prompt" data-player-id="${escapeHtml(player.id)}" data-task-type="${escapeHtml(taskType)}" data-slot-id="${escapeHtml(slotId)}" type="button">${cache ? '最新プロンプトを再コピー' : 'プロンプトをコピー'}</button>${cache ? '<span class="success-text">生成済み</span>' : ''}</div>${cache ? `${this._renderPromptDiagnostics(cache)}<details class="prompt-preview"><summary>生成したプロンプトを確認</summary><textarea readonly>${escapeHtml(cache.text)}</textarea></details>` : ''}</div>`;
  }

  _renderAiBox(state, player, taskType, validTargetIds, slotId = '') {
    const { key, cache, current, error } = this._freshPromptState(state, player.id, taskType, slotId);
    if (error) {
      return `<div class="ai-box prompt-error"><strong>プロンプト生成を停止しました</strong><p>${escapeHtml(error.message)}</p><button class="button primary" type="button" disabled>プロンプトをコピー</button><button class="button primary" type="button" disabled>解析して登録</button></div>`;
    }
    const manualPlan = this.aiExecutionSettings.executionMode === 'manual' ? this.manualGenerationController.manualPlan(player.id, taskType) : null;
    if (manualPlan?.depth > 1) return this.manualGenerationController.renderManualGenerationBox(state, player, taskType, slotId, key, cache ?? current, manualPlan);
    const participantManual = this.aiExecutionSettings.executionMode === 'automatic'
      && !this.aiExecutionSettings.assignments?.[player.id];
    const manualNotice = participantManual
      ? '<div class="validation warning"><strong>この参加者は手動生成です。</strong><span>プロンプトを外部AIへ渡し、JSON回答を登録してください。全自動実行中は登録後に自動進行へ戻ります。</span></div>'
      : '';
    const raw = this.drafts.get(`ai-response:${key}`) ?? '';
    const mode = cache?.mode ?? current.mode;
    const parseResult = raw ? parseAiResponse(raw, mode) : null;
    const parsed = parseResult?.value ?? null;
    const parseErrors = parseResult?.diagnostics?.errors ?? [];
    return renderAiResponseBox({
      state,
      player,
      taskType,
      slotId,
      key,
      cache,
      raw,
      parsed,
      parseErrors,
      manualNotice,
    });
  }

  _renderSetup(state) {
    return renderSetupView({
      state,
      locked: state.game.phase !== 'setup',
      validation: validateComposition(state),
      roleSummaryText: roleSummary(state),
    });
  }

  _renderRecords(state) {
    const memoToolsByPlayerId = Object.fromEntries(
      state.players.map((player) => [
        player.id,
        player.controller === 'ai'
          ? this._renderAiBox(state, player, 'memo-consolidate', [])
          : '',
      ]),
    );
    const manualMemoDraftsByPlayerId = Object.fromEntries(
      state.players.map((player) => [
        player.id,
        this.drafts.get(`manual-memo-summary:${player.id}`) ?? '',
      ]),
    );
    return renderRecordsView({
      state,
      showConfidential: this.showConfidential,
      getPlayerName: (id) => getPlayerName(state, id),
      getRoleName,
      getAiProfileLabel: (id) => this.aiExecutionSettings.profiles.find((profile) => profile.id === id)?.label ?? null,
      memoToolsByPlayerId,
      manualMemoDraftsByPlayerId,
      notificationHistory: this.notificationController.getNotificationHistory(),
      recordsViewMode: this.recordsViewMode,
      relationshipSelectedPlayerId: this.relationshipSelectedPlayerId,
      relationshipSnapshotId: this.relationshipSnapshotId,
      relationshipVisibleRelationTypes: [...this.relationshipVisibleRelationTypes],
      correctionWorkspaceMode: this.recordsCorrectionMode,
      correctionWorkspaceSelectionId: this.recordsCorrectionSelectionId,
      postgameAnalysis: this.postgameAnalysisController.viewModel(state),
    });
  }

  _renderPublic(state) {
    const snapshot = buildPublicSnapshot(state, {
      includeConfidential: this.showConfidential,
    });
    const appearance = resolvePublicAppearance(this.getAppearance());
    return `<section class="page public-page"><div class="page-head"><div><span class="eyebrow">公開専用表示</span><h2>${escapeHtml(snapshot.game.title)}</h2></div><div class="page-head-actions"><button class="button ghost" data-action="export-public-html" type="button">HTML出力</button><button class="button primary" data-action="open-public-window" type="button">別ウィンドウで開く</button></div></div><div class="public-appearance-preview" data-theme="${escapeHtml(appearance.theme)}" data-accent="${escapeHtml(appearance.accent)}" data-font-size="${escapeHtml(appearance.fontSize)}" data-effects="${appearance.effects ? 'on' : 'off'}" data-motion="${escapeHtml(appearance.motion)}">${renderPublicSnapshot(snapshot)}</div></section>`;
  }

  refreshAppearance() {
    this.publicWindowController.setAppearance(this.getAppearance());
    this.relationshipDialogController.refreshAppearance();
    if (this.activeTab === 'public') this.render();
  }

  _bind() {
    document.addEventListener('click', (event) => {
      const pressedButton = event.target.closest('button:not(:disabled)');
      if (pressedButton && this.notificationController.hasActiveErrorToast()) this.dismissToast();
      this._click(event);
    });
    document.addEventListener('input', (event) => this._input(event));
    document.addEventListener('compositionstart', (event) => {
      if (this.root?.contains(event.target)) beginRenderComposition(this.renderCompositionState);
    });
    document.addEventListener('compositionend', (event) => {
      if (!this.root?.contains(event.target)) return;
      if (!endRenderComposition(this.renderCompositionState)) return;
      queueMicrotask(() => this.render());
    });
    document.addEventListener('change', (event) => this._change(event));
    this.modal.addEventListener('click', (event) => {
      if (event.target.closest('[data-modal-close]')) this.modal.close();
    });
    this.relationshipDialog?.addEventListener('click', (event) => {
      if (event.target.closest('[data-modal-close]')) this.relationshipDialog.close();
    });
  }

  _input(event) {
    const draft = event.target.closest('[data-draft]');
    if (draft) this.drafts.set(draft.dataset.draft, draft.type === 'checkbox' ? draft.checked : draft.value);
  }

  _change(event) {
    if (this.activeTab === 'chat-room' && event.target.closest('[data-chat-field], [data-spectator-field]')) {
      this.chatRoomController.handleChange(event).catch((error) => this.toast(error.message, 'error'));
      return;
    }
    if (this.isAutomationMutationLocked() && this.activeTab === 'setup' && event.target.matches('input, select, textarea')) {
      this.toast('自動実行中はゲーム設定を変更できません。一時停止してから操作してください。', 'warning');
      this._restoreSetupInputValue(event.target);
      return;
    }
    const draft = event.target.closest('[data-draft]');
    if (draft) this.drafts.set(draft.dataset.draft, draft.type === 'checkbox' ? draft.checked : draft.value);
    if (draft?.dataset.draft?.startsWith('human-priority-ability-action:')
      || /^human-priority-ability:[^:]+:\d+:role$/u.test(draft?.dataset.draft ?? '')) {
      this.render();
      return;
    }
    const setup = event.target.closest('[data-setup]');
    if (setup?.dataset.setup === 'title') this._commitSetupMutation('ゲーム名変更', (state) => { state.game.title = setup.value; });
    if (setup?.dataset.setup === 'player-count') this.setupActionController._changePlayerCount(Number(setup.value));
    const characterCard = event.target.closest('[data-character-card]');
    if (characterCard) this.setupActionController._assignCharacterCard(characterCard.dataset.playerId, characterCard.value);
    const playerField = event.target.closest('[data-player-field]');
    if (playerField) {
      if (playerField.dataset.playerField === 'name') {
        const validation = validatePlayerDisplayName(playerField.value);
        if (!validation.ok) {
          this.toast(validation.errors[0], 'error');
          const current = getPlayer(this.store.getState(), playerField.dataset.playerId);
          if (current) playerField.value = current.name;
          return;
        }
      }
      const field = playerField.dataset.playerField;
      this.setupActionController._changePlayerField(playerField.dataset.playerId, field, playerField.value);
    }
    const rule = event.target.closest('[data-rule]');
    if (rule) this.setupActionController._changeRule(rule.dataset.rule, rule.type === 'checkbox' ? rule.checked : rule.value);
    if (event.target.matches('[data-draft="wolf-speaker"]')) {
      this.selectedWolfSpeakerId = event.target.value;
      this.render();
    }
    if (event.target.matches('[data-draft="mason-speaker"]')) {
      this.selectedMasonSpeakerId = event.target.value;
      this.render();
    }
    if (event.target.matches('[data-draft="graveyard-speaker"]')) {
      this.selectedGraveyardSpeakerId = event.target.value;
      this.render();
    }
  }

  _click(event) {
    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) {
      this.requestTab(tabButton.dataset.tab).catch((error) => {
        this.toast(`画面を切り替えられませんでした: ${error.message}`, 'error');
      });
      return;
    }
    const chatButton = event.target.closest('[data-chat-action]');
    if (chatButton && this.activeTab === 'chat-room') return this.chatRoomController.handleClick(chatButton);
    const spectatorButton = event.target.closest('[data-spectator-action]');
    if (spectatorButton && this.activeTab === 'chat-room') return this.chatRoomController.handleClick(spectatorButton);
    const chatRoomModeButton = event.target.closest('[data-chat-room-mode]');
    if (chatRoomModeButton && this.activeTab === 'chat-room') return this.chatRoomController.handleClick(chatRoomModeButton);
    const button = event.target.closest('[data-action]');
    if (button) return this.actionDispatchController.dispatch(button);
    return undefined;
  }


  _copyPrompt(button) {
    const state = this.store.getState();
    const playerId = button.dataset.playerId;
    const taskType = button.dataset.taskType;
    const slotId = button.dataset.slotId ?? '';
    const key = this._promptKey(state, taskType, playerId, slotId);
    try {
      const built = this.prepareAiTask({ playerId, taskType, slotId, forceRefresh: true });
      this.drafts.delete(`ai-response:${key}`);
      copyText(composeManualAiPrompt(built)).then(() => {
        if (taskType === 'briefing') this.setupActionController._markBriefingShown(playerId);
        this.toast('プロンプトをコピーしました。', 'success', { key: 'prompt-copy' });
        this.render();
      }).catch((error) => this.toast(error.message, 'error'));
    } catch (error) {
      this.promptCache.delete(key);
      this.drafts.delete(`ai-response:${key}`);
      this.toast(error.message, 'error');
    }
  }

  _validTargets(state, taskType, playerId) {
    return resolveAiTaskValidTargetIds(state, taskType, playerId);
  }

  _getHumanCoOperation(playerId, draftScope = playerId) {
    const action = this._controlValue(`human-co-action:${draftScope}`, 'none');
    const roleId = ['declare', 'change'].includes(action)
      ? this._controlValue(`human-co-role:${draftScope}`, 'none')
      : 'none';
    return { action, roleId };
  }

  _getHumanPriorityAbilityClaims(state, questionEventId) {
    if (this._controlValue(`human-priority-ability-action:${questionEventId}`, 'none') !== 'publish') return [];
    const bySequence = new Map((state.events ?? [])
      .filter((event) => event.status === 'published' && Number.isInteger(Number(event.sequence)))
      .map((event) => [Number(event.sequence), event.id]));
    const rowCount = Math.max(1, Number(state.game.day ?? 1));
    return Array.from({ length: rowCount }, (_, offset) => {
      const index = offset + 1;
      const prefix = `human-priority-ability:${questionEventId}:${index}`;
      const targetId = this._controlValue(`${prefix}:target`, '');
      if (!targetId) return null;
      const evidenceEventIds = String(this._controlValue(`${prefix}:evidence`, ''))
        .split(/[\s,、]+/u)
        .map((item) => Number(item.replace(/^#/u, '')))
        .filter(Number.isInteger)
        .map((sequence) => bySequence.get(sequence))
        .filter(Boolean);
      return {
        action: 'publish',
        claimedRoleId: this._controlValue(`${prefix}:role`, ''),
        targetId,
        result: this._controlValue(`${prefix}:result`, ''),
        ...(buildAbilityClaimTiming(this._controlValue(`${prefix}:role`, ''), Number(this._controlValue(`${prefix}:day`, String(offset)))) ?? {}),
        selectionBasis: this._controlValue(`${prefix}:basis`, 'no-public-information'),
        evidenceEventIds,
        selectionReasonAtTime: String(this._controlValue(`${prefix}:reason`, '')).trim(),
      };
    }).filter(Boolean);
  }


  _getHumanTestamentAbilityClaims(state, playerId) {
    if (this._controlValue(`human-testament-ability-action:${playerId}`, 'none') !== 'publish') return [];
    const bySequence = new Map((state.events ?? [])
      .filter((event) => event.status === 'published' && Number.isInteger(Number(event.sequence)))
      .map((event) => [Number(event.sequence), event.id]));
    const rowCount = Math.max(1, Number(state.game.day ?? 1));
    return Array.from({ length: rowCount }, (_, offset) => {
      const index = offset + 1;
      const prefix = `human-testament-ability:${playerId}:${index}`;
      const targetId = this._controlValue(`${prefix}:target`, '');
      if (!targetId) return null;
      const evidenceEventIds = String(this._controlValue(`${prefix}:evidence`, ''))
        .split(/[\s,、]+/u)
        .map((item) => Number(item.replace(/^#/u, '')))
        .filter(Number.isInteger)
        .map((sequence) => bySequence.get(sequence))
        .filter(Boolean);
      return {
        action: 'publish',
        claimedRoleId: this._controlValue(`${prefix}:role`, ''),
        targetId,
        result: this._controlValue(`${prefix}:result`, ''),
        ...(buildAbilityClaimTiming(this._controlValue(`${prefix}:role`, ''), Number(this._controlValue(`${prefix}:day`, String(offset)))) ?? {}),
        selectionBasis: this._controlValue(`${prefix}:basis`, 'no-public-information'),
        evidenceEventIds,
        selectionReasonAtTime: String(this._controlValue(`${prefix}:reason`, '')).trim(),
      };
    }).filter(Boolean);
  }


  commitAiTaskFallback(...args) {
    return this.aiTaskCommitController.commitAiTaskFallback(...args);
  }
  commitAiTaskCandidate(...args) {
    return this.aiTaskCommitController.commitAiTaskCandidate(...args);
  }


  _showValidation(errors, warnings = []) {
    this.modal.innerHTML = `<div class="modal-header"><h3>AI応答を登録できません</h3><button class="button icon ghost" data-modal-close type="button">×</button></div><div class="modal-body"><ul class="error-list">${errors.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>${warnings.length ? `<h4>警告</h4><ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}<p>応答を修正するか、GM代理入力・ランダム決定・一時停止を使用してください。</p></div>`;
    this.modal.showModal();
  }

  _openRoleHelp() {
    const state = this.store.getState();
    this.modal.innerHTML = `<div class="modal-header"><h3>役職ヘルプ</h3><button class="button icon ghost" data-modal-close type="button">×</button></div>${renderRoleHelp({ state })}<div class="modal-footer"><button class="button primary" data-modal-close type="button">閉じる</button></div>`;
    this.modal.showModal();
  }

  _openPlayerModal(playerId) {
    const state = this.store.getState();
    const player = getPlayer(state, playerId);
    this.modal.innerHTML = renderPlayerDetailForm({ player, players: state.players });

    const form = this.modal.querySelector('form');
    const cleanDetailError = (message) => String(message ?? '').replace(/^キャラクター詳細の/u, '');
    const focusDetailError = (message) => {
      const text = cleanDetailError(message);
      const seed = text.match(/^会話のきっかけ(\d+)の(話題|雰囲気)/u);
      let control = null;
      if (seed) {
        const row = form.querySelectorAll('[data-player-conversation-seed-row]')[Number(seed[1]) - 1];
        control = row?.querySelector(seed[2] === '話題' ? '[name="conversationSeedSubject"]' : '[name="conversationSeedTone"]') ?? null;
      }
      const callName = !control ? text.match(/^(?:相手別呼称)(\d+)/u) : null;
      if (callName) control = form.querySelectorAll('input[name="callNamePreferred"]')[Number(callName[1]) - 1] ?? null;
      if (!control) {
        const fieldMap = [
          ['別名', 'aliases'],
          ['性格・人物設定', 'profile'],
          ['一人称', 'firstPerson'],
          ['汎用二人称', 'genericSecondPerson'],
          ['話し方の特徴', 'speakingStyle'],
          ['基本語尾', 'defaultEndings'],
          ['避ける表現', 'avoidedExpressions'],
          ['口調例', 'speechExamples'],
          ['議論での振る舞い補足', 'discussionBehavior'],
        ];
        const matched = fieldMap.find(([prefix]) => text.includes(prefix));
        if (matched) control = form.elements.namedItem(matched[1]);
      }
      if (!control || typeof control.focus !== 'function') return false;
      control.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      control.focus({ preventScroll: true });
      if (typeof control.select === 'function' && !['SELECT', 'BUTTON'].includes(control.tagName)) control.select();
      return true;
    };
    const showDetailError = (messages) => {
      const target = form.querySelector('[data-player-detail-error]');
      if (!target) return;
      const items = (Array.isArray(messages) ? messages : [messages]).map(cleanDetailError).filter(Boolean);
      target.innerHTML = items.map((message) => `<div>× ${escapeHtml(message)}</div>`).join('');
      target.hidden = items.length === 0;
      if (items.length && !focusDetailError(items[0])) target.scrollIntoView({ block: 'nearest' });
    };

    form.addEventListener('click', (event) => {
      const action = event.target.closest('[data-player-detail-action]')?.dataset.playerDetailAction;
      if (!action) return;
      if (action === 'add-conversation-seed') {
        const list = form.querySelector('[data-player-conversation-seed-list]');
        if (!list) return;
        if (list.querySelectorAll('[data-player-conversation-seed-row]').length >= CHARACTER_TEXT_LIMITS.conversationSeedsMax) {
          showDetailError(`会話のきっかけは最大${CHARACTER_TEXT_LIMITS.conversationSeedsMax}件です。`);
          return;
        }
        list.insertAdjacentHTML('beforeend', renderPlayerConversationSeedRow({
          id: createId('conversation-seed'),
          subject: '',
          tone: '',
        }));
        list.lastElementChild?.querySelector('input[name="conversationSeedSubject"]')?.focus();
        const addButton = form.querySelector('[data-player-detail-action="add-conversation-seed"]');
        if (addButton && list.querySelectorAll('[data-player-conversation-seed-row]').length >= CHARACTER_TEXT_LIMITS.conversationSeedsMax) addButton.disabled = true;
        showDetailError([]);
        return;
      }
      if (action === 'remove-conversation-seed') {
        event.target.closest('[data-player-conversation-seed-row]')?.remove();
        const addButton = form.querySelector('[data-player-detail-action="add-conversation-seed"]');
        if (addButton) addButton.disabled = false;
        showDetailError([]);
      }
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.isAutomationMutationLocked()) return this.toast('自動実行中はプレイヤー設定を変更できません。一時停止してから操作してください。', 'warning');
      const data = new FormData(event.currentTarget);
      const currentState = this.store.getState();
      const values = {
        ...Object.fromEntries(data.entries()),
        conversationSeedIds: data.getAll('conversationSeedId'),
        conversationSeedSubjects: data.getAll('conversationSeedSubject'),
        conversationSeedTones: data.getAll('conversationSeedTone'),
        callNameTargetPlayerIds: data.getAll('callNameTargetPlayerId'),
        callNamePreferredValues: data.getAll('callNamePreferred'),
      };
      const validCallNameTargetPlayerIds = currentState.players
        .filter((target) => target.id !== playerId)
        .map((target) => target.id);
      const prepared = this.setupActionController._commitPlayerDetailUpdate(playerId, values, validCallNameTargetPlayerIds);

      if (!prepared.ok) {
        showDetailError(prepared.errors);
        return;
      }
      this.modal.close();
    });
    this.modal.showModal();
  }

  _openNewGameDialog() {
    const dialog = document.querySelector('#new-game-dialog');
    if (!dialog || dialog.open) return;
    dialog.returnValue = 'cancel';
    dialog.showModal();
  }

  _openPlayerStatus(playerId) {
    const state = this.store.getState();
    const player = getPlayer(state, playerId);
    const knowledge = state.playerKnowledge[playerId] ?? {};
    const correctionHtml = ['setup', 'briefing'].includes(state.game.phase)
      ? `<hr><h4>役職訂正</h4><p class="help">公開発言前に限り役職を訂正できます。実行時に訂正モードへ入り、訂正後は全員の役職通知を最初からやり直します。</p><label class="field"><span>訂正後の役職</span><select id="correction-role">${roleOptions(player.roleId)}</select></label><label class="field"><span>理由</span><input id="correction-player-reason"></label><button class="button danger wide" id="correct-player-button" type="button">役職を訂正</button>`
      : state.game.correctionMode.enabled
        ? `<hr><h4>状態訂正</h4><p class="help">公開後の役職・生死は直接書き換えられません。処刑・夜明け・ゲーム結果の公開直前に作成された復元ポイントへ戻し、正しい進行をやり直してください。</p>`
        : '';
    this.modal.innerHTML = `<div class="modal-header"><h3>${escapeHtml(player.name)}</h3><button class="button icon ghost" data-modal-close type="button">×</button></div><div class="modal-body"><dl class="detail-list"><dt>種別</dt><dd>${player.controller === 'ai' ? 'AI' : '人間'}</dd><dt>状態</dt><dd>${player.alive ? '生存' : '死亡'}</dd><dt>公開CO</dt><dd>${escapeHtml(getRoleName(state.claims.find((claim) => claim.actorId === playerId && claim.status === 'active')?.roleId) || 'なし')}</dd>${this.showConfidential ? `<dt>真の役職</dt><dd>${escapeHtml(getRoleName(player.roleId))}</dd><dt>既知の人狼</dt><dd>${escapeHtml((knowledge.knownWolfIds ?? []).map((id) => getPlayerName(state,id)).join('、') || 'なし')}</dd><dt>既知の共有者</dt><dd>${escapeHtml((knowledge.knownMasonIds ?? []).map((id) => getPlayerName(state,id)).join('、') || 'なし')}</dd><dt>心の声</dt><dd><p class="heart-voice-text">${escapeHtml(player.heartVoice || 'なし')}</p></dd><dt>自由内部メモ</dt><dd><pre>${escapeHtml([player.internalMemory?.summary, ...(player.internalMemory?.notes ?? []).map((note) => `- ${note.text}`)].filter(Boolean).join('\n\n') || 'なし')}</pre></dd>` : ''}</dl>${correctionHtml}</div>`;
    const correctionButton = this.modal.querySelector('#correct-player-button');
    if (correctionButton) correctionButton.addEventListener('click', () => {
      if (this.isAutomationMutationLocked()) return this.toast('自動実行中は訂正できません。一時停止してから操作してください。', 'warning');
      const correctedRoleId = this.modal.querySelector('#correction-role').value;
      const reason = this.modal.querySelector('#correction-player-reason').value;
      const response = this.correctionController._correctRoleAssignment(playerId, correctedRoleId, reason);
      if (response?.ok) this.modal.close();
    });
    this.modal.showModal();
  }

  _openManualFinish() {
    this.modal.innerHTML = `<form><div class="modal-header"><h3>手動勝敗判定</h3><button class="button icon ghost" data-modal-close type="button">×</button></div><div class="modal-body form-grid"><label class="field"><span>勝利陣営</span><select name="team">${option('village','村人陣営','')}${option('wolf','人狼陣営','')}${option('fox','妖狐陣営','')}${option('draw','引き分け','')}</select></label><label class="field full"><span>理由</span><textarea name="reason" required>GMによる手動判定</textarea></label></div><div class="modal-footer"><button class="button ghost" data-modal-close type="button">キャンセル</button><button class="button danger" type="submit">結果確認へ進む</button></div></form>`;
    this.modal.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.isAutomationMutationLocked()) return this.toast('自動実行中は手動勝敗判定を実行できません。一時停止してから操作してください。', 'warning');
      const data = new FormData(event.currentTarget);
      this.workbenchActionController._manualFinish(data.get('team'), data.get('reason'));
      this.modal.close();
    });
    this.modal.showModal();
  }


}

