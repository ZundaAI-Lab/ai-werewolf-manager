/**
 * 責務: 解析済みAI応答を現在タスク・候補・公開権限・明示構造化CO・判断差分・陣営戦略差分・襲撃価値・雪女の戦術候補と照合し、エラーと警告を返す。
 * 変更ルール: 状態を書き換えない。通常発言はpublicSpeech必須だけを構造で検証し、publicSpeechの人物・疑い・CO・能力結果・禁止表現を本文から推定しない。ゲーム進行に不要な理由・比較・戦略・内面・監査項目は省略可能とし、出力された欄だけを構造化人物名・対象可否・公開根拠参照・権限・フェーズ・明示構造同士の整合へ厳密に照合する。任意項目の劣化判定へ渡すissue.pathはトップレベル責務を失わないよう構造名へ正規化する。対象失効で利用不能になった前回判断はkeepを許可せず、現在候補への再評価を要求する。heartVoiceの長さ検証は文字数上限だけを正本とし、文数は制約・警告に使用しない。
 */

import {
  MAX_FREEZE_ACTION_RATIONALE_LENGTH,
  MAX_NIGHT_ACTION_RATIONALE_LENGTH,
  MAX_RESULT_IMPRESSION_LENGTH,
} from '../../config/constants.js';
import { isPersonalNightActionTask } from '../../config/personalNightActionTasks.js';
import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';
import { normalizeFreeDiscussionPreference } from '../../domain/discussion/freeDiscussionPolicy.js';
import { normalizeName } from '../../shared/utils.js';
import { buildClaimRolePolicy, isAbilityClaimRoleAllowed, validateCoOperationTransition } from '../../domain/claims/claimRolePolicy.js';
import { resolveAiTruthfulAbilityClaimSource } from '../../domain/claims/aiAbilityClaimGroundingPolicy.js';
import { getPlayer } from '../../domain/game/standardRules.js';
import { canSpeakDuringDay } from '../../domain/game/playerStatus.js';
import { countsAsWolf, getFactionStrategyProfile } from '../../domain/roles/roleAttributes.js';
import { getPublicAbilityClaimDefinition, normalizePublicAbilityResult, resolvePublicAbilityClaimRequirements, validatePublicAbilityClaim } from '../../domain/policies/publicAbilityClaimPolicy.js';
import { resolveAbilityEvidenceRefs } from '../../domain/policies/abilityClaimTimelinePolicy.js';
import { applyDecisionPatch, compareDecisionStates, deriveDecisionTransition, isSubstantiveDecisionReason } from '../../domain/game/decisionState.js';
import { validateFactionStrategyPatch } from '../../domain/game/factionStrategyState.js';
import { resolveFactionStrategyPolicy } from '../../domain/game/factionStrategyPolicy.js';
import { getPublishedPublicEvents } from '../../domain/events/eventStore.js';
import { buildDecisionTargetPolicy, getCurrentDecisionProjection } from '../../domain/game/decisionTargetPolicy.js';
import { resolveWolfPartnerDispositionPolicy } from '../../domain/game/wolfPartnerDispositionPolicy.js';
import { getDecisionGroundingReferenceFields } from './responseContract.js';
import { resolveSnowWomanEstimateLimit } from '../../domain/night/snowWomanEstimatePolicy.js';
import { isPublicQuestionAnswered, isPublicQuestionSkipped } from '../../domain/discussion/publicQuestionResolution.js';

export function resolvePlayerName(state, input, candidateIds = null) {
  const normalized = normalizeName(input);
  if (!normalized) return { player: null, certainty: 'none', candidates: [] };
  const allowed = state.players.filter((player) => !candidateIds || candidateIds.includes(player.id));
  const exact = allowed.find((player) => normalizeName(player.name) === normalized);
  if (exact) return { player: exact, certainty: 'exact', candidates: [exact] };
  const aliasExact = allowed.find((player) => player.aliases?.some((alias) => normalizeName(alias) === normalized));
  if (aliasExact) return { player: aliasExact, certainty: 'alias', candidates: [aliasExact] };
  const partial = allowed.filter((player) => {
    const name = normalizeName(player.name);
    return name.includes(normalized) || normalized.includes(name);
  });
  return { player: partial.length === 1 ? partial[0] : null, certainty: partial.length === 1 ? 'partial' : 'ambiguous', candidates: partial };
}


export function resolveExactPlayerName(state, input, candidateIds = null) {
  const normalized = normalizeName(input);
  if (!normalized) return null;
  return state.players.find((player) => (
    (!candidateIds || candidateIds.includes(player.id))
    && normalizeName(player.name) === normalized
  )) ?? null;
}

function addCharacterWarnings(player, text, warnings) {
  const profile = player?.character ?? {};
  const avoided = String(profile.avoidedExpressions ?? '')
    .split(/[,、\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
  avoided.forEach((term) => {
    if (String(text ?? '').includes(term)) warnings.push(`避ける表現「${term}」が含まれています。`);
  });
}

function validateCoOperation(state, playerId, coOperation, claimRolePolicy, errors) {
  if (!coOperation) {
    errors.push('coOperationを解析できません。');
    return;
  }
  const activeRoleId = state.claims.find((claim) => claim.actorId === playerId && claim.status === 'active')?.roleId ?? null;
  const transition = validateCoOperationTransition({
    policy: claimRolePolicy,
    activeRoleId,
    operation: coOperation,
  });
  errors.push(...transition.errors);
}

function resolveOptionalDecisionTarget(state, text, candidateIds, label, errors, warnings, { allowAbstain = false } = {}) {
  if (!text) return null;
  if (allowAbstain && /^(?:棄権|abstain)$/iu.test(text)) return { id: 'abstain', name: '棄権' };
  const resolved = resolvePlayerName(state, text, candidateIds);
  if (!resolved.player) {
    errors.push(`${label}の対象を一意に特定できません。`);
    return null;
  }
  if (resolved.certainty !== 'exact') warnings.push(`${label}の「${text}」を${resolved.player.name}として解釈しました。`);
  return resolved.player;
}

function validateAbilityClaims(state, playerId, parsed, claimRolePolicy, errors, warnings) {
  const submitted = parsed.abilityClaims;
  if (!submitted) {
    errors.push('abilityClaimsを解析できません。');
    return { resolvedClaims: [], normalizedParsedAbilityClaims: null };
  }
  if (submitted.action !== 'publish') return { resolvedClaims: [], normalizedParsedAbilityClaims: null };

  const activeBefore = state.claims.find((item) => item.actorId === playerId && item.status === 'active')?.roleId ?? null;
  let activeAfter = activeBefore;
  if (parsed.coOperation?.action === 'declare' || parsed.coOperation?.action === 'change') activeAfter = parsed.coOperation.roleId;
  if (parsed.coOperation?.action === 'withdraw') activeAfter = null;

  const resolvedClaims = [];
  const canonicalClaims = [];
  submitted.claims.forEach((claim, index) => {
    const label = `能力履歴${index + 1}`;
    let roleId = '';
    let target = null;
    let timing = null;
    let result = '';

    if (claim.intent === 'truthful') {
      const grounded = resolveAiTruthfulAbilityClaimSource(state, {
        actorId: playerId,
        sourceRef: claim.sourceRef,
      });
      if (!grounded.ok || !grounded.source) {
        errors.push(...grounded.errors.map((message) => `${label}: ${message}`));
        return;
      }
      roleId = grounded.source.roleId;
      target = getPlayer(state, grounded.source.targetId);
      timing = {
        actionDay: grounded.source.actionDay,
        actionPhase: grounded.source.actionPhase,
        availableDay: grounded.source.availableDay,
        availablePhase: grounded.source.availablePhase,
      };
      result = grounded.source.result;
      if (!target) {
        errors.push(`${label}: truthful参照の対象が現在のゲーム状態に存在しません。`);
        return;
      }
    } else {
      roleId = claim.roleId;
      const resolvedTarget = resolvePlayerName(state, claim.targetName, state.players.map((player) => player.id));
      if (!resolvedTarget.player) {
        errors.push(`${label}の対象を一意に特定できません。`);
        return;
      }
      if (resolvedTarget.certainty !== 'exact') warnings.push(`${label}の「${claim.targetName}」を${resolvedTarget.player.name}として解釈しました。`);
      target = resolvedTarget.player;
      timing = {
        actionDay: Number(claim.actionDay),
        actionPhase: String(claim.actionPhase ?? ''),
        availableDay: Number(claim.availableDay),
        availablePhase: String(claim.availablePhase ?? ''),
      };
      result = normalizePublicAbilityResult(claim.result);
    }

    if (!isAbilityClaimRoleAllowed(claimRolePolicy, roleId)) {
      const allowed = claimRolePolicy.abilityClaimRoleIds.length
        ? claimRolePolicy.abilityClaimRoleIds.join(' / ')
        : 'なし';
      errors.push(`${label}のroleIdは今回の配役で構造化公開できる役職（${allowed}）から指定してください。`);
      return;
    }

    const forced = resolvePublicAbilityClaimRequirements(state, {
      roleId,
      actionDay: timing.actionDay,
      targetId: target.id,
    });
    const evidence = roleId === 'medium'
      ? { errors: [], resolved: forced.requiredEvidenceEventIds.map((eventId) => state.events.find((event) => event.id === eventId)).filter(Boolean) }
      : resolveAbilityEvidenceRefs(state, claim.evidenceRefs, timing.actionDay);
    errors.push(...evidence.errors.map((message) => `${label}: ${message}`));

    const resolved = {
      action: 'publish',
      actorId: playerId,
      claimedRoleId: roleId,
      actionType: getPublicAbilityClaimDefinition(roleId)?.actionType ?? null,
      targetId: target.id,
      result,
      ...timing,
      selectionBasis: roleId === 'medium' ? forced.selectionBasis : claim.selectionBasis,
      evidenceEventIds: evidence.resolved.map((event) => event.id),
      selectionReasonAtTime: roleId === 'medium' ? forced.selectionReasonAtTime : claim.selectionReasonAtTime,
    };
    errors.push(...validatePublicAbilityClaim(state, {
      actorId: playerId,
      claim: resolved,
      activeRoleId: activeAfter,
      announcedDay: state.game.day,
      additionalClaims: resolvedClaims,
    }).map((message) => `${label}: ${message}`));
    resolvedClaims.push(resolved);
    canonicalClaims.push({
      roleId,
      ...timing,
      targetName: target.name,
      result,
      selectionBasis: roleId === 'medium' ? '' : claim.selectionBasis,
      evidenceRefs: roleId === 'medium' ? [] : [...(claim.evidenceRefs ?? [])],
      selectionReasonAtTime: roleId === 'medium' ? '' : String(claim.selectionReasonAtTime ?? ''),
    });
  });

  return {
    resolvedClaims,
    normalizedParsedAbilityClaims: canonicalClaims.length
      ? { action: 'publish', count: canonicalClaims.length, claims: canonicalClaims }
      : null,
  };
}
function resolvePublicEventRefs(state, refs, label, errors, {
  allowedTypes = [],
} = {}) {
  const bySequence = new Map(getPublishedPublicEvents(state).map((event) => [Number(event.sequence), event]));
  const resolved = [];
  (refs ?? []).forEach((sequence) => {
    const event = bySequence.get(Number(sequence));
    if (!event) {
      errors.push(`${label}の#${sequence}は現在参照できる公開イベントではありません。`);
      return;
    }
    if (allowedTypes.length && !allowedTypes.includes(event.type)) {
      errors.push(`${label}の#${sequence}は使用できません。許可イベント: ${allowedTypes.join(' / ')}`);
      return;
    }
    if (!resolved.some((item) => item.id === event.id)) resolved.push(event);
  });
  return resolved;
}


function validateSpeechInteraction(state, playerId, parsed, errors) {
  const submitted = parsed.speechInteraction;
  if (!submitted) {
    errors.push('speechInteractionを解析できません。');
    return null;
  }
  const aliveIds = new Set(state.players.filter((player) => player.alive).map((player) => player.id));
  const questionTargetIds = [];
  (submitted.questionTargetNames ?? []).forEach((name, index) => {
    const target = resolveExactPlayerName(state, name);
    if (!target) {
      errors.push(`speechInteraction.questionTargets[${index}]は正式表示名で指定してください。`);
      return;
    }
    if (target.id === playerId) {
      errors.push('speechInteraction.questionTargetsへ本人を指定できません。');
      return;
    }
    if (!aliveIds.has(target.id)) {
      errors.push(`speechInteraction.questionTargetsの${target.name}は現在生存していません。`);
      return;
    }
    if (!canSpeakDuringDay(state, target.id)) {
      errors.push(`speechInteraction.questionTargets[${index}]の${target.name}は現在昼会話できません。`);
      return;
    }
    if (!questionTargetIds.includes(target.id)) questionTargetIds.push(target.id);
  });
  const answerEvents = resolvePublicEventRefs(
    state,
    submitted.answerToRefs,
    'speechInteraction.answerToRefs',
    errors,
    { allowedTypes: ['public-speech'] },
  );
  const answersEventIds = [];
  answerEvents.forEach((event) => {
    if (event.actorId === playerId) {
      errors.push(`speechInteraction.answerToRefsの#${event.sequence}は本人自身の発言です。`);
      return;
    }
    const targetIds = event.payload?.structured?.interaction?.questionTargetIds ?? [];
    if (!targetIds.includes(playerId)) {
      errors.push(`speechInteraction.answerToRefsの#${event.sequence}は本人への明示質問ではありません。`);
      return;
    }
    if (isPublicQuestionAnswered(state, event, playerId)) {
      errors.push(`speechInteraction.answerToRefsの#${event.sequence}は本人がすでに回答済みの質問です。`);
      return;
    }
    if (isPublicQuestionSkipped(state, event, playerId)) {
      errors.push(`speechInteraction.answerToRefsの#${event.sequence}はすでにスキップ済みの質問です。`);
      return;
    }
    answersEventIds.push(event.id);
  });
  return { questionTargetIds, answersEventIds };
}

function addedDecisionTargetIds(previous, next) {
  const before = new Set([
    ...(previous?.suspicionCandidateIds ?? []),
    ...(previous?.executionCandidateIds ?? []),
    previous?.intendedVoteId,
  ].filter((id) => id && id !== 'abstain'));
  return [...new Set([
    ...(next?.suspicionCandidateIds ?? []),
    ...(next?.executionCandidateIds ?? []),
    next?.intendedVoteId,
  ].filter((id) => id && id !== 'abstain'))].filter((id) => !before.has(id));
}

function deriveDecisionRevisionCause(taskType, parsed, correctedSequences, evidenceSequences) {
  if (correctedSequences.length) return 'self-correction';
  if (taskType === 'vote') return 'vote-pressure';
  if (parsed.coOperation && ['declare', 'change', 'withdraw'].includes(parsed.coOperation.action)) return 'role-structure-change';
  if (taskType === 'priority-answer' || taskType === 'mason-conversation' || taskType === 'graveyard-conversation') return 'response-evaluation';
  if (evidenceSequences.length) return 'new-public-evidence';
  return 'response-evaluation';
}

function validateDecisionUpdate(state, player, parsed, taskType, action, candidateIds, errors, warnings) {
  if (!parsed.decisionUpdate) return null;
  const update = parsed.decisionUpdate;
  const targetPolicy = buildDecisionTargetPolicy(state, player.id, { taskType, candidateIds });
  const previousProjection = getCurrentDecisionProjection(state, player.id, { taskType, candidateIds });
  const previous = previousProjection.state;
  const hasPreviousDecision = Boolean(previousProjection.invalidation?.usablePreviousDecision);
  const changes = {};
  const supplied = update.changes ?? {};
  const resolveNames = (names, label, allowedIds) => {
    const resolvedItems = [];
    (names ?? []).forEach((name) => {
      const resolved = resolvePlayerName(state, name, allowedIds);
      if (!resolved.player) {
        const outside = resolvePlayerName(state, name);
        if (outside.player && !allowedIds.includes(outside.player.id)) {
          warnings.push(`${label}の「${name}」は今回の対象外のため除外しました。`);
          return;
        }
        errors.push(`${label}の対象を一意に特定できません。`);
        return;
      }
      if (resolved.certainty !== 'exact') warnings.push(`${label}の「${name}」を${resolved.player.name}として解釈しました。`);
      if (!resolvedItems.some((item) => item.id === resolved.player.id)) resolvedItems.push(resolved.player);
    });
    return resolvedItems;
  };

  if (update.mode === 'keep') {
    if (Object.keys(supplied).length) errors.push('内部判断更新のkeepに変更項目が混在しています。');
    if (previousProjection.invalidation?.invalidationReason === 'target-unavailable') {
      errors.push('前回判断の対象が死亡または対象外になったため、現在の候補をdecisionPatchで再評価してください。');
    } else if (!hasPreviousDecision) {
      errors.push('前回の公開判断状態がないため、判断維持は使用できません。');
    }
  } else if (update.mode === 'patch' && !Object.keys(supplied).length) {
    errors.push('decisionPatchには変更項目を1件以上指定してください。');
  }

  if (Object.hasOwn(supplied, 'suspicionCandidateNames')) {
    changes.suspicionCandidateIds = resolveNames(
      supplied.suspicionCandidateNames,
      '疑い候補',
      targetPolicy.suspicionCandidateIds,
    ).map((item) => item.id);
  }
  if (Object.hasOwn(supplied, 'executionCandidateNames')) {
    changes.executionCandidateIds = resolveNames(
      supplied.executionCandidateNames,
      '処刑価値候補',
      targetPolicy.executionCandidateIds,
    ).map((item) => item.id);
  }
  if (['speech', 'priority-answer', 'mason-conversation'].includes(taskType) && Object.hasOwn(supplied, 'intendedVoteName')) {
    const intendedVote = resolveOptionalDecisionTarget(
      state,
      supplied.intendedVoteName,
      targetPolicy.intendedVoteCandidateIds,
      '暫定投票予定',
      errors,
      warnings,
    );
    changes.intendedVoteId = intendedVote?.id ?? null;
  }
  if (taskType === 'vote' && action) changes.intendedVoteId = action.id;
  // 継続判断状態へ保存するのは既存の状態項目だけ。推理モード固有のdecisionPatch項目は
  // JSON例で今回の思考を誘導するターン内情報としてparsedDecisionUpdateへ残し、次ターンへ累積させない。
  [
    'assessmentLevel',
    'leaveAliveBenefit',
    'misexecutionCost',
    'selectionDifference',
    'uncertainty',
    'nextDiscriminatingInformation',
  ].forEach((key) => {
    if (Object.hasOwn(supplied, key)) changes[key] = supplied[key];
  });

  const groundingFields = getDecisionGroundingReferenceFields();
  const correctedSequences = update.grounding?.correctedSpeechRefs ?? [];
  const evidenceSequences = update.grounding?.evidenceRefs ?? [];
  const correctedEvents = resolvePublicEventRefs(
    state,
    correctedSequences,
    'decisionPatch.correctedSpeechRefs',
    errors,
    { allowedTypes: groundingFields.correctedSpeechRefs.allowedEventTypes },
  );
  const evidenceEvents = resolvePublicEventRefs(
    state,
    evidenceSequences,
    'decisionPatch.evidenceRefs',
    errors,
    { allowedTypes: groundingFields.evidenceRefs.allowedEventTypes },
  );
  const groundingCause = deriveDecisionRevisionCause(taskType, parsed, correctedSequences, evidenceSequences);
  if (groundingCause === 'self-correction' && !correctedEvents.length) {
    errors.push('自己訂正ではdecisionPatch.correctedSpeechRefsへ訂正対象の公開発言番号を1件以上指定してください。');
  }

  const evidenceEventIds = evidenceEvents.map((event) => event.id);
  const submittedReason = String(taskType === 'vote' ? parsed.selectionRationale : update.decisionReason ?? '').trim();
  const nextDecision = applyDecisionPatch(previous, {
    mode: update.mode,
    changes,
    decisionReason: submittedReason || String(previous?.decisionReason ?? ''),
    revisionCause: groundingCause,
    keyPublicEvidenceEventIds: evidenceEventIds.length
      ? evidenceEventIds
      : previous?.keyPublicEvidenceEventIds ?? [],
  });
  if (!nextDecision) return null;

  if (taskType !== 'vote' && submittedReason && !isSubstantiveDecisionReason(submittedReason)) {
    warnings.push('decisionPatch.reasonは任意ですが、出力する場合は今回の判断を支える具体的な公開根拠を記載すると後続AIの判断品質が上がります。');
  }

  if (groundingCause === 'self-correction' && addedDecisionTargetIds(previous, nextDecision).length) {
    const correctedSet = new Set(correctedSequences.map(Number));
    const independentEvidence = evidenceSequences.some((sequence) => !correctedSet.has(Number(sequence)));
    if (!independentEvidence) {
      errors.push('誤読訂正と同じ回答で新しい疑い先・処刑候補・投票予定へ移る場合、訂正対象とは別の公開根拠をdecisionPatch.evidenceRefsへ指定してください。候補を撤回して保留するだけなら新候補は不要です。');
    }
  }

  const transition = deriveDecisionTransition(previous, nextDecision, { hasPreviousDecision });
  return { ...nextDecision, ...transition };
}

function wolfPartnerPolicy(state, player) {
  if (!player || !countsAsWolf(state, player)) return null;
  return resolveWolfPartnerDispositionPolicy({
    actorId: player.id,
    knownWolfIds: state.playerKnowledge[player.id]?.knownWolfIds ?? [],
    alivePlayerIds: state.players.filter((item) => item.alive).map((item) => item.id),
  });
}

function validateFactionStrategy(state, player, parsed, taskType, errors, warnings) {
  if (!player || !['speech', 'priority-answer', 'vote'].includes(taskType)) return null;
  // 陣営戦略差分は全タスクで任意。省略は現在値維持であり、暗黙補完や必須契機判定を行わない。
  if (!parsed.factionStrategyPatch) return null;
  const updatePolicy = resolveFactionStrategyPolicy(state, {
    playerId: player.id,
    taskType,
    coOperation: parsed.coOperation,
  });
  const validation = validateFactionStrategyPatch(
    player.factionStrategyState,
    parsed.factionStrategyPatch,
    getFactionStrategyProfile(state, player),
    {
      partnerDispositionPolicy: wolfPartnerPolicy(state, player),
      updatePolicy,
    },
  );
  errors.push(...validation.errors);
  warnings.push(...(validation.warnings ?? []));
  return validation.resolvedUpdate;
}

function validateAttackAssessment(state, parsed, action, candidateIds, errors, warnings) {
  const assessment = parsed.attackAssessment;
  if (!assessment) return null;
  const guardRiskLevels = new Set(['low', 'medium', 'high']);
  const expectedTargetId = action?.id ?? null;
  const otherTarget = assessment.otherTargetName
    ? resolveExactPlayerName(state, assessment.otherTargetName, candidateIds)
    : null;
  if (assessment.otherTargetName && !otherTarget) {
    errors.push('襲撃判断のotherTargetは有効な襲撃候補の正式表示名だけを指定してください。');
  }
  if (otherTarget && expectedTargetId && otherTarget.id === expectedTargetId) {
    errors.push('襲撃判断のotherTargetは実際の襲撃対象と異なる候補にしてください。');
  }
  if (assessment.hunterAliveChance && !guardRiskLevels.has(assessment.hunterAliveChance)) {
    errors.push('襲撃判断のhunterAliveChanceはlow / medium / highで指定してください。');
  }
  if (assessment.selectedTargetGuardRisk && !guardRiskLevels.has(assessment.selectedTargetGuardRisk)) {
    errors.push('襲撃判断のguardRiskはlow / medium / highで指定してください。');
  }
  if (assessment.otherTargetGuardRisk && !guardRiskLevels.has(assessment.otherTargetGuardRisk)) {
    errors.push('襲撃判断のotherGuardRiskはlow / medium / highで指定してください。');
  }
  if (!assessment.otherTargetName && (assessment.otherTargetGuardRisk)) {
    warnings.push('otherGuardRiskを出力する場合は、otherTargetの正式表示名も併記すると襲撃判断の監査品質が上がります。');
  }
  return {
    hunterAliveChance: assessment.hunterAliveChance,
    hunterSurvivalReason: assessment.hunterSurvivalReason,
    selectedTargetGuardRisk: assessment.selectedTargetGuardRisk,
    selectedTargetValue: assessment.selectedTargetValue,
    selectedTargetFailureCost: assessment.selectedTargetFailureCost,
    otherTargetId: otherTarget?.id ?? null,
    otherTargetGuardRisk: assessment.otherTargetGuardRisk,
    otherTargetValue: assessment.otherTargetValue,
    selectionDifference: assessment.selectionDifference,
  };
}

function validateFreezeEstimates(state, playerId, parsed, resolvedAction, candidateIds, errors, warnings) {
  const limit = resolveSnowWomanEstimateLimit(candidateIds.length);
  const aliveIds = new Set(state.players.filter((player) => player.alive).map((player) => player.id));
  const validateIds = (ids, label) => {
    if (!Array.isArray(ids)) return [];
    if (ids.length && (ids.length < limit.min || ids.length > limit.max)) {
      warnings.push(`${label}は任意ですが、思考品質の目安は現在の有効候補数に応じて${limit.min}～${limit.max}件です。`);
    }
    return ids.filter((id) => {
      if (!aliveIds.has(id)) {
        errors.push(`${label}にはcurrent-task.alivePlayersにある生存者IDだけを指定してください。`);
        return false;
      }
      if (id === playerId) {
        errors.push(`${label}に雪女本人を含めることはできません。`);
        return false;
      }
      return true;
    });
  };

  const estimatedWerewolfIds = validateIds(parsed.estimatedWerewolfIds, 'estimate.wolfCandidateIds');
  const predictedAttackTargetIds = validateIds(parsed.predictedAttackTargetIds, 'estimate.predictedAttackTargetIds');
  if (resolvedAction && estimatedWerewolfIds.includes(resolvedAction.id)) {
    warnings.push('凍結対象がestimate.wolfCandidateIdsの推定人狼候補と重複しています。意図した戦術なら登録できます。');
  }
  if (resolvedAction && predictedAttackTargetIds.includes(resolvedAction.id)) {
    warnings.push('凍結対象がestimate.predictedAttackTargetIdsの予想襲撃先と重複しています。意図した戦術なら登録できます。');
  }
  return { estimatedWerewolfIds, predictedAttackTargetIds };
}

function validationIssuePath(message) {
  const text = String(message ?? '');
  const explicit = text.match(/^([A-Za-z][A-Za-z0-9_.\[\]]*)/u)?.[1];
  if (explicit) return explicit;
  if (/行動回答/u.test(text)) return 'actionAnswer';
  if (/公開発言|publicSpeech/u.test(text)) return 'publicSpeech';
  if (/陣営戦略|factionStrategy|partnerDisposition/u.test(text)) return 'factionStrategy';
  if (/共有戦略|sharedStrategy/u.test(text)) return 'sharedStrategy';
  if (/整理後内部メモ/u.test(text)) return 'fullMemo';
  return '';
}

function validationIssueFromMessage(message, { state, candidateIds = [], taskType = '' } = {}) {
  const text = String(message ?? '');
  const path = validationIssuePath(text);
  if (/プロンプト生成後に、本人から見えるゲーム状態が更新/u.test(text)) {
    return { code: 'STALE_PROMPT', category: 'state', path: '', message: text };
  }
  if (/対象プレイヤーが存在しません/u.test(text)) {
    return { code: 'PLAYER_NOT_FOUND', category: 'internal', path: 'playerId', message: text };
  }
  if (/行動回答の対象を一意に特定できません/u.test(text)) {
    const expectedValues = (state?.players ?? [])
      .filter((player) => candidateIds.includes(player.id))
      .map((player) => player.name);
    if (taskType === 'vote' && state?.game?.rules?.vote?.abstentionAllowed) expectedValues.push('棄権');
    return { code: 'INVALID_ACTION_TARGET', category: 'reference', path: 'actionAnswer', message: text, expectedValues };
  }
  if (/行動回答がありません/u.test(text)) {
    return { code: 'MISSING_ACTION_ANSWER', category: 'schema', path: 'actionAnswer', message: text };
  }
  if (/勝敗後のpublicSpeechがありません/u.test(text)) {
    return { code: 'MISSING_PUBLIC_SPEECH', category: 'schema', path: 'publicSpeech', message: text };
  }
  if (/modeがkeepの場合、changesは空オブジェクト/u.test(text)) {
    return { code: 'KEEP_WITH_CHANGES', category: 'semantic', path: 'decisionPatch', message: text, expectedValue: {} };
  }
  if (/modeがpatchの場合、changesへ変更項目/u.test(text)) {
    return { code: 'EMPTY_PATCH', category: 'semantic', path: 'decisionPatch', message: text };
  }
  if (/未対応|存在しません|見つかりません/u.test(text) && !path) {
    return { code: 'INTERNAL_VALIDATION_ERROR', category: 'internal', path: '', message: text };
  }
  return { code: 'SEMANTIC_VALIDATION_ERROR', category: 'semantic', path, message: text };
}

function buildValidationIssues(parseResult, errors, context) {
  const parserIssues = new Map((parseResult?.diagnostics?.issues ?? []).map((issue) => [String(issue.message ?? ''), issue]));
  return [...new Set(errors)].map((message) => parserIssues.get(message) ?? validationIssueFromMessage(message, context));
}

export function validateAiResponse(state, {
  parsed: parseResult,
  playerId,
  taskType,
  candidateIds = [],
  promptFingerprint,
  currentFingerprint,
}) {
  const parsed = parseResult?.value ?? {};
  const errors = [...(parseResult?.diagnostics?.errors ?? [])];
  const warnings = [...(parseResult?.diagnostics?.warnings ?? [])];
  const player = getPlayer(state, playerId);
  const semanticTaskType = isNormalSpeechTask(taskType) ? 'speech' : taskType;
  if (!player) errors.push('対象プレイヤーが存在しません。');
  if (promptFingerprint && currentFingerprint && promptFingerprint !== currentFingerprint) {
    errors.push('プロンプト生成後に、本人から見えるゲーム状態が更新されています。');
  }

  if (taskType === 'result-impression' && !String(parsed.publicSpeech ?? '').trim()) {
    errors.push('勝敗後のpublicSpeechがありません。');
  }
  if (semanticTaskType === 'speech' && !String(parsed.publicSpeech ?? '').trim()) {
    errors.push('通常発言のpublicSpeechがありません。');
  }
  if (taskType === 'testament' && !String(parsed.publicSpeech ?? '').trim()) {
    errors.push('遺言のpublicSpeechがありません。');
  }
  if (taskType === 'graveyard-conversation' && !String(parsed.graveyardMessage ?? '').trim()) {
    errors.push('墓場会話のgraveyardMessageがありません。');
  }

  let resolvedAction = null;
  let resolvedSpeechInteraction = null;
  let resolvedAbilityClaims = [];
  let normalizedParsedAbilityClaims = parsed.abilityClaims ?? null;
  const claimRolePolicy = buildClaimRolePolicy(
    state.players.reduce((counts, item) => {
      counts[item.roleId] = Number(counts[item.roleId] ?? 0) + 1;
      return counts;
    }, {}),
  );
  if (semanticTaskType === 'speech' && parsed.speechInteraction) {
    resolvedSpeechInteraction = validateSpeechInteraction(state, playerId, parsed, errors);
  }
  if (['speech', 'priority-answer', 'testament'].includes(semanticTaskType)) {
    if (parsed.coOperation) {
      validateCoOperation(state, playerId, parsed.coOperation, claimRolePolicy, errors);
    }
    if (parsed.abilityClaims) {
      const abilityValidation = validateAbilityClaims(state, playerId, parsed, claimRolePolicy, errors, warnings);
      resolvedAbilityClaims = abilityValidation.resolvedClaims;
      normalizedParsedAbilityClaims = abilityValidation.normalizedParsedAbilityClaims;
    }
  }
  if (taskType === 'vote' || taskType === 'wolf-attack' || isPersonalNightActionTask(taskType)) {
    if (!parsed.actionAnswer) errors.push('行動回答がありません。');
    else if (taskType === 'vote' && /^(棄権|abstain)$/iu.test(parsed.actionAnswer)) {
      if (!state.game.rules.vote.abstentionAllowed) errors.push('棄権は許可されていません。');
      else resolvedAction = { id: 'abstain', name: '棄権' };
    } else {
      const resolved = resolvePlayerName(state, parsed.actionAnswer, candidateIds);
      if (!resolved.player) errors.push('行動回答の対象を一意に特定できません。');
      else {
        resolvedAction = resolved.player;
        if (resolved.certainty !== 'exact') warnings.push(`${parsed.actionAnswer}を${resolved.player.name}として解釈しました。`);
      }
    }
  }
  if (isPersonalNightActionTask(taskType) || taskType === 'wolf-attack') {
    const rationale = String(parsed.selectionRationale ?? '').trim();
    if (rationale) {
      const sentenceLimit = taskType === 'freeze' ? 3 : 2;
      const rationaleLimit = taskType === 'freeze'
        ? MAX_FREEZE_ACTION_RATIONALE_LENGTH
        : MAX_NIGHT_ACTION_RATIONALE_LENGTH;
      if (rationale.length > rationaleLimit) {
        errors.push(`rationaleは${rationaleLimit}文字以内で記載してください。`);
      }
      const rationaleSentences = rationale.split(/[。！？!?]+/u).map((item) => item.trim()).filter(Boolean);
      if (rationaleSentences.length > sentenceLimit) {
        warnings.push(`rationaleは1～${sentenceLimit}文へ短くまとめてください。`);
      }
    }
  }
  let resolvedAttackAssessment = null;
  if (taskType === 'wolf-attack') {
    resolvedAttackAssessment = validateAttackAssessment(
      state,
      parsed,
      resolvedAction,
      candidateIds,
      errors,
      warnings,
    );
  }

  let resolvedFreezeEstimates = null;
  if (taskType === 'freeze') {
    resolvedFreezeEstimates = validateFreezeEstimates(state, playerId, parsed, resolvedAction, candidateIds, errors, warnings);
  }

  let resolvedDecisionUpdate = null;
  if (player && parsed.decisionUpdate && ['speech', 'priority-answer', 'vote', 'mason-conversation'].includes(semanticTaskType)) {
    resolvedDecisionUpdate = validateDecisionUpdate(
      state,
      player,
      parsed,
      semanticTaskType,
      resolvedAction,
      candidateIds,
      errors,
      warnings,
    );
  }

  const resolvedFactionStrategyState = validateFactionStrategy(state, player, parsed, semanticTaskType, errors, warnings);

  let resolvedNextSpeakerPreferenceId = null;
  let resolvedDiscussionPreference = null;
  let resolvedOpeningPreference = null;
  if (taskType === 'speech-designated') {
    const requestedName = String(parsed.nextSpeakerPreference ?? '').trim();
    if (requestedName) {
      const discussion = state.discussion ?? {};
      const spoken = new Set(discussion.spokenInCurrentRound ?? []);
      const candidateIds = (discussion.queue ?? [])
        .slice(Number(discussion.currentIndex ?? 0) + 1)
        .filter((id) => !spoken.has(id));
      const resolved = resolvePlayerName(state, requestedName, candidateIds);
      if (resolved.player) resolvedNextSpeakerPreferenceId = resolved.player.id;
      else warnings.push('nextSpeakerPreferenceを現在巡の未発言者として解決できないため、指名なしとして扱います。');
    }
  }
  if (taskType === 'speech-free') {
    const rawPreference = String(parsed.discussionPreference ?? '').trim().toUpperCase();
    resolvedDiscussionPreference = normalizeFreeDiscussionPreference(rawPreference);
    if (!rawPreference || resolvedDiscussionPreference !== rawPreference) warnings.push('discussionPreferenceが未指定または不正なためNORMALとして扱います。');
  }
  if (taskType === 'discussion-opening-preference') {
    resolvedOpeningPreference = String(parsed.openingPreference ?? '').trim().toUpperCase();
  }

  if (taskType === 'memo-consolidate') {
    if (!parsed.fullMemo?.trim()) errors.push('整理後内部メモがありません。');
    if (parsed.fullMemo.length > (state.game.rules.ai.maxInternalMemoLength ?? 3000)) {
      warnings.push(`整理後内部メモが文字数上限${state.game.rules.ai.maxInternalMemoLength ?? 3000}文字を超えています。`);
    }
  }
  if (parsed.internalMemoUpdate?.mode === 'add'
    && parsed.internalMemoUpdate.text.length > (state.game.rules.ai.maxInternalMemoLength ?? 3000)) {
    warnings.push(`内部メモの追記が文字数上限${state.game.rules.ai.maxInternalMemoLength ?? 3000}文字を超えています。`);
  }

  if (['speech', 'priority-answer', 'testament'].includes(semanticTaskType) && parsed.publicSpeech.length > (state.game.rules.ai.maxPublicSpeechLength ?? 450)) {
    warnings.push(`公開発言がシステムの長文警告基準${state.game.rules.ai.maxPublicSpeechLength}文字を超えています。`);
  }
  if (taskType === 'result-impression') {
    if (parsed.publicSpeech.length > MAX_RESULT_IMPRESSION_LENGTH) {
      errors.push(`勝敗後の感想は${MAX_RESULT_IMPRESSION_LENGTH}文字以内で記載してください。`);
    }
  }
  if (taskType === 'wolf-conversation') {
    const purpose = state.night?.plan?.wolfConversationPurpose ?? null;
    if (parsed.sharedStrategyPatch) {
      if (purpose === 'opening-strategy' && parsed.sharedStrategyPatch.mode !== 'patch') {
        errors.push('初夜の共有作戦でsharedStrategyを出力する場合はmodeをpatchにし、今回決める作戦をchangesへ記載してください。');
      }
      if (purpose === 'opening-strategy' && Object.hasOwn(parsed.sharedStrategyPatch.changes ?? {}, 'attackPlan')) {
        errors.push('Day 0のattackPlanはシステムがnoneへ固定するため、sharedStrategy.changesへ出力しないでください。');
      }
    }
    if (purpose === 'opening-strategy' && /(?:襲撃|噛み)(?:対象|候補|先)|護衛(?:対象|候補|先)/u.test(parsed.wolfMessage)) {
      warnings.push('Day 0は初夜襲撃が無効なため、この共有会話で襲撃対象を決めても今夜は実行されません。');
    }
  }
  if (taskType === 'mason-conversation' && parsed.masonMessage.length > (state.game.rules.ai.maxMasonMessageLength ?? 450)) {
    warnings.push(`共有者会話が文字数上限${state.game.rules.ai.maxMasonMessageLength ?? 450}文字を超えています。`);
  }
  if (taskType === 'graveyard-conversation' && parsed.graveyardMessage.length > (state.game.rules.ai.maxGraveyardMessageLength ?? 450)) {
    warnings.push(`墓場会話が文字数上限${state.game.rules.ai.maxGraveyardMessageLength ?? 450}文字を超えています。`);
  }
  if (taskType === 'wolf-conversation' && parsed.wolfMessage.length > (state.game.rules.ai.maxWolfMessageLength ?? 450)) {
    warnings.push(`人狼共有発言が文字数上限${state.game.rules.ai.maxWolfMessageLength ?? 450}文字を超えています。`);
  }
  if (parsed.heartVoice.length > (state.game.rules.ai.maxHeartVoiceLength ?? 120)) {
    warnings.push(`心の声が文字数上限${state.game.rules.ai.maxHeartVoiceLength ?? 120}文字を超えています。`);
  }
  if (taskType === 'mason-conversation' && !parsed.masonMessage.trim()) warnings.push('共有者会話が空です。');
  if (taskType === 'wolf-conversation' && !parsed.wolfMessage.trim()) warnings.push('人狼共有発言が空です。');
  if (taskType === 'graveyard-conversation' && !parsed.graveyardMessage.trim()) warnings.push('墓場会話が空です。');

  const speechText = taskType === 'mason-conversation'
    ? parsed.masonMessage
    : taskType === 'wolf-conversation'
      ? parsed.wolfMessage
      : taskType === 'graveyard-conversation'
        ? parsed.graveyardMessage
        : parsed.publicSpeech;
  if (player) {
    if (!['speech', 'testament', 'result-impression'].includes(semanticTaskType)) addCharacterWarnings(player, speechText, warnings);
    addCharacterWarnings(player, parsed.heartVoice, warnings);
  }

  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    issues: buildValidationIssues(parseResult, uniqueErrors, { state, candidateIds, taskType }),
    warnings: [...new Set(warnings)],
    resolvedAction,
    resolvedDecisionUpdate,
    resolvedSpeechInteraction,
    resolvedFactionStrategyState,
    resolvedAbilityClaims,
    normalizedParsedAbilityClaims,
    resolvedAttackAssessment,
    resolvedFreezeEstimates,
    resolvedNextSpeakerPreferenceId,
    resolvedDiscussionPreference,
    resolvedOpeningPreference,
  };
}
