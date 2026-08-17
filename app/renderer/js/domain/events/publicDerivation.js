/**
 * 責務: 公開イベントからCO・公開能力結果・3巡目CO後の追加発言対象を再構築し、AI私有ターン台帳から本人自身の判断状態だけを決定的に再構築する。
 * 変更ルール: 公開発言本文を解析しない。公開事実とAI私有情報を同じイベントへ混在させず、判断状態はaiTurns.resolvedDecisionUpdateだけを一次情報源とする。DOM・保存・ゲーム進行操作を行わない。
 */

import { validatePublicAbilityClaim } from '../policies/publicAbilityClaimPolicy.js';
import { createEmptyDecisionState, deriveDecisionTransition } from '../game/decisionState.js';

function bySequence(a, b) {
  return Number(a.sequence ?? 0) - Number(b.sequence ?? 0);
}

function publicSpeechEvents(state) {
  return (state.events ?? [])
    .filter((event) => event.type === 'public-speech' && event.audience?.type === 'public')
    .sort(bySequence);
}

function structuredOf(event) {
  return event.payload?.structured ?? {};
}

function validCoOperation(value) {
  const action = String(value?.action ?? 'none');
  const roleId = action === 'none' ? 'none' : String(value?.roleId ?? 'none');
  return { action, roleId };
}

export function rebuildRoleClaims(state) {
  const claims = [];
  const activeByActor = new Map();

  publicSpeechEvents(state).forEach((event) => {
    const operation = validCoOperation(structuredOf(event).coOperation);
    if (!['declare', 'change', 'withdraw'].includes(operation.action)) return;

    if (event.status === 'voided') {
      if (['declare', 'change'].includes(operation.action)) {
        claims.push({
          id: `claim:${event.id}`,
          actorId: event.actorId,
          roleId: operation.roleId,
          day: event.day,
          status: 'voided',
          sourceEventId: event.id,
          withdrawnByEventId: null,
          voidedByEventId: event.voidedByEventId ?? null,
        });
      }
      return;
    }
    if (event.status !== 'published') return;

    const previous = activeByActor.get(event.actorId);
    if (previous && ['change', 'withdraw'].includes(operation.action)) {
      previous.status = 'withdrawn';
      previous.withdrawnByEventId = event.id;
      activeByActor.delete(event.actorId);
    }
    if (operation.action === 'declare' && previous) {
      // 不正状態でも再構築を停止せず、後発COへ置き換えて監査可能にする。
      previous.status = 'withdrawn';
      previous.withdrawnByEventId = event.id;
      activeByActor.delete(event.actorId);
    }
    if (['declare', 'change'].includes(operation.action)) {
      const claim = {
        id: `claim:${event.id}`,
        actorId: event.actorId,
        roleId: operation.roleId,
        day: event.day,
        status: 'active',
        sourceEventId: event.id,
        withdrawnByEventId: null,
        voidedByEventId: null,
      };
      claims.push(claim);
      activeByActor.set(event.actorId, claim);
    }
  });

  state.claims = claims;
  return claims;
}

export function rebuildPublicAbilityClaims(state) {
  const claims = [];
  publicSpeechEvents(state).forEach((event) => {
    const eventClaims = structuredOf(event).abilityClaims ?? [];
    eventClaims.forEach((claim, index) => {
      if (!claim || claim.action !== 'publish') return;
      claims.push({
        id: `ability-claim:${event.id}:${index}`,
        actorId: event.actorId,
        claimedRoleId: claim.claimedRoleId ?? claim.roleId,
        actionType: claim.actionType,
        targetId: claim.targetId,
        result: claim.result,
        observedDay: Number(claim.observedDay),
        announcedDay: Number(event.day),
        selectionBasis: claim.selectionBasis,
        evidenceEventIds: [...(claim.evidenceEventIds ?? [])],
        selectionReasonAtTime: String(claim.selectionReasonAtTime ?? ''),
        sourceEventId: event.id,
        sourceClaimIndex: index,
        status: event.status === 'voided' ? 'voided' : 'active',
        voidedByEventId: event.status === 'voided' ? event.voidedByEventId ?? null : null,
      });
    });
  });
  state.publicAbilityClaims = claims;
  return claims;
}

const DECISION_STATE_SOURCE_TASK_TYPES = new Set([
  'speech',
  'speech-fallback',
  'priority-answer',
  'priority-answer-fallback',
  'vote',
  'mason-conversation-message',
]);

function cloneDecisionUpdateForDerivation(update) {
  return {
    ...update,
    suspicionCandidateIds: [...(update.suspicionCandidateIds ?? [])],
    executionCandidateIds: [...(update.executionCandidateIds ?? [])],
    changedFields: [...(update.changedFields ?? [])],
    keyPublicEvidenceEventIds: [...(update.keyPublicEvidenceEventIds ?? [])],
  };
}

function committedPublicDecisionEvent(state, turn) {
  const committedIds = new Set(turn.committedEntityIds ?? []);
  return (state.events ?? [])
    .filter((event) => committedIds.has(event.id))
    .find((event) => ['public-speech', 'vote-cast'].includes(event.type)) ?? null;
}

export function rebuildPlayerDecisionStates(state) {
  (state.players ?? []).forEach((player) => {
    player.decisionState = createEmptyDecisionState();
  });
  (state.aiTurns ?? [])
    .filter((turn) => turn?.resolvedDecisionUpdate && DECISION_STATE_SOURCE_TASK_TYPES.has(turn.taskType))
    .forEach((turn) => {
      const update = cloneDecisionUpdateForDerivation(turn.resolvedDecisionUpdate);
      const player = state.players.find((item) => item.id === turn.playerId);
      if (!player) return;
      const nextDecision = {
        suspicionCandidateIds: [...(update.suspicionCandidateIds ?? [])],
        executionCandidateIds: [...(update.executionCandidateIds ?? [])],
        intendedVoteId: update.intendedVoteId ?? null,
        assessmentLevel: String(update.assessmentLevel ?? 'unresolved'),
        keyPublicEvidenceEventIds: [...(update.keyPublicEvidenceEventIds ?? [])],
        leaveAliveBenefit: String(update.leaveAliveBenefit ?? ''),
        misexecutionCost: String(update.misexecutionCost ?? ''),
        selectionDifference: String(update.selectionDifference ?? ''),
        uncertainty: String(update.uncertainty ?? ''),
        nextDiscriminatingInformation: String(update.nextDiscriminatingInformation ?? ''),
        decisionReason: String(update.decisionReason ?? '').trim(),
        revisionCause: String(update.revisionCause ?? 'unchanged'),
      };
      const resolvedDecision = {
        ...nextDecision,
        ...deriveDecisionTransition(player.decisionState, nextDecision, {
          hasPreviousDecision: Boolean(player.decisionState?.updatedAt),
        }),
      };
      const sourceEvent = committedPublicDecisionEvent(state, turn);
      player.decisionState = {
        ...resolvedDecision,
        updatedAt: turn.timestamp ?? null,
        sourceAiTurnId: turn.id,
        sourceEventId: sourceEvent?.id ?? null,
        sourceDay: Number(turn.day ?? sourceEvent?.day ?? 0),
      };
    });
}

function coReason(state, event, operation) {
  const name = state.players.find((player) => player.id === event.actorId)?.name ?? 'プレイヤー';
  if (operation.action === 'declare') return `${name}が新しく役職COしました。`;
  if (operation.action === 'change') return `${name}がCO役職を変更しました。`;
  if (operation.action === 'withdraw') return `${name}が役職COを撤回しました。`;
  return '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function orderAlivePlayerIds(state, playerIds) {
  const targetIds = new Set(unique(playerIds ?? []));
  return (state.players ?? [])
    .filter((player) => player.alive && targetIds.has(player.id))
    .map((player) => player.id);
}

export function rebuildDiscussionReconsideration(state, { deterministicTimestamps = false } = {}) {
  const discussion = state.discussion;
  if (!discussion || state.game.phase !== 'discussion') return null;
  const previous = discussion.reconsideration ?? {};
  const handledRound = Number(previous.handledRound ?? 0);
  const aliveIds = new Set((state.players ?? []).filter((player) => player.alive).map((player) => player.id));
  const items = [];

  publicSpeechEvents(state)
    .filter((event) => event.status === 'published' && Number(event.day) === Number(discussion.day ?? state.game.day))
    .forEach((event) => {
      const eventRound = Number(event.payload?.round ?? 0);
      if (eventRound !== 3 || eventRound <= handledRound) return;
      const operation = validCoOperation(structuredOf(event).coOperation);
      const reason = coReason(state, event, operation);
      if (!reason) return;

      const remainingAtSpeechStart = event.payload?.opportunityContext?.remainingByPlayerAtSpeechStart;
      if (!remainingAtSpeechStart || typeof remainingAtSpeechStart !== 'object' || Array.isArray(remainingAtSpeechStart)) return;
      const targetPlayerIds = orderAlivePlayerIds(
        state,
        Object.entries(remainingAtSpeechStart)
          .filter(([playerId, count]) => playerId !== event.actorId && aliveIds.has(playerId) && count !== null && Number(count) <= 0)
          .map(([playerId]) => playerId),
      );
      if (!targetPlayerIds.length) return;
      items.push({
        id: `reconsideration:${event.id}:co`,
        type: operation.action === 'declare' ? 'new-co' : operation.action === 'change' ? 'co-change' : 'co-withdraw',
        sourceEventId: event.id,
        targetPlayerIds,
        reason,
      });
    });

  const affectedPlayerIds = orderAlivePlayerIds(
    state,
    items.flatMap((item) => item.targetPlayerIds ?? []),
  );
  const sourceEventIds = unique(items.map((item) => item.sourceEventId));
  const sourceUpdatedAt = sourceEventIds
    .map((eventId) => (state.events ?? []).find((event) => event.id === eventId))
    .map((event) => event?.publishedAt ?? event?.createdAt ?? null)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  discussion.reconsideration = {
    pending: Boolean(items.length && affectedPlayerIds.length),
    active: Boolean(previous.active && items.length),
    items,
    reasons: unique(items.map((item) => item.reason)),
    sourceEventIds,
    affectedPlayerIds,
    updatedAt: items.length
      ? (deterministicTimestamps ? sourceUpdatedAt : new Date().toISOString())
      : previous.updatedAt ?? null,
    handledRound: previous.handledRound ?? null,
  };
  return discussion.reconsideration;
}


export function validatePublicStructuredHistory(state) {
  const errors = [];
  const activeRoleByActor = new Map();
  const activeEvents = publicSpeechEvents(state).filter((event) => event.status === 'published');
  activeEvents.forEach((event) => {
    const operation = validCoOperation(structuredOf(event).coOperation);
    const before = activeRoleByActor.get(event.actorId) ?? null;
    if (operation.action === 'declare') {
      if (before) errors.push(`#${event.sequence}: すでにCO中の人物がdeclareを使用しています。`);
      activeRoleByActor.set(event.actorId, operation.roleId);
    } else if (operation.action === 'change') {
      if (!before) errors.push(`#${event.sequence}: COしていない人物がchangeを使用しています。`);
      else if (before === operation.roleId) errors.push(`#${event.sequence}: 現在と同じ役職へのchangeが指定されています。`);
      activeRoleByActor.set(event.actorId, operation.roleId);
    } else if (operation.action === 'withdraw') {
      if (!before) errors.push(`#${event.sequence}: COしていない人物がwithdrawを使用しています。`);
      activeRoleByActor.delete(event.actorId);
    }

    const eventClaims = structuredOf(event).abilityClaims ?? [];
    const validatedClaims = [];
    eventClaims.forEach((claim, index) => {
      if (claim?.action !== 'publish') return;
      validatePublicAbilityClaim(state, {
        actorId: event.actorId,
        claim,
        activeRoleId: activeRoleByActor.get(event.actorId) ?? null,
        announcedDay: event.day,
        excludeSourceEventId: event.id,
        additionalClaims: validatedClaims,
      }).forEach((message) => errors.push(`#${event.sequence} 能力履歴${index + 1}: ${message}`));
      validatedClaims.push({ ...claim, actorId: event.actorId });
    });
  });
  return [...new Set(errors)];
}

export function rebuildPublicDerivedState(state, { deterministicTimestamps = false } = {}) {
  rebuildRoleClaims(state);
  rebuildPublicAbilityClaims(state);
  rebuildPlayerDecisionStates(state);
  rebuildDiscussionReconsideration(state, { deterministicTimestamps });
  return state;
}
