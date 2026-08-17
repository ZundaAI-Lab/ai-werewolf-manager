/**
 * 責務: AI本人から見える構造化盤面・個人情報・本人の正式行動理由・本人が公開した能力結果理由・最新判断・本人限定陣営戦略・共有情報・墓場の死亡時点公開情報を抽出し、次の通常発言者本人宛ての未解決質問を通常発言タスクへ統合して、プロンプト鮮度判定用フィンガープリントを生成する。
 * 変更ルール: 状態を書き換えない。他人の内部メモ・心の声・陣営戦略、GM専用情報、非参加会話を返さない。公開配役構成はroleComposition.jsを正本とし、役職欠け後も開始前に固定した公開構成を使用する。継続アンカー・当日カプセル・AIターン履歴を参照せず、正式状態から現在必要な本人情報だけを抽出する。永続判断状態は現在盤面向けへ射影したコピーだけを返し、公開発言と確定公開事項は種類別に一度だけ抽出する。correctionLineageIdsは実際に複数イベントから成る訂正系列だけへ付与し、未訂正発言へ自己IDだけの系列を付けない。通常発言へ統合する質問はpriorityAnswerPolicy.jsが決定した構造化質問だけを使用し、本文解析や独自の発言順判定を行わない。 保存済みheartVoiceと雪女の過去estimateは状態・監査用途に保持しても、次回プロンプトへ再投入しない。
 */

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';
import { ROLE_DEFINITIONS } from '../../config/constants.js';
import { buildPromptCallNameRows } from '../../characters/callNames/callNameResolver.js';
import { getPublishedPublicEvents, getVisibleEvents } from '../../domain/events/eventStore.js';
import { collectCorrectionLineageIds, getCorrectionRootEvent } from '../../domain/events/correctionLineage.js';
import { getAlivePlayers, getDeadPlayers, getPlayer } from '../../domain/game/standardRules.js';
import { getFactionStrategyProfile, getPlayerTeam } from '../../domain/roles/roleAttributes.js';
import { getPublicRoleComposition } from '../../domain/roles/roleComposition.js';
import { isFrozenOnDay } from '../../domain/game/playerStatus.js';
import {
  canIncludeCurrentGraveyardConversation,
  canIncludeCurrentMasonConversation,
  canIncludeCurrentWolfConversation,
  canIncludePastGraveyardConversation,
  canIncludePastMasonConversation,
  canIncludePastWolfConversation,
  canIncludePrivateEvent,
} from '../policies/promptAccessPolicy.js';
import { hashText, stableStringify } from '../../shared/utils.js';
import { buildPublicClaimTimingFacts } from '../../domain/discussion/discussionOpportunity.js';
import { getAbilityEvidenceCutoffs } from '../../domain/policies/abilityClaimTimelinePolicy.js';
import { listPendingMediumClaimRequirements } from '../../domain/policies/publicAbilityClaimPolicy.js';
import { buildDecisionTargetPolicy, getCurrentDecisionProjection } from '../../domain/game/decisionTargetPolicy.js';
import { buildResultImpressionContext } from '../../domain/result/resultImpressions.js';
import { buildWolfPartnerPublicPositionContext } from './wolfPartnerPublicPositionContext.js';
import { buildZashikiWarashiStrategy } from '../../domain/game/zashikiWarashiStrategy.js';
import {
  getCurrentNormalSpeechAnswerTasks,
  getPendingPriorityAnswerTasks,
} from '../../domain/discussion/priorityAnswerPolicy.js';

function compactEvent(event) {
  return {
    id: event.id,
    sequence: event.sequence,
    day: event.day,
    phase: event.phase,
    type: event.type,
    actorId: event.actorId,
    targetIds: [...(event.targetIds ?? [])],
    audience: {
      type: event.audience?.type ?? null,
      targetIds: [...(event.audience?.targetIds ?? [])],
    },
    payload: event.payload,
    status: event.status,
  };
}

function bySequence(a, b) {
  return Number(a?.sequence ?? 0) - Number(b?.sequence ?? 0);
}

function correctedPublicSpeeches(state, publicEvents) {
  return publicEvents
    .filter((event) => event.type === 'public-speech')
    .map((event) => {
      const root = getCorrectionRootEvent(state.events, event) ?? event;
      const correctionLineageIds = collectCorrectionLineageIds(state.events, event);
      return {
        ...compactEvent(event),
        sequence: root.sequence,
        day: root.day,
        phase: root.phase,
        ...(correctionLineageIds.length > 1 ? { correctionLineageIds } : {}),
      };
    })
    .sort(bySequence);
}

function publicTimeline(state, publicEvents) {
  const speeches = correctedPublicSpeeches(state, publicEvents);
  const correctionTargets = new Set(
    publicEvents
      .filter((event) => event.type === 'correction' && event.payload?.targetEventId)
      .map((event) => event.payload.targetEventId),
  );
  const category = (type) => publicEvents.filter((event) => event.type === type).map(compactEvent);
  return {
    speeches,
    voteResults: category('vote-finalized'),
    executions: category('execution'),
    dawns: category('dawn'),
    corrections: publicEvents
      .filter((event) => event.type === 'correction')
      .map(compactEvent),
    gameResults: category('game-result'),
    other: publicEvents
      .filter((event) => ![
        'public-speech', 'vote-finalized', 'execution', 'dawn', 'correction', 'game-result',
      ].includes(event.type))
      .filter((event) => !correctionTargets.has(event.id))
      .map(compactEvent),
  };
}


function playerDeathPublicSequence(state, playerId) {
  const event = [...getPublishedPublicEvents(state)]
    .sort(bySequence)
    .find((item) => ['execution', 'dawn'].includes(item.type) && (item.payload?.deadPlayerIds ?? []).includes(playerId));
  return event ? Number(event.sequence ?? 0) : Number(state.game.eventSequence ?? 0);
}

function publicKnowledgeForTask(state, playerId, taskType) {
  const all = [...getPublishedPublicEvents(state)].sort(bySequence);
  if (taskType !== 'graveyard-conversation') {
    return { publicEvents: all, cutoffSequence: Number(state.game.eventSequence ?? 0), frozenAtDeath: false };
  }
  const cutoffSequence = playerDeathPublicSequence(state, playerId);
  return {
    publicEvents: all.filter((event) => Number(event.sequence ?? 0) <= cutoffSequence),
    cutoffSequence,
    frozenAtDeath: true,
  };
}

function claimsAtSequence(state, cutoffSequence) {
  const eventSequence = (eventId) => Number(state.events.find((event) => event.id === eventId)?.sequence ?? Number.POSITIVE_INFINITY);
  return (state.claims ?? [])
    .filter((claim) => eventSequence(claim.sourceEventId) <= cutoffSequence)
    .map((claim) => {
      const withdrawn = claim.withdrawnByEventId && eventSequence(claim.withdrawnByEventId) <= cutoffSequence;
      const voided = claim.voidedByEventId && eventSequence(claim.voidedByEventId) <= cutoffSequence;
      return { ...claim, status: voided ? 'voided' : withdrawn ? 'withdrawn' : 'active', withdrawnByEventId: withdrawn ? claim.withdrawnByEventId : null, voidedByEventId: voided ? claim.voidedByEventId : null };
    })
    .filter((claim) => claim.status === 'active');
}

function abilityClaimsAtSequence(state, cutoffSequence) {
  const eventSequence = (eventId) => Number(state.events.find((event) => event.id === eventId)?.sequence ?? Number.POSITIVE_INFINITY);
  return (state.publicAbilityClaims ?? [])
    .filter((claim) => eventSequence(claim.sourceEventId) <= cutoffSequence)
    .map((claim) => {
      const voided = claim.voidedByEventId && eventSequence(claim.voidedByEventId) <= cutoffSequence;
      return { ...claim, status: voided ? 'voided' : 'active', voidedByEventId: voided ? claim.voidedByEventId : null };
    })
    .filter((claim) => claim.status !== 'voided');
}

function currentGraveyardConversation(state, playerId, taskType) {
  const conversationId = state.night?.graveyardConversationId;
  const session = state.graveyardConversations.find((item) => item.id === conversationId) ?? null;
  const visible = canIncludeCurrentGraveyardConversation(state, playerId, session, taskType);
  if (!visible) return { current: null, currentVisible: false };
  return {
    currentVisible: true,
    current: {
      id: session.id,
      day: session.day,
      participantIds: [...session.participantIds],
      speechCountPerParticipant: session.speechCountPerParticipant,
      remainingByParticipant: { ...session.remainingByParticipant },
      messages: [...session.messages].sort(bySequence).map((message) => ({ id: message.id, speakerId: message.speakerId, content: message.content, sequence: message.sequence })),
    },
  };
}

function pastGraveyardConversations(state, playerId, taskType) {
  const currentConversationId = state.night?.graveyardConversationId ?? null;
  const sessions = [...state.graveyardConversations]
    .filter((session) => session.id !== currentConversationId && session.status === 'closed')
    .filter((session) => canIncludePastGraveyardConversation(state, playerId, session, taskType))
    .sort((a, b) => Number(a.day ?? 0) - Number(b.day ?? 0) || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  const latestId = sessions.at(-1)?.id ?? null;
  const past = sessions.map((session) => ({
    id: session.id,
    day: session.day,
    participantIds: [...session.participantIds],
    summary: session.summary || [...session.messages].sort(bySequence).slice(-8).map((message) => message.content).join(' / '),
    messages: session.id === latestId
      ? [...session.messages].sort(bySequence).map((message) => ({ id: message.id, speakerId: message.speakerId, content: message.content, sequence: message.sequence }))
      : [],
  }));
  return { past, pastVisible: past.length > 0 };
}

function currentMasonConversation(state, playerId, taskType) {
  const conversationId = state.night?.masonConversationId;
  const session = state.masonConversations.find((item) => item.id === conversationId) ?? null;
  const visible = canIncludeCurrentMasonConversation(state, playerId, session, taskType);
  if (!visible) return { current: null, currentVisible: false };
  return {
    currentVisible: true,
    current: {
      id: session.id,
      day: session.day,
      participantIds: [...session.participantIds],
      speechCountPerParticipant: session.speechCountPerParticipant,
      remainingByParticipant: { ...session.remainingByParticipant },
      messages: [...session.messages].sort(bySequence).map((message) => ({
        id: message.id,
        speakerId: message.speakerId,
        content: message.content,
        sequence: message.sequence,
      })),
    },
  };
}

function pastMasonConversations(state, playerId) {
  const currentConversationId = state.night?.masonConversationId ?? null;
  const sessions = [...state.masonConversations]
    .filter((session) => session.id !== currentConversationId)
    .filter((session) => session.status === 'closed')
    .filter((session) => canIncludePastMasonConversation(state, playerId, session))
    .sort((a, b) => Number(a.day ?? 0) - Number(b.day ?? 0) || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    .map((session) => ({
      id: session.id,
      day: session.day,
      summary: session.summary || [...session.messages].sort(bySequence).slice(-8).map((message) => message.content).join(' / '),
    }));
  return { past: sessions, pastVisible: sessions.length > 0 };
}

function currentWolfConversation(state, playerId, taskType) {
  const conversationId = state.night?.wolfConversationId;
  const session = state.wolfConversations.find((item) => item.id === conversationId) ?? null;
  const visible = canIncludeCurrentWolfConversation(state, playerId, session, taskType);
  if (!visible) return { current: null, currentVisible: false };
  return {
    currentVisible: true,
    current: {
      id: session.id,
      day: session.day,
      purpose: session.purpose,
      sharedStrategy: { ...(session.sharedStrategy ?? {}) },
      participantIds: [...session.participantIds],
      speechCountPerParticipant: session.speechCountPerParticipant,
      remainingByParticipant: { ...session.remainingByParticipant },
      messages: [...session.messages].sort(bySequence).map((message) => ({
        id: message.id,
        speakerId: message.speakerId,
        content: message.content,
        sequence: message.sequence,
      })),
    },
  };
}

function pastWolfConversations(state, playerId) {
  const currentConversationId = state.night?.wolfConversationId ?? null;
  const sessions = [...state.wolfConversations]
    .filter((session) => session.id !== currentConversationId)
    .filter((session) => session.status === 'closed')
    .filter((session) => canIncludePastWolfConversation(state, playerId, session))
    .sort((a, b) => Number(a.day ?? 0) - Number(b.day ?? 0) || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    .map((session) => ({
      id: session.id,
      day: session.day,
      purpose: session.purpose,
      sharedStrategy: { ...(session.sharedStrategy ?? {}) },
      summary: session.summary || [...session.messages].sort(bySequence).slice(-8).map((message) => message.content).join(' / '),
    }));
  return { past: sessions, pastVisible: sessions.length > 0 };
}

function latestOwnFreezeJudgment(state, player) {
  if (player?.roleId !== 'snowWoman') return null;
  const turn = [...(state.aiTurns ?? [])]
    .reverse()
    .find((item) => item.playerId === player.id && item.taskType === 'freeze');
  if (!turn) return null;
  return {
    nightDay: Number(turn.day ?? 0),
    targetId: turn.parsedActionAnswer ?? null,
    actionRationale: String(turn.parsedActionRationale ?? ''),
  };
}

export function buildPlayerVisibleContext(state, playerId, { taskType = 'speech', validTargetIds = [], slotId = '' } = {}) {
  const player = getPlayer(state, playerId);
  if (!player) throw new Error('対象プレイヤーが存在しません。');
  const knowledgeWindow = publicKnowledgeForTask(state, playerId, taskType);
  const publicEvents = knowledgeWindow.publicEvents;
  const timeline = publicTimeline(state, publicEvents);
  const visiblePrivateEvents = getVisibleEvents(state, playerId)
    .filter((event) => canIncludePrivateEvent(state, playerId, event))
    .filter((event) => taskType !== 'graveyard-conversation' || event.type === 'graveyard-conversation' || Number(event.sequence ?? 0) <= knowledgeWindow.cutoffSequence)
    .sort(bySequence);
  const abilityResults = visiblePrivateEvents.filter((event) => event.type === 'private-result').map(compactEvent);
  const votes = visiblePrivateEvents.filter((event) => event.type === 'vote-cast').map(compactEvent);
  const nightActions = visiblePrivateEvents.filter((event) => event.type === 'night-action').map(compactEvent);
  const personalNotifications = visiblePrivateEvents
    .filter((event) => !['role-notified', 'private-result', 'vote-cast', 'night-action', 'wolf-conversation', 'mason-conversation', 'graveyard-conversation'].includes(event.type))
    .map(compactEvent);
  const knowledge = state.playerKnowledge[playerId] ?? {
    knownWolfIds: [], knownMadmanIds: [], knownMasonIds: [], roleNotifiedAt: null, knowledgeRevision: 0,
  };
  const currentGraveyard = currentGraveyardConversation(state, playerId, taskType);
  const pastGraveyard = pastGraveyardConversations(state, playerId, taskType);
  const currentMason = currentMasonConversation(state, playerId, taskType);
  const pastMason = pastMasonConversations(state, playerId);
  const currentWolf = currentWolfConversation(state, playerId, taskType);
  const pastWolf = pastWolfConversations(state, playerId);
  const activeClaims = taskType === 'graveyard-conversation'
    ? claimsAtSequence(state, knowledgeWindow.cutoffSequence)
    : state.claims.filter((claim) => claim.status === 'active').map((claim) => ({ ...claim }));
  const activePublicAbilityClaims = taskType === 'graveyard-conversation'
    ? abilityClaimsAtSequence(state, knowledgeWindow.cutoffSequence)
    : state.publicAbilityClaims.filter((claim) => claim.status !== 'voided').map((claim) => ({ ...claim }));
  const decisionProjection = getCurrentDecisionProjection(state, playerId, {
    taskType,
    candidateIds: validTargetIds,
  });
  const claimTimingFacts = buildPublicClaimTimingFacts({
    speeches: timeline.speeches,
    claims: activeClaims,
    publicAbilityClaims: activePublicAbilityClaims,
  });
  const priorityAnswerTask = taskType === 'priority-answer'
    ? getPendingPriorityAnswerTasks(state).find((task) => task.questionEventId === slotId && task.targetPlayerId === playerId) ?? null
    : null;
  const normalSpeechAnswers = isNormalSpeechTask(taskType)
    ? getCurrentNormalSpeechAnswerTasks(state, playerId).map((task) => ({
      questionEventId: task.questionEventId,
      questionSequence: task.questionSequence,
      askerId: task.askerPlayerId,
      askerName: getPlayer(state, task.askerPlayerId)?.name ?? task.askerPlayerId,
      questionText: task.questionText,
    }))
    : [];
  if (taskType === 'priority-answer' && !priorityAnswerTask) {
    throw new Error('現在の回答優先タスクを特定できません。');
  }
  const priorityAnswer = priorityAnswerTask
    ? {
      questionEventId: priorityAnswerTask.questionEventId,
      questionSequence: priorityAnswerTask.questionSequence,
      askerId: priorityAnswerTask.askerPlayerId,
      askerName: getPlayer(state, priorityAnswerTask.askerPlayerId)?.name ?? priorityAnswerTask.askerPlayerId,
      questionText: priorityAnswerTask.questionText,
    }
    : null;

  return {
    player: {
      id: player.id,
      name: player.name,
      aliases: [...(player.aliases ?? [])],
      controller: player.controller,
      aiContextStatus: player.aiContextStatus,
      roleId: player.roleId,
      role: ROLE_DEFINITIONS[player.roleId],
      team: getPlayerTeam(state, player),
      strategyProfile: getFactionStrategyProfile(state, player),
      roleState: player.roleState ? JSON.parse(JSON.stringify(player.roleState)) : null,
      isFrozenToday: isFrozenOnDay(state, player.id),
      character: player.character,
      privateInfo: player.privateInfo,
      internalMemory: {
        summary: String(player.internalMemory?.summary ?? ''),
        notes: [...(player.internalMemory?.notes ?? [])].map((note) => ({ ...note })),
        lastConsolidatedAt: player.internalMemory?.lastConsolidatedAt ?? null,
        consolidationRecommended: Boolean(player.internalMemory?.consolidationRecommended),
      },
      memoryLedger: {
        privateFacts: [...(player.memoryLedger?.privateFacts ?? [])].map((item) => ({ ...item })),
        publicCommitments: [...(player.memoryLedger?.publicCommitments ?? [])].map((item) => ({ ...item })),
        actionRationales: [...(player.memoryLedger?.actionRationales ?? [])].map((item) => ({ ...item })),
        pendingDiscriminators: [...(player.memoryLedger?.pendingDiscriminators ?? [])].map((item) => ({ ...item })),
        updatedAt: player.memoryLedger?.updatedAt ?? null,
      },
      decisionState: {
        ...decisionProjection.state,
        decisionReason: decisionProjection.displayDecisionReason,
      },
      decisionInvalidation: { ...decisionProjection.invalidation },
      factionStrategyState: player.factionStrategyState ? { ...player.factionStrategyState } : null,
      zashikiStrategy: buildZashikiWarashiStrategy(state, player),
      knowledge: {
        knownWolfIds: [...(knowledge.knownWolfIds ?? [])],
        knownMadmanIds: [...(knowledge.knownMadmanIds ?? [])],
        knownMasonIds: [...(knowledge.knownMasonIds ?? [])],
        knownOwnerId: knowledge.knownOwnerId ?? null,
        knownOwnerRoleId: knowledge.knownOwnerRoleId ?? null,
        resolvedTeam: knowledge.resolvedTeam ?? null,
        roleNotifiedAt: knowledge.roleNotifiedAt,
        knowledgeRevision: knowledge.knowledgeRevision,
      },
    },
    callNames: {
      enabled: Boolean(state.game.rules.callNames?.enabled),
      rows: buildPromptCallNameRows(state, playerId),
    },
    game: {
      id: state.game.id,
      day: state.game.day,
      phase: state.game.phase,
      status: state.game.status,
      rules: state.game.rules,
      roleComposition: getPublicRoleComposition(state),
      publicRevision: taskType === 'graveyard-conversation' ? knowledgeWindow.cutoffSequence : state.publicRevision,
      vote: taskType === 'graveyard-conversation' ? null : state.voteSession ? {
        id: state.voteSession.id,
        round: state.voteSession.round,
        type: state.voteSession.type,
        status: state.voteSession.status,
        candidateIds: [...state.voteSession.candidateIds],
        parentSessionId: state.voteSession.parentSessionId ?? null,
        triggerVoteResultEventId: state.voteSession.triggerVoteResultEventId ?? null,
      } : null,
      discussion: taskType === 'graveyard-conversation' ? null : state.discussion ? {
        mode: state.discussion.mode,
        round: state.discussion.round,
        roundKind: state.discussion.roundKind ?? 'normal',
        roundStartedAtSequence: Number(state.discussion.roundStartedAtSequence ?? 0),
        roundEligiblePlayerIds: [...(state.discussion.roundEligiblePlayerIds ?? [])],
        currentIndex: Number(state.discussion.currentIndex ?? 0),
        queue: [...(state.discussion.queue ?? [])],
        remainingByPlayer: { ...(state.discussion.remainingByPlayer ?? {}) },
        spokenInCurrentRound: [...(state.discussion.spokenInCurrentRound ?? [])],
        deferredCountByPlayer: { ...(state.discussion.deferredCountByPlayer ?? {}) },
        designatedPlayerId: state.discussion.designatedPlayerId ?? null,
        completed: Boolean(state.discussion.completed),
        reconsideration: {
          pending: Boolean(state.discussion.reconsideration?.pending),
          active: Boolean(state.discussion.reconsideration?.active),
          reasons: [...(state.discussion.reconsideration?.reasons ?? [])],
          affectedPlayerIds: [...(state.discussion.reconsideration?.affectedPlayerIds ?? [])],
        },
      } : null,
    },
    board: {
      alive: getAlivePlayers(state).map((item) => ({ id: item.id, name: item.name, frozen: isFrozenOnDay(state, item.id) })),
      dead: getDeadPlayers(state).map((item) => ({ id: item.id, name: item.name, death: item.death ? { day: item.death.day, phase: item.death.phase } : null })),
      claims: activeClaims,
      publicAbilityClaims: activePublicAbilityClaims,
      publicTimeline: timeline,
      claimTimingFacts,
      abilityEvidenceCutoffs: taskType === 'graveyard-conversation' ? {} : getAbilityEvidenceCutoffs(state),
      pendingMediumClaimRequirements: taskType === 'graveyard-conversation' ? [] : listPendingMediumClaimRequirements(state, playerId),
    },
    private: {
      abilityResults,
      personalNotifications,
    },
    ownHistory: {
      votes,
      nightActions,
      roleClaims: (taskType === 'graveyard-conversation' ? activeClaims : state.claims).filter((claim) => claim.actorId === playerId).map((claim) => ({ ...claim })),
      publishedAbilityClaims: activePublicAbilityClaims
        .filter((claim) => claim.actorId === playerId)
        .map((claim) => ({
          ...claim,
          evidenceEventIds: [...(claim.evidenceEventIds ?? [])],
        })),
      actionRationales: [...(player.memoryLedger?.actionRationales ?? [])]
        .filter((item) => item.active !== false)
        .map((item) => ({ ...item })),
      latestFreezeJudgment: latestOwnFreezeJudgment(state, player),
    },
    graveyardCommunication: {
      ...currentGraveyard,
      ...pastGraveyard,
      knowledgeCutoffSequence: knowledgeWindow.cutoffSequence,
      frozenAtDeath: knowledgeWindow.frozenAtDeath,
    },
    masonCommunication: {
      ...currentMason,
      ...pastMason,
    },
    wolfCommunication: {
      ...currentWolf,
      ...pastWolf,
    },
    wolfPartnerPublicPositions: taskType === 'graveyard-conversation' ? [] : buildWolfPartnerPublicPositionContext(state, playerId),
    task: {
      type: taskType,
      validTargetIds: [...validTargetIds],
      decisionTargetPolicy: buildDecisionTargetPolicy(state, playerId, { taskType, candidateIds: validTargetIds }),
      wolfConversationPurpose: state.night?.plan?.wolfConversationPurpose
        ?? currentWolf.current?.purpose
        ?? null,
      wolfAttackRequired: Boolean(state.night?.plan?.wolfAttackRequired),
      resultImpression: taskType === 'result-impression'
        ? buildResultImpressionContext(state, playerId)
        : null,
      priorityAnswer,
      normalSpeechAnswers,
      knowledgeCutoffSequence: knowledgeWindow.cutoffSequence,
      publicKnowledgeFrozenAtDeath: knowledgeWindow.frozenAtDeath,
    },
  };
}

export function createPromptContextFingerprint(context) {
  // 責務境界: 永続化やモジュール再構築でオブジェクトキー順が変わっても、本人可視内容が同じなら同じ指紋にする。
  return hashText(stableStringify(context));
}
