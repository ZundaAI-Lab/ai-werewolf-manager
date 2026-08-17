/**
 * 責務: 生成計画と工程プロンプトポリシーに従い、直接生成・構造草案・発言化・校正を順番に実行し、最終候補と工程監査情報を返す。深度3と4は同じ構造草案・発言化経路を通り、深度4だけが校正を後置する。構造草案は公開履歴送信方式に従い、ゲームstateから導出した現在状態と本人正式履歴を使用する。初回候補取得失敗時は、項目単位回収と自動代替へ渡す生回答・評価・失敗工程監査を例外へ付与する。API回答本文未取得時は後段工程でも停止用例外を維持して呼出元へ返す。
 * 変更ルール: ゲーム状態を直接更新せず、各工程のAPI通信は注入関数へ委譲する。発言化・校正のtextPatch解析・キー検証・文章連続性検証・mergeはgenerationTextPatchServiceを唯一の適用入口とし、手動経路と受理条件を分岐させない。適用不能工程は送信せず、API回答本文を取得した発言化・校正の構造不正・文章乖離・境界違反では直前の有効候補へ決定的にフォールバックする。通信・認証・空応答等でAPI回答本文を取得できなかった例外はフォールバックへ変換しない。直接生成・構造草案の失敗候補を破棄せず、呼出元が正常項目を回収できる形で返す。差分公開履歴の継続性は本サービスで推測せず、呼出元が最新stateからEnvelopeを再構築する。
 */

import { validateAndMergeGenerationTextPatch } from './generationTextPatchService.js';
import { autoRepairIssues } from '../prompts/response/responseAutoRepair.js';

const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 });

function normalizeUsage(usage) {
  return Object.fromEntries(Object.keys(ZERO_USAGE).map((key) => {
    const value = Number(usage?.[key] ?? 0);
    return [key, Number.isFinite(value) ? Math.max(0, value) : 0];
  }));
}

function normalizeIssues(issues) {
  return (Array.isArray(issues) ? issues : []).map((item) => ({
    code: String(item?.code ?? 'GENERATION_STAGE_ERROR'),
    message: String(item?.message ?? item ?? '生成工程でエラーが発生しました。'),
  }));
}

function stageAudit(stage, values = {}) {
  return {
    stageId: stage.stageId,
    executorProfileId: String(stage.executorProfileId ?? ''),
    status: values.status,
    attemptCount: Number(values.attemptCount ?? 0),
    targetTextFields: [...(values.targetTextFields ?? [])],
    skipReason: values.skipReason ?? null,
    rawResponse: String(values.rawResponse ?? ''),
    fallbackUsed: Boolean(values.fallbackUsed),
    issues: normalizeIssues(values.issues),
    usage: normalizeUsage(values.usage),
  };
}

function sumUsage(stages) {
  return stages.reduce((total, stage) => {
    for (const key of Object.keys(ZERO_USAGE)) total[key] += Number(stage.usage?.[key] ?? 0);
    return total;
  }, { ...ZERO_USAGE });
}

export async function runGenerationPipeline({
  plan,
  taskArtifact,
  requestFullCandidate,
  requestTextPatch,
  evaluateCandidate,
  resolveStagePromptPolicy,
  buildDraftPrompt,
  buildRenderPrompt,
  buildProofreadPrompt,
}) {
  const stages = [];
  let totalCallCount = 0;
  let currentRawResponse = '';
  let currentEvaluation = null;
  let finalStageId = null;
  let coreCallCount = 0;
  const hasProofreadStage = plan.stages.some((stage) => stage.stageId === 'proofread');
  const configuredCoreBudget = Number(plan.coreCallBudget);
  const coreCallBudget = Number.isInteger(configuredCoreBudget) && configuredCoreBudget >= 1
    ? configuredCoreBudget
    : Math.max(1, Number(plan.maximumCallBudget ?? 1) - (hasProofreadStage ? 1 : 0));

  function remainingCallBudget(stageId) {
    return stageId === 'proofread'
      ? Math.max(0, Number(plan.maximumCallBudget ?? 0) - totalCallCount)
      : Math.max(0, coreCallBudget - coreCallCount);
  }

  function addAttemptCount(stageId, value) {
    const count = Math.max(0, Number(value ?? 0));
    totalCallCount += count;
    if (stageId !== 'proofread') coreCallCount += count;
  }

  for (const stage of plan.stages) {
    if (stage.stageId === 'direct' || stage.stageId === 'draft') {
      const prompt = stage.stageId === 'direct'
        ? taskArtifact.text
        : buildDraftPrompt({
          taskArtifact,
          policy: resolveStagePromptPolicy({ stageId: 'draft', taskType: taskArtifact.taskType }),
        });
      let response;
      try {
        response = await requestFullCandidate({ stage, prompt, taskArtifact, callBudget: remainingCallBudget(stage.stageId) });
      } catch (cause) {
        const rawResponse = String(cause?.rawResponse ?? '');
        const evaluation = cause?.evaluation ?? evaluateCandidate(rawResponse);
        const attemptCount = Number(cause?.attemptCount ?? 0);
        addAttemptCount(stage.stageId, attemptCount);
        const failedStage = stageAudit(stage, {
          status: 'fallback',
          attemptCount,
          rawResponse,
          fallbackUsed: true,
          issues: cause?.issues ?? [{ code: 'STAGE_API_ERROR', message: cause?.message ?? String(cause) }],
          usage: cause?.usage,
        });
        const error = cause instanceof Error ? cause : new Error(String(cause ?? 'AI生成APIでエラーが発生しました。'));
        error.stageId = stage.stageId;
        error.rawResponse = rawResponse;
        error.evaluation = evaluation;
        error.issues = normalizeIssues(cause?.issues ?? evaluation?.issues ?? [{ code: 'STAGE_API_ERROR', message: error.message }]);
        error.totalCallCount = totalCallCount;
        error.generationRun = {
          schemaVersion: 1,
          executionMode: 'automatic',
          depth: plan.depth,
          ownerProfileId: plan.ownerProfileId,
          taskCategory: plan.taskCategory,
          normalCallCount: plan.normalCallCount,
          totalCallCount,
          finalStageId: stage.stageId,
          stages: [...stages, failedStage],
        };
        throw error;
      }
      addAttemptCount(stage.stageId, response?.attemptCount);
      const evaluation = response?.evaluation ?? evaluateCandidate(response?.rawResponse ?? '');
      if (!response?.ok || !evaluation?.ok) {
        const failedStage = stageAudit(stage, {
          status: 'fallback',
          attemptCount: response?.attemptCount,
          rawResponse: response?.sourceRawResponse ?? response?.rawResponse,
          fallbackUsed: true,
          issues: response?.issues ?? evaluation?.issues,
          usage: response?.usage,
        });
        const error = new Error(response?.message || evaluation?.issues?.map((item) => item.message).join('\n') || `${stage.stageId}工程で有効候補を取得できませんでした。`);
        error.stageId = stage.stageId;
        error.rawResponse = String(response?.rawResponse ?? '');
        error.evaluation = evaluation;
        error.issues = normalizeIssues(response?.issues ?? evaluation?.issues);
        error.totalCallCount = totalCallCount;
        error.generationRun = {
          schemaVersion: 1,
          executionMode: 'automatic',
          depth: plan.depth,
          ownerProfileId: plan.ownerProfileId,
          taskCategory: plan.taskCategory,
          normalCallCount: plan.normalCallCount,
          totalCallCount,
          finalStageId: stage.stageId,
          stages: [...stages, failedStage],
        };
        throw error;
      }
      currentRawResponse = String(evaluation.effectiveRawResponse ?? response.rawResponse ?? '');
      currentEvaluation = evaluation;
      finalStageId = stage.stageId;
      stages.push(stageAudit(stage, {
        status: 'accepted',
        attemptCount: response.attemptCount,
        rawResponse: response.sourceRawResponse ?? response.rawResponse,
        issues: [...(response.issues ?? []), ...autoRepairIssues(evaluation.autoRepair)],
        usage: response.usage,
      }));
      continue;
    }

    const policy = resolveStagePromptPolicy({
      stageId: stage.stageId,
      taskType: taskArtifact.taskType,
      candidateObject: currentEvaluation.candidateObject,
      presentTopLevelKeys: currentEvaluation.presentTopLevelKeys,
    });
    if (!policy.applicable) {
      stages.push(stageAudit(stage, {
        status: 'skipped',
        attemptCount: 0,
        targetTextFields: [],
        skipReason: 'NO_APPLICABLE_TEXT_FIELD',
        rawResponse: '',
        fallbackUsed: false,
        issues: [],
        usage: ZERO_USAGE,
      }));
      continue;
    }
    if (remainingCallBudget(stage.stageId) <= 0) {
      stages.push(stageAudit(stage, {
        status: 'fallback',
        attemptCount: 0,
        targetTextFields: policy.targetTextFields,
        rawResponse: '',
        fallbackUsed: true,
        issues: [{ code: 'CALL_BUDGET_EXHAUSTED', message: '生成パイプラインの共通AI呼び出し予算を使い切りました。' }],
        usage: ZERO_USAGE,
      }));
      continue;
    }
    const prompt = stage.stageId === 'render'
      ? buildRenderPrompt({ taskArtifact, candidateObject: currentEvaluation.candidateObject, policy })
      : buildProofreadPrompt({ taskArtifact, candidateObject: currentEvaluation.candidateObject, policy });
    let response;
    try {
      response = await requestTextPatch({ stage, prompt, policy, taskArtifact, callBudget: remainingCallBudget(stage.stageId) });
    } catch (cause) {
      const attemptCount = Number(cause?.attemptCount ?? 0);
      if (cause?.apiResponseUnavailable === true) {
        addAttemptCount(stage.stageId, attemptCount);
        const rawResponse = String(cause?.rawResponse ?? '');
        const failedStage = stageAudit(stage, {
          status: 'fallback',
          attemptCount,
          targetTextFields: policy.targetTextFields,
          rawResponse,
          fallbackUsed: true,
          issues: cause?.issues ?? [{ code: 'STAGE_API_ERROR', message: cause?.message ?? String(cause) }],
          usage: cause?.usage,
        });
        const error = cause instanceof Error ? cause : new Error(String(cause ?? 'AI生成APIでエラーが発生しました。'));
        error.apiResponseUnavailable = true;
        error.stageId = stage.stageId;
        error.rawResponse = rawResponse;
        error.issues = normalizeIssues(cause?.issues ?? [{ code: 'STAGE_API_ERROR', message: error.message }]);
        error.totalCallCount = totalCallCount;
        error.generationRun = {
          schemaVersion: 1,
          executionMode: 'automatic',
          depth: plan.depth,
          ownerProfileId: plan.ownerProfileId,
          taskCategory: plan.taskCategory,
          normalCallCount: plan.normalCallCount,
          totalCallCount,
          finalStageId: finalStageId ?? stage.stageId,
          stages: [...stages, failedStage],
        };
        throw error;
      }
      response = { ok: false, attemptCount, rawResponse: String(cause?.rawResponse ?? ''), issues: cause?.issues ?? [{ code: 'STAGE_API_ERROR', message: cause?.message ?? String(cause) }], usage: cause?.usage };
    }
    addAttemptCount(stage.stageId, response?.attemptCount);
    const patchResult = response?.ok
      ? validateAndMergeGenerationTextPatch({
        stageId: stage.stageId,
        candidateObject: currentEvaluation.candidateObject,
        targetTextFields: policy.targetTextFields,
        rawResponse: response.rawResponse,
      })
      : { ok: false, candidateObject: currentEvaluation.candidateObject, issues: response?.issues ?? [] };
    if (!response?.ok || !patchResult.ok) {
      stages.push(stageAudit(stage, {
        status: 'fallback',
        attemptCount: response?.attemptCount,
        targetTextFields: policy.targetTextFields,
        rawResponse: response?.rawResponse,
        fallbackUsed: true,
        issues: response?.issues?.length ? response.issues : patchResult.issues,
        usage: response?.usage,
      }));
      continue;
    }
    const mergedRawResponse = JSON.stringify(patchResult.candidateObject);
    const mergedEvaluation = evaluateCandidate(mergedRawResponse);
    if (!mergedEvaluation.ok) {
      stages.push(stageAudit(stage, {
        status: 'fallback',
        attemptCount: response.attemptCount,
        targetTextFields: policy.targetTextFields,
        rawResponse: response.rawResponse,
        fallbackUsed: true,
        issues: mergedEvaluation.issues?.length
          ? mergedEvaluation.issues
          : [{ code: 'MERGED_CANDIDATE_INVALID', message: 'textPatch適用後の候補が現行検証を通過しませんでした。' }],
        usage: response.usage,
      }));
      continue;
    }
    currentRawResponse = String(mergedEvaluation.effectiveRawResponse ?? mergedRawResponse);
    currentEvaluation = mergedEvaluation;
    finalStageId = stage.stageId;
    stages.push(stageAudit(stage, {
      status: 'applied',
      attemptCount: response.attemptCount,
      targetTextFields: policy.targetTextFields,
      rawResponse: response.rawResponse,
      fallbackUsed: false,
      issues: [...(response.issues ?? []), ...autoRepairIssues(mergedEvaluation.autoRepair)],
      usage: response.usage,
    }));
  }

  const generationRun = {
    schemaVersion: 1,
    executionMode: 'automatic',
    depth: plan.depth,
    ownerProfileId: plan.ownerProfileId,
    taskCategory: plan.taskCategory,
    normalCallCount: plan.normalCallCount,
    totalCallCount,
    finalStageId,
    stages,
  };
  return {
    ok: true,
    rawResponse: currentRawResponse,
    evaluation: currentEvaluation,
    generationRun,
    usage: sumUsage(stages),
  };
}
