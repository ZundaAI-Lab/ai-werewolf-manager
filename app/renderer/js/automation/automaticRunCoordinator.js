/**
 * 責務: 状態駆動の一手実行、独立AIタスクの全自動バッチ実行、AI役職通知の一括処理、自動進行ループ、停止完了待機と、AIプロファイル利用上限到達時の再開可能な一時停止を所有する。
 * 変更ルール: 単発のperformOneStepは従来どおり一つの操作だけを進め、並列化・一括化は全自動ループだけで使用する。並列対象はruntimeの純粋batch policyを正本とし、Automation側でゲーム規則を複製しない。内部メモ整理だけは専用Schedulerへ委譲し、異なるAIの通信を並行継続しつつ本人の次AI生成前に必ず完了を待つ。処理中メモ整理はAutomation状態としてworkflow候補から一時除外し、ゲームstateへ進行中フラグを追加しない。自動実行ループは表示中タブを変更しない。DOM、data-action、ボタン表示文字列をゲーム進行APIとして使用せず、正式コマンドAPIを直接実行する。全自動開始は単一の実行Promiseへ集約し、準備中を含めて実行セッションを重複生成しない。PROFILE_BUDGET_EXCEEDEDだけはゲーム状態を進めずpausedへ移し、設定変更後に同じ未処理タスクから再開できる状態を保つ。
 */

export function createAutomaticRunCoordinator(context) {
  const {
    apiRetryPolicy,
    automationRunControl,
    automaticMemoConsolidationScheduler,
    bridge,
    controller,
    currentGameState,
    dialogError,
    enableLiveView,
    executeAiStep,
    executeAiBatch,
    openManualAiTask,
    playerName,
    refreshLiveView,
    runtime,
    setAutomationMode,
    setStatus,
    updateButtons,
    usesManualAiGeneration,
  } = context;
  let activeRunPromise = null;

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function settleWithin(promise, timeoutMs, timeoutMessage = '') {
    let timeoutId = null;
    const timeout = new Promise((resolve, reject) => {
      timeoutId = window.setTimeout(() => {
        if (timeoutMessage) reject(new Error(timeoutMessage));
        else resolve(undefined);
      }, timeoutMs);
    });
    return Promise.race([Promise.resolve(promise), timeout])
      .finally(() => window.clearTimeout(timeoutId));
  }

  function structuredApiError(error) {
    if (error?.apiError) return error.apiError;
    return {
      code: 'IPC_ERROR',
      message: error?.message ?? String(error),
      retryable: false,
      deliveryUnknown: false,
      retryAfterMs: null,
    };
  }

  function apiErrorAsException(error) {
    const exception = new Error(apiRetryPolicy.apiErrorMessage(error));
    exception.apiError = error;
    return exception;
  }

  async function waitFor(predicate, {
    timeoutMs = 8000,
    intervalMs = 40,
    message = '状態更新を確認できませんでした。',
    session = controller.runSession,
  } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (session) automationRunControl.assertRunning(session);
      const value = predicate();
      if (value) return value;
      if (session) await automationRunControl.delayWithAbort(intervalMs, session);
      else await delay(intervalMs);
    }
    throw new Error(message);
  }

  async function waitForRevisionChange(beforeRevision, message) {
    return waitFor(() => {
      const error = dialogError?.();
      if (error) return { error };
      const revision = Number(currentGameState()?.revision ?? beforeRevision);
      return revision !== beforeRevision ? { revision } : null;
    }, { timeoutMs: 12000, message }).then((result) => {
      if (result.error) throw new Error(result.error);
      return result;
    });
  }

  function assertCommandAdvanced(beforeRevision, response, label) {
    if (!response?.ok) throw new Error(response?.message || `${label}を実行できませんでした。`);
    const afterRevision = Number(currentGameState()?.revision ?? beforeRevision);
    if (afterRevision === beforeRevision) throw new Error(`${label}後にゲーム状態が更新されませんでした。`);
    setStatus(`${label}を完了しました。`, 'working');
  }

  function automaticActionOptions(session = controller.runSession) {
    return {
      ignoredMemoConsolidationPlayerIds: automaticMemoConsolidationScheduler?.pendingPlayerIds(session) ?? [],
    };
  }

  function resolveAutomaticAction(runtimeApi, session) {
    return runtimeApi.resolveAutomaticAction({
      autoPublish: controller.settings.autoRun.autoPublish,
      ...automaticActionOptions(session),
    });
  }

  async function resolveActionAfterPlayerMemoBarrier(runtimeApi, action, session) {
    if (action?.kind !== 'ai-task') return action;
    const playerId = String(action.taskRequest?.playerId ?? '');
    if (!playerId) return action;
    await automaticMemoConsolidationScheduler?.waitForPlayer(playerId, session);
    return resolveAutomaticAction(runtimeApi, session);
  }

  async function performOneStep(session) {
    automationRunControl.assertRunning(session);
    automaticMemoConsolidationScheduler?.assertHealthy(session);
    if (controller.stepping) return { status: 'busy' };
    controller.stepping = true;
    updateButtons();
    try {
      const state = currentGameState();
      if (!state) throw new Error('ゲームランタイムを取得できません。アプリを再起動してください。');
      const runtimeApi = runtime();
      if (typeof runtimeApi.resolveAutomaticAction !== 'function' || typeof runtimeApi.executeAutomaticAction !== 'function') {
        throw new Error('状態駆動の全自動進行APIを利用できません。');
      }
      let action = resolveAutomaticAction(runtimeApi, session);
      action = await resolveActionAfterPlayerMemoBarrier(runtimeApi, action, session);

      if (action.kind === 'ai-task') {
        const request = action.taskRequest;
        if (usesManualAiGeneration(request.playerId)) {
          return {
            status: 'manual-ai',
            ...request,
            reason: `${playerName(request.playerId)}はAIプロファイル未設定のため、手動生成へ切り替えます。`,
          };
        }
        await executeAiStep(request, session);
        return { status: 'advanced' };
      }

      if (action.kind === 'command') {
        const beforeRevision = Number(currentGameState()?.revision ?? 0);
        const response = runtimeApi.executeAutomaticAction(action);
        assertCommandAdvanced(beforeRevision, response, action.label || action.command);
        return { status: 'advanced' };
      }

      if (action.kind === 'ended') {
        await automaticMemoConsolidationScheduler?.waitForAll(session);
        return { status: 'ended', reason: action.reason };
      }
      if (action.kind === 'human-public' || action.kind === 'human-private') {
        await automaticMemoConsolidationScheduler?.waitForAll(session);
        return {
          status: action.kind,
          reason: action.reason,
          playerId: action.playerId,
          taskType: action.taskType,
          slotId: action.slotId ?? '',
          questionEventId: action.questionEventId ?? '',
          conversationId: action.conversationId ?? '',
        };
      }
      return { status: 'stopped', reason: action.reason ?? '自動化対象外のGM確認で停止しました。' };
    } finally {
      controller.stepping = false;
      updateButtons();
    }
  }

  function sameCommandRequest(action, request) {
    return action?.kind === 'command'
      && String(action.command ?? '') === String(request.command ?? '')
      && String(action.playerId ?? '') === String(request.playerId ?? '');
  }

  async function performCommandBatch(session, batch) {
    automationRunControl.assertRunning(session);
    const requests = [...(batch?.commandRequests ?? [])];
    if (requests.length < 2) return { status: 'invalidated', advancedCount: 0 };
    const runtimeApi = runtime();
    setStatus(`AI役職通知を一括処理中（${requests.length}件）`, 'working');
    let advancedCount = 0;
    for (const request of requests) {
      automationRunControl.assertRunning(session);
      const action = resolveAutomaticAction(runtimeApi, session);
      if (!sameCommandRequest(action, request)) {
        return { status: advancedCount > 0 ? 'advanced' : 'invalidated', advancedCount };
      }
      const beforeRevision = Number(currentGameState()?.revision ?? 0);
      const response = runtimeApi.executeAutomaticAction(action);
      assertCommandAdvanced(beforeRevision, response, action.label || action.command);
      advancedCount += 1;
    }
    return { status: 'advanced', advancedCount };
  }

  async function performParallelBatch(session, batch) {
    automationRunControl.assertRunning(session);
    automaticMemoConsolidationScheduler?.assertHealthy(session);
    if (controller.stepping) return { status: 'busy', advancedCount: 0 };
    controller.stepping = true;
    updateButtons();
    try {
      if (batch?.kind === 'command-batch') return performCommandBatch(session, batch);
      if (batch?.source === 'memo-consolidation') {
        return automaticMemoConsolidationScheduler.startBatch(batch, session);
      }
      await automaticMemoConsolidationScheduler?.waitForPlayers(
        (batch?.taskRequests ?? []).map((request) => request.playerId),
        session,
      );
      return await executeAiBatch(batch, session);
    } finally {
      controller.stepping = false;
      updateButtons();
    }
  }

  function automaticBatchForCurrentState(session = controller.runSession) {
    if (typeof executeAiBatch !== 'function') return null;
    if (controller.settings.aiOptions?.parallelExecutionMode === 'disabled') return null;
    const runtimeApi = runtime();
    if (typeof runtimeApi.resolveAutomaticAiBatch !== 'function') return null;
    const batch = runtimeApi.resolveAutomaticAiBatch(automaticActionOptions(session));
    if (!['ai-task-batch', 'command-batch'].includes(batch?.kind)) return null;

    const remainingSteps = Math.max(0, Number(controller.settings.autoRun.maxConsecutiveSteps ?? 0) - controller.completedSteps);
    if (remainingSteps < 2) return null;

    if (batch.kind === 'command-batch') {
      const executable = [...(batch.commandRequests ?? [])].slice(0, remainingSteps);
      if (executable.length < 2) return null;
      return { ...batch, commandRequests: executable };
    }

    if (!Array.isArray(batch.taskRequests) || batch.taskRequests.length < 2) return null;
    const executable = [];
    for (const request of batch.taskRequests) {
      if (executable.length >= remainingSteps) break;
      if (usesManualAiGeneration(request.playerId)) break;
      executable.push(request);
    }
    if (executable.length < 2) return null;
    return { ...batch, taskRequests: executable };
  }

  async function executeRunLoop() {
    if (controller.settings.executionMode !== 'automatic') throw new Error('実行方式が手動プロンプトになっています。AI管理で自動API実行へ切り替えてください。');
    enableLiveView();
    runtime().beginAutomaticNotifications();
    controller.running = true;
    controller.waitingHuman = false;
    controller.resumeAfterHuman = false;
    controller.resumeAfterManualAi = false;
    controller.pendingManualAiTask = null;
    controller.pendingHumanTask = null;
    const session = automationRunControl.createRunSession();
    controller.runSession = session;
    controller.completedSteps = 0;
    updateButtons();
    setAutomationMode('running');
    setStatus('全自動進行を開始しました。画面を移動しても自動実行は継続します。', 'working');
    try {
      while (!automationRunControl.isStopped(session)) {
        automaticMemoConsolidationScheduler?.assertHealthy(session);
        if (controller.completedSteps >= controller.settings.autoRun.maxConsecutiveSteps) {
          throw new Error('自動実行の連続ステップ上限に達しました。');
        }
        const batch = automaticBatchForCurrentState(session);
        let result = batch
          ? await performParallelBatch(session, batch)
          : await performOneStep(session);
        if (result.status === 'invalidated') result = await performOneStep(session);
        if (result.status === 'advanced') {
          controller.completedSteps += Math.max(1, Number(result.advancedCount ?? 1));
          await automationRunControl.delayWithAbort(controller.settings.autoRun.intervalMs, session);
          continue;
        }
        if (result.status === 'manual-ai') {
          await automaticMemoConsolidationScheduler?.waitForAll(session);
          setAutomationMode('waiting-manual-ai', { playerId: result.playerId, taskType: result.taskType, slotId: result.slotId ?? '' });
          setStatus(result.reason ?? 'AIプロファイル未設定の参加者を手動生成します。', 'idle');
          await openManualAiTask({ resume: true, request: result });
          break;
        }
        if (['human-public', 'human-private'].includes(result.status)) {
          controller.waitingHuman = true;
          controller.resumeAfterHuman = true;
          controller.pendingHumanTask = {
            kind: result.status,
            playerId: result.playerId ?? '',
            taskType: result.taskType ?? '',
            slotId: result.slotId ?? '',
            questionEventId: result.questionEventId ?? '',
            conversationId: result.conversationId ?? '',
          };
          setAutomationMode('waiting-human', controller.pendingHumanTask);
          setStatus(result.reason ?? '人間プレイヤーの操作待ちです。', 'idle');
          refreshLiveView();
          break;
        }
        await automaticMemoConsolidationScheduler?.waitForAll(session);
        setAutomationMode('idle');
        setStatus(result.reason ?? '自動実行を停止しました。', result.status === 'ended' ? 'success' : 'idle');
        if (result.status === 'ended') {
          runtime().toast('全自動進行が完了しました。', 'success', {
            key: 'automatic-run-complete',
            forceDisplay: true,
            source: 'automatic-run',
          });
        }
        break;
      }
    } catch (error) {
      controller.resumeAfterHuman = false;
      if (automationRunControl.isAutomationStoppedError(error)) {
        setStatus('自動実行を停止しました。', 'idle');
      } else if (structuredApiError(error).code === 'PROFILE_BUDGET_EXCEEDED') {
        const budgetMessage = 'AIプロファイルの利用上限に達したため一時停止しました。利用上限または使用量を変更してから再開してください。';
        setAutomationMode('paused', { reason: 'profile-budget', message: error.message });
        setStatus(budgetMessage, 'idle');
        runtime().toast(budgetMessage, 'warning', {
          key: 'automatic-run-profile-budget',
          forceDisplay: true,
          source: 'automatic-run',
        });
      } else {
        setAutomationMode('error', { message: error.message });
        setStatus(`停止: ${error.message}`, 'error');
        runtime().toast(`AI自動実行を停止しました: ${error.message}`, 'error', {
          key: 'automatic-run-error',
          forceDisplay: true,
          durationMs: 0,
          source: 'automatic-run',
        });
      }
    } finally {
      try {
        await automaticMemoConsolidationScheduler?.settleAll(session);
        controller.running = false;
        if (controller.runSession === session) controller.runSession = null;
        runtime().endAutomaticNotifications();
        updateButtons();
        refreshLiveView();
      } finally {
        automationRunControl.completeSession(session);
      }
    }
  }

  function runLoop() {
    if (activeRunPromise) return activeRunPromise;
    if (controller.running) return Promise.resolve();
    const runPromise = executeRunLoop();
    activeRunPromise = runPromise;
    runPromise.finally(() => {
      if (activeRunPromise === runPromise) activeRunPromise = null;
    }).catch(() => {});
    return runPromise;
  }

  async function stopLoop({ waitForCompletion = false, preserveMode = false } = {}) {
    const session = controller.runSession;
    automationRunControl.requestStop(session);
    controller.resumeAfterHuman = false;
    controller.waitingHuman = false;
    controller.resumeAfterManualAi = false;
    controller.pendingManualAiTask = null;
    controller.pendingHumanTask = null;
    if (!preserveMode) setAutomationMode('idle');
    const requestIds = automationRunControl.activeRequestIds(session);
    if (requestIds.length) {
      await settleWithin(
        Promise.allSettled(requestIds.map((requestId) => bridge.cancelRequest(requestId).catch(() => {}))),
        2000,
      );
    }
    setStatus('停止要求を受け付けました。', 'idle');
    if (!waitForCompletion || !session) return;
    await settleWithin(
      automationRunControl.waitForCompletion(session),
      8000,
      '自動実行の停止完了を確認できませんでした。',
    );
  }

  return Object.freeze({
    delay,
    settleWithin,
    structuredApiError,
    apiErrorAsException,
    waitFor,
    waitForRevisionChange,
    performOneStep,
    performParallelBatch,
    runLoop,
    stopLoop,
  });
}
