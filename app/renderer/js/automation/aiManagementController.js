/**
 * 責務: AI管理画面全体のイベント振り分け、画面ライフサイクル、プロファイル別/全体の使用量リセットを含む管理操作の調停を所有する。専用Controller依存は機能単位のオブジェクトとして受け取り、巨大なフラットcontextへ展開しない。
 * 変更ルール: 表示タブの切替では自動実行を停止しない。人狼卓を1手だけ進める処理はrunSingleAutomaticStepを正本とし、AI管理画面とリアルタイム人狼観戦の両入口から共有して進行規則を複製しない。実行方式変更時はliveProgressControllerへ進行卓表示方式の同期を委譲し、manualは通常進行卓、automaticは実行開始前・一時停止中を含め自動実行用進行卓を正本とする。自動実行セッション中は実行内容へ影響するAI設定変更だけを拒否し、閲覧・画面移動・停止操作は許可する。接続テスト・生成工程テストはrunning中だけAI生成リソース競合防止のため無効化する。プロファイル編集・JSON転送等の処理本体は各専用Controllerを正本とし、使用量リセットの永続処理はMainのsettingsStoreへ委譲する。AI通信とプライバシーの説明・初回確認はprivacy/dataTransmissionNotice.jsへ委譲する。プロファイル一覧構造を変更する操作は保存完了後の正式再描画を1回だけ行い、削除後の編集状態を未保存扱いで残さない。AI管理内の破壊操作確認はOSネイティブconfirmを使わず共通HTML dialogを使用し、確認直後も同一BrowserWindowの入力フォーカスを保持する。自動実行ロックは画面固有のdisabled状態を保存して対称的に解除し、再描画の有無へ解除成否を依存させない。
 */

export function createAiManagementController(context) {
  const {
    AI_COMMIT_RESULT_EVENT,
    DEFAULT_OLLAMA_THINKING_LEVEL,
    LOCAL_SERVER_PRESETS,
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
    emptyUsage,
    enableLiveView,
    firstEnabledProfileId,
    handleManualAiCommitResult,
    hideLiveView,
    isAutomationAiRequestLocked,
    isAutomationMutationLocked,
    normalizeGenerationSettings,
    openHumanTask,
    openManualAiTask,
    performOneStep,
    persistSettings,
    playerName,
    prepareLiveWorkbench,
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
    showPendingManualAiTask,
    syncExecutionModeWorkbenchView,
    updateButtons,
    updateGenerationCardUi,
    profileEditorController,
    aiProfileTransferController,
    assignmentController,
    generationTestController,
  } = context;
  // 接続診断はプロファイル編集Controller、生成工程診断は生成テストControllerを正本とする。
  const {
    switchProfileEditor,
    switchProfileEditorTab,
    syncProfileProviderFields,
    updateProfileEditorPreview,
    testProfile,
    listProfileModels,
  } = profileEditorController;
  const { exportSelectedProfileJson, importProfileJsonFile } = aiProfileTransferController;
  const {
    updateManagementReadouts,
    applyManagementExecutionModeUi,
    saveAssignment,
    showBulkAssignmentFeedback,
  } = assignmentController;
  const {
    generationCandidateAnswer,
    buildGenerationTestStageSnapshots,
    testGenerationPipeline,
  } = generationTestController;

  const LOCKED_AI_ACTIONS = new Set([
    'open-manual', 'step', 'add-profile', 'duplicate-profile', 'move-profile-up',
    'move-profile-down', 'delete-profile', 'import-profile-json', 'export-profile-json', 'bulk-assign', 'resync-player', 'resync-all', 'reset-profile-usage', 'reset-all-usage',
  ]);
  const AI_REQUEST_TEST_ACTIONS = new Set(['test-profile', 'test-generation-pipeline']);

  function rejectLockedAiMutation(action) {
    if (!isAutomationMutationLocked() || !LOCKED_AI_ACTIONS.has(action)) return false;
    runtime().toast('自動実行中はAI設定・進行条件を変更できません。一時停止してから操作してください。', 'warning');
    return true;
  }

  function confirmManagementAction({ title = '確認', message = '', confirmLabel = '実行', danger = false } = {}) {
    const dialog = document.querySelector('#modal-dialog');
    if (!dialog || typeof dialog.showModal !== 'function') return Promise.resolve(false);
    if (dialog.open) return Promise.resolve(false);

    dialog.returnValue = 'cancel';
    dialog.innerHTML = `<form method="dialog">
      <div class="modal-header"><h3 data-ai-management-confirm-title></h3></div>
      <div class="modal-body"><p data-ai-management-confirm-message></p></div>
      <div class="modal-footer"><button class="button ghost" value="cancel" type="submit" autofocus>キャンセル</button><button class="button ${danger ? 'danger' : 'primary'}" value="confirm" type="submit" data-ai-management-confirm-submit></button></div>
    </form>`;
    dialog.querySelector('[data-ai-management-confirm-title]').textContent = String(title ?? '確認');
    dialog.querySelector('[data-ai-management-confirm-message]').textContent = String(message ?? '');
    dialog.querySelector('[data-ai-management-confirm-submit]').textContent = String(confirmLabel ?? '実行');

    return new Promise((resolve) => {
      dialog.addEventListener('close', () => {
        const accepted = dialog.returnValue === 'confirm';
        dialog.innerHTML = '';
        resolve(accepted);
      }, { once: true });
      dialog.showModal();
    });
  }

  function restoreManagementWindowFocus(profileId = '') {
    window.requestAnimationFrame(() => {
      window.focus();
      const target = [...document.querySelectorAll('[data-ai-profile-select]')]
        .find((item) => item.dataset.aiProfileSelect === profileId)
        ?? document.querySelector('#ai-management-form');
      if (!target || typeof target.focus !== 'function') return;
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
    });
  }

  function setAutomationDisabled(control, disabled) {
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

  function applyManagementAutomationLock() {
    const form = document.querySelector('#ai-management-form');
    if (!form) return;
    const mutationLocked = isAutomationMutationLocked();
    const aiRequestLocked = isAutomationAiRequestLocked();
    // ロック解除時も同じDOMを安全に再利用できるよう、ロックが付与したdisabledだけを対称的に戻す。
    // 本来からdisabledだった項目はpreserveとして保持し、画面固有の有効条件を壊さない。
    form.querySelectorAll('input, select, textarea').forEach((control) => {
      setAutomationDisabled(control, mutationLocked);
    });
    LOCKED_AI_ACTIONS.forEach((action) => {
      form.querySelectorAll(`[data-ai-action="${action}"]`).forEach((button) => {
        setAutomationDisabled(button, mutationLocked);
      });
    });
    AI_REQUEST_TEST_ACTIONS.forEach((action) => {
      form.querySelectorAll(`[data-ai-action="${action}"]`).forEach((button) => {
        setAutomationDisabled(button, aiRequestLocked);
        if (aiRequestLocked) button.title = '自動実行中は実行できません。一時停止してから実行してください。';
        else if (button.title === '自動実行中は実行できません。一時停止してから実行してください。') button.removeAttribute('title');
      });
    });
  }

  async function openManualWorkbench({ persistForm = true, navigate = true } = {}) {
    if (controller.running || controller.stepping || controller.runSession) {
      await stopLoop({ waitForCompletion: true });
    }
    controller.resumeAfterManualAi = false;
    controller.pendingManualAiTask = null;
    runtime().dismissToast('manual-ai-generation');
    if (persistForm) {
      const saved = collectManagementForm();
      saved.executionMode = 'manual';
      await persistSettings(saved, { refresh: false });
    }
    setManagementDirty(false);
    setAutomationMode('idle');
    hideLiveView();
    setStatus('手動プロンプト進行を開きました。', 'idle');
    if (navigate) runtime().setTab(currentGameState()?.game?.phase === 'setup' ? 'setup' : 'workbench');
  }

  async function runSingleAutomaticStep({ persistForm = true, showLiveView = true } = {}) {
    if (isAutomationMutationLocked()) throw new Error('自動実行中は人狼卓を1手進められません。一時停止してから操作してください。');
    if (persistForm) {
      const saved = collectManagementForm();
      await persistSettings(saved, { refresh: false });
      setManagementDirty(false);
    }
    const validation = assignmentValidation();
    if (!validation.ok) throw new Error(validation.errors[0]);
    if (showLiveView) enableLiveView();
    const runtimeApi = runtime();
    const session = automationRunControl.createRunSession();
    controller.runSession = session;
    setAutomationMode('running', { singleStep: true });
    runtimeApi?.beginNightActorPrivacy?.();
    try {
      const result = await performOneStep(session);
      if (result.status === 'manual-ai') {
        setAutomationMode('waiting-manual-ai', { playerId: result.playerId, taskType: result.taskType, slotId: result.slotId ?? '' });
        setStatus(result.reason ?? 'AIプロファイル未設定の参加者を手動生成します。', 'idle');
        await openManualAiTask({ resume: false, request: result });
        return result;
      }
      if (['human-public', 'human-private'].includes(result.status)) {
        controller.waitingHuman = true;
        controller.resumeAfterHuman = false;
        controller.pendingHumanTask = {
          kind: result.status,
          playerId: result.playerId ?? '',
          taskType: result.taskType ?? '',
          slotId: result.slotId ?? '',
          questionEventId: result.questionEventId ?? '',
          conversationId: result.conversationId ?? '',
        };
        setAutomationMode('waiting-human', controller.pendingHumanTask);
      } else {
        setAutomationMode('idle');
      }
      setStatus(result.reason ?? '1ステップを完了しました。', result.status === 'advanced' ? 'success' : 'idle');
      refreshLiveView();
      return result;
    } catch (error) {
      setAutomationMode('error', { message: error.message });
      setStatus(`停止: ${error.message}`, 'error');
      throw error;
    } finally {
      try {
        if (controller.runSession === session) controller.runSession = null;
        runtimeApi?.endNightActorPrivacy?.();
      } finally {
        automationRunControl.completeSession(session);
      }
    }
  }

  async function handleAiAction(button) {
      const action = button.dataset.aiAction;
      if (action === 'open-data-privacy') {
        await globalThis.AiWerewolfDataTransmissionNotice?.openExternalDataPrivacyHelp?.();
        return;
      }
      if (action === 'open-management') {
        openManagementTab();
        return;
      }
      if (action === 'open-live') {
        if (!isAutomationMutationLocked()) {
          const saved = collectManagementForm();
          await persistSettings(saved, { refresh: false });
          setManagementDirty(false);
        }
        await prepareLiveWorkbench();
        setStatus('公開実況を表示しています。', controller.statusType === 'error' ? 'error' : 'idle');
        return;
      }
      if (action === 'open-pending-task') {
        if (controller.automationMode === 'waiting-manual-ai') return showPendingManualAiTask();
        if (controller.automationMode === 'waiting-human') {
          return openHumanTask();
        }
        return;
      }
      if (rejectLockedAiMutation(action)) return;
      if (action === 'open-manual') {
        await openManualWorkbench({ navigate: false });
        runtime().setTab(currentGameState()?.game?.phase === 'setup' ? 'setup' : 'workbench');
        return;
      }
      if (action === 'step') {
        await runSingleAutomaticStep({ persistForm: true, showLiveView: true });
        return;
      }
      if (action === 'toggle-run') {
        if (['running', 'waiting-human', 'waiting-manual-ai'].includes(controller.automationMode)) return stopLoop();
        const saved = collectManagementForm();
        await persistSettings(saved, { refresh: false });
        setManagementDirty(false);
        const validation = assignmentValidation();
        if (!validation.ok) throw new Error(validation.errors[0]);
        return runLoop();
      }
      if (action === 'pause-automatic') {
        if (controller.settings.executionMode !== 'automatic' || controller.automationMode !== 'running') return;
        if (controller.running || controller.stepping || controller.runSession) {
          await stopLoop({ waitForCompletion: true, preserveMode: true });
        }
        setAutomationMode('paused');
        setStatus('自動実行を一時停止しました。', 'idle');
        refreshLiveView();
        return;
      }
      if (action === 'resume-automatic') {
        if (controller.settings.executionMode !== 'automatic' || controller.automationMode !== 'paused') return;
        setStatus('自動実行を再開します。', 'working');
        return runLoop();
      }
      if (action === 'open-required-settings') {
        document.querySelectorAll('.ai-assignment-panel, .ai-profiles-panel').forEach((section) => { section.open = true; });
        document.querySelector('.ai-assignment-panel > summary')?.focus();
        return;
      }
      if (action === 'open-human-task') return openHumanTask();
      if (action === 'resync-player') {
        const playerId = document.querySelector('#ai-resync-player')?.value;
        if (!playerId) throw new Error('再同期するAI参加者を選択してください。');
        runtime().scheduleFullPublicHistory([playerId]);
        setStatus(`${playerName(playerId)}は次回だけ全履歴を送信します。`, 'success');
        refreshVisibleUi();
        return;
      }
      if (action === 'resync-all') {
        const ids = (currentGameState()?.players ?? []).filter((player) => player.controller === 'ai').map((player) => player.id);
        runtime().scheduleFullPublicHistory(ids);
        setStatus('全AI参加者は次回だけ全履歴を送信します。', 'success');
        refreshVisibleUi();
        return;
      }
      if (action === 'reset-profile-usage') {
        const profileId = String(button.dataset.profileId ?? '');
        const profile = controller.settings.profiles.find((item) => item.id === profileId);
        if (!profile) return;
        const accepted = await confirmManagementAction({
          title: 'プロファイル使用量をリセット',
          message: `AIプロファイル「${profile.label}」の累計使用量・使用額をリセットします。\n人狼・チャットルームなどすべての用途分が対象です。他プロファイルと詳細APIログは残ります。`,
          confirmLabel: 'リセット',
          danger: true,
        });
        if (!accepted) return;
        controller.persistedUsage = await bridge.resetProfileUsage(profileId);
        refreshVisibleUi();
        setStatus(`「${profile.label}」の累計使用量をリセットしました。`, 'success');
        restoreManagementWindowFocus(controller.selectedProfileId ?? profileId);
        return;
      }
      if (action === 'reset-all-usage') {
        const accepted = await confirmManagementAction({
          title: '全プロファイルの使用量をリセット',
          message: '全AIプロファイルの累計使用量・使用額をリセットします。\n詳細APIログは削除されません。',
          confirmLabel: 'リセット',
          danger: true,
        });
        if (!accepted) return;
        controller.persistedUsage = await bridge.resetUsageSummary('all');
        controller.usage = emptyUsage();
        controller.lastRequestUsage = null;
        refreshVisibleUi();
        setStatus('全AIプロファイルの使用量をリセットしました。', 'success');
        restoreManagementWindowFocus(controller.selectedProfileId ?? '');
        return;
      }
      if (action === 'import-profile-json') {
        document.querySelector('#ai-profile-import-file')?.click();
        return;
      }
      if (action === 'export-profile-json') {
        await exportSelectedProfileJson();
        return;
      }
      if (action === 'add-profile') {
        const current = await persistSettings(collectManagementForm(), { refresh: false });
        const profileId = createProfileId();
        current.profiles.push({
          id: profileId, label: `AIプロファイル ${current.profiles.length + 1}`, provider: 'demo', model: 'demo-balanced', endpoint: '', enabled: true, hasApiKey: false, timeoutMs: 180000, maxOutputTokens: 8192, chatTokenLimitField: 'max_completion_tokens', contextWindowTokens: 131072, promptCacheMode: 'auto', anthropicCacheTtl: 'auto', jsonRequestMode: 'prompt-only', jsonResponseMode: 'strict', thinkingLevel: DEFAULT_OLLAMA_THINKING_LEVEL, localServerPreset: 'custom', billing: { inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, outputUsdPerMillion: 0, profileBudgetUsd: 0 }, generation: defaultGenerationSettings(),
        });
        controller.selectedProfileId = profileId;
        await persistSettings(current, { refresh: true, statusMessage: '新しいAIプロファイルを追加しました。' });
        return;
      }
      if (action === 'duplicate-profile') {
        const current = await persistSettings(collectManagementForm(), { refresh: false });
        const source = current.profiles.find((profile) => profile.id === button.dataset.profileId);
        if (!source) return;
        const profileId = createProfileId();
        current.profiles.push({
          ...source,
          id: profileId,
          label: `${source.label} のコピー`,
          hasApiKey: false,
          apiKey: '',
          clearApiKey: false,
          generation: structuredClone(normalizeGenerationSettings(source.generation)),
        });
        controller.selectedProfileId = profileId;
        await persistSettings(current, { refresh: true, statusMessage: 'AIプロファイルを複製しました。APIキーは安全のため複製していません。' });
        return;
      }
      if (action === 'move-profile-up' || action === 'move-profile-down') {
        const current = collectManagementForm();
        const profileId = button.dataset.profileId;
        const offset = action === 'move-profile-up' ? -1 : 1;
        const reordered = reorderedProfiles(current.profiles, profileId, offset);
        if (reordered.every((profile, index) => profile.id === current.profiles[index]?.id)) return;
        current.profiles = reordered;
        controller.selectedProfileId = profileId;
        await persistSettings(current, { refresh: true, statusMessage: 'AIプロファイルの並び順を保存しました。' });
        return;
      }
      if (action === 'delete-profile') {
        const profileId = button.dataset.profileId;
        const current = collectManagementForm();
        if (current.profiles.length <= 1) return runtime().toast('最後のAIプロファイルは削除できません。', 'error');
        const usedBy = (currentGameState()?.players ?? []).filter((player) => player.controller === 'ai' && current.assignments[player.id] === profileId);
        if (usedBy.length) return runtime().toast(`使用中のため削除できません: ${usedBy.map((player) => player.name).join('、')}`, 'error');
        const generationReferences = current.profiles.flatMap((sourceProfile) => {
          if (sourceProfile.id === profileId) return [];
          const generation = normalizeGenerationSettings(sourceProfile.generation);
          return [
            ['第1工程（判断／客観分析）', generation.reasoningProfileId],
            ['第2/最終工程（発言化／最終回答）', generation.outputProfileId],
            ['批判的検証', generation.critiqueProfileId],
          ].filter(([, referenceId]) => referenceId === profileId).map(([stageLabel]) => `${sourceProfile.label}の${stageLabel}担当`);
        });
        if (generationReferences.length) return runtime().toast(`工程担当として参照中のため削除できません: ${generationReferences.join('、')}`, 'error');
        const profile = current.profiles.find((item) => item.id === profileId);
        const accepted = await confirmManagementAction({
          title: 'AIプロファイルを削除',
          message: `AIプロファイル「${profile?.label ?? profileId}」を削除します。`,
          confirmLabel: '削除',
          danger: true,
        });
        if (!accepted) return;
        if (document.activeElement === button) button.blur();
        current.profiles = current.profiles.filter((item) => item.id !== profileId);
        if (controller.selectedProfileId === profileId) controller.selectedProfileId = current.profiles[0]?.id ?? null;
        await persistSettings(current, { refresh: true, statusMessage: 'AIプロファイルを削除しました。', profileDeletionId: profileId });
        setManagementDirty(false);
        restoreManagementWindowFocus(controller.selectedProfileId ?? '');
        return;
      }
      if (action === 'list-profile-models') return listProfileModels(button.dataset.profileId, button);
      if (action === 'test-profile') return testProfile(button.dataset.profileId, button);
      if (action === 'test-generation-pipeline') return testGenerationPipeline(button.dataset.profileId, button);
      if (action === 'bulk-assign') {
        const bulkSelect = document.querySelector('#ai-bulk-profile');
        const profileId = bulkSelect?.value;
        if (!profileId) return runtime().toast('一括設定するAIプロファイルを選択してください。', 'error');
        controller.bulkAssignmentProfileId = profileId;
        const assignments = { ...controller.settings.assignments };
        const aiPlayerIds = (currentGameState()?.players ?? []).filter((player) => player.controller === 'ai').map((player) => player.id);
        aiPlayerIds.forEach((playerId) => { assignments[playerId] = profileId; });
        button.disabled = true;
        try {
          await persistSettings({ ...controller.settings, assignments }, { refresh: false, statusMessage: `AI参加者${aiPlayerIds.length}名へプロファイルを適用しました。` });
          document.querySelectorAll('[data-ai-profile-player-id]').forEach((select) => {
            if (aiPlayerIds.includes(select.dataset.aiProfilePlayerId)) select.value = profileId;
          });
          updateManagementReadouts();
          const message = `✓ AI参加者${aiPlayerIds.length}名へ設定を適用しました。`;
          showBulkAssignmentFeedback(message, aiPlayerIds);
          runtime().toast(message, 'success');
          // ゲーム準備画面の一括適用では、開始前検証と個別選択欄も同じ保存結果へ同期する。
          if (bulkSelect?.dataset.aiBulkScope === 'setup') refreshVisibleUi();
        } finally {
          button.disabled = controller.settings.executionMode === 'manual';
        }
        return;
      }
    }

  function beforeManagementTabRender({ root }) {
      if (!root?.querySelector?.('#ai-management-form')) return;
      captureManagementSectionState(root);
      controller.managementScrollTop = Number(root.scrollTop ?? 0);
    }

  function afterManagementTabRender({ root }) {
      if (root) root.scrollTop = controller.managementScrollTop;
      updateButtons();
      applyManagementAutomationLock();
      setStatus(controller.statusMessage, controller.statusType);
    }

  function openManagementTab() {
      runtime().setTab('ai-management');
    }

  

  function bindManagementEvents() {
      document.addEventListener('toggle', (event) => {
        const section = event.target;
        if (!section?.matches?.('details[data-ai-management-section]')) return;
        const sectionId = section.dataset.aiManagementSection;
        if (Object.hasOwn(controller.managementSectionOpen, sectionId)) {
          controller.managementSectionOpen[sectionId] = Boolean(section.open);
        }
      }, true);
      window.addEventListener(AI_COMMIT_RESULT_EVENT, (event) => {
        handleManualAiCommitResult(event.detail);
      });
      document.addEventListener('change', async (event) => {
        if (event.target.id === 'ai-profile-import-file') {
          const file = event.target.files?.[0] ?? null;
          event.target.value = '';
          if (!file) return;
          if (isAutomationMutationLocked()) {
            runtime().toast('自動実行中はAIプロファイルを読み込めません。一時停止してから操作してください。', 'warning');
            return;
          }
          try { await importProfileJsonFile(file); }
          catch (error) { runtime().toast(`プロファイル読込失敗: ${error.message}`, 'error'); }
          return;
        }
        if (isAutomationMutationLocked() && event.target.closest('#ai-management-form')) {
          runtime().toast('自動実行中はAI設定を変更できません。一時停止してから操作してください。', 'warning');
          runtime().refreshTab('ai-management');
          return;
        }
        if (event.target.id === 'ai-bulk-profile') {
          controller.bulkAssignmentProfileId = event.target.value || null;
          return;
        }
        const provider = event.target.closest('[data-profile-setting="provider"]');
        if (provider) {
          const card = provider.closest('.ai-profile-card');
          syncProfileProviderFields(card, provider.value);
          updateProfileEditorPreview(card);
          setManagementDirty(true);
          return;
        }
        const localPreset = event.target.closest('[data-profile-setting="localServerPreset"]');
        if (localPreset) {
          const card = localPreset.closest('.ai-profile-card');
          const endpoint = card?.querySelector('[data-profile-setting="endpoint"]');
          const preset = LOCAL_SERVER_PRESETS[localPreset.value];
          if (endpoint && preset?.endpoint) endpoint.value = preset.endpoint;
          if (endpoint) endpoint.readOnly = localPreset.value !== 'custom';
          card?.querySelectorAll('[data-ollama-setting]').forEach((field) => { field.hidden = localPreset.value !== 'ollama'; });
          updateProfileEditorPreview(card);
          setManagementDirty(true);
          return;
        }
        const generationDepth = event.target.closest('[data-generation-depth]');
        if (generationDepth) {
          const card = generationDepth.closest('.ai-profile-card');
          updateGenerationCardUi(card);
          const editorGeneration = card?.querySelector('[data-profile-editor-generation]');
          const summary = card?.querySelector('[data-generation-summary]');
          if (editorGeneration && summary) editorGeneration.textContent = summary.textContent;
          setManagementDirty(true);
          return;
        }
        const generationOverride = event.target.closest('[data-generation-task-override]');
        if (generationOverride) {
          const card = generationOverride.closest('.ai-profile-card');
          updateGenerationCardUi(card);
          const editorGeneration = card?.querySelector('[data-profile-editor-generation]');
          const summary = card?.querySelector('[data-generation-summary]');
          if (editorGeneration && summary) editorGeneration.textContent = summary.textContent;
          setManagementDirty(true);
          return;
        }
        const generationExecutor = event.target.closest('[data-generation-profile-id]');
        if (generationExecutor) {
          const card = generationExecutor.closest('.ai-profile-card');
          updateGenerationCardUi(card);
          const editorGeneration = card?.querySelector('[data-profile-editor-generation]');
          const summary = card?.querySelector('[data-generation-summary]');
          if (editorGeneration && summary) editorGeneration.textContent = summary.textContent;
          setManagementDirty(true);
          return;
        }
        const assignment = event.target.closest('[data-ai-profile-player-id]');
        if (assignment) {
          try { await saveAssignment(assignment.dataset.aiProfilePlayerId, assignment.value); }
          catch (error) { runtime().toast(`割り当て保存失敗: ${error.message}`, 'error'); }
          return;
        }
        const executionMode = event.target.closest('input[name="executionMode"]');
        if (executionMode) {
          try {
            if (executionMode.value === 'manual') {
              controller.resumeAfterManualAi = false;
              controller.pendingManualAiTask = null;
              runtime().dismissToast('manual-ai-generation');
            }
            await persistSettings({ ...controller.settings, executionMode: executionMode.value === 'manual' ? 'manual' : 'automatic' }, { refresh: false, statusMessage: executionMode.value === 'manual' ? '手動プロンプト方式へ切り替えました。' : '自動API実行へ切り替えました。' });
            if (executionMode.value === 'manual') {
              await openManualWorkbench({ persistForm: false });
              return;
            }
            syncExecutionModeWorkbenchView();
            applyManagementExecutionModeUi();
          } catch (error) { runtime().toast(`実行方式の保存に失敗しました: ${error.message}`, 'error'); }
          return;
        }
        const immediateAutoRun = event.target.closest('input[name="autoConfirmWarnings"], input[name="autoPublish"]');
        if (immediateAutoRun) {
          try {
            const autoRun = { ...controller.settings.autoRun, [immediateAutoRun.name]: immediateAutoRun.checked };
            await persistSettings({ ...controller.settings, autoRun }, { refresh: false, statusMessage: '進行オプションを保存しました。' });
            updateManagementReadouts();
          } catch (error) { runtime().toast(`進行オプションの保存に失敗しました: ${error.message}`, 'error'); }
          return;
        }
        if (event.target.matches('[data-profile-setting], input[name="intervalMs"], input[name="maxConsecutiveSteps"], select[name="publicHistoryMode"], select[name="apiErrorAction"], select[name="responseRecoveryMode"], select[name="apiLogScope"]')) {
          updateProfileEditorPreview(event.target.closest('.ai-profile-card'));
          setManagementDirty(true);
        }
        const controllerSelect = event.target.closest('[data-player-field="controller"]');
        if (controllerSelect?.value === 'ai' && !Object.hasOwn(controller.settings.assignments, controllerSelect.dataset.playerId)) {
          try { await saveAssignment(controllerSelect.dataset.playerId, firstEnabledProfileId()); }
          catch (error) { runtime().toast(`AI切替時の割り当て保存に失敗しました: ${error.message}`, 'error'); }
        }
      });
      document.addEventListener('click', async (event) => {
        const profileSelector = event.target.closest('[data-ai-profile-select]');
        if (profileSelector) {
          event.preventDefault();
          switchProfileEditor(profileSelector.dataset.aiProfileSelect);
          return;
        }
        const profileTab = event.target.closest('[data-ai-profile-tab]');
        if (profileTab) {
          event.preventDefault();
          switchProfileEditorTab(profileTab.dataset.aiProfileTab);
          return;
        }
        const button = event.target.closest('[data-ai-action]');
        if (!button) return;
        event.preventDefault();
        const concealNightActor = button.dataset.aiAction === 'step' && currentGameState()?.game?.phase === 'night';
        try { await handleAiAction(button); }
        catch (error) { runtime().toast(`AI管理操作に失敗しました: ${error.message}`, 'error', { concealNightActor }); }
      });
      document.addEventListener('input', (event) => {
        const profileSetting = event.target.closest('[data-profile-setting]');
        if (profileSetting) updateProfileEditorPreview(profileSetting.closest('.ai-profile-card'));
        if (event.target.closest('#ai-management-form') && !event.target.matches('input[name="executionMode"], input[name="autoConfirmWarnings"], input[name="autoPublish"], [data-ai-profile-player-id], #ai-bulk-profile')) setManagementDirty(true);
      });
      document.addEventListener('keydown', (event) => {
        if (!event.target.matches('[data-human-primary-input][data-human-enter-submit]') || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        event.target.closest('[data-human-task-card]')?.querySelector('[data-action="submit-human-task"]')?.click();
      });
      window.addEventListener('ai-werewolf-human-task-completed', () => {
        if (controller.automationMode !== 'waiting-human') return;
        window.setTimeout(resumeAutomaticAfterHuman, 0);
      });
      document.addEventListener('submit', async (event) => {
        if (event.target.id !== 'ai-management-form') return;
        event.preventDefault();
        if (isAutomationMutationLocked()) {
          runtime().toast('自動実行中はAI設定を保存できません。一時停止してから操作してください。', 'warning');
          return;
        }
        try {
          await persistSettings(collectManagementForm(), { refresh: true, statusMessage: 'AI管理設定を保存しました。' });
          setManagementDirty(false);
          runtime().toast('AI管理設定を保存しました。', 'success');
        } catch (error) {
          runtime().toast(`設定保存失敗: ${error.message}`, 'error');
        }
      });
    }

  return Object.freeze({
    switchProfileEditor,
    switchProfileEditorTab,
    syncProfileProviderFields,
    updateProfileEditorPreview,
    updateManagementReadouts,
    applyManagementExecutionModeUi,
    saveAssignment,
    showBulkAssignmentFeedback,
    testProfile,
    generationCandidateAnswer,
    buildGenerationTestStageSnapshots,
    testGenerationPipeline,
    listProfileModels,
    handleAiAction,
    runSingleAutomaticStep,
    beforeManagementTabRender,
    afterManagementTabRender,
    openManagementTab,
    bindManagementEvents,
  });
}
