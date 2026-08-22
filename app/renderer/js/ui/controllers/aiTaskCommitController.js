/**
 * 責務: AI候補の検証、正常項目保持、必須項目代替、正式runtime登録を所有する。
 * 変更ルール: ゲーム規則を独自実装せず、store・AI入力キャッシュ・プロンプト状態・正式runtime実行等の必要依存だけを使用する。各runtime登録にはそのタスク契約が所有する項目だけを渡し、共通生成情報から無関係な項目を流入させない。通常発言は検証済みpublicSpeechを登録し、AI生成失敗時の自動代替だけを発言フォールバックとして扱う。投票・襲撃の対象代替は選択戦略と対象をoverride監査情報へ必ず記録する。AppUI全体へ依存せず、処理本体をFacadeへ戻さない。
 */

// @ts-check

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';
import { shouldCompleteFullPublicHistorySync } from '../../domain/game/aiTurnRegistrationPolicy.js';
import { recordGraveyardMessage, recordMasonMessage, recordNightAction, recordWolfAttackVote, recordWolfMessage } from '../../domain/night/nightCommands.js';
import { recordAiDiscussionOpeningPreference, recordAiPriorityAnswer, recordAiSpeech, recordAiSpeechPass, skipAiPriorityAnswer } from '../../domain/discussion/discussionCommands.js';
import { recordVote } from '../../domain/vote/voteCommands.js';
import { recordAiTestament, skipTestament } from '../../domain/execution/testamentCommands.js';
import { recordResultImpression, skipResultImpression } from '../../domain/result/resultCommands.js';
import { consolidatePlayerInternalMemory, skipAiMemoConsolidation } from '../../domain/memory/memoryCommands.js';
import { evaluateAiTaskCandidate as evaluateAiTaskCandidateService } from '../../services/aiTaskService.js';
import { buildRequiredFieldFallbackCandidate } from '../../services/aiTaskFallbackService.js';
import { parseAiResponse } from '../../prompts/response/responseParser.js';
import { autoRepairIssues } from '../../prompts/response/responseAutoRepair.js';
import { getRoleName } from '../../state/selectors.js';
import { isPersonalNightAction } from './uiStateFormatters.js';
import { ZERO_GENERATION_USAGE } from '../ai/manualGenerationController.js';
import { confirmAppDialog } from './appDialogController.js';

const domainCommands = /** @type {any} */ ({
  recordGraveyardMessage,
  recordMasonMessage,
  recordNightAction,
  recordWolfAttackVote,
  recordWolfMessage,
  recordAiDiscussionOpeningPreference,
  recordAiPriorityAnswer,
  recordAiSpeech,
  recordAiSpeechPass,
  skipAiPriorityAnswer,
  recordVote,
  recordAiTestament,
  skipTestament,
  recordResultImpression,
  skipResultImpression,
  consolidatePlayerInternalMemory,
  skipAiMemoConsolidation,
});
export function createAiTaskCommitController({
  store,
  toast,
  drafts,
  promptCache,
  promptKey,
  freshPromptState,
  showValidation,
  manualPlan,
  manualDirectGenerationRun,
  runEngine,
  clearSpeechMetadata,
  completeFullPublicHistorySync,
}) {
  if (!store || typeof store.getState !== 'function') throw new TypeError('状態Storeがありません。');
  if (typeof toast !== 'function') throw new TypeError('通知関数がありません。');
  if (!(drafts instanceof Map) || !(promptCache instanceof Map)) throw new TypeError('AI入力キャッシュがありません。');
  if (typeof promptKey !== 'function' || typeof freshPromptState !== 'function') throw new TypeError('AIプロンプト状態関数がありません。');
  if (typeof showValidation !== 'function') throw new TypeError('検証表示関数がありません。');
  if (typeof manualPlan !== 'function' || typeof manualDirectGenerationRun !== 'function') throw new TypeError('手動生成情報関数がありません。');
  if (typeof runEngine !== 'function') throw new TypeError('ゲームエンジン実行関数がありません。');
  if (typeof clearSpeechMetadata !== 'function') throw new TypeError('発言メタデータ初期化関数がありません。');
  if (typeof completeFullPublicHistorySync !== 'function') throw new TypeError('公開履歴同期完了関数がありません。');

  function _dispatchAiCommitResult({ playerId, taskType, slotId = '', ok, message = '', issues = [] }) {
      const detail = {
        playerId: String(playerId ?? ''),
        taskType: String(taskType ?? ''),
        slotId: String(slotId ?? ''),
        ok: Boolean(ok),
        message: String(message ?? ''),
        issues: Array.isArray(issues) ? structuredClone(issues) : [],
      };
      window.dispatchEvent(new CustomEvent('ai-werewolf-ai-commit-result', { detail }));
      return detail;
    }

  async function _commitAiSafely(button) {
      try {
        return await _commitAi(button);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? 'AI応答の登録中に予期しないエラーが発生しました。');
        toast(message, 'error');
        _dispatchAiCommitResult({
          playerId: button.dataset.playerId,
          taskType: button.dataset.taskType,
          slotId: button.dataset.slotId ?? '',
          ok: false,
          message,
          issues: [{ code: 'INTERNAL_UI_ERROR', category: 'internal', path: '', message }],
        });
        return { ok: false, message };
      }
    }

  function _automaticFallbackGenerationRun(taskArtifact, rawResponse, reason, fallbackFields = [], sourceRun = null) {
      const plan = manualPlan(taskArtifact.playerId, taskArtifact.taskType);
      const stage = plan?.stages?.find((item) => ['direct', 'draft'].includes(item.stageId))
        ?? { stageId: 'direct', executorProfileId: '' };
      const sourceStages = Array.isArray(sourceRun?.stages) ? sourceRun.stages : [];
      const attemptCount = sourceStages.reduce((total, item) => total + Math.max(0, Number(item?.attemptCount ?? 0)), 0);
      const usage = sourceStages.reduce((total, item) => {
        Object.keys(total).forEach((key) => { total[key] += Math.max(0, Number(item?.usage?.[key] ?? 0)); });
        return total;
      }, { ...ZERO_GENERATION_USAGE });
      const fallbackSummary = fallbackFields.length
        ? fallbackFields.map((item) => `${item.key}:${item.strategy}`).join(', ')
        : 'row-fallback';
      return {
        schemaVersion: 1,
        executionMode: 'automatic',
        depth: plan?.depth ?? 1,
        ownerProfileId: String(plan?.ownerProfileId ?? ''),
        taskCategory: String(plan?.taskCategory ?? taskArtifact.taskType ?? 'automatic-fallback'),
        normalCallCount: Number(plan?.normalCallCount ?? 1),
        totalCallCount: attemptCount,
        finalStageId: stage.stageId,
        stages: [{
          stageId: stage.stageId,
          executorProfileId: String(stage.executorProfileId ?? ''),
          status: 'accepted',
          attemptCount,
          targetTextFields: [],
          skipReason: null,
          rawResponse: String(rawResponse ?? ''),
          fallbackUsed: false,
          issues: [{
            code: fallbackFields.length ? 'REQUIRED_FIELD_FALLBACK_APPLIED' : 'ROW_FALLBACK_APPLIED',
            message: `${String(reason ?? 'AI生成失敗')} / ${fallbackSummary}`,
          }],
          usage,
        }],
      };
    }

  /** @param {any} input */
  function commitAiTaskFallback(input = {}) {
      let {
        taskArtifact,
        rawResponse = '',
        evaluation = null,
        generationRun = null,
        reason = 'AI回答を正常に取得できなかったため自動代替',
      } = input;
      if (!taskArtifact) return { ok: false, message: 'AIタスク成果物がありません。', issues: [] };
      const state = store.getState();
      evaluation = evaluateAiTaskCandidateService(state, taskArtifact, rawResponse);
      const fallbackCandidate = buildRequiredFieldFallbackCandidate(state, taskArtifact, evaluation);
      if (fallbackCandidate.ok) {
        const fallbackRun = _automaticFallbackGenerationRun(
          taskArtifact,
          evaluation.originalRawResponse ?? rawResponse,
          reason,
          fallbackCandidate.fallbackFields,
          generationRun,
        );
        const actionFallback = ['vote', 'wolf-attack'].includes(taskArtifact.taskType)
          ? fallbackCandidate.fallbackFields.find((field) => field.key === 'actionAnswer')
          : null;
        const committed = commitAiTaskCandidate({
          taskArtifact,
          rawResponse: fallbackCandidate.rawResponse,
          generationRun: fallbackRun,
          interactive: false,
          autoConfirmWarnings: true,
          override: actionFallback ? {
            applied: true,
            type: actionFallback.strategy === 'random-valid-target' ? 'random-fallback' : 'decision-state-fallback',
            selectedBy: 'system',
            reason: String(reason ?? '').trim() || 'AI回答を正常に取得できないため既存判断から対象を確定',
            candidateIds: [...taskArtifact.validTargetIds],
            selectedTargetId: actionFallback.targetId,
          } : null,
        });
        return {
          ...committed,
          fallbackUsed: Boolean(committed?.ok),
          fallbackScope: 'field',
          fallbackFields: fallbackCandidate.fallbackFields,
        };
      }
  
      const { playerId, taskType, slotId = '' } = taskArtifact;
      const parsed = evaluation?.parsed ?? parseAiResponse(rawResponse, taskArtifact.mode)?.value ?? {};
      const validation = evaluation?.validation ?? {};
      const fallbackRun = _automaticFallbackGenerationRun(
        taskArtifact,
        evaluation?.originalRawResponse ?? rawResponse,
        reason,
        [],
        generationRun,
      );
      const fallbackWarning = `自動代替: ${String(reason ?? '').trim() || 'AI生成失敗'}`;
      const common = {
        playerId,
        rawResponse: String(evaluation?.effectiveRawResponse ?? rawResponse ?? ''),
        promptText: taskArtifact.text,
        promptFingerprint: taskArtifact.fingerprint,
        promptMode: taskArtifact.promptMode,
        publicSequenceAtGeneration: taskArtifact.publicSequenceAtGeneration,
        resolvedInternalReasoningDirective: taskArtifact.internalReasoningDirective ?? null,
        heartVoice: parsed?.heartVoice ?? '',
        internalMemoUpdate: parsed?.internalMemoUpdate ?? null,
        parsedDecisionUpdate: parsed?.decisionUpdate ?? null,
        decisionUpdate: validation?.resolvedDecisionUpdate ?? null,
        parsedFactionStrategyPatch: parsed?.factionStrategyPatch ?? null,
        factionStrategyPatch: validation?.resolvedFactionStrategyState ?? null,
        warnings: [...(validation?.warnings ?? []), fallbackWarning],
        generationRun: fallbackRun,
      };
      let command = null;
      let options = {};
      if (isNormalSpeechTask(taskType)) {
        command = (draft) => domainCommands.recordAiSpeechPass(draft, { ...common, aiTaskType: taskType, discussionPreference: taskType === 'speech-free' ? 'NORMAL' : null });
        options = { publicBarrier: true };
      } else if (taskType === 'discussion-opening-preference') {
        command = (draft) => domainCommands.recordAiDiscussionOpeningPreference(draft, {
          playerId,
          preference: 'NORMAL',
          rawResponse: common.rawResponse,
          promptText: common.promptText,
          promptFingerprint: common.promptFingerprint,
          promptMode: common.promptMode,
          publicSequenceAtGeneration: common.publicSequenceAtGeneration,
          warnings: common.warnings,
          generationRun: fallbackRun,
          resolvedInternalReasoningDirective: taskArtifact.internalReasoningDirective ?? null,
        });
      } else if (taskType === 'priority-answer') {
        command = (draft) => domainCommands.skipAiPriorityAnswer(draft, {
          playerId,
          questionEventId: slotId,
          reason,
          parsedAbilityClaims: null,
          ...common,
        });
      } else if (taskType === 'testament') {
        command = (draft) => domainCommands.skipTestament(draft, { ...common, reason });
      } else if (taskType === 'result-impression') {
        command = (draft) => domainCommands.skipResultImpression(draft, {
          playerId,
          reason,
          heartVoice: parsed?.heartVoice ?? '',
          rawResponse: common.rawResponse,
          promptText: common.promptText,
          promptFingerprint: common.promptFingerprint,
          promptMode: common.promptMode,
          publicSequenceAtGeneration: common.publicSequenceAtGeneration,
          warnings: common.warnings,
          generationRun: fallbackRun,
        });
        options = { publicBarrier: true };
      } else if (taskType === 'memo-consolidate') {
        command = (draft) => domainCommands.skipAiMemoConsolidation(draft, {
          playerId,
          reason,
          rawResponse: common.rawResponse,
          promptText: common.promptText,
          promptFingerprint: common.promptFingerprint,
          promptMode: common.promptMode,
          publicSequenceAtGeneration: common.publicSequenceAtGeneration,
          warnings: common.warnings,
          generationRun: fallbackRun,
        });
      } else {
        return {
          ok: false,
          message: `必須項目の自動代替に対応していないAIタスクです: ${taskType}`,
          issues: [{ code: 'UNSUPPORTED_ROW_FALLBACK', category: 'internal', path: 'taskType', message: `未対応タスク: ${taskType}` }],
        };
      }
  
      const key = promptKey(state, taskType, playerId, slotId);
      const response = runEngine(`AI ${taskType}自動代替`, command, options);
      if (response?.ok) {
        promptCache.delete(key);
        drafts.delete(`ai-response:${key}`);
        if (isNormalSpeechTask(taskType)) clearSpeechMetadata(playerId);
      }
      return {
        ...response,
        fallbackUsed: Boolean(response?.ok),
        fallbackScope: 'row',
        fallbackFields: fallbackCandidate.fallbackFields ?? [],
        issues: response?.ok ? [] : [{ code: 'ENGINE_FALLBACK_ERROR', category: 'internal', path: '', message: response?.message ?? 'AI自動代替を登録できませんでした。' }],
        warnings: common.warnings,
      };
    }

  /** @param {any} input */
  function commitAiTaskCandidate(input = {}) {
      let {
        taskArtifact,
        rawResponse,
        evaluation = null,
        generationRun = null,
        interactive = true,
        autoConfirmWarnings = false,
        override = null,
      } = input;
      if (!taskArtifact) return { ok: false, message: 'AIタスク成果物がありません。', issues: [] };
      const state = store.getState();
      const currentEvaluation = evaluation ?? evaluateAiTaskCandidateService(state, taskArtifact, rawResponse);
      if (!currentEvaluation.ok) {
        if (interactive) showValidation(currentEvaluation.validation.errors, currentEvaluation.warnings);
        return {
          ok: false,
          message: currentEvaluation.validation.errors.join('\n') || 'AI応答を登録できませんでした。',
          issues: currentEvaluation.issues,
          warnings: currentEvaluation.warnings,
        };
      }
      evaluation = currentEvaluation;
      const originalRawResponse = String(rawResponse ?? '');
      rawResponse = evaluation.effectiveRawResponse ?? originalRawResponse;
      if (evaluation.warnings.length && !interactive && !autoConfirmWarnings) {
        return { ok: false, message: '警告を含むAI応答の自動登録は許可されていません。', issues: [{ code: 'WARNING_CONFIRMATION_REQUIRED', category: 'warning', path: '', message: evaluation.warnings.join('\n') }] };
      }
  
      const { playerId, taskType, slotId = '' } = taskArtifact;
      generationRun = generationRun ?? manualDirectGenerationRun(taskArtifact, originalRawResponse, evaluation);
      if (generationRun && evaluation.autoRepair?.accepted) {
        const repairIssues = autoRepairIssues(evaluation.autoRepair);
        const finalStage = [...(generationRun.stages ?? [])].reverse().find((stage) => stage.stageId === generationRun.finalStageId);
        if (finalStage && repairIssues.length && !(finalStage.issues ?? []).some((issue) => String(issue.code ?? '').startsWith('AUTO_REPAIR_'))) {
          finalStage.issues = [...(finalStage.issues ?? []), ...repairIssues];
        }
      }
      const parsed = evaluation.parsed;
      const validation = evaluation.validation;

  
      const common = {
        rawResponse: String(rawResponse ?? ''),
        promptText: taskArtifact.text,
        promptFingerprint: taskArtifact.fingerprint,
        promptMode: taskArtifact.promptMode,
        publicSequenceAtGeneration: taskArtifact.publicSequenceAtGeneration,
        resolvedInternalReasoningDirective: taskArtifact.internalReasoningDirective ?? null,
        heartVoice: parsed.heartVoice,
        internalMemoUpdate: parsed.internalMemoUpdate,
        selectionRationale: parsed.selectionRationale,
        parsedAttackAssessment: parsed.attackAssessment,
        resolvedAttackAssessment: validation.resolvedAttackAssessment,
        estimatedWerewolfIds: validation.resolvedFreezeEstimates?.estimatedWerewolfIds ?? [],
        predictedAttackTargetIds: validation.resolvedFreezeEstimates?.predictedAttackTargetIds ?? [],
        parsedFactionStrategyPatch: parsed.factionStrategyPatch,
        factionStrategyPatch: validation.resolvedFactionStrategyState,
        warnings: validation.warnings,
        generationRun,
        override,
      };
      let command;
      let options = {};
      if (taskType === 'discussion-opening-preference') {
        command = (draft) => domainCommands.recordAiDiscussionOpeningPreference(draft, {
          playerId,
          preference: validation.resolvedOpeningPreference || 'NORMAL',
          rawResponse: String(rawResponse ?? ''),
          promptText: taskArtifact.text,
          promptFingerprint: taskArtifact.fingerprint,
          promptMode: taskArtifact.promptMode,
          publicSequenceAtGeneration: taskArtifact.publicSequenceAtGeneration,
          warnings: validation.warnings,
          generationRun,
          resolvedInternalReasoningDirective: taskArtifact.internalReasoningDirective ?? null,
        });
      } else if (taskType === 'result-impression') {
        command = (draft) => domainCommands.recordResultImpression(draft, {
          playerId,
          content: parsed.publicSpeech,
          heartVoice: parsed.heartVoice,
          rawResponse: String(rawResponse ?? ''),
          promptText: taskArtifact.text,
          promptFingerprint: taskArtifact.fingerprint,
          promptMode: taskArtifact.promptMode,
          publicSequenceAtGeneration: taskArtifact.publicSequenceAtGeneration,
          warnings: validation.warnings,
          generationRun,
        });
        options = { publicBarrier: true };
      } else if (taskType === 'priority-answer') {
        command = (draft) => domainCommands.recordAiPriorityAnswer(draft, {
          playerId,
          questionEventId: slotId,
          content: parsed.publicSpeech,
          heartVoice: parsed.heartVoice,
          internalMemoUpdate: parsed.internalMemoUpdate,
          rawResponse: String(rawResponse ?? ''),
          promptText: taskArtifact.text,
          promptFingerprint: taskArtifact.fingerprint,
          promptMode: taskArtifact.promptMode,
          publicSequenceAtGeneration: taskArtifact.publicSequenceAtGeneration,
          resolvedInternalReasoningDirective: taskArtifact.internalReasoningDirective ?? null,
          coOperation: parsed.coOperation,
          parsedAbilityClaims: validation.normalizedParsedAbilityClaims,
          abilityClaims: validation.resolvedAbilityClaims,
          parsedDecisionUpdate: parsed.decisionUpdate,
          decisionUpdate: validation.resolvedDecisionUpdate,
          parsedFactionStrategyPatch: parsed.factionStrategyPatch,
          factionStrategyPatch: validation.resolvedFactionStrategyState,
          warnings: validation.warnings,
          generationRun,
        });
        options = { publicBarrier: true };
      } else if (taskType === 'testament') {
        command = (draft) => domainCommands.recordAiTestament(draft, {
          playerId,
          content: parsed.publicSpeech,
          coOperation: parsed.coOperation,
          parsedAbilityClaims: validation.normalizedParsedAbilityClaims,
          abilityClaims: validation.resolvedAbilityClaims,
          ...common,
        });
        options = { publicBarrier: true };
      } else if (isNormalSpeechTask(taskType)) {
        const speechInput = {
          playerId,
          rawResponse: common.rawResponse,
          promptText: common.promptText,
          promptFingerprint: common.promptFingerprint,
          promptMode: common.promptMode,
          publicSequenceAtGeneration: common.publicSequenceAtGeneration,
          resolvedInternalReasoningDirective: common.resolvedInternalReasoningDirective,
          heartVoice: common.heartVoice,
          internalMemoUpdate: common.internalMemoUpdate,
          parsedDecisionUpdate: parsed.decisionUpdate,
          decisionUpdate: validation.resolvedDecisionUpdate,
          parsedFactionStrategyPatch: common.parsedFactionStrategyPatch,
          factionStrategyPatch: common.factionStrategyPatch,
          warnings: common.warnings,
          generationRun: common.generationRun,
          aiTaskType: taskType,
          nextSpeakerPreference: taskType === 'speech-designated' ? validation.resolvedNextSpeakerPreferenceId : null,
          discussionPreference: taskType === 'speech-free' ? validation.resolvedDiscussionPreference : null,
        };
        command = (draft) => domainCommands.recordAiSpeech(draft, {
          ...speechInput,
          content: parsed.publicSpeech,
          parsedSpeechInteraction: parsed.speechInteraction,
          speechInteraction: validation.resolvedSpeechInteraction,
          coOperation: parsed.coOperation,
          parsedAbilityClaims: validation.normalizedParsedAbilityClaims,
          abilityClaims: validation.resolvedAbilityClaims,
        });
        options = { publicBarrier: true };
      } else if (taskType === 'vote') {
        command = (draft) => domainCommands.recordVote(draft, {
          voterId: playerId,
          targetId: validation.resolvedAction.id,
          parsedDecisionUpdate: parsed.decisionUpdate,
          decisionUpdate: validation.resolvedDecisionUpdate,
          ...common,
        });
        if (state.game.rules.vote.visibilityDuringInput === 'public') options = { publicBarrier: true };
      } else if (isPersonalNightAction(taskType)) {
        command = (draft) => domainCommands.recordNightAction(draft, { slotId, actorId: playerId, targetId: validation.resolvedAction.id, ...common });
      } else if (taskType === 'wolf-attack') {
        command = (draft) => domainCommands.recordWolfAttackVote(draft, { actorId: playerId, targetId: validation.resolvedAction.id, ...common });
      } else if (taskType === 'mason-conversation') {
        command = (draft) => domainCommands.recordMasonMessage(draft, { speakerId: playerId, content: parsed.masonMessage, parsedDecisionUpdate: parsed.decisionUpdate, decisionUpdate: validation.resolvedDecisionUpdate, ...common });
      } else if (taskType === 'graveyard-conversation') {
        command = (draft) => domainCommands.recordGraveyardMessage(draft, { speakerId: playerId, content: parsed.graveyardMessage, ...common });
      } else if (taskType === 'wolf-conversation') {
        command = (draft) => domainCommands.recordWolfMessage(draft, { speakerId: playerId, content: parsed.wolfMessage, sharedStrategyPatch: parsed.sharedStrategyPatch, ...common });
      } else if (taskType === 'memo-consolidate') {
        command = (draft) => domainCommands.consolidatePlayerInternalMemory(draft, {
          playerId,
          summary: parsed.fullMemo,
          rawResponse: String(rawResponse ?? ''),
          promptText: taskArtifact.text,
          promptFingerprint: taskArtifact.fingerprint,
          promptMode: taskArtifact.promptMode,
          publicSequenceAtGeneration: taskArtifact.publicSequenceAtGeneration,
          warnings: validation.warnings,
          generationRun,
        });
      } else {
        return { ok: false, message: '未対応のAIタスクです。', issues: [{ code: 'UNSUPPORTED_TASK', category: 'internal', path: 'taskType', message: '未対応のAIタスクです。' }] };
      }
  
      const key = promptKey(state, taskType, playerId, slotId);
      const completesFullHistorySync = shouldCompleteFullPublicHistorySync(taskArtifact, generationRun);
      const response = runEngine(`AI ${taskType}登録`, command, options);
      if (response?.ok) {
        promptCache.delete(key);
        drafts.delete(`ai-response:${key}`);
        if (isNormalSpeechTask(taskType)) clearSpeechMetadata(playerId);
        if (completesFullHistorySync) completeFullPublicHistorySync(playerId);
      }
      return {
        ...response,
        issues: response?.ok ? [] : [{ code: 'ENGINE_COMMIT_ERROR', category: 'internal', path: '', message: response?.message ?? 'AI応答を登録できませんでした。' }],
        warnings: validation.warnings,
      };
    }

  async function _commitAi(button) {
      const state = store.getState();
      const { playerId, taskType } = button.dataset;
      const slotId = button.dataset.slotId ?? '';
      const report = (result) => {
        _dispatchAiCommitResult({ playerId, taskType, slotId, ok: Boolean(result?.ok), message: result?.message ?? '', issues: result?.issues ?? [] });
        return result;
      };
      const { key, cache, current, error } = freshPromptState(state, playerId, taskType, slotId);
      if (error) {
        toast(error.message, 'error');
        return report({ ok: false, message: error.message, issues: [{ code: 'PROMPT_BUILD_ERROR', category: 'internal', path: '', message: error.message }] });
      }
      if (!cache || !current) {
        const message = '先に最新プロンプトを生成してください。';
        toast(message, 'error');
        return report({ ok: false, message, issues: [{ code: 'STALE_PROMPT', category: 'state', path: '', message }] });
      }
      const rawResponse = drafts.get(`ai-response:${key}`) ?? '';
      const evaluation = evaluateAiTaskCandidateService(state, cache, rawResponse);
      if (!evaluation.ok) {
        showValidation(evaluation.validation.errors, evaluation.warnings);
        return report({
          ok: false,
          message: evaluation.validation.errors.join('\n') || 'AI応答を登録できませんでした。',
          issues: evaluation.issues,
          warnings: evaluation.warnings,
        });
      }
      if (evaluation.warnings.length) {
        const accepted = await confirmAppDialog({
          title: 'AI応答の警告確認',
          message: `警告があります。登録しますか？\n\n${evaluation.warnings.join('\n')}`,
          confirmLabel: '登録',
        });
        if (!accepted) return report({ ok: false, message: 'AI応答の警告確認がキャンセルされました。', issues: [{ code: 'USER_CANCELLED', category: 'user-action', path: '', message: 'AI応答の警告確認がキャンセルされました。' }] });
      }
      const parsed = evaluation.parsed;
      if ((isNormalSpeechTask(taskType) || ['priority-answer', 'testament'].includes(taskType)) && parsed.coOperation && parsed.coOperation.action !== 'none') {
        const roleLabel = parsed.coOperation.action === 'withdraw'
          ? '現在のCOを撤回'
          : `${getRoleName(parsed.coOperation.roleId)}を${parsed.coOperation.action === 'declare' ? '新規CO' : 'CO変更'}`;
        const accepted = await confirmAppDialog({
          title: 'AIのCO操作確認',
          message: `AIが次のCO操作を指定しています。\n\n${roleLabel}\n\n公開発言と一緒に登録しますか？`,
          confirmLabel: '一緒に登録',
        });
        if (!accepted) return report({ ok: false, message: 'AIのCO操作確認がキャンセルされました。', issues: [{ code: 'USER_CANCELLED', category: 'user-action', path: 'coOperation', message: 'AIのCO操作確認がキャンセルされました。' }] });
      }
      return report(commitAiTaskCandidate({ taskArtifact: cache, rawResponse, evaluation, interactive: false, autoConfirmWarnings: true }));
    }

  return Object.freeze({
    _dispatchAiCommitResult,
    _commitAiSafely,
    _automaticFallbackGenerationRun,
    commitAiTaskFallback,
    commitAiTaskCandidate,
    _commitAi,
  });
}
