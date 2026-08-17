/**
 * 責務: 1件のAIタスクについて工程別API要求、通信再試行、全履歴再同期、応答修復、正式登録または項目代替までを実行する。
 * 変更ルール: DOM画面構築と全自動ループを担当しない。実行セッション停止後は新規API要求・再試行・正式登録・代替登録を開始しない。外部LLMはprivacy/dataTransmissionNotice.jsの初回確認完了後だけMainへ要求する。工程プロンプトは最新taskArtifactから工程別ビルダーで再構築し、投票修復は有効対象だけの最小契約、それ以外は最新の基準プロンプトを参照する。過去のAPI要求・生応答を保存・再送せず、固定・継続・動的区画とProvider非依存Schemaを持つpromptEnvelopeだけをMainへ渡す。OllamaがThinkingだけを返した投票再試行に限り、同一タスク内で一度だけThinkingを無効化する。
 */

(function initializeAutomaticAiExecutor(global) {
  'use strict';

  function replaceTaskArtifact(target, source) {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, source);
    return target;
  }

  function buildFullCandidateStagePrompt({
    stageId,
    taskArtifact,
    resolveStagePromptPolicy,
    buildDraftStagePrompt,
  }) {
    if (stageId === 'direct') return String(taskArtifact.promptEnvelope?.dynamicTaskPrompt ?? taskArtifact.text ?? '');
    if (stageId === 'draft') {
      return buildDraftStagePrompt({
        taskArtifact,
        policy: resolveStagePromptPolicy({ stageId: 'draft', taskType: taskArtifact.taskType }),
      });
    }
    throw new Error(`完成候補生成の対象外工程です: ${stageId}`);
  }

  function createAutomaticAiExecutor(dependencies) {
    const {
      apiRetryPolicy,
      responseRetryPolicy,
      runControl,
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
      structuredApiError,
      apiErrorAsException,
      generationFailureRequiresStop,
    } = dependencies;

    if (!apiRetryPolicy || !responseRetryPolicy || !runControl) throw new Error('AI自動実行の必須ポリシーを初期化できません。');

    return async function executeAiStep(taskRequest, session) {
      runControl.assertRunning(session);
      const playerId = String(taskRequest?.playerId ?? '');
      const taskType = String(taskRequest?.taskType ?? '');
      const slotId = String(taskRequest?.slotId ?? '');
      if (!playerId || !taskType) throw new Error('AIタスク要求に対象プレイヤーまたはタスク種別がありません。');
      const runtimeApi = runtime();
      if (!runtimeApi?.prepareAiTask || !runtimeApi?.runGenerationPipeline || !runtimeApi?.commitAiTaskFallback) {
        throw new Error('生成深度対応の正式runtime APIを利用できません。');
      }
      const ownerProfile = profileForPlayer(playerId);
      const plan = runtimeApi.resolveGenerationPlan({
        ownerProfile,
        profiles: controller.settings.profiles,
        taskType,
      });
      const deltaRequested = controller.settings.aiOptions?.publicHistoryMode === 'delta';
      await runControl.delayWithAbort(0, session);

      const taskArtifact = runtimeApi.prepareAiTask({
        playerId,
        taskType,
        slotId,
      });
      const forceFullPublicHistory = Boolean(taskArtifact.forceFullPublicHistory);
      const recoveryMode = responseRetryPolicy.normalizeRecoveryMode(controller.settings.aiOptions?.responseRecoveryMode);
      const responseRetryToastKey = `ai-response-retry:${playerId}`;
      runtimeApi.dismissToast?.(responseRetryToastKey);
      let taskApiCallCount = 0;
      let regenerationRecorded = false;
      let ollamaThinkingFallbackUsed = false;

      function addStageUsage(target, usage) {
        for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'costUsd']) {
          const value = Number(usage?.[key] ?? 0);
          target[key] += Number.isFinite(value) ? Math.max(0, value) : 0;
        }
      }

      function responseContractSystemInstruction(requestPurpose) {
        return ['generation-render', 'generation-proofread'].includes(requestPurpose)
          ? ''
          : String(taskArtifact.systemInstruction ?? '');
      }

      function rebuildStagePrompt(stageId) {
        return buildFullCandidateStagePrompt({
          stageId,
          taskArtifact,
          resolveStagePromptPolicy: runtimeApi.resolveGenerationStagePromptPolicy,
          buildDraftStagePrompt: runtimeApi.buildDraftStagePrompt,
        });
      }

      function validVoteTargetNames() {
        if (taskType !== 'vote') return [];
        const state = currentGameState();
        const validIds = new Set((taskArtifact.validTargetIds ?? []).map(String));
        const names = (state?.players ?? [])
          .filter((player) => validIds.has(String(player?.id ?? '')))
          .map((player) => String(player?.name ?? '').trim())
          .filter(Boolean);
        if (state?.game?.rules?.vote?.abstentionAllowed) names.push('棄権');
        return [...new Set(names)];
      }

      async function refreshTaskArtifact(stageId, { forceFullHistory = false } = {}) {
        runControl.assertRunning(session);
        if (forceFullHistory) runtimeApi.scheduleFullPublicHistory?.([playerId]);
        await runControl.delayWithAbort(0, session);
        const refreshedArtifact = runtimeApi.prepareAiTask({
          playerId,
          taskType,
          slotId,
          forceRefresh: true,
          forceFullPublicHistory: forceFullHistory,
        });
        replaceTaskArtifact(taskArtifact, refreshedArtifact);
        return rebuildStagePrompt(stageId);
      }

      function requestPromptEnvelope(prompt, requestPurpose) {
        const base = taskArtifact.promptEnvelope;
        if (!base || typeof base !== 'object') throw new Error('構造化プロンプトEnvelopeを利用できません。');
        const textPatchStage = ['generation-render', 'generation-proofread'].includes(requestPurpose);
        return {
          schemaVersion: 5,
          commonSystemInstruction: responseContractSystemInstruction(requestPurpose),
          commonGameContext: textPatchStage ? '' : String(base.commonGameContext ?? ''),
          taskInvariantContext: textPatchStage ? '' : String(base.taskInvariantContext ?? ''),
          taskVariableContext: textPatchStage ? '' : String(base.taskVariableContext ?? ''),
          stablePlayerContext: textPatchStage ? '' : String(base.stablePlayerContext ?? ''),
          dynamicTaskPrompt: String(prompt ?? ''),
          structuredOutput: textPatchStage ? null : (base.structuredOutput ? structuredClone(base.structuredOutput) : null),
          cacheIdentity: {
            ...(base.cacheIdentity ?? {}),
            promptFamily: textPatchStage ? 'text-patch' : String(base.cacheIdentity?.promptFamily ?? 'game-candidate'),
          },
        };
      }

      async function requestStageApi({
        stage,
        prompt,
        requestPurpose,
        generationStage = stage.stageId,
        callBudget,
        publicHistoryMode = taskArtifact.publicHistoryMode ?? 'full',
        onResync = null,
      }) {
        let attemptCount = 0;
        let apiRetryIndex = 0;
        const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: 0 };
        const issues = [];
        let currentPrompt = prompt;
        while (attemptCount < callBudget) {
          runControl.assertRunning(session);
          attemptCount += 1;
          const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const executorProfile = profileById(stage.executorProfileId);
          if (!executorProfile?.enabled) {
            const error = new Error(`工程担当AIプロファイルを利用できません: ${stage.executorProfileId}`);
            error.apiResponseUnavailable = true;
            throw error;
          }
          const dataNotice = global.AiWerewolfDataTransmissionNotice;
          const dataNoticeAccepted = await dataNotice?.ensureExternalDataNoticeForProfile?.(executorProfile);
          if (dataNoticeAccepted === false) {
            const error = new Error('外部LLMへのデータ送信を開始しませんでした。');
            error.apiResponseUnavailable = true;
            throw error;
          }
          setStatus(`${playerName(playerId)} / ${stage.stageId}（${attemptCount}/${callBudget}）`, 'working');
          const usageFlags = {
            isTaskCall: true,
            taskStart: taskApiCallCount === 0,
            regeneratedTask: requestPurpose === 'regenerate' && !regenerationRecorded,
          };
          taskApiCallCount += 1;
          if (usageFlags.regeneratedTask) regenerationRecorded = true;
          runControl.beginRequest(session, requestId);
          try {
            const response = await bridge.generate({
              requestId,
              profileId: executorProfile.id,
              promptEnvelope: requestPromptEnvelope(currentPrompt, requestPurpose),
              taskType,
              requestPurpose,
              generationStage,
              playerName: playerName(playerId),
              gameId: currentGameState()?.game?.id ?? '',
              retryIndex: attemptCount - 1,
              publicHistoryMode,
              thinkingLevelOverride: ollamaThinkingFallbackUsed ? 'none' : null,
              ...usageFlags,
            });
            runControl.assertRunning(session);
            if (response?.ok === false) throw apiErrorAsException(response.error ?? {});
            if (!response?.text) {
              throw apiErrorAsException({
                code: 'EMPTY_PROVIDER_RESPONSE',
                message: 'AIから応答本文を取得できませんでした。',
                retryable: false,
                deliveryUnknown: false,
              });
            }
            addUsage(controller.usage, response.usage, { retry: attemptCount > 1, ...usageFlags });
            addStageUsage(usage, response.usage);
            refreshUsageSummary().catch(() => {});
            return { ok: true, rawResponse: response.text, attemptCount, usage, issues, profile: response.profile };
          } catch (error) {
            runControl.assertRunning(session);
            addUsage(controller.usage, null, { failed: true, retry: attemptCount > 1, ...usageFlags });
            refreshUsageSummary().catch(() => {});
            const apiError = structuredApiError(error);
            issues.push({ code: apiError.code ?? 'API_ERROR', message: apiRetryPolicy.apiErrorMessage(apiError) });
            if (taskType === 'vote'
              && executorProfile.localServerPreset === 'ollama'
              && apiError.code === 'OLLAMA_THINKING_FINAL_RESPONSE_MISSING'
              && !ollamaThinkingFallbackUsed
              && attemptCount < callBudget) {
              ollamaThinkingFallbackUsed = true;
              issues.push({ code: 'OLLAMA_VOTE_THINKING_DISABLED', message: '投票の再試行だけThinkingを無効化しました。' });
              continue;
            }
            const decision = apiRetryPolicy.decideApiRetry({
              error: apiError,
              action: controller.settings.aiOptions?.apiErrorAction ?? 'retry',
              retryIndex: apiRetryIndex,
            });
            if (decision.type === 'stop' || attemptCount >= callBudget) {
              const exception = apiErrorAsException(apiError);
              exception.apiResponseUnavailable = true;
              exception.attemptCount = attemptCount;
              exception.usage = usage;
              exception.issues = issues;
              throw exception;
            }
            apiRetryIndex += 1;
            if (decision.delayMs > 0) await runControl.delayWithAbort(decision.delayMs, session);
            runControl.assertRunning(session);
            if (decision.type === 'full-history-retry') {
              if (typeof onResync !== 'function') {
                const exception = apiErrorAsException(apiError);
                exception.apiResponseUnavailable = true;
                exception.attemptCount = attemptCount;
                exception.usage = usage;
                exception.issues = issues;
                throw exception;
              }
              const refreshed = await onResync();
              runControl.assertRunning(session);
              currentPrompt = String(refreshed?.prompt ?? currentPrompt);
              publicHistoryMode = refreshed?.publicHistoryMode ?? 'full';
            }
          } finally {
            runControl.endRequest(session, requestId);
          }
        }
        const error = new Error('工程API呼び出し予算を使い切りました。');
        error.apiResponseUnavailable = true;
        throw error;
      }

      async function requestFullCandidate({ stage, prompt, callBudget }) {
        let phase = stage.stageId === 'draft' ? 'generation-draft' : 'normal';
        let basePrompt = prompt;
        let currentPrompt = basePrompt;
        let failedResponse = '';
        let validationIssues = [];
        let previousIssueSignature = '';
        let stateRefreshUsed = false;
        let totalAttempts = 0;
        const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: 0 };
        const stageIssues = [];
        while (totalAttempts < callBudget) {
          runControl.assertRunning(session);
          const initialCandidatePhase = phase === 'normal' || phase === 'generation-draft';
          const historyCapableStage = stage.stageId === 'direct' || stage.stageId === 'draft';
          let result;
          try {
            result = await requestStageApi({
              stage,
              prompt: currentPrompt,
              requestPurpose: phase,
              generationStage: ['repair', 'regenerate'].includes(phase) ? phase : stage.stageId,
              callBudget: callBudget - totalAttempts,
              publicHistoryMode: initialCandidatePhase && historyCapableStage ? taskArtifact.publicHistoryMode : 'full',
              onResync: initialCandidatePhase && historyCapableStage && deltaRequested
                ? async () => {
                  basePrompt = await refreshTaskArtifact(stage.stageId, { forceFullHistory: true });
                  currentPrompt = basePrompt;
                  return { prompt: basePrompt, publicHistoryMode: 'full' };
                }
                : null,
            });
          } catch (error) {
            const accumulatedUsage = { ...usage };
            addStageUsage(accumulatedUsage, error?.usage);
            error.rawResponse = String(error?.rawResponse ?? failedResponse ?? '');
            error.evaluation = error?.evaluation
              ?? runtimeApi.evaluateAiTaskCandidate({ taskArtifact, rawResponse: error.rawResponse });
            error.attemptCount = totalAttempts + Math.max(0, Number(error?.attemptCount ?? 0));
            error.usage = accumulatedUsage;
            error.issues = [
              ...stageIssues,
              ...(error?.issues ?? []),
              ...(error.evaluation?.issues ?? []),
            ];
            throw error;
          }
          runControl.assertRunning(session);
          totalAttempts += result.attemptCount;
          addStageUsage(usage, result.usage);
          stageIssues.push(...result.issues);
          const evaluation = runtimeApi.evaluateAiTaskCandidate({ taskArtifact, rawResponse: result.rawResponse });
          const repairIssues = (evaluation.autoRepair?.operations ?? []).map((item) => ({
            code: `AUTO_REPAIR_${String(item.code ?? 'APPLIED')}`,
            message: String(item.message ?? 'AI応答を決定的に自動補正しました。'),
          }));
          if (evaluation.ok) {
            return {
              ok: true,
              rawResponse: evaluation.effectiveRawResponse ?? result.rawResponse,
              sourceRawResponse: result.rawResponse,
              evaluation,
              attemptCount: totalAttempts,
              usage,
              issues: stageIssues,
            };
          }
          const commitResult = {
            ok: false,
            message: evaluation.validation?.errors?.join('\n') ?? 'AI応答が不正です。',
            issues: evaluation.issues,
          };
          const decision = responseRetryPolicy.decideNext({
            recoveryMode,
            phase: phase === 'normal' || phase === 'generation-draft' ? 'normal' : phase,
            commitResult,
            stateRefreshUsed,
            previousIssueSignature,
          });
          if (decision.action === 'stop' || totalAttempts >= callBudget) {
            return {
              ok: false,
              rawResponse: evaluation.effectiveRawResponse ?? result.rawResponse,
              sourceRawResponse: result.rawResponse,
              evaluation,
              attemptCount: totalAttempts,
              usage,
              issues: [...stageIssues, ...repairIssues, ...evaluation.issues],
            };
          }
          previousIssueSignature = decision.signature;
          validationIssues = decision.issues;
          failedResponse = evaluation.effectiveRawResponse ?? result.rawResponse;
          if (decision.action === 'regenerate-prompt') {
            const refreshWithFullHistory = Boolean(forceFullPublicHistory || deltaRequested);
            basePrompt = await refreshTaskArtifact(stage.stageId, {
              forceFullHistory: refreshWithFullHistory,
            });
            currentPrompt = basePrompt;
            phase = stage.stageId === 'draft' ? 'generation-draft' : 'normal';
            stateRefreshUsed = true;
            continue;
          }
          if (decision.action === 'repair') {
            phase = 'repair';
            currentPrompt = responseRetryPolicy.buildRepairPrompt({
              originalPrompt: basePrompt,
              failedResponse,
              issues: validationIssues,
              taskType,
              validTargetNames: validVoteTargetNames(),
            });
          } else {
            phase = 'regenerate';
            currentPrompt = responseRetryPolicy.buildRegenerationPrompt({
              originalPrompt: basePrompt,
              issues: validationIssues,
              taskType,
              validTargetNames: validVoteTargetNames(),
            });
          }
          runtimeApi.toast?.(`${playerName(playerId)}の${stage.stageId}候補を${responseRetryPolicy.phaseLabel(phase)}します。`, 'warning', {
            key: responseRetryToastKey,
            forceDisplay: true,
            durationMs: 0,
            source: 'ai-response-retry',
          });
        }
        return { ok: false, rawResponse: failedResponse, attemptCount: totalAttempts, usage, issues: stageIssues };
      }

      async function requestTextPatch({ stage, prompt, callBudget }) {
        const requestPurpose = stage.stageId === 'render' ? 'generation-render' : 'generation-proofread';
        return requestStageApi({
          stage,
          prompt,
          requestPurpose,
          callBudget,
          publicHistoryMode: 'full',
        });
      }

      const beforeRevision = Number(currentGameState()?.revision ?? 0);
      let pipelineResult = null;
      let commitResult = null;
      let automaticFallbackUsed = false;
      try {
        pipelineResult = await runtimeApi.runGenerationPipeline({
          plan,
          taskArtifact,
          requestFullCandidate,
          requestTextPatch,
          evaluateCandidate: (rawResponse) => runtimeApi.evaluateAiTaskCandidate({ taskArtifact, rawResponse }),
          resolveStagePromptPolicy: runtimeApi.resolveGenerationStagePromptPolicy,
          buildDraftPrompt: runtimeApi.buildDraftStagePrompt,
          buildRenderPrompt: runtimeApi.buildRenderStagePrompt,
          buildProofreadPrompt: runtimeApi.buildProofreadStagePrompt,
        });
        runControl.assertRunning(session);
        commitResult = runtimeApi.commitAiTaskCandidate({
          taskArtifact,
          rawResponse: pipelineResult.rawResponse,
          evaluation: pipelineResult.evaluation,
          generationRun: pipelineResult.generationRun,
          interactive: false,
          autoConfirmWarnings: controller.settings.autoRun.autoConfirmWarnings,
        });
        if (!commitResult?.ok) {
          const error = new Error(commitResult?.message || 'AI応答を登録できませんでした。');
          error.rawResponse = pipelineResult.rawResponse;
          error.evaluation = pipelineResult.evaluation;
          error.generationRun = pipelineResult.generationRun;
          error.issues = commitResult?.issues ?? [];
          throw error;
        }
      } catch (error) {
        if (runControl.isStopped(session)) runControl.assertRunning(session);
        if (error?.apiResponseUnavailable === true || generationFailureRequiresStop?.(error, pipelineResult)) throw error;
        const fallbackRawResponse = String(error?.rawResponse ?? pipelineResult?.rawResponse ?? '');
        const fallbackEvaluation = error?.evaluation
          ?? pipelineResult?.evaluation
          ?? runtimeApi.evaluateAiTaskCandidate({ taskArtifact, rawResponse: fallbackRawResponse });
        const fallbackReason = `AI生成失敗: ${String(error?.message ?? error ?? '原因不明')}`;
        runControl.assertRunning(session);
        commitResult = runtimeApi.commitAiTaskFallback({
          taskArtifact,
          rawResponse: fallbackRawResponse,
          evaluation: fallbackEvaluation,
          generationRun: error?.generationRun ?? pipelineResult?.generationRun ?? null,
          reason: fallbackReason,
        });
        if (!commitResult?.ok) {
          const fallbackError = new Error(`AI自動代替にも失敗しました。${commitResult?.message ? ` ${commitResult.message}` : ''}`);
          fallbackError.cause = error;
          fallbackError.issues = commitResult?.issues ?? [];
          throw fallbackError;
        }
        automaticFallbackUsed = true;
      }
      const afterRevision = Number(currentGameState()?.revision ?? beforeRevision);
      if (afterRevision === beforeRevision) {
        throw new Error(automaticFallbackUsed
          ? 'AI自動代替の登録成功後にゲーム状態が更新されませんでした。'
          : 'AI応答の登録成功後にゲーム状態が更新されませんでした。');
      }
      runControl.assertRunning(session);

      runtimeApi.dismissToast?.(responseRetryToastKey);
      if (automaticFallbackUsed) {
        const scopeLabel = commitResult?.fallbackScope === 'field' ? '必須項目だけを代替' : '現在タスクを代替';
        setStatus(`${playerName(playerId)}の${taskType}は${scopeLabel}して進行しました。`, 'working');
      } else {
        setStatus(`${playerName(playerId)}の${taskType}を深度${plan.depth}で登録しました。`, 'working');
      }
    };
  }

  global.AiWerewolfAutomaticAiExecutor = Object.freeze({
    createAutomaticAiExecutor,
    replaceTaskArtifact,
    buildFullCandidateStagePrompt,
  });
})(globalThis);

// bundle側のside-effect ES Moduleとして到達させ、HTMLのscript順序へ依存しない。
export {};
