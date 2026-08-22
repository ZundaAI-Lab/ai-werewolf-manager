/**
 * 責務: 墓場／共有者／人狼秘密会話、襲撃投票、夜行動、夜解決、夜明け公開を実行する。
 * 変更ルール: 秘密情報を公開状態へ混入させず、候補・行動解決・恐怖処理・機密会話の発言順は専用ポリシーを正本とする。AI失敗時のランダム代替は乱数関数を注入可能にして決定的検証を許可する。
 */

import {
  detectWinner,
  getAliveWolfIds,
  getAttackCandidates,
  getNightActionCandidates,
  getPlayer,
  inspectResult,
} from '../game/standardRules.js';
import { buildNightPlan } from './nightPlanner.js';
import {
  canWolfConversationSpeakerTakeTurn,
  createWolfConversationProgress,
  consumeWolfConversationSpeech,
  getWolfConversationEligibleSpeakerIds,
  isWolfConversationComplete,
} from './wolfConversationPolicy.js';
import {
  canMasonConversationSpeakerTakeTurn,
  createMasonConversationProgress,
  consumeMasonConversationSpeech,
  getMasonConversationEligibleSpeakerIds,
  isMasonConversationComplete,
} from './masonConversationPolicy.js';
import {
  canGraveyardConversationSpeakerTakeTurn,
  createGraveyardConversationProgress,
  consumeGraveyardConversationSpeech,
  getGraveyardConversationEligibleSpeakerIds,
  isGraveyardConversationComplete,
} from './graveyardConversationPolicy.js';
import { resolveNightActions } from './nightResolution.js';
import { applyResolvedFearStatuses } from './actionExecutionPolicy.js';
import { createEvent } from '../events/eventStore.js';
import {
  createId,
  nowIso,
} from '../../shared/utils.js';
import { rebuildPublicDerivedState } from '../events/publicDerivation.js';
import {
  applyInternalMemoryUpdate,
  recordSelectionRationale,
  voidSelectionRationalesForDay,
} from '../memory/memoryLedger.js';
import { createEmptyFactionStrategyState } from '../game/factionStrategyState.js';
import {
  countsAsWolf,
  getFactionStrategyProfile,
  getPlayerTeam,
} from '../roles/roleAttributes.js';
import { markRoleActionSelected } from '../roles/roleState.js';
import {
  requestMandatoryRestorePoint,
  RESTORE_POINT_TYPES,
} from '../correction/restorePointPolicy.js';


import {
  result,
  commandGuard,
  setPhase,
  setHeartVoice,
  resolveDecisionUpdateForCommit,
  cloneSharedStrategyPatch,
  recordAiTurn,
  freezeKnowledge,
} from '../game/gameRuntimeShared.js';
import { initializeDiscussion } from '../discussion/discussionRuntime.js';
import { detectGameResult } from '../result/resultRuntime.js';

export function createEmptyWolfSharedStrategy(purpose = 'attack-planning') {
  return {
    claimPlan: '',
    blackReceivedPlan: '',
    partnerExecutionPlan: '',
    collapsePlan: '',
    discussionPlan: '',
    attackPlan: purpose === 'opening-strategy' ? 'none' : '',
    updatedAt: null,
    updatedByPlayerId: null,
  };
}

export function normalizeWolfSharedStrategyPatch(update) {
  if (!update) return null;
  const mode = String(update.mode ?? '');
  const changes = Object.fromEntries(
    Object.entries(update.changes ?? {})
      .filter(([key]) => ['claimPlan', 'blackReceivedPlan', 'partnerExecutionPlan', 'collapsePlan', 'discussionPlan', 'attackPlan'].includes(key))
      .map(([key, value]) => [key, String(value ?? '').trim()]),
  );
  return { mode, changes };
}

export function mergeWolfSharedStrategy(session, update, speakerId) {
  if (!update || update.mode === 'keep') return;
  const next = { ...session.sharedStrategy };
  Object.entries(update.changes ?? {}).forEach(([key, value]) => {
    next[key] = value;
  });
  if (session.purpose === 'opening-strategy') next.attackPlan = 'none';
  next.updatedAt = nowIso();
  next.updatedByPlayerId = speakerId;
  session.sharedStrategy = next;
}

export function initializeNight(state, day = state.game.day, plan = buildNightPlan(state, day)) {
  state.players.forEach((player) => {
    player.statusEffects = (player.statusEffects ?? []).filter((effect) => !(effect.type === 'frozen' && Number(effect.day) <= Number(day)));
  });
  state.game.day = day;
  setPhase(state, 'night');
  let graveyardConversationId = null;
  if (plan.graveyardConversationRequired) {
    const conversationProgress = createGraveyardConversationProgress(
      plan.graveyardConversationParticipantIds,
      state.game.rules.graveyardCommunication.speechCountPerNight,
    );
    const session = {
      id: createId('graveyard-chat'),
      day,
      status: 'open',
      participantIds: [...plan.graveyardConversationParticipantIds],
      messages: [],
      ...conversationProgress,
      summary: '',
      createdAt: nowIso(),
      closedAt: null,
    };
    state.graveyardConversations.push(session);
    graveyardConversationId = session.id;
  }

  let masonConversationId = null;
  if (plan.masonConversationRequired) {
    const conversationProgress = createMasonConversationProgress(
      plan.masonConversationParticipantIds,
      state.game.rules.masonCommunication.speechCountPerNight,
    );
    const session = {
      id: createId('mason-chat'),
      day,
      status: 'open',
      participantIds: [...plan.masonConversationParticipantIds],
      messages: [],
      ...conversationProgress,
      summary: '',
      createdAt: nowIso(),
      closedAt: null,
    };
    state.masonConversations.push(session);
    masonConversationId = session.id;
  }

  let wolfConversationId = null;
  if (plan.wolfConversationRequired) {
    const conversationProgress = createWolfConversationProgress(
      plan.wolfConversationParticipantIds,
      state.game.rules.wolfCommunication.speechCountPerNight,
    );
    const session = {
      id: createId('wolf-chat'),
      day,
      purpose: plan.wolfConversationPurpose,
      status: 'open',
      participantIds: [...plan.wolfConversationParticipantIds],
      messages: [],
      ...conversationProgress,
      sharedStrategy: createEmptyWolfSharedStrategy(plan.wolfConversationPurpose),
      summary: '',
      createdAt: nowIso(),
      closedAt: null,
    };
    state.wolfConversations.push(session);
    wolfConversationId = session.id;
  }
  const voterWolfIds = getAliveWolfIds(state);
  const attackStatus = plan.wolfAttackRequired
    ? (plan.wolfConversationRequired ? 'waiting-conversation' : 'voting')
    : 'not-required';
  state.night = {
    day,
    status: plan.graveyardConversationRequired || plan.masonConversationRequired || plan.wolfConversationRequired ? 'conversation' : 'input',
    aliveAtStartIds: [...plan.aliveAtStartIds],
    plan: {
      ownerSelectionRequired: plan.ownerSelectionRequired,
      graveyardConversationRequired: plan.graveyardConversationRequired,
      graveyardConversationParticipantIds: [...plan.graveyardConversationParticipantIds],
      masonConversationRequired: plan.masonConversationRequired,
      masonConversationParticipantIds: [...plan.masonConversationParticipantIds],
      wolfConversationRequired: plan.wolfConversationRequired,
      wolfConversationPurpose: plan.wolfConversationPurpose,
      wolfAttackRequired: plan.wolfAttackRequired,
      inspectActorIds: [...plan.inspectActorIds],
      guardActorIds: [...plan.guardActorIds],
      visitActorIds: [...plan.visitActorIds],
      freezeActorIds: [...plan.freezeActorIds],
      mediumResultRecipientIds: [...plan.mediumResultRecipientIds],
    },
    currentSlotIndex: 0,
    graveyardConversationId,
    masonConversationId,
    wolfConversationId,
    wolfAttack: {
      conversationId: wolfConversationId,
      voterWolfIds,
      voteByWolfId: Object.fromEntries(voterWolfIds.map((id) => [id, null])),
      rationaleByWolfId: Object.fromEntries(voterWolfIds.map((id) => [id, ''])),
      overrideByWolfId: Object.fromEntries(voterWolfIds.map((id) => [id, null])),
      tally: { countsByTargetId: {}, topTargetIds: [], resolutionMethod: null },
      finalTargetId: null,
      status: attackStatus,
    },
    slots: plan.slots.map((slot) => ({ ...slot })),
    resolution: null,
  };
  state.executionResolution = null;

  state.night.slots.filter((slot) => slot.status === 'gm-override').forEach((slot) => {
    createEvent(state, {
      type: 'night-action',
      actorId: slot.actorId,
      targetIds: [slot.targetId],
      audience: { type: 'player', targetIds: [slot.actorId] },
      payload: { actionType: slot.type, targetId: slot.targetId, nightDay: day, override: slot.override },
    });
  });
}

export function getActiveGraveyardConversationSession(state) {
  return state.graveyardConversations.find((session) => session.id === state.night?.graveyardConversationId) ?? null;
}

function syncNightConversationStatus(state) {
  const open = [
    getActiveGraveyardConversationSession(state),
    getActiveMasonConversationSession(state),
    getActiveWolfConversationSession(state),
  ].some((session) => session?.status === 'open');
  state.night.status = open ? 'conversation' : 'input';
}

export function finishGraveyardConversationSession(state, session) {
  session.status = 'closed';
  session.closedAt = nowIso();
  session.summary = session.messages.slice(-8).map((message) => `${getPlayer(state, message.speakerId)?.name ?? '不明'}: ${message.content}`).join(' / ');
  syncNightConversationStatus(state);
}

export function recordGraveyardMessage(state, {
  speakerId,
  content,
  heartVoice = '',
  internalMemoUpdate = null,
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  warnings = [],
}) {
  const guard = commandGuard(state, { phases: ['night'] });
  if (guard) return guard;
  const session = getActiveGraveyardConversationSession(state);
  if (!session || session.status !== 'open') return result(false, '墓場会話は開かれていません。');
  const speaker = getPlayer(state, speakerId);
  if (!speaker || speaker.alive) return result(false, '墓場会話は死亡者だけが参加できます。');
  if (!session.participantIds.includes(speakerId)) return result(false, 'このプレイヤーは今夜の墓場会話参加者ではありません。');
  if (!getGraveyardConversationEligibleSpeakerIds(session).includes(speakerId)) return result(false, 'このプレイヤーの墓場会話発言回数は残っていません。');
  if (!canGraveyardConversationSpeakerTakeTurn(session, speakerId)) return result(false, '他に発言可能な死亡者がいるため、同じ死亡者は連続して発言できません。');
  const text = String(content ?? '').trim();
  if (!text) return result(false, '墓場会話の発言を入力してください。');
  const message = {
    id: createId('graveyard-message'),
    sessionId: session.id,
    speakerId,
    type: text === 'なし' ? 'pass' : 'message',
    content: text,
    sequence: session.messages.length + 1,
    source: rawResponse ? 'ai' : 'human',
    aiTurnId: null,
    timestamp: nowIso(),
  };
  session.messages.push(message);
  consumeGraveyardConversationSpeech(session, speakerId);
  setHeartVoice(state, speakerId, heartVoice);
  const event = createEvent(state, {
    type: 'graveyard-conversation',
    actorId: speakerId,
    audience: { type: 'participants', targetIds: [...session.participantIds] },
    payload: { conversationId: session.id, messageId: message.id, content: message.content },
  });
  if (rawResponse) {
    const turn = recordAiTurn(state, {
      taskType: 'graveyard-conversation',
      playerId: speakerId,
      promptText,
      promptFingerprint,
      promptMode,
      publicSequenceAtGeneration,
      rawResponse,
      generationRun,
      parsedGraveyardConversationMessage: message.content,
      parsedHeartVoice: heartVoice,
      parsedInternalMemoUpdate: internalMemoUpdate,
      warnings,
      committedEntityIds: [message.id, event.id],
    });
    message.aiTurnId = turn.id;
    applyInternalMemoryUpdate(state, speakerId, internalMemoUpdate, turn.id);
  } else {
    applyInternalMemoryUpdate(state, speakerId, internalMemoUpdate);
  }
  if (isGraveyardConversationComplete(session)) {
    finishGraveyardConversationSession(state, session);
    return result(true, '墓場会話の発言を登録し、設定された発言回数を完了しました。', { messageId: message.id, eventId: event.id, conversationCompleted: true });
  }
  return result(true, '墓場会話の発言を登録しました。', { messageId: message.id, eventId: event.id, conversationCompleted: false });
}

export function closeGraveyardConversation(state) {
  const guard = commandGuard(state, { phases: ['night'] });
  if (guard) return guard;
  const session = getActiveGraveyardConversationSession(state);
  if (!session || session.status !== 'open') return result(false, '開いている墓場会話がありません。');
  finishGraveyardConversationSession(state, session);
  return result(true, '墓場会話を終了しました。');
}

export function getActiveMasonConversationSession(state) {
  return state.masonConversations.find((session) => session.id === state.night?.masonConversationId) ?? null;
}

export function finishMasonConversationSession(state, session) {
  session.status = 'closed';
  session.closedAt = nowIso();
  session.summary = session.messages.slice(-8).map((message) => `${getPlayer(state, message.speakerId)?.name ?? '不明'}: ${message.content}`).join(' / ');
  syncNightConversationStatus(state);
}

export function recordMasonMessage(state, {
  speakerId,
  content,
  heartVoice = '',
  internalMemoUpdate = null,
  decisionUpdate = null,
  parsedDecisionUpdate = null,
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  warnings = [],
}) {
  const guard = commandGuard(state, { phases: ['night'] });
  if (guard) return guard;
  const session = getActiveMasonConversationSession(state);
  if (!session || session.status !== 'open') return result(false, '共有者共有会話は開かれていません。');
  if (!session.participantIds.includes(speakerId)) return result(false, 'このプレイヤーは共有者共有会話の参加者ではありません。');
  if (!getMasonConversationEligibleSpeakerIds(session).includes(speakerId)) return result(false, 'このプレイヤーの共有発言回数は残っていません。');
  if (!canMasonConversationSpeakerTakeTurn(session, speakerId)) return result(false, '他に発言可能な共有者がいるため、同じ共有者は連続して発言できません。');
  const text = String(content ?? '').trim();
  if (!text) return result(false, '共有発言を入力してください。');
  const committedDecisionUpdate = resolveDecisionUpdateForCommit(state, speakerId, decisionUpdate, {
    taskType: 'mason-conversation',
  });
  const message = {
    id: createId('mason-message'),
    sessionId: session.id,
    speakerId,
    type: text === 'なし' ? 'pass' : 'message',
    content: text,
    sequence: session.messages.length + 1,
    source: rawResponse ? 'ai' : 'human',
    aiTurnId: null,
    timestamp: nowIso(),
  };
  session.messages.push(message);
  consumeMasonConversationSpeech(session, speakerId);
  setHeartVoice(state, speakerId, heartVoice);
  const event = createEvent(state, {
    type: 'mason-conversation',
    actorId: speakerId,
    audience: { type: 'participants', targetIds: [...session.participantIds] },
    payload: { conversationId: session.id, messageId: message.id, content: message.content },
  });
  if (rawResponse) {
    const turn = recordAiTurn(state, {
      taskType: 'mason-conversation-message',
      playerId: speakerId,
      promptText,
      promptFingerprint,
      promptMode,
      publicSequenceAtGeneration,
      rawResponse,
      generationRun,
      parsedMasonConversationMessage: message.content,
      parsedHeartVoice: heartVoice,
      parsedInternalMemoUpdate: internalMemoUpdate,
      parsedDecisionUpdate: parsedDecisionUpdate ?? null,
      resolvedDecisionUpdate: committedDecisionUpdate,
      warnings,
      committedEntityIds: [message.id, event.id],
    });
    message.aiTurnId = turn.id;
    applyInternalMemoryUpdate(state, speakerId, internalMemoUpdate, turn.id);
    rebuildPublicDerivedState(state);
  } else {
    applyInternalMemoryUpdate(state, speakerId, internalMemoUpdate);
  }
  if (isMasonConversationComplete(session)) {
    finishMasonConversationSession(state, session);
    return result(true, '共有者共有発言を登録し、設定された発言回数を完了しました。', { messageId: message.id, eventId: event.id, conversationCompleted: true });
  }
  return result(true, '共有者共有発言を登録しました。', { messageId: message.id, eventId: event.id, conversationCompleted: false });
}

export function closeMasonConversation(state) {
  const guard = commandGuard(state, { phases: ['night'] });
  if (guard) return guard;
  const session = getActiveMasonConversationSession(state);
  if (!session || session.status !== 'open') return result(false, '開いている共有者共有会話がありません。');
  finishMasonConversationSession(state, session);
  return result(true, '共有者共有会話を終了しました。');
}

export function getActiveWolfConversationSession(state) {
  return state.wolfConversations.find((session) => session.id === state.night?.wolfConversationId) ?? null;
}

export function finishWolfConversationSession(state, session) {
  session.status = 'closed';
  session.closedAt = nowIso();
  session.summary = session.messages.slice(-8).map((message) => `${getPlayer(state, message.speakerId)?.name ?? '不明'}: ${message.content}`).join(' / ');
  syncNightConversationStatus(state);
  if (state.night.plan.wolfAttackRequired) state.night.wolfAttack.status = 'voting';
}

export function recordWolfMessage(state, {
  speakerId,
  content,
  sharedStrategyPatch = null,
  heartVoice = '',
  internalMemoUpdate = null,
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  warnings = [],
}) {
  const guard = commandGuard(state, { phases: ['night'] });
  if (guard) return guard;
  const session = getActiveWolfConversationSession(state);
  if (!session || session.status !== 'open') return result(false, '人狼共有会話は開かれていません。');
  if (!session.participantIds.includes(speakerId)) return result(false, 'このプレイヤーは共有会話参加者ではありません。');
  if (!getWolfConversationEligibleSpeakerIds(session).includes(speakerId)) return result(false, 'このプレイヤーの共有発言回数は残っていません。');
  if (!canWolfConversationSpeakerTakeTurn(session, speakerId)) return result(false, '他に発言可能な人狼がいるため、同じ人狼は連続して発言できません。');
  const text = String(content ?? '').trim();
  if (!text) return result(false, '共有発言を入力してください。');
  const normalizedSharedStrategyPatch = normalizeWolfSharedStrategyPatch(sharedStrategyPatch);
  const message = {
    id: createId('wolf-message'),
    sessionId: session.id,
    speakerId,
    type: text === 'なし' ? 'pass' : 'message',
    content: text,
    sequence: session.messages.length + 1,
    source: rawResponse ? 'ai' : 'human',
    aiTurnId: null,
    timestamp: nowIso(),
  };
  session.messages.push(message);
  consumeWolfConversationSpeech(session, speakerId);
  mergeWolfSharedStrategy(session, normalizedSharedStrategyPatch, speakerId);
  setHeartVoice(state, speakerId, heartVoice);
  const event = createEvent(state, {
    type: 'wolf-conversation',
    actorId: speakerId,
    audience: { type: 'participants', targetIds: [...session.participantIds] },
    payload: {
      conversationId: session.id,
      messageId: message.id,
      content: message.content,
      purpose: session.purpose,
      sharedStrategyPatch: normalizedSharedStrategyPatch
        ? { mode: normalizedSharedStrategyPatch.mode, changes: { ...normalizedSharedStrategyPatch.changes } }
        : null,
    },
  });
  if (rawResponse) {
    const turn = recordAiTurn(state, {
      taskType: 'wolf-conversation-message',
      playerId: speakerId,
      promptText,
      promptFingerprint,
      promptMode,
      publicSequenceAtGeneration,
      rawResponse,
      generationRun,
      parsedWolfConversationMessage: message.content,
      parsedSharedStrategyPatch: cloneSharedStrategyPatch(normalizedSharedStrategyPatch),
      parsedHeartVoice: heartVoice,
      parsedInternalMemoUpdate: internalMemoUpdate,
      warnings,
      committedEntityIds: [message.id, event.id],
    });
    message.aiTurnId = turn.id;
    applyInternalMemoryUpdate(state, speakerId, internalMemoUpdate, turn.id);
  } else {
    applyInternalMemoryUpdate(state, speakerId, internalMemoUpdate);
  }
  if (isWolfConversationComplete(session)) {
    finishWolfConversationSession(state, session);
    return result(true, '人狼共有発言を登録し、設定された発言回数を完了しました。', { messageId: message.id, eventId: event.id, conversationCompleted: true });
  }
  return result(true, '人狼共有発言を登録しました。', { messageId: message.id, eventId: event.id, conversationCompleted: false });
}

export function closeWolfConversation(state) {
  const guard = commandGuard(state, { phases: ['night'] });
  if (guard) return guard;
  const session = getActiveWolfConversationSession(state);
  if (!session || session.status !== 'open') return result(false, '開いている人狼共有会話がありません。');
  finishWolfConversationSession(state, session);
  return result(true, '共有会話を終了しました。');
}

export function reopenWolfConversation(state) {
  const guard = commandGuard(state, { phases: ['night'] });
  if (guard) return guard;
  const session = getActiveWolfConversationSession(state);
  if (!session) return result(false, '共有会話がありません。');
  if (isWolfConversationComplete(session)) return result(false, '全参加者が設定された共有発言回数を使い切っています。');
  const attack = state.night.wolfAttack;
  if (attack.status !== 'not-required' && Object.values(attack.voteByWolfId ?? {}).some(Boolean)) {
    return result(false, '襲撃投票開始後は共有会話を再開できません。');
  }
  session.status = 'open';
  session.closedAt = null;
  state.night.status = 'conversation';
  if (attack.status !== 'not-required') {
    voidSelectionRationalesForDay(state, state.night.day, 'wolf-attack');
    attack.status = 'waiting-conversation';
    attack.finalTargetId = null;
    attack.voteByWolfId = Object.fromEntries(attack.voterWolfIds.map((id) => [id, null]));
    attack.rationaleByWolfId = Object.fromEntries(attack.voterWolfIds.map((id) => [id, '']));
    attack.overrideByWolfId = Object.fromEntries(attack.voterWolfIds.map((id) => [id, null]));
    attack.tally = { countsByTargetId: {}, topTargetIds: [], resolutionMethod: null };
  }
  return result(true, '共有会話を再開しました。');
}

export function chooseRandomItem(items, random = Math.random) {
  const values = [...items];
  if (!values.length) return null;
  const raw = Number(random?.() ?? 0);
  const ratio = Number.isFinite(raw) ? Math.min(0.999999999, Math.max(0, raw)) : 0;
  return values[Math.floor(ratio * values.length)] ?? values[0];
}

export function finalizeWolfAttackVote(state, { random = Math.random } = {}) {
  const attack = state.night?.wolfAttack;
  if (!attack || attack.status !== 'voting') return result(false, '現在は襲撃投票を集計できません。');
  const missingWolfId = attack.voterWolfIds.find((id) => !attack.voteByWolfId?.[id]);
  if (missingWolfId) return result(false, '未投票の生存人狼がいます。', { missingWolfId });
  requestMandatoryRestorePoint(state, RESTORE_POINT_TYPES.BEFORE_ATTACK_FINALIZE);

  const countsByTargetId = {};
  attack.voterWolfIds.forEach((wolfId) => {
    const targetId = attack.voteByWolfId[wolfId];
    countsByTargetId[targetId] = (countsByTargetId[targetId] ?? 0) + 1;
  });
  const entries = Object.entries(countsByTargetId);
  if (!entries.length) return result(false, '襲撃票がありません。');
  const maxVotes = Math.max(...entries.map(([, count]) => count));
  const topTargetIds = entries.filter(([, count]) => count === maxVotes).map(([targetId]) => targetId);
  const finalTargetId = topTargetIds.length === 1 ? topTargetIds[0] : chooseRandomItem(topTargetIds, random);
  if (!finalTargetId) return result(false, '同率候補から襲撃対象を決定できません。');

  attack.tally = {
    countsByTargetId,
    topTargetIds,
    resolutionMethod: topTargetIds.length === 1 ? 'plurality' : 'random-tie',
  };
  attack.finalTargetId = finalTargetId;
  attack.status = 'confirmed';
  return result(true, topTargetIds.length === 1
    ? '最多票の襲撃対象を確定しました。'
    : '最多同率候補からランダムに襲撃対象を確定しました。', {
    finalTargetId,
    tally: attack.tally,
  });
}

export function recordWolfAttackVote(state, {
  actorId,
  targetId,
  heartVoice = '',
  internalMemoUpdate = null,
  selectionRationale = '',
  parsedAttackAssessment = null,
  resolvedAttackAssessment = null,
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  warnings = [],
  override = null,
  random = Math.random,
} = {}) {
  const guard = commandGuard(state, { phases: ['night'] });
  if (guard) return guard;
  const attack = state.night?.wolfAttack;
  if (!attack || attack.status !== 'voting') return result(false, '現在は襲撃先投票を入力できません。');
  if (!attack.voterWolfIds.includes(actorId)) return result(false, 'このプレイヤーに襲撃投票権はありません。');
  if (attack.voteByWolfId?.[actorId]) return result(false, 'この人狼はすでに襲撃先へ投票しています。');
  const actor = getPlayer(state, actorId);
  if (!actor?.alive || !countsAsWolf(state, actor)) return result(false, '生存人狼だけが襲撃先へ投票できます。');
  if (!getAttackCandidates(state).some((player) => player.id === targetId)) return result(false, '襲撃できない対象です。');
  const rationale = String(selectionRationale ?? '').trim();
  const willFinalizeAttack = attack.voterWolfIds.every((wolfId) => wolfId === actorId || Boolean(attack.voteByWolfId?.[wolfId]));
  if (willFinalizeAttack) requestMandatoryRestorePoint(state, RESTORE_POINT_TYPES.BEFORE_ATTACK_FINALIZE);

  attack.voteByWolfId[actorId] = targetId;
  attack.rationaleByWolfId[actorId] = rationale;
  attack.overrideByWolfId[actorId] = override ? structuredClone(override) : null;
  setHeartVoice(state, actorId, heartVoice);

  let sourceTurnId = null;
  if (rawResponse) {
    const turn = recordAiTurn(state, {
      taskType: 'wolf-attack',
      playerId: actorId,
      promptText,
      promptFingerprint,
      promptMode,
      publicSequenceAtGeneration,
      rawResponse,
      generationRun,
      parsedHeartVoice: heartVoice,
      parsedInternalMemoUpdate: internalMemoUpdate,
      parsedActionAnswer: targetId,
      parsedSelectionRationale: rationale,
      parsedAttackAssessment,
      resolvedAttackAssessment,
      warnings,
      override,
      committedEntityIds: [],
    });
    sourceTurnId = turn.id;
    applyInternalMemoryUpdate(state, actorId, internalMemoUpdate, turn.id);
  } else {
    applyInternalMemoryUpdate(state, actorId, internalMemoUpdate);
  }
  if (rationale) {
    recordSelectionRationale(state, actorId, {
      ...(sourceTurnId ? { id: `wolf-attack-rationale:${sourceTurnId}` } : {}),
      taskType: 'wolf-attack',
      day: state.night.day,
      phase: 'night',
      targetId,
      rationale,
      sourceAiTurnId: sourceTurnId,
    });
  }

  const pendingWolfId = attack.voterWolfIds.find((id) => !attack.voteByWolfId[id]);
  if (pendingWolfId) return result(true, '襲撃先への秘密投票を登録しました。', { pendingWolfId });
  return finalizeWolfAttackVote(state, { random });
}

export function forceWolfAttackVote(state, actorId, targetId, reason) {
  const overrideReason = String(reason ?? '').trim();
  if (!overrideReason) return result(false, 'GM代理入力の理由を記載してください。');
  return recordWolfAttackVote(state, {
    actorId,
    targetId,
    override: { applied: true, type: 'gm-proxy', selectedBy: 'gm', reason: overrideReason },
  });
}

export function recordRandomWolfAttackVote(state, actorId, reason = 'AI回答を正常に取得できないためランダム抽選', { random = Math.random } = {}) {
  const candidates = getAttackCandidates(state);
  const target = chooseRandomItem(candidates, random);
  if (!target) return result(false, '襲撃候補がありません。');
  return recordWolfAttackVote(state, {
    actorId,
    targetId: target.id,
    override: {
      applied: true,
      type: 'random-fallback',
      selectedBy: 'system',
      reason: String(reason ?? '').trim() || 'AI回答を正常に取得できないためランダム抽選',
      candidateIds: candidates.map((player) => player.id),
      selectedTargetId: target.id,
    },
    random,
  });
}

export function recordNightAction(state, {
  slotId,
  actorId,
  targetId,
  heartVoice = '',
  internalMemoUpdate = null,
  selectionRationale = '',
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  estimatedWerewolfIds = [],
  predictedAttackTargetIds = [],
  warnings = [],
  override = null,
}) {
  const guard = commandGuard(state, { phases: ['night'] });
  if (guard) return guard;
  const slot = state.night?.slots.find((item) => item.id === slotId);
  if (!slot || slot.status !== 'pending' || slot.actorId !== actorId) return result(false, '対象の夜行動スロットがありません。');
  const candidates = getNightActionCandidates(state, slot.type, actorId);
  if (!candidates.some((player) => player.id === targetId)) return result(false, '選択できない対象です。');
  const rationale = String(selectionRationale ?? '').trim();
  slot.targetId = targetId;
  slot.status = override ? 'gm-override' : 'submitted';
  slot.override = override;
  slot.rationale = rationale;
  const target = getPlayer(state, targetId);
  if (slot.type === 'choose-owner') {
    markRoleActionSelected(getPlayer(state, actorId), slot.type, target, getPlayerTeam(state, target));
  } else {
    markRoleActionSelected(getPlayer(state, actorId), slot.type, target);
  }
  setHeartVoice(state, actorId, heartVoice);
  const event = createEvent(state, {
    type: 'night-action',
    actorId,
    targetIds: [targetId],
    audience: { type: 'player', targetIds: [actorId] },
    payload: { actionType: slot.type, targetId, nightDay: state.night.day, rationale, override },
  });
  let sourceTurnId = null;
  if (rawResponse) {
    const turn = recordAiTurn(state, {
      taskType: slot.type,
      playerId: actorId,
      promptText,
      promptFingerprint,
      promptMode,
      publicSequenceAtGeneration,
      rawResponse,
      generationRun,
      parsedHeartVoice: heartVoice,
      parsedInternalMemoUpdate: internalMemoUpdate,
      parsedActionAnswer: targetId,
      parsedSelectionRationale: rationale,
      estimatedWerewolfIds,
      predictedAttackTargetIds,
      warnings,
      override,
      committedEntityIds: [slot.id, event.id],
    });
    sourceTurnId = turn.id;
    slot.aiTurnId = turn.id;
    event.payload.sourceAiTurnId = turn.id;
    applyInternalMemoryUpdate(state, actorId, internalMemoUpdate, turn.id);
  } else {
    applyInternalMemoryUpdate(state, actorId, internalMemoUpdate);
  }
  if (rationale) {
    recordSelectionRationale(state, actorId, {
      id: `action-rationale:${event.id}`,
      taskType: slot.type,
      day: state.night.day,
      phase: 'night',
      targetId,
      rationale,
      sourceAiTurnId: sourceTurnId,
      sourceEventId: event.id,
    });
  }
  if (slot.type === 'choose-owner') {
    const actor = getPlayer(state, actorId);
    actor.factionStrategyState = createEmptyFactionStrategyState(getFactionStrategyProfile(state, actor));
    freezeKnowledge(state);
    createEvent(state, {
      type: 'private-result',
      actorId,
      targetIds: [targetId],
      audience: { type: 'player', targetIds: [actorId] },
      payload: {
        actionType: 'choose-owner',
        targetId,
        ownerRoleId: target.roleId,
        resolvedTeam: actor.roleState.resolvedTeam,
        availableFromDay: 0,
      },
    });
    initializeNight(state, state.night.day, buildNightPlan(state, state.night.day));
    return result(true, '家主と所属陣営を確定し、初夜の通常行動へ進みました。', { eventId: event.id });
  }
  return result(true, '夜行動を登録しました。', { eventId: event.id });
}

export function recordRandomNightAction(state, slotId, reason = 'AI回答を正常に取得できないためランダム決定', { random = Math.random } = {}) {
  const slot = state.night?.slots.find((item) => item.id === slotId);
  if (!slot || slot.status !== 'pending') return result(false, '対象の夜行動スロットがありません。');
  const candidates = getNightActionCandidates(state, slot.type, slot.actorId);
  if (!candidates.length) return result(false, '有効な対象がありません。');
  const target = candidates[Math.floor(random() * candidates.length)];
  return recordNightAction(state, {
    slotId,
    actorId: slot.actorId,
    targetId: target.id,
    override: { applied: true, reason, selectedBy: 'random' },
  });
}

export function canResolveNight(state) {
  if (!state.night) return false;
  if (state.night.plan.graveyardConversationRequired && getActiveGraveyardConversationSession(state)?.status !== 'closed') return false;
  if (state.night.plan.masonConversationRequired && getActiveMasonConversationSession(state)?.status !== 'closed') return false;
  if (state.night.plan.wolfConversationRequired && getActiveWolfConversationSession(state)?.status !== 'closed') return false;
  if (state.night.plan.wolfAttackRequired && state.night.wolfAttack.status !== 'confirmed') return false;
  return state.night.slots.every((slot) => ['submitted', 'waived-by-rule', 'gm-override'].includes(slot.status));
}

export function resolveNight(state, random = Math.random) {
  const guard = commandGuard(state, { phases: ['night'] });
  if (guard) return guard;
  if (!canResolveNight(state)) return result(false, '未完了の夜行動があります。');
  requestMandatoryRestorePoint(state, RESTORE_POINT_TYPES.BEFORE_NIGHT_RESOLVE);
  const submitted = (type) => state.night.slots.filter((slot) => slot.type === type && ['submitted', 'gm-override'].includes(slot.status));
  const inspectSlots = submitted('inspect');
  const guardSlots = submitted('guard');
  const visitSlots = submitted('visit');
  const freezeSlots = submitted('freeze');
  const attackedTargetId = state.night.plan.wolfAttackRequired ? state.night.wolfAttack.finalTargetId : null;
  const nightResolution = resolveNightActions(state, {
    attackedTargetId,
    guardSlots,
    inspectSlots,
    visitSlots,
    freezeSlots,
    random,
  });
  const deadPlayerIds = nightResolution.deaths.map((death) => death.playerId);
  const privateResults = inspectSlots.map((slot) => ({
    actorId: slot.actorId,
    actionType: 'inspect',
    targetId: slot.targetId,
    result: inspectResult(state, slot.targetId),
  }));
  const frozenNames = nightResolution.frozenPlayerId
    ? [getPlayer(state, nightResolution.frozenPlayerId)?.name ?? '不明']
    : [];
  const deathText = deadPlayerIds.length
    ? `昨夜、${deadPlayerIds.map((id) => getPlayer(state, id)?.name ?? '不明').join('、')}が死亡しました。`
    : '昨夜、死亡者はいませんでした。';
  const freezeText = frozenNames.length
    ? `${frozenNames.join('、')}は凍結され、本日の昼会話と投票に参加できません。`
    : '';
  const publicAnnouncement = state.night.day === 0 && !state.night.plan.wolfAttackRequired && !deadPlayerIds.length && !frozenNames.length
    ? null
    : `${deathText}${freezeText}`;
  const aliveAfterResolution = state.players.filter((player) => player.alive && !deadPlayerIds.includes(player.id));

  state.night.resolution = {
    attackedTargetId: nightResolution.attackedTargetId,
    guardedTargetIds: nightResolution.guardedTargetIds,
    successfulGuardActorIds: nightResolution.successfulGuardActorIds,
    deaths: nightResolution.deaths,
    attackOutcome: nightResolution.attackOutcome,
    statusApplications: nightResolution.statusApplications,
    actionExecutions: nightResolution.actionExecutions,
    freezeActorId: nightResolution.freezeActorId,
    freezeTargetId: nightResolution.freezeTargetId,
    freezeOutcome: nightResolution.freezeOutcome,
    frozenPlayerId: nightResolution.frozenPlayerId,
    inspectedFoxIds: nightResolution.inspectedFoxIds,
    catCollateralWolfId: nightResolution.catCollateralWolfId,
    privateResults,
    gmNotes: nightResolution.gmNotes,
    publicAnnouncement,
    winnerPreview: detectWinner(state, aliveAfterResolution),
  };
  state.night.status = 'resolved';
  setPhase(state, 'dawn');
  return result(true, '夜行動を同時解決しました。夜明け内容を確認してください。');
}

export function deliverNightPrivateResults(state, nextDay, deadIds) {
  const deliverToDead = state.game.rules.nightResolution.deliverPrivateResultToDeadPlayer;
  state.night.resolution.privateResults.forEach((entry) => {
    const actor = getPlayer(state, entry.actorId);
    const diedTonight = deadIds.includes(entry.actorId);
    if (!actor || (diedTonight && !deliverToDead)) return;
    createEvent(state, {
      type: 'private-result',
      actorId: entry.actorId,
      targetIds: [entry.targetId],
      audience: { type: 'player', targetIds: [entry.actorId] },
      payload: { ...entry, availableFromDay: nextDay, nightDay: state.night.day },
    });
  });

  state.mediumResults.forEach((entry) => {
    if (entry.delivered || entry.availableFromDay > nextDay) return;
    const medium = getPlayer(state, entry.mediumId);
    const diedTonight = deadIds.includes(entry.mediumId);
    if (!medium || !medium.alive || diedTonight) {
      entry.expired = true;
      return;
    }
    const event = createEvent(state, {
      type: 'private-result',
      actorId: entry.mediumId,
      targetIds: [entry.executedPlayerId],
      audience: { type: 'player', targetIds: [entry.mediumId] },
      payload: { actionType: 'medium', targetId: entry.executedPlayerId, result: entry.result, availableFromDay: entry.availableFromDay },
    });
    entry.delivered = true;
    entry.eventId = event.id;
  });
}

export function publishDawn(state) {
  const guard = commandGuard(state, { phases: ['dawn'] });
  if (guard) return guard;
  if (!state.night?.resolution) return result(false, '公開できる夜明け結果がありません。');
  requestMandatoryRestorePoint(state, RESTORE_POINT_TYPES.BEFORE_DAWN_PUBLISH);
  const resolution = state.night.resolution;
  const nextDay = state.night.day + 1;
  const deadPlayerIds = resolution.deaths.map((death) => death.playerId);
  resolution.deaths.forEach((death) => {
    const player = getPlayer(state, death.playerId);
    if (!player) return;
    player.alive = false;
    player.death = { day: nextDay, phase: 'dawn', cause: death.cause, announced: true };
  });
  applyResolvedFearStatuses(state, resolution, deadPlayerIds);
  state.game.day = nextDay;
  if (resolution.frozenPlayerId && !deadPlayerIds.includes(resolution.frozenPlayerId)) {
    const frozen = getPlayer(state, resolution.frozenPlayerId);
    frozen.statusEffects.push({ type: 'frozen', day: nextDay, sourcePlayerId: resolution.freezeActorId });
  }
  deliverNightPrivateResults(state, nextDay, deadPlayerIds);
  let event = null;
  if (resolution.publicAnnouncement) {
    event = createEvent(state, {
      type: 'dawn',
      targetIds: [...deadPlayerIds],
      audience: { type: 'public', targetIds: [] },
      payload: { text: resolution.publicAnnouncement, deadPlayerIds: [...deadPlayerIds], frozenPlayerIds: resolution.frozenPlayerId ? [resolution.frozenPlayerId] : [] },
      status: 'published',
    });
  } else {
    createEvent(state, {
      type: 'system',
      audience: { type: 'gm', targetIds: [] },
      payload: { text: '初日夜の非公開処理が完了しました。' },
    });
  }
  const winner = detectWinner(state);
  if (winner) detectGameResult(state, winner);
  else initializeDiscussion(state);
  return result(true, resolution.publicAnnouncement ? '夜明け結果を公開しました。' : '初日夜の処理を完了し、昼議論へ進みました。', { eventId: event?.id ?? null });
}
