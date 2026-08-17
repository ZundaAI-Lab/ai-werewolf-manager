/**
 * 責務: 状態駆動の一手実行、自動進行ループ、停止完了待機を所有する。
 * 変更ルール: 自動実行ループは表示中タブを変更しない。DOM、data-action、ボタン表示文字列をゲーム進行APIとして使用せず、次の操作はruntimeの純粋ポリシーで導出して正式コマンドAPIを直接実行する。全自動開始は単一の実行Promiseへ集約し、準備中を含めて実行セッションを重複生成しない。
 */

(function initializeAiWerewolfAutomaticRunCoordinator(globalScope) {
  'use strict';

  function createAutomaticRunCoordinator(context) {
    const {
      apiRetryPolicy,
      automationRunControl,
      bridge,
      controller,
      currentGameState,
      dialogError,
      enableLiveView,
      executeAiStep,
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

    async function performOneStep(session) {
      automationRunControl.assertRunning(session);
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
        const action = runtimeApi.resolveAutomaticAction({
          autoPublish: controller.settings.autoRun.autoPublish,
        });

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
          const beforeRevision = Number(state.revision ?? 0);
          const response = runtimeApi.executeAutomaticAction(action);
          assertCommandAdvanced(beforeRevision, response, action.label || action.command);
          return { status: 'advanced' };
        }

        if (action.kind === 'ended') return { status: 'ended', reason: action.reason };
        if (action.kind === 'human-public' || action.kind === 'human-private') {
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
          if (controller.completedSteps >= controller.settings.autoRun.maxConsecutiveSteps) {
            throw new Error('自動実行の連続ステップ上限に達しました。');
          }
          const result = await performOneStep(session);
          if (result.status === 'advanced') {
            controller.completedSteps += 1;
            await automationRunControl.delayWithAbort(controller.settings.autoRun.intervalMs, session);
            continue;
          }
          if (result.status === 'manual-ai') {
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
      if (session?.currentRequestId) {
        await settleWithin(
          bridge.cancelRequest(session.currentRequestId).catch(() => {}),
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
      runLoop,
      stopLoop,
    });
  }

  globalScope.AiWerewolfAutomaticRunCoordinator = Object.freeze({ createAutomaticRunCoordinator });
}(typeof window === 'undefined' ? globalThis : window));

// bundle側のside-effect ES Moduleとして到達させ、HTMLのscript順序へ依存しない。
export {};
