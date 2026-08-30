/**
 * 責務: 生成計画に従い、既存の直接生成、判断、客観分析、批判的検証、最終回答、キャラクター発言化を実行し、最終候補と工程監査情報を返す。
 * 変更ルール: ゲーム状態を直接更新せず、API通信は注入関数へ委譲する。decide/finalizeだけが完成候補JSONを生成し、analyze/critiqueは自由記述を一時参照情報として保持する。renderはgenerationTextPatchServiceを唯一の適用入口とし、確定済みのゲーム判断を変更しない。analyze/critique失敗は後続候補生成を妨げず監査へ記録し、analyze失敗時はcritiqueを省略する。完成候補の検証不合格は失敗生回答を複製せず、失敗試行の段階・issueコード・カテゴリ・パスだけをrejectedAttemptsへ保持する。自由記述の元回答は監査へ保持し、後続参照だけgenerationIntermediateTextPolicyの安全上限へ制限する。将来工程の最低1呼び出しを予約し、前段再試行が後段を枯渇させない。
 */

import { validateAndMergeGenerationTextPatch } from './generationTextPatchService.js';
import { autoRepairIssues } from '../prompts/response/responseAutoRepair.js';
import { intermediateReferenceTruncationIssue, limitGenerationIntermediateReference } from '../prompts/stages/generationIntermediateTextPolicy.js';

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

function normalizeRejectedAttempts(attempts) {
  return (Array.isArray(attempts) ? attempts : []).map((attempt) => {
    const issues = (Array.isArray(attempt?.issues) ? attempt.issues : []).map((issue) => ({
      code: String(issue?.code ?? 'VALIDATION_ERROR'),
      category: String(issue?.category ?? 'validation'),
      path: String(issue?.path ?? ''),
    }));
    return {
      attempt: Math.max(1, Math.trunc(Number(attempt?.attempt ?? 1))),
      phase: String(attempt?.phase ?? 'normal'),
      issueCodes: [...new Set((attempt?.issueCodes ?? issues.map((issue) => issue.code)).map(String).filter(Boolean))],
      issues,
    };
  });
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
    rejectedAttempts: normalizeRejectedAttempts(values.rejectedAttempts),
    usage: normalizeUsage(values.usage),
  };
}

function sumUsage(stages) {
  return stages.reduce((total, stage) => {
    for (const key of Object.keys(ZERO_USAGE)) total[key] += Number(stage.usage?.[key] ?? 0);
    return total;
  }, { ...ZERO_USAGE });
}

function generationRunSnapshot(plan, stages, totalCallCount, finalStageId) {
  return {
    schemaVersion: 2,
    executionMode: 'automatic',
    depth: plan.depth,
    ownerProfileId: plan.ownerProfileId,
    taskCategory: plan.taskCategory,
    normalCallCount: plan.normalCallCount,
    totalCallCount,
    finalStageId,
    stages,
  };
}



async function runDirectGeneration({
  plan,
  taskArtifact,
  requestFullCandidate,
  evaluateCandidate,
}) {
  const stages = [];
  let totalCallCount = 0;
  let currentRawResponse = '';
  let currentEvaluation = null;
  let finalStageId = null;
  const configuredBudget = Number(plan.maximumCallBudget ?? plan.coreCallBudget);
  const maximumCallBudget = Number.isInteger(configuredBudget) && configuredBudget >= 1
    ? configuredBudget
    : Math.max(1, Number(plan.normalCallCount ?? plan.stages?.length ?? 1));
  const remainingCallBudget = () => Math.max(0, maximumCallBudget - totalCallCount);
  const addAttemptCount = (value) => { totalCallCount += Math.max(0, Number(value ?? 0)); };

  const stage = plan.stages[0];
  if (remainingCallBudget() <= 0) throw new Error('最初の有効候補を作る前にAI呼び出し予算を使い切りました。');
  const prompt = String(taskArtifact.promptEnvelope?.dynamicTaskPrompt ?? taskArtifact.text ?? '');
  let response;
  try {
    response = await requestFullCandidate({
      stage,
      prompt,
      taskArtifact,
      callBudget: remainingCallBudget(),
      candidateObject: null,
    });
  } catch (cause) {
    const attemptCount = Number(cause?.attemptCount ?? 0);
    addAttemptCount(attemptCount);
    const rawResponse = String(cause?.rawResponse ?? '');
    const evaluation = cause?.evaluation ?? evaluateCandidate(rawResponse);
    const failedStage = stageAudit(stage, {
      status: 'fallback',
      attemptCount,
      rawResponse,
      fallbackUsed: true,
      issues: cause?.issues ?? [{ code: 'STAGE_API_ERROR', message: cause?.message ?? String(cause) }],
      rejectedAttempts: cause?.rejectedAttempts,
      usage: cause?.usage,
    });
    const error = cause instanceof Error ? cause : new Error(String(cause ?? 'AI生成APIでエラーが発生しました。'));
    error.stageId = stage.stageId;
    error.rawResponse = rawResponse;
    error.evaluation = evaluation;
    error.issues = normalizeIssues(cause?.issues ?? evaluation?.issues ?? [{ code: 'STAGE_API_ERROR', message: error.message }]);
    error.totalCallCount = totalCallCount;
    error.generationRun = generationRunSnapshot(plan, [...stages, failedStage], totalCallCount, finalStageId ?? stage.stageId);
    throw error;
  }
  addAttemptCount(response?.attemptCount);
  const evaluation = response?.evaluation ?? evaluateCandidate(response?.rawResponse ?? '');
  if (!response?.ok || !evaluation?.ok) {
    const failedStage = stageAudit(stage, {
      status: 'fallback',
      attemptCount: response?.attemptCount,
      rawResponse: response?.sourceRawResponse ?? response?.rawResponse,
      fallbackUsed: true,
      issues: response?.issues ?? evaluation?.issues,
      rejectedAttempts: response?.rejectedAttempts,
      usage: response?.usage,
    });
    const error = new Error(response?.message || evaluation?.issues?.map((item) => item.message).join('\n') || `${stage.stageId}工程で有効候補を取得できませんでした。`);
    error.stageId = stage.stageId;
    error.rawResponse = String(response?.rawResponse ?? '');
    error.evaluation = evaluation;
    error.issues = normalizeIssues(response?.issues ?? evaluation?.issues);
    error.totalCallCount = totalCallCount;
    error.generationRun = generationRunSnapshot(plan, [...stages, failedStage], totalCallCount, stage.stageId);
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
    rejectedAttempts: response.rejectedAttempts,
    usage: response.usage,
  }));

  const generationRun = generationRunSnapshot(plan, stages, totalCallCount, finalStageId);
  return {
    ok: true,
    rawResponse: currentRawResponse,
    evaluation: currentEvaluation,
    generationRun,
    usage: sumUsage(stages),
  };
}

function minimumFutureCalls(plan, stageIndex) {
  return (plan.stages ?? []).slice(stageIndex + 1).length;
}

function candidatePrompt({ stageId, taskArtifact, analysisText, critiqueText, resolveStagePromptPolicy, buildDecidePrompt, buildFinalizePrompt }) {
  const policy = resolveStagePromptPolicy({ stageId, taskType: taskArtifact.taskType });
  if (stageId === 'decide') return buildDecidePrompt({ taskArtifact, policy });
  if (stageId === 'finalize') return buildFinalizePrompt({ taskArtifact, policy, analysisText, critiqueText });
  throw new RangeError(`完成候補生成の対象外です: ${stageId}`);
}

export async function runGenerationPipeline({
  plan,
  taskArtifact,
  requestFullCandidate,
  requestFreeText,
  requestTextPatch,
  evaluateCandidate,
  resolveStagePromptPolicy,
  buildDecidePrompt,
  buildAnalyzePrompt,
  buildCritiquePrompt,
  buildFinalizePrompt,
  buildRenderPrompt,
}) {
  if (plan?.stages?.length === 1 && plan.stages[0]?.stageId === 'direct') {
    return runDirectGeneration({ plan, taskArtifact, requestFullCandidate, evaluateCandidate });
  }
  const stages = [];
  let totalCallCount = 0;
  let currentRawResponse = '';
  let currentEvaluation = null;
  let finalStageId = null;
  let analysisText = '';
  let critiqueText = '';
  const configuredBudget = Number(plan.maximumCallBudget ?? plan.coreCallBudget);
  const maximumCallBudget = Number.isInteger(configuredBudget) && configuredBudget >= 1
    ? configuredBudget
    : Math.max(1, Number(plan.normalCallCount ?? plan.stages?.length ?? 1));

  const remainingCallBudget = () => Math.max(0, maximumCallBudget - totalCallCount);
  const addAttemptCount = (value) => { totalCallCount += Math.max(0, Number(value ?? 0)); };

  for (let stageIndex = 0; stageIndex < plan.stages.length; stageIndex += 1) {
    const stage = plan.stages[stageIndex];
    const reservedFutureCalls = minimumFutureCalls(plan, stageIndex);
    const availableForStage = Math.max(0, remainingCallBudget() - reservedFutureCalls);

    if (stage.stageId === 'analyze' || stage.stageId === 'critique') {
      if (stage.stageId === 'critique' && !analysisText.trim()) {
        stages.push(stageAudit(stage, {
          status: 'skipped',
          skipReason: 'ANALYSIS_UNAVAILABLE',
          fallbackUsed: false,
          issues: [{ code: 'ANALYSIS_UNAVAILABLE', message: '客観分析を取得できなかったため、批判的検証を省略しました。' }],
          usage: ZERO_USAGE,
        }));
        continue;
      }
      if (availableForStage <= 0) {
        stages.push(stageAudit(stage, {
          status: 'fallback',
          fallbackUsed: true,
          issues: [{ code: 'CALL_BUDGET_RESERVED', message: '後続の必須AI呼び出しを予約するため、この分析呼び出しを省略しました。' }],
          usage: ZERO_USAGE,
        }));
        continue;
      }
      const policy = resolveStagePromptPolicy({ stageId: stage.stageId, taskType: taskArtifact.taskType });
      const prompt = stage.stageId === 'analyze'
        ? buildAnalyzePrompt({ taskArtifact, policy })
        : buildCritiquePrompt({ taskArtifact, policy, analysisText });
      try {
        const response = await requestFreeText({
          stage,
          prompt,
          taskArtifact,
          callBudget: 1,
          analysisText,
        });
        addAttemptCount(response?.attemptCount);
        const rawResponse = String(response?.rawResponse ?? '').trim();
        if (!response?.ok || !rawResponse) {
          stages.push(stageAudit(stage, {
            status: 'fallback',
            attemptCount: response?.attemptCount,
            rawResponse: response?.rawResponse,
            fallbackUsed: true,
            issues: response?.issues?.length ? response.issues : [{ code: 'EMPTY_ANALYSIS_RESPONSE', message: '分析回答を取得できませんでした。' }],
            usage: response?.usage,
          }));
          continue;
        }
        const limited = limitGenerationIntermediateReference(stage.stageId, rawResponse);
        if (stage.stageId === 'analyze') analysisText = limited.text;
        else critiqueText = limited.text;
        const truncationIssue = intermediateReferenceTruncationIssue(stage.stageId, limited);
        stages.push(stageAudit(stage, {
          status: 'accepted',
          attemptCount: response?.attemptCount,
          rawResponse: response?.rawResponse,
          issues: [...(response?.issues ?? []), ...(truncationIssue ? [truncationIssue] : [])],
          usage: response?.usage,
        }));
      } catch (cause) {
        const attemptCount = Number(cause?.attemptCount ?? 0);
        addAttemptCount(attemptCount);
        stages.push(stageAudit(stage, {
          status: 'fallback',
          attemptCount,
          rawResponse: cause?.rawResponse,
          fallbackUsed: true,
          issues: cause?.issues ?? [{ code: 'STAGE_API_ERROR', message: cause?.message ?? String(cause) }],
          usage: cause?.usage,
        }));
      }
      continue;
    }

    if (['decide', 'finalize'].includes(stage.stageId)) {
      const callBudget = Math.max(0, remainingCallBudget() - reservedFutureCalls);
      if (callBudget <= 0) {
        const error = new Error('完成候補を作るためのAI呼び出し予算がありません。');
        error.stageId = stage.stageId;
        error.totalCallCount = totalCallCount;
        error.generationRun = generationRunSnapshot(plan, stages, totalCallCount, finalStageId ?? stage.stageId);
        throw error;
      }
      const prompt = candidatePrompt({
        stageId: stage.stageId,
        taskArtifact,
        analysisText,
        critiqueText,
        resolveStagePromptPolicy,
        buildDecidePrompt,
        buildFinalizePrompt,
      });
      let response;
      try {
        response = await requestFullCandidate({
          stage,
          prompt,
          taskArtifact,
          callBudget,
          analysisText,
          critiqueText,
        });
      } catch (cause) {
        const attemptCount = Number(cause?.attemptCount ?? 0);
        addAttemptCount(attemptCount);
        const rawResponse = String(cause?.rawResponse ?? '');
        const evaluation = cause?.evaluation ?? evaluateCandidate(rawResponse);
        const failedStage = stageAudit(stage, {
          status: 'fallback',
          attemptCount,
          rawResponse,
          fallbackUsed: true,
          issues: cause?.issues ?? [{ code: 'STAGE_API_ERROR', message: cause?.message ?? String(cause) }],
          rejectedAttempts: cause?.rejectedAttempts,
          usage: cause?.usage,
        });
        const error = cause instanceof Error ? cause : new Error(String(cause ?? 'AI生成APIでエラーが発生しました。'));
        error.stageId = stage.stageId;
        error.rawResponse = rawResponse;
        error.evaluation = evaluation;
        error.issues = normalizeIssues(cause?.issues ?? evaluation?.issues ?? [{ code: 'STAGE_API_ERROR', message: error.message }]);
        error.totalCallCount = totalCallCount;
        error.generationRun = generationRunSnapshot(plan, [...stages, failedStage], totalCallCount, finalStageId ?? stage.stageId);
        throw error;
      }
      addAttemptCount(response?.attemptCount);
      const evaluation = response?.evaluation ?? evaluateCandidate(response?.rawResponse ?? '');
      if (!response?.ok || !evaluation?.ok) {
        const failedStage = stageAudit(stage, {
          status: 'fallback',
          attemptCount: response?.attemptCount,
          rawResponse: response?.sourceRawResponse ?? response?.rawResponse,
          fallbackUsed: true,
          issues: response?.issues ?? evaluation?.issues,
          rejectedAttempts: response?.rejectedAttempts,
          usage: response?.usage,
        });
        const error = new Error(response?.message || evaluation?.issues?.map((item) => item.message).join('\n') || `${stage.stageId}で有効候補を取得できませんでした。`);
        error.stageId = stage.stageId;
        error.rawResponse = String(response?.rawResponse ?? '');
        error.evaluation = evaluation;
        error.issues = normalizeIssues(response?.issues ?? evaluation?.issues);
        error.totalCallCount = totalCallCount;
        error.generationRun = generationRunSnapshot(plan, [...stages, failedStage], totalCallCount, stage.stageId);
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
        rejectedAttempts: response.rejectedAttempts,
        usage: response.usage,
      }));
      continue;
    }

    if (stage.stageId !== 'render') throw new RangeError(`未対応の生成段階です: ${stage.stageId}`);
    const policy = resolveStagePromptPolicy({
      stageId: 'render',
      taskType: taskArtifact.taskType,
      candidateObject: currentEvaluation?.candidateObject,
      presentTopLevelKeys: currentEvaluation?.presentTopLevelKeys,
    });
    if (!policy.applicable) {
      stages.push(stageAudit(stage, { status: 'skipped', skipReason: 'NO_APPLICABLE_TEXT_FIELD', usage: ZERO_USAGE }));
      continue;
    }
    if (remainingCallBudget() <= 0) {
      stages.push(stageAudit(stage, {
        status: 'fallback',
        targetTextFields: policy.targetTextFields,
        fallbackUsed: true,
        issues: [{ code: 'CALL_BUDGET_EXHAUSTED', message: 'キャラクター発言化のAI呼び出し予算を確保できませんでした。' }],
        usage: ZERO_USAGE,
      }));
      continue;
    }
    const prompt = buildRenderPrompt({ taskArtifact, candidateObject: currentEvaluation.candidateObject, policy });
    let response;
    try {
      response = await requestTextPatch({ stage, prompt, policy, taskArtifact, callBudget: remainingCallBudget() });
    } catch (cause) {
      const attemptCount = Number(cause?.attemptCount ?? 0);
      if (cause?.apiResponseUnavailable === true) {
        addAttemptCount(attemptCount);
        const failedStage = stageAudit(stage, {
          status: 'fallback', attemptCount, targetTextFields: policy.targetTextFields, rawResponse: cause?.rawResponse, fallbackUsed: true,
          issues: cause?.issues ?? [{ code: 'STAGE_API_ERROR', message: cause?.message ?? String(cause) }], usage: cause?.usage,
        });
        const error = cause instanceof Error ? cause : new Error(String(cause ?? 'AI生成APIでエラーが発生しました。'));
        error.apiResponseUnavailable = true;
        error.stageId = stage.stageId;
        error.issues = normalizeIssues(cause?.issues ?? [{ code: 'STAGE_API_ERROR', message: error.message }]);
        error.totalCallCount = totalCallCount;
        error.generationRun = generationRunSnapshot(plan, [...stages, failedStage], totalCallCount, finalStageId ?? stage.stageId);
        throw error;
      }
      response = { ok: false, attemptCount, rawResponse: String(cause?.rawResponse ?? ''), issues: cause?.issues ?? [{ code: 'STAGE_API_ERROR', message: cause?.message ?? String(cause) }], usage: cause?.usage };
    }
    addAttemptCount(response?.attemptCount);
    const patchResult = response?.ok
      ? validateAndMergeGenerationTextPatch({ stageId: 'render', candidateObject: currentEvaluation.candidateObject, targetTextFields: policy.targetTextFields, rawResponse: response.rawResponse })
      : { ok: false, candidateObject: currentEvaluation.candidateObject, issues: response?.issues ?? [] };
    if (!response?.ok || !patchResult.ok) {
      stages.push(stageAudit(stage, {
        status: 'fallback', attemptCount: response?.attemptCount, targetTextFields: policy.targetTextFields, rawResponse: response?.rawResponse, fallbackUsed: true,
        issues: response?.issues?.length ? response.issues : patchResult.issues, usage: response?.usage,
      }));
      continue;
    }
    const mergedRawResponse = JSON.stringify(patchResult.candidateObject);
    const mergedEvaluation = evaluateCandidate(mergedRawResponse);
    if (!mergedEvaluation.ok) {
      stages.push(stageAudit(stage, {
        status: 'fallback', attemptCount: response.attemptCount, targetTextFields: policy.targetTextFields, rawResponse: response.rawResponse, fallbackUsed: true,
        issues: mergedEvaluation.issues?.length ? mergedEvaluation.issues : [{ code: 'MERGED_CANDIDATE_INVALID', message: '発言化適用後の候補が現行検証を通過しませんでした。' }],
        usage: response.usage,
      }));
      continue;
    }
    currentRawResponse = String(mergedEvaluation.effectiveRawResponse ?? mergedRawResponse);
    currentEvaluation = mergedEvaluation;
    finalStageId = stage.stageId;
    stages.push(stageAudit(stage, {
      status: 'applied', attemptCount: response.attemptCount, targetTextFields: policy.targetTextFields, rawResponse: response.rawResponse,
      issues: [...(response.issues ?? []), ...autoRepairIssues(mergedEvaluation.autoRepair)], usage: response.usage,
    }));
  }

  if (!currentEvaluation?.ok) throw new Error('生成パイプラインで有効な最終候補を取得できませんでした。');
  const generationRun = generationRunSnapshot(plan, stages, totalCallCount, finalStageId);
  return { ok: true, rawResponse: currentRawResponse, evaluation: currentEvaluation, generationRun, usage: sumUsage(stages) };
}
