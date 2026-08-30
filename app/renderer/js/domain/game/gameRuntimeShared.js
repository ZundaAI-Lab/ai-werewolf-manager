/**
 * 責務: ゲーム状態遷移で共有するコマンド結果、フェーズ更新、AIターン監査、判断・戦略・心の声更新、開始時知識固定を提供する。
 * 変更ルール: 共有の原子的更新だけを扱い、夜・議論・投票・結果・訂正の進行規則を追加しない。AI公開本文の保存契約を変更しない。AIターンの生成カテゴリは生成タスク正本と監査専用種別の明示対応だけから解決し、未知種別をnightActionへフォールバックしない。
 */

import { PROMPT_SPEC_VERSION } from '../../config/constants.js';
import { TASK_GENERATION_CATEGORY } from '../../config/generationTaskCategories.js';
import { BUILD_ID } from '../../../generated/buildInfo.js';
import { getPlayer } from './standardRules.js';
import { createEvent } from '../events/eventStore.js';
import {
  createId,
  nowIso,
} from '../../shared/utils.js';
import { deriveDecisionTransition } from './decisionState.js';
import {
  buildDecisionTargetPolicy,
  getCurrentDecisionProjection,
  projectDecisionStateForPolicy,
} from './decisionTargetPolicy.js';
import {
  createFactionStrategyState,
  getFactionStrategyFields,
  normalizeFactionStrategyForPolicy,
  validateFactionStrategyState,
} from './factionStrategyState.js';
import { resolveWolfPartnerDispositionPolicy } from './wolfPartnerDispositionPolicy.js';
import {
  canKnowMadmanPartners,
  canKnowWolfPartners,
  countsAsWolf,
  getFactionStrategyProfile,
  getPlayerTeam,
  isMadmanClass,
} from '../roles/roleAttributes.js';


const AI_TURN_AUDIT_ONLY_CATEGORY = Object.freeze({
  'speech-fallback': 'speech',
  'priority-answer-fallback': 'speech',
  'testament-fallback': 'speech',
  'result-impression-fallback': 'resultImpression',
  'memo-consolidate-fallback': 'memoConsolidate',
  'mason-conversation-message': 'privateConversation',
  'wolf-conversation-message': 'privateConversation',
});

function resolveAiTurnTaskCategory(taskType) {
  const normalized = String(taskType ?? '').trim();
  const category = TASK_GENERATION_CATEGORY[normalized] ?? AI_TURN_AUDIT_ONLY_CATEGORY[normalized];
  if (!category) throw new RangeError(`AIターン監査で未定義のタスク種別です: ${normalized || '(empty)'}`);
  return category;
}

export function result(ok, message, extra = {}) {
  return { ok, message, ...extra };
}

export function cloneStateForAtomicCorrection(state) {
  return JSON.parse(JSON.stringify(state));
}

export function restoreStateAfterFailedCorrection(state, snapshot) {
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, snapshot);
}

export function commandGuard(state, { phases = null, allowCorrection = false } = {}) {
  if (state.game.correctionMode?.enabled && !allowCorrection) return result(false, '訂正モード中は通常進行を操作できません。');
  if (phases && !phases.includes(state.game.phase)) return result(false, '現在のフェーズでは実行できません。');
  return null;
}

export function addEvent(state, payload) {
  return createEvent(state, payload);
}

export function setPhase(state, phase) {
  state.game.phase = phase;
  state.game.phaseStartedAt = nowIso();
}

export function setHeartVoice(state, playerId, heartVoice, source = 'ai') {
  const player = getPlayer(state, playerId);
  if (!player || !String(heartVoice ?? '').trim()) return;
  if (player.heartVoice) {
    player.heartVoiceHistory.push({ heartVoice: player.heartVoice, updatedAt: player.heartVoiceUpdatedAt, source });
  }
  player.heartVoice = String(heartVoice).trim();
  player.heartVoiceUpdatedAt = nowIso();
}

export function resolveDecisionUpdateForCommit(state, playerId, decisionUpdate, {
  taskType = 'speech',
  candidateIds = null,
} = {}) {
  if (!decisionUpdate) return null;
  const player = getPlayer(state, playerId);
  const targetPolicy = buildDecisionTargetPolicy(state, playerId, { taskType, candidateIds });
  const projectedDecision = projectDecisionStateForPolicy(decisionUpdate, targetPolicy).state;
  const nextDecision = {
    suspicionCandidateIds: [...(projectedDecision.suspicionCandidateIds ?? [])],
    executionCandidateIds: [...(projectedDecision.executionCandidateIds ?? [])],
    intendedVoteId: projectedDecision.intendedVoteId ?? null,
    assessmentLevel: String(projectedDecision.assessmentLevel ?? 'unresolved'),
    keyPublicEvidenceEventIds: [...(projectedDecision.keyPublicEvidenceEventIds ?? [])],
    leaveAliveBenefit: String(projectedDecision.leaveAliveBenefit ?? ''),
    misexecutionCost: String(projectedDecision.misexecutionCost ?? ''),
    selectionDifference: String(projectedDecision.selectionDifference ?? ''),
    uncertainty: String(projectedDecision.uncertainty ?? ''),
    nextDiscriminatingInformation: String(projectedDecision.nextDiscriminatingInformation ?? ''),
    decisionReason: String(projectedDecision.decisionReason ?? '').trim(),
    revisionCause: String(projectedDecision.revisionCause ?? 'unchanged'),
  };
  const previousDecision = getCurrentDecisionProjection(state, playerId, { taskType, candidateIds }).state;
  return {
    ...nextDecision,
    ...deriveDecisionTransition(previousDecision, nextDecision, {
      hasPreviousDecision: Boolean(player?.decisionState?.updatedAt),
    }),
  };
}

export function cloneDecisionUpdate(decisionUpdate) {
  if (!decisionUpdate) return null;
  return {
    ...decisionUpdate,
    suspicionCandidateIds: [...(decisionUpdate.suspicionCandidateIds ?? [])],
    executionCandidateIds: [...(decisionUpdate.executionCandidateIds ?? [])],
    keyPublicEvidenceEventIds: [...(decisionUpdate.keyPublicEvidenceEventIds ?? [])],
  };
}

export function cloneFactionStrategyState(update) {
  if (!update) return null;
  const profile = String(update.profile ?? '');
  return {
    profile,
    ...Object.fromEntries(getFactionStrategyFields(profile).map((key) => [key, String(update[key] ?? '')])),
  };
}

export function cloneInternalReasoningDirective(directive) {
  if (!directive) return null;
  return {
    modeId: String(directive.modeId ?? ''),
    lens: String(directive.lens ?? ''),
    focusPlayerIds: [...(directive.focusPlayerIds ?? [])],
    anchorEventSequences: [...(directive.anchorEventSequences ?? [])],
    publicSequenceAtGeneration: Number(directive.publicSequenceAtGeneration ?? 0),
  };
}

export function cloneSharedStrategyPatch(update) {
  if (!update) return null;
  return {
    mode: String(update.mode ?? ''),
    changes: Object.fromEntries(
      Object.entries(update.changes ?? {}).map(([key, value]) => [key, String(value ?? '')]),
    ),
  };
}

export function cloneFactionStrategyPatch(update) {
  if (!update) return null;
  return {
    mode: update.mode,
    changes: update.changes ? { ...update.changes } : update.changes,
  };
}

export function cloneParsedAttackAssessment(assessment) {
  if (!assessment) return null;
  // 責務境界: 応答パーサーの診断情報はUI確認用であり、永続状態には現行Schemaの監査項目だけを保存する。
  return {
    hunterAliveChance: String(assessment.hunterAliveChance ?? ''),
    hunterSurvivalReason: String(assessment.hunterSurvivalReason ?? ''),
    selectedTargetGuardRisk: String(assessment.selectedTargetGuardRisk ?? ''),
    selectedTargetValue: String(assessment.selectedTargetValue ?? ''),
    selectedTargetFailureCost: String(assessment.selectedTargetFailureCost ?? ''),
    otherTargetName: String(assessment.otherTargetName ?? ''),
    otherTargetGuardRisk: String(assessment.otherTargetGuardRisk ?? ''),
    otherTargetValue: String(assessment.otherTargetValue ?? ''),
    selectionDifference: String(assessment.selectionDifference ?? ''),
  };
}

export function resolveFactionStrategyForCommit(state, playerId, update) {
  const player = getPlayer(state, playerId);
  if (!player) return { ok: false, errors: ['対象プレイヤーが存在しません。'], update: null };
  if (!update) return { ok: true, errors: [], update: null };
  const partnerDispositionPolicy = countsAsWolf(state, player)
    ? resolveWolfPartnerDispositionPolicy({
      actorId: player.id,
      knownWolfIds: state.playerKnowledge[player.id]?.knownWolfIds ?? [],
      alivePlayerIds: state.players.filter((item) => item.alive).map((item) => item.id),
    })
    : null;
  const profile = getFactionStrategyProfile(state, player);
  const normalized = normalizeFactionStrategyForPolicy(update, profile, { partnerDispositionPolicy });
  const errors = validateFactionStrategyState(normalized, profile, { partnerDispositionPolicy, allowPartial: true, requiredFields: [], requireSubstantive: false });
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    update: errors.length ? null : normalized,
  };
}

export function setFactionStrategyState(state, playerId, update, sourceAiTurnId = null) {
  if (!update) return;
  const player = getPlayer(state, playerId);
  if (!player) return;
  player.factionStrategyState = createFactionStrategyState(getFactionStrategyProfile(state, player), update, {
    updatedAt: nowIso(),
    sourceAiTurnId,
  });
}

export function cloneGenerationRun(run, payload = {}) {
  if (!run) {
    const category = resolveAiTurnTaskCategory(payload.taskType);
    run = {
      schemaVersion: 2, executionMode: 'manual', depth: 1, ownerProfileId: '', taskCategory: category,
      normalCallCount: 1, totalCallCount: 0, finalStageId: 'direct',
      stages: [{ stageId: 'direct', executorProfileId: '', status: 'accepted', attemptCount: 0, targetTextFields: [], skipReason: null, rawResponse: payload.rawResponse ?? '', fallbackUsed: false, issues: [], rejectedAttempts: [], usage: {} }],
    };
  }
  const usageKeys = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
  return {
    schemaVersion: 2,
    executionMode: String(run.executionMode ?? 'automatic'),
    depth: Number(run.depth ?? 1),
    ownerProfileId: String(run.ownerProfileId ?? ''),
    taskCategory: String(run.taskCategory ?? ''),
    normalCallCount: Number(run.normalCallCount ?? 1),
    totalCallCount: Number(run.totalCallCount ?? 0),
    finalStageId: String(run.finalStageId ?? 'direct'),
    stages: (run.stages ?? []).map((stage) => ({
      stageId: String(stage.stageId ?? ''),
      executorProfileId: String(stage.executorProfileId ?? ''),
      status: String(stage.status ?? ''),
      attemptCount: Number(stage.attemptCount ?? 0),
      targetTextFields: [...(stage.targetTextFields ?? [])].map(String),
      skipReason: stage.skipReason ?? null,
      rawResponse: String(stage.rawResponse ?? ''),
      fallbackUsed: Boolean(stage.fallbackUsed),
      issues: (stage.issues ?? []).map((item) => ({ code: String(item.code ?? ''), message: String(item.message ?? '') })),
      rejectedAttempts: (stage.rejectedAttempts ?? []).map((attempt) => ({
        attempt: Math.max(1, Math.trunc(Number(attempt?.attempt ?? 1))),
        phase: String(attempt?.phase ?? 'normal'),
        issueCodes: [...new Set((attempt?.issueCodes ?? []).map(String).filter(Boolean))],
        issues: (attempt?.issues ?? []).map((issue) => ({
          code: String(issue?.code ?? ''),
          category: String(issue?.category ?? ''),
          path: String(issue?.path ?? ''),
        })),
      })),
      usage: Object.fromEntries(usageKeys.map((key) => [key, Number(stage.usage?.[key] ?? 0)])),
    })),
  };
}

export function recordAiTurn(state, payload) {
  const turn = {
    id: createId('ai-turn'),
    day: state.game.day,
    phase: state.game.phase,
    stateRevision: state.game.stateRevision ?? state.revision,
    promptContextFingerprint: payload.promptFingerprint ?? '',
    promptMode: payload.promptMode ?? 'runtime',
    publicSequenceAtGeneration: Number(payload.publicSequenceAtGeneration ?? 0),
    publicSequenceAtRegistration: Math.max(0, ...(state.events ?? [])
      .filter((event) => event.status === 'published' && event.audience?.type === 'public')
      .map((event) => Number(event.sequence ?? 0))),
    promptText: payload.promptText ?? '',
    rawResponse: payload.rawResponse ?? '',
    parsedPublicSpeech: payload.parsedPublicSpeech ?? '',
    parsedSpeechInteraction: payload.parsedSpeechInteraction ? {
      questionTargetNames: [...(payload.parsedSpeechInteraction.questionTargetNames ?? [])],
      answerToRefs: [...(payload.parsedSpeechInteraction.answerToRefs ?? [])],
    } : null,
    resolvedSpeechInteraction: payload.resolvedSpeechInteraction ? {
      questionTargetIds: [...(payload.resolvedSpeechInteraction.questionTargetIds ?? [])],
      answersEventIds: [...(payload.resolvedSpeechInteraction.answersEventIds ?? [])],
    } : null,
    parsedWolfConversationMessage: payload.parsedWolfConversationMessage ?? '',
    parsedMasonConversationMessage: payload.parsedMasonConversationMessage ?? '',
    parsedGraveyardConversationMessage: payload.parsedGraveyardConversationMessage ?? '',
    parsedSharedStrategyPatch: cloneSharedStrategyPatch(payload.parsedSharedStrategyPatch),
    parsedHeartVoice: payload.parsedHeartVoice ?? '',
    parsedInternalMemoUpdate: payload.parsedInternalMemoUpdate ?? null,
    parsedFullMemo: payload.parsedFullMemo ?? '',
    parsedActionAnswer: payload.parsedActionAnswer ?? '',
    parsedSelectionRationale: payload.parsedSelectionRationale ?? '',
    parsedCoOperation: payload.parsedCoOperation ?? null,
    parsedAbilityClaims: payload.parsedAbilityClaims ?? null,
    resolvedAbilityClaims: (payload.resolvedAbilityClaims ?? []).map((claim) => ({ ...claim, evidenceEventIds: [...(claim.evidenceEventIds ?? [])] })),
    parsedDecisionUpdate: payload.parsedDecisionUpdate ?? null,
    resolvedDecisionUpdate: cloneDecisionUpdate(payload.resolvedDecisionUpdate),
    parsedFactionStrategyPatch: cloneFactionStrategyPatch(payload.parsedFactionStrategyPatch),
    resolvedFactionStrategyState: cloneFactionStrategyState(payload.resolvedFactionStrategyState),
    parsedAttackAssessment: cloneParsedAttackAssessment(payload.parsedAttackAssessment),
    resolvedAttackAssessment: payload.resolvedAttackAssessment ?? null,
    estimatedWerewolfIds: [...(payload.estimatedWerewolfIds ?? [])],
    predictedAttackTargetIds: [...(payload.predictedAttackTargetIds ?? [])],
    resolvedInternalReasoningDirective: cloneInternalReasoningDirective(payload.resolvedInternalReasoningDirective),
    warnings: [...(payload.warnings ?? [])],
    override: payload.override ?? null,
    committedEntityIds: [...(payload.committedEntityIds ?? [])],
    runtimeBuildId: BUILD_ID,
    promptSpecVersion: PROMPT_SPEC_VERSION,
    taskType: payload.taskType,
    playerId: payload.playerId,
    timestamp: nowIso(),
    generationRun: cloneGenerationRun(payload.generationRun, payload),
  };
  state.aiTurns.push(turn);
  return turn;
}

export function freezeKnowledge(state) {
  const previous = state.playerKnowledge ?? {};
  const allWolfIds = state.players.filter((player) => countsAsWolf(state, player)).map((player) => player.id);
  const allMadmanIds = state.players.filter((player) => isMadmanClass(state, player)).map((player) => player.id);
  const allMasonIds = state.players.filter((player) => player.roleId === 'mason').map((player) => player.id);
  state.playerKnowledge = {};
  state.players.forEach((player) => {
    state.playerKnowledge[player.id] = {
      knownWolfIds: canKnowWolfPartners(state, player) ? [...allWolfIds] : [],
      knownMadmanIds: canKnowMadmanPartners(state, player) ? [...allMadmanIds] : [],
      knownMasonIds: player.roleId === 'mason' ? [...allMasonIds] : [],
      knownOwnerId: player.roleId === 'zashikiWarashi' ? player.roleState?.ownerId ?? null : null,
      knownOwnerRoleId: player.roleId === 'zashikiWarashi' ? player.roleState?.ownerRoleId ?? null : null,
      resolvedTeam: player.roleId === 'zashikiWarashi' ? player.roleState?.resolvedTeam ?? null : getPlayerTeam(state, player),
      roleNotifiedAt: previous[player.id]?.roleNotifiedAt ?? null,
      knowledgeRevision: Number(previous[player.id]?.knowledgeRevision ?? 0) + 1,
    };
  });
}
