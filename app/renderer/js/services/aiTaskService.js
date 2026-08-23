/**
 * 責務: AIタスクの本番プロンプト、固定共通システム指示、候補回答の項目単位回収・決定的自動補正・解析・検証、文章流用境界検査、生成工程用の完全機械契約例をUIと自動実行へ共通提供する。
 * 変更ルール: ゲーム状態を更新せず、DOM、API通信、設定保存を行わない。画面へ表示するフェーズ契約を生成工程用完全契約へ置き換えない。手動送信用テキストはAPI送信と同じ常時システム契約を先頭へ結合し、通常プロンプトへ固定原則を重複掲載しない。正常なAI生成項目を保持し、単純な任意項目の不正だけを未入力化する。speechInteractionは公開本文とは独立した補助制御として利用不能部分を監査付きで破棄できるが、判断・陣営戦略など意味を持つ構造化項目は原則として黙って破棄しない。投票では有効なactionAnswerを優先し、不正な任意項目だけを監査操作付きで未入力化する。必須項目は本サービスで創作・代替せず、補正後も既存responseParser・responseValidatorと文字列境界検査を必ず再実行する。
 */

import { isPersonalNightActionTask } from '../config/personalNightActionTasks.js';
import { buildClaimRolePolicy } from '../domain/claims/claimRolePolicy.js';
import { resolveSnowWomanEstimateLimit } from '../domain/night/snowWomanEstimatePolicy.js';
import { resolveWolfPartnerDispositionPolicy } from '../domain/game/wolfPartnerDispositionPolicy.js';
import {
  getAttackCandidates,
  getNightActionCandidates,
  getVoteCandidates,
} from '../domain/game/standardRules.js';
import { buildPromptContext } from '../prompts/promptBuilder.js';
import {
  buildResponseConditionalExamples,
  buildResponseContractExample,
  getRequiredResponseTopLevelKeys,
  getResponseModeForTask,
  getRoleCompatibleResponseTopLevelKeys,
} from '../prompts/response/responseContract.js';
import { parseAiResponse } from '../prompts/response/responseParser.js';
import { validateAiResponse } from '../prompts/response/responseValidator.js';
import { discardInvalidOptionalResponseFields, repairAiResponseCandidate } from '../prompts/response/responseAutoRepair.js';
import { buildGenerationStageSource } from '../prompts/context/generationStageSource.js';
import { buildResponseExampleReferences } from '../prompts/response/responseExampleReferences.js';
import { validateGeneratedTextBoundary } from '../prompts/stages/generationTextBoundary.js';

const FIELD_DESCRIPTIONS = Object.freeze({
  publicSpeech: '公開表示へそのまま保存する完成文章',
  speechInteraction: '質問先と回答参照の構造化記録',
  coOperation: 'CO操作の構造化記録',
  abilityClaims: '公開能力結果の構造化記録',
  decisionPatch: '本人の現在判断の変更分',
  factionStrategy: '本人限定の陣営戦略更新',
  heartVoice: '本人限定の心の声',
  memoAdd: '本人限定の内部メモ追記',
  actionAnswer: '確定する行動回答',
  rationale: '結果判明前の具体的な選択理由',
  attackAssessment: '襲撃候補比較の構造化記録',
  estimate: '雪女本人の人狼候補・襲撃先推定',
  wolfMessage: '人狼仲間だけに見せる秘密会話',
  sharedStrategy: '人狼共有戦略更新',
  masonMessage: '共有者間だけに見せる秘密会話',
  graveyardMessage: '死亡者間だけに見せる墓場会話',
  fullMemo: '整理後の本人限定内部メモ全文',
  nextSpeakerPreference: '指名制で次に前倒ししたい未発言者',
  discussionPreference: '発言希望制の次巡発言希望',
  openingPreference: '発言希望制1巡目の発言順希望',
});


export function composeManualAiPrompt({ systemInstruction = '', text = '' } = {}) {
  const instruction = String(systemInstruction ?? '').trim();
  const prompt = String(text ?? '').trim();
  if (!instruction) return prompt;
  if (!prompt) return instruction;
  return `${instruction}

---

${prompt}`;
}

export function resolveAiTaskValidTargetIds(state, taskType, playerId) {
  if (taskType === 'vote') {
    return getVoteCandidates(state, playerId, state.voteSession?.candidateIds ?? []).map((player) => player.id);
  }
  if (isPersonalNightActionTask(taskType)) {
    return getNightActionCandidates(state, taskType, playerId).map((player) => player.id);
  }
  if (['wolf-conversation', 'wolf-attack'].includes(taskType)) {
    return getAttackCandidates(state).map((player) => player.id);
  }
  return [];
}

function responseContractForArtifact(state, context, taskType, validTargetIds) {
  const mode = getResponseModeForTask(taskType);
  const requiredTopLevelKeys = getRequiredResponseTopLevelKeys(mode);
  const roleId = context?.player?.roleId ?? '';
  const exampleReferences = buildResponseExampleReferences(state, context);
  const partnerDispositionPolicy = resolveWolfPartnerDispositionPolicy({
    actorId: context?.player?.id,
    knownWolfIds: context?.player?.knowledge?.knownWolfIds ?? [],
    alivePlayerIds: (context?.board?.alive ?? []).map((player) => String(player?.id ?? player?.playerId ?? '')),
  });
  const completeExample = buildResponseContractExample({
    mode,
    roleId,
    partnerDispositionPolicy,
    claimRolePolicy: buildClaimRolePolicy(context?.game?.roleComposition ?? {}),
    freezeEstimateLimit: taskType === 'freeze' ? resolveSnowWomanEstimateLimit(validTargetIds.length) : null,
    wolfConversationPurpose: context?.task?.wolfConversationPurpose ?? null,
    attackAlternativeAvailable: taskType === 'wolf-attack' ? validTargetIds.length > 1 : true,
    exampleReferences,
  });
  const conditionalExamples = buildResponseConditionalExamples({
    mode,
    claimRolePolicy: buildClaimRolePolicy(context?.game?.roleComposition ?? {}),
    exampleReferences,
  });
  const availableKeys = new Set([
    ...Object.keys(completeExample),
    ...Object.keys(conditionalExamples),
  ]);
  const allowedTopLevelKeys = getRoleCompatibleResponseTopLevelKeys(mode, roleId)
    .filter((key) => availableKeys.has(key));
  const missingRequiredKeys = requiredTopLevelKeys.filter((key) => !allowedTopLevelKeys.includes(key));
  if (missingRequiredKeys.length) {
    throw new Error(`完全応答契約例に必須キーがありません: ${missingRequiredKeys.join(', ')}`);
  }
  const optionalTopLevelKeys = allowedTopLevelKeys.filter((key) => !requiredTopLevelKeys.includes(key));
  return {
    mode,
    allowedTopLevelKeys,
    requiredTopLevelKeys,
    optionalTopLevelKeys,
    fieldDescriptions: Object.fromEntries(allowedTopLevelKeys.map((key) => [key, FIELD_DESCRIPTIONS[key] ?? key])),
    completeExample,
    conditionalExamples,
  };
}

export function prepareAiTask(state, {
  playerId,
  taskType,
  slotId = '',
  publicHistoryTransmissionMode = 'delta',
  forceFullPublicHistory = false,
} = {}) {
  const validTargetIds = resolveAiTaskValidTargetIds(state, taskType, playerId);
  const built = buildPromptContext(state, playerId, {
    taskType,
    validTargetIds,
    slotId,
    publicHistoryTransmissionMode,
    forceFullPublicHistory,
  });
  const responseContract = responseContractForArtifact(
    state,
    built.context,
    taskType,
    validTargetIds,
  );
  return {
    playerId: String(playerId ?? ''),
    taskType: String(taskType ?? ''),
    slotId: String(slotId ?? ''),
    text: built.text,
    promptEnvelope: built.promptEnvelope,
    systemInstruction: built.systemInstruction,
    fingerprint: built.fingerprint,
    mode: built.mode,
    promptMode: built.promptMode,
    includeInitial: built.includeInitial,
    publicSequenceAtGeneration: built.publicSequenceAtGeneration,
    publicHistoryMode: built.publicHistoryMode,
    publicHistoryTransmissionMode: String(publicHistoryTransmissionMode ?? 'delta'),
    forceFullPublicHistory: Boolean(forceFullPublicHistory),
    context: built.context,
    decision: built.decision,
    validTargetIds,
    internalReasoningDirective: built.internalReasoningDirective,
    diagnostics: built.diagnostics,
    stageSource: buildGenerationStageSource({
      context: built.context,
      decision: built.decision,
      taskType,
      playerId,
      slotId,
      validTargetIds,
        publicHistoryMode: built.publicHistoryMode,
      responseContract,
      generationGuidance: built.generationGuidance,
      internalReasoningDirective: built.internalReasoningDirective,
    }),
  };
}

function parseCandidateObject(rawResponse) {
  try {
    const value = JSON.parse(String(rawResponse ?? '').trim());
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function evaluateCandidateOnce(state, taskArtifact, rawResponse, currentFingerprint) {
  const parseResult = parseAiResponse(rawResponse, taskArtifact.mode);
  const candidateObject = parseCandidateObject(rawResponse);
  const presentTopLevelKeys = candidateObject ? [...new Set(Object.keys(candidateObject))].sort() : [];
  const validation = validateAiResponse(state, {
    parsed: parseResult,
    playerId: taskArtifact.playerId,
    taskType: taskArtifact.taskType,
    candidateIds: taskArtifact.validTargetIds,
    promptFingerprint: taskArtifact.fingerprint,
    currentFingerprint,
  });
  const boundaryValidation = candidateObject
    ? validateGeneratedTextBoundary({ taskArtifact, candidateObject })
    : { ok: true, issues: [] };
  const issues = [
    ...(validation.issues ?? []),
    ...(boundaryValidation.issues ?? []),
  ];
  if (!candidateObject && !issues.length) {
    issues.push({ code: 'INVALID_JSON_OBJECT', category: 'syntax', path: '', message: 'AI応答が単一JSONオブジェクトではありません。' });
  }
  return {
    ok: Boolean(candidateObject) && validation.ok && boundaryValidation.ok,
    parseResult,
    candidateObject,
    presentTopLevelKeys,
    parsed: parseResult.value,
    validation,
    issues,
    warnings: [...(validation.warnings ?? [])],
  };
}

function combinedAutoRepair(primary, optionalOperations, {
  accepted,
  initialIssues,
  remainingIssues,
  originalRawResponse = '',
  repairedRawResponse = '',
} = {}) {
  const operations = [
    ...(primary?.operations ?? []),
    ...(optionalOperations ?? []),
  ];
  if (!operations.length && !primary) return null;
  return {
    applied: operations.length > 0,
    originalRawResponse: primary?.originalRawResponse ?? String(originalRawResponse ?? ''),
    repairedRawResponse: primary?.repairedRawResponse ?? String(repairedRawResponse ?? ''),
    operations,
    blockedReason: primary?.blockedReason ?? null,
    accepted: Boolean(accepted),
    initialIssues: [...(initialIssues ?? [])],
    remainingIssues: [...(remainingIssues ?? [])],
  };
}

function recoverInvalidOptionalFields(state, taskArtifact, evaluation, rawResponse, currentFingerprint) {
  let current = evaluation;
  let currentRawResponse = String(rawResponse ?? '');
  const operations = [];
  const seen = new Set([currentRawResponse]);
  for (let attempt = 0; attempt < 12 && !current.ok; attempt += 1) {
    const discarded = discardInvalidOptionalResponseFields(
      currentRawResponse,
      taskArtifact.mode,
      current.issues,
      { taskType: taskArtifact.taskType },
    );
    if (!discarded.applied || seen.has(discarded.repairedRawResponse)) break;
    operations.push(...discarded.operations);
    currentRawResponse = discarded.repairedRawResponse;
    seen.add(currentRawResponse);
    current = evaluateCandidateOnce(state, taskArtifact, currentRawResponse, currentFingerprint);
  }
  return { evaluation: current, rawResponse: currentRawResponse, operations };
}

export function evaluateAiTaskCandidate(state, taskArtifact, rawResponse) {
  const originalRawResponse = String(rawResponse ?? '');
  const current = buildPromptContext(state, taskArtifact.playerId, {
    taskType: taskArtifact.taskType,
    validTargetIds: taskArtifact.validTargetIds,
    slotId: taskArtifact.slotId,
    publicHistoryTransmissionMode: taskArtifact.publicHistoryTransmissionMode ?? (['full', 'compact', 'delta'].includes(taskArtifact.publicHistoryMode) ? taskArtifact.publicHistoryMode : 'delta'),
    forceFullPublicHistory: Boolean(taskArtifact.forceFullPublicHistory),
  });
  const initial = evaluateCandidateOnce(state, taskArtifact, originalRawResponse, current.fingerprint);
  if (initial.ok) {
    const normalization = repairAiResponseCandidate(state, taskArtifact, originalRawResponse);
    if (!normalization.applied) {
      return {
        ...initial,
        originalRawResponse,
        effectiveRawResponse: originalRawResponse,
        autoRepair: null,
      };
    }

    const normalized = evaluateCandidateOnce(state, taskArtifact, normalization.repairedRawResponse, current.fingerprint);
    if (normalized.ok) {
      return {
        ...normalized,
        originalRawResponse,
        effectiveRawResponse: normalization.repairedRawResponse,
        autoRepair: combinedAutoRepair(normalization, [], {
          accepted: true,
          initialIssues: [],
          remainingIssues: [],
        }),
      };
    }

    return {
      ...initial,
      originalRawResponse,
      effectiveRawResponse: originalRawResponse,
      autoRepair: combinedAutoRepair(normalization, [], {
        accepted: false,
        initialIssues: [],
        remainingIssues: normalized.issues,
      }),
    };
  }

  const structuralRepair = repairAiResponseCandidate(state, taskArtifact, originalRawResponse);
  const structurallyEvaluated = structuralRepair.applied
    ? evaluateCandidateOnce(state, taskArtifact, structuralRepair.repairedRawResponse, current.fingerprint)
    : initial;
  const structuralRawResponse = structuralRepair.applied
    ? structuralRepair.repairedRawResponse
    : originalRawResponse;
  const optionalRecovery = recoverInvalidOptionalFields(
    state,
    taskArtifact,
    structurallyEvaluated,
    structuralRawResponse,
    current.fingerprint,
  );
  const finalEvaluation = optionalRecovery.evaluation;
  const effectiveRawResponse = optionalRecovery.rawResponse;
  const autoRepair = combinedAutoRepair(structuralRepair.applied ? structuralRepair : null, optionalRecovery.operations, {
    accepted: finalEvaluation.ok,
    initialIssues: initial.issues,
    remainingIssues: finalEvaluation.issues,
    originalRawResponse,
    repairedRawResponse: effectiveRawResponse,
  });

  return {
    ...finalEvaluation,
    originalRawResponse,
    effectiveRawResponse,
    autoRepair: autoRepair ?? structuralRepair,
  };
}
