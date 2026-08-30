/**
 * 責務: 投票開始・入力・集計・公開、処刑解決・公開を実行し、処刑あり／なしの公開確定時に当日終了のプレイヤー相関スナップショットを保存する。
 * 変更ルール: 投票候補と同票処理はvoteResolutionを正本とし、結果公開前に次フェーズへ進めない。逐次公開済みの票は通常操作で再入力へ戻さず、秘密投票だけ確定前の再入力を許可する。遺言の要否・凍結による自動スキップはtestamentPolicyを正本とする。AI失敗時のランダム代替は乱数関数を注入可能にして決定的検証を許可する。相関スナップショットの構築・同日置換はplayerRelationshipModel.jsへ委譲する。
 */

import {
  detectWinner,
  getAlivePlayers,
  getPlayer,
  getPlayersByRole,
  getVoteCandidates,
  isValidVoteTarget,
  mediumResult,
} from '../game/standardRules.js';
import { resolveExecutionDeaths, resolveFollowUpDeaths } from '../game/deathResolution.js';
import { resolveVoteResult } from './voteResolution.js';
import {
  createEvent,
  getEvent,
  voidEvent,
} from '../events/eventStore.js';
import { createId, nowIso } from '../../shared/utils.js';
import { rebuildPublicDerivedState } from '../events/publicDerivation.js';
import { getCurrentPriorityAnswerTask } from '../discussion/priorityAnswerPolicy.js';
import {
  applyInternalMemoryUpdate,
  recordSelectionRationale,
  voidSelectionRationalesForEvent,
} from '../memory/memoryLedger.js';
import { getVoteEligiblePlayerIds } from '../game/playerStatus.js';
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
  resolveFactionStrategyForCommit,
  setFactionStrategyState,
  recordAiTurn,
} from '../game/gameRuntimeShared.js';
import { initializeNight } from '../night/nightRuntime.js';
import { detectGameResult, getRoleNameLocal } from '../result/resultRuntime.js';
import { captureDayEndPlayerRelationshipSnapshot } from '../records/playerRelationshipModel.js';
import { getTestamentAvailability } from '../execution/testamentPolicy.js';

export function beginVote(state, { type = 'normal', candidateIds = null, round = 1, parentSessionId = null, triggerVoteResultEventId = null } = {}) {
  const guard = commandGuard(state, { phases: ['discussion', 'vote', 'runoff'] });
  if (guard) return guard;
  if (state.game.phase === 'discussion' && getCurrentPriorityAnswerTask(state)) {
    return result(false, '質問への優先回答を完了してから投票へ進んでください。');
  }
  if (state.game.phase === 'discussion' && !state.discussion?.completed) return result(false, '昼議論を終了してから投票へ進んでください。');
  if (state.game.phase === 'discussion' && state.discussion?.reconsideration?.pending) {
    return result(false, '3巡目のCO後に発言できなかった参加者がいます。対象者の追加発言を完了してください。');
  }
  const eligibleVoterIds = getVoteEligiblePlayerIds(state);
  const aliveCandidateIds = getAlivePlayers(state).map((player) => player.id);
  const candidates = candidateIds ?? [...aliveCandidateIds];
  state.voteSession = {
    id: createId('vote-session'),
    day: state.game.day,
    round,
    type,
    parentSessionId: type === 'runoff' ? parentSessionId : null,
    triggerVoteResultEventId: type === 'runoff' ? triggerVoteResultEventId : null,
    status: 'input',
    inputMode: 'sequential',
    eligibleVoterIds,
    candidateIds: candidates,
    currentVoterIndex: 0,
    votes: {},
    voteEventIdByVoterId: {},
    tally: [],
    result: null,
  };
  setPhase(state, type === 'runoff' ? 'runoff' : 'vote');
  return result(true, type === 'runoff' ? '決選投票を開始しました。' : '投票を開始しました。');
}

function firstPendingVoteIndex(session) {
  return session.eligibleVoterIds.findIndex((id) => !Object.hasOwn(session.votes, id));
}

function refreshVoteSessionReadiness(session) {
  const pendingIndex = firstPendingVoteIndex(session);
  if (session.inputMode === 'sequential') {
    session.currentVoterIndex = pendingIndex < 0 ? session.eligibleVoterIds.length : pendingIndex;
  }
  if (pendingIndex < 0 && session.status === 'input') session.status = 'ready';
  return pendingIndex;
}

export function recordVote(state, {
  voterId,
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
  warnings = [],
  override = null,
  decisionUpdate = null,
  parsedDecisionUpdate = null,
  factionStrategyPatch = null,
  parsedFactionStrategyPatch = null,
}) {
  const guard = commandGuard(state, { phases: ['vote', 'runoff'] });
  if (guard) return guard;
  const session = state.voteSession;
  if (!session || session.status !== 'input') return result(false, '現在は投票入力中ではありません。');
  if (!session.eligibleVoterIds.includes(voterId)) return result(false, '投票資格がありません。');
  const expected = session.eligibleVoterIds[session.currentVoterIndex];
  if (session.inputMode === 'sequential' && expected !== voterId) return result(false, '現在の投票者ではありません。');
  if (!isValidVoteTarget(state, voterId, targetId, session.candidateIds)) return result(false, '投票できない対象です。');
  const voteDecisionUpdate = decisionUpdate ? { ...decisionUpdate, intendedVoteId: targetId } : decisionUpdate;
  const committedDecisionUpdate = resolveDecisionUpdateForCommit(state, voterId, voteDecisionUpdate, {
    taskType: 'vote',
    candidateIds: session.candidateIds,
  });
  const factionStrategy = resolveFactionStrategyForCommit(state, voterId, factionStrategyPatch);
  if (!factionStrategy.ok) return result(false, factionStrategy.errors.join('\n'));
  const committedFactionStrategyPatch = factionStrategy.update;
  const existingEventId = session.voteEventIdByVoterId[voterId];
  if (existingEventId) {
    const existing = getEvent(state, existingEventId);
    if (existing?.status === 'published') return result(false, '公開済み投票は通常操作で変更できません。');
    voidEvent(state, existingEventId);
    voidSelectionRationalesForEvent(state, existingEventId);
  }
  session.votes[voterId] = targetId;
  setHeartVoice(state, voterId, heartVoice);
  const publicDuringInput = state.game.rules.vote.visibilityDuringInput === 'public';
  const targetName = targetId === 'abstain' ? '棄権' : getPlayer(state, targetId)?.name ?? '不明';
  const event = createEvent(state, {
    type: 'vote-cast',
    actorId: voterId,
    targetIds: targetId === 'abstain' ? [] : [targetId],
    audience: publicDuringInput ? { type: 'public', targetIds: [] } : { type: 'player', targetIds: [voterId] },
    status: publicDuringInput ? 'published' : 'confirmed',
    payload: {
      text: publicDuringInput ? `${getPlayer(state, voterId)?.name}は${targetName}へ投票しました。` : '',
      voteSessionId: session.id,
      targetId,
      override,
    },
  });
  session.voteEventIdByVoterId[voterId] = event.id;
  let sourceTurnId = null;
  if (rawResponse) {
    const turn = recordAiTurn(state, {
      taskType: 'vote',
      playerId: voterId,
      promptText,
      promptFingerprint,
      promptMode,
      publicSequenceAtGeneration,
      rawResponse,
      generationRun,
      parsedHeartVoice: heartVoice,
      parsedInternalMemoUpdate: internalMemoUpdate,
      parsedActionAnswer: targetId,
      parsedSelectionRationale: String(selectionRationale ?? '').trim(),
      parsedDecisionUpdate: parsedDecisionUpdate ?? null,
      resolvedDecisionUpdate: committedDecisionUpdate,
      parsedFactionStrategyPatch: parsedFactionStrategyPatch ?? null,
      resolvedFactionStrategyState: committedFactionStrategyPatch,
      warnings,
      override,
      committedEntityIds: [event.id],
    });
    sourceTurnId = turn.id;
    setFactionStrategyState(state, voterId, committedFactionStrategyPatch, turn.id);
    applyInternalMemoryUpdate(state, voterId, internalMemoUpdate, turn.id);
  } else {
    applyInternalMemoryUpdate(state, voterId, internalMemoUpdate);
  }
  if (String(selectionRationale ?? '').trim()) {
    recordSelectionRationale(state, voterId, {
      id: `action-rationale:${event.id}`,
      taskType: 'vote',
      day: state.game.day,
      phase: state.game.phase,
      targetId,
      rationale: selectionRationale,
      sourceAiTurnId: sourceTurnId,
      sourceEventId: event.id,
    });
  }
  rebuildPublicDerivedState(state);
  refreshVoteSessionReadiness(session);
  return result(true, '投票を登録しました。', { eventId: event.id });
}

export function recordRandomVote(state, voterId, reason = 'AI回答を正常に取得できないためランダム決定', { random = Math.random } = {}) {
  const session = state.voteSession;
  if (!session?.eligibleVoterIds.includes(voterId)) return result(false, '投票者が不正です。');
  const candidates = getVoteCandidates(state, voterId, session.candidateIds).map((player) => player.id);
  if (state.game.rules.vote.abstentionAllowed) candidates.push('abstain');
  if (!candidates.length) return result(false, '有効な投票先がありません。');
  const targetId = candidates[Math.floor(random() * candidates.length)];
  return recordVote(state, {
    voterId,
    targetId,
    override: { applied: true, reason, selectedBy: 'random' },
  });
}

export function setVoteInputMode(state, mode) {
  const guard = commandGuard(state, { phases: ['vote', 'runoff'] });
  if (guard) return guard;
  if (!state.voteSession || state.voteSession.status !== 'input') return result(false, '投票入力中ではありません。');
  if (!['sequential', 'list'].includes(mode)) return result(false, '入力方式が不正です。');
  state.voteSession.inputMode = mode;
  if (mode === 'sequential') refreshVoteSessionReadiness(state.voteSession);
  return result(true, '投票入力方式を変更しました。');
}

export function reopenVoteInput(state) {
  const guard = commandGuard(state, { phases: ['vote', 'runoff'] });
  if (guard) return guard;
  const session = state.voteSession;
  if (!session || !['ready', 'finalized'].includes(session.status)) return result(false, '修正できる投票状態ではありません。');
  if (state.game.rules.vote.visibilityDuringInput === 'public') {
    return result(false, '逐次公開済みの投票は通常操作で変更できません。必要な場合は訂正・復元を使用してください。');
  }
  if (session.status === 'finalized') {
    session.tally = [];
    session.result = null;
  }
  session.status = 'input';
  const pendingIndex = firstPendingVoteIndex(session);
  session.currentVoterIndex = pendingIndex < 0 ? 0 : pendingIndex;
  return result(true, '投票入力へ戻しました。');
}

export function finalizeVote(state, random = Math.random) {
  const guard = commandGuard(state, { phases: ['vote', 'runoff'] });
  if (guard) return guard;
  const session = state.voteSession;
  if (!session || session.status !== 'ready') return result(false, '全員の投票が揃っていません。');
  requestMandatoryRestorePoint(state, RESTORE_POINT_TYPES.BEFORE_VOTE_FINALIZE);
  const counts = new Map();
  Object.values(session.votes).filter((targetId) => targetId !== 'abstain').forEach((targetId) => counts.set(targetId, (counts.get(targetId) ?? 0) + 1));
  session.tally = [...counts.entries()].map(([targetId, count]) => ({ targetId, count })).sort((a, b) => b.count - a.count);
  session.result = resolveVoteResult({
    tally: session.tally,
    round: session.round,
    runoffLimit: state.game.rules.vote.runoffLimit,
    tieResolution: state.game.rules.vote.tieResolution,
    random,
  });
  session.status = 'finalized';
  return result(true, '投票を集計しました。公開内容を確認してください。');
}

export function votePublicationPayload(state, session) {
  const ballots = Object.entries(session.votes).map(([voterId, targetId]) => ({ voterId, targetId }));
  const mode = state.game.rules.vote.publicationAfterFinalize;
  const targetName = session.result.targetId ? getPlayer(state, session.result.targetId)?.name : '';
  const tallyText = session.tally.map((item) => `${getPlayer(state, item.targetId)?.name} ${item.count}票`).join('、');
  const resultText = session.result.type === 'execution'
    ? session.result.resolution === 'random-tie-break'
      ? `決選投票上限後も同票のため、同票候補からランダムに${targetName}が処刑候補となりました。`
      : `処刑候補は${targetName}です。`
    : session.result.type === 'runoff'
      ? `同票のため決選投票を行います。`
      : session.result.resolution === 'tie-no-execution'
        ? '決選投票上限後も同票のため、処刑なしとなりました。'
        : '有効票がないため、処刑なしとなりました。';
  if (mode === 'all-ballots') {
    const ballotText = ballots.map((item) => `${getPlayer(state, item.voterId)?.name}→${item.targetId === 'abstain' ? '棄権' : getPlayer(state, item.targetId)?.name}`).join('、');
    return { text: `投票結果: ${tallyText}。${resultText} 投票先: ${ballotText}`, tally: session.tally, ballots, result: session.result };
  }
  if (mode === 'tally-only') return { text: `投票結果: ${tallyText}。${resultText}`, tally: session.tally, result: session.result };
  return { text: resultText, result: session.result };
}

export function publishVoteResult(state) {
  const guard = commandGuard(state, { phases: ['vote', 'runoff'] });
  if (guard) return guard;
  const session = state.voteSession;
  if (!session || session.status !== 'finalized') return result(false, '公開できる投票結果がありません。');
  const payload = votePublicationPayload(state, session);
  const event = createEvent(state, {
    type: 'vote-finalized',
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload: { sessionId: session.id, type: session.type, round: session.round, ...payload },
  });
  session.status = 'published';
  if (session.result.type === 'runoff') {
    const parentSessionId = session.id;
    beginVote(state, {
      type: 'runoff',
      candidateIds: session.result.tiedCandidateIds,
      round: session.round + 1,
      parentSessionId,
      triggerVoteResultEventId: event.id,
    });
    return result(true, '投票結果を公開し、決選投票を開始しました。', { eventId: event.id });
  }
  if (session.result.type === 'execution') {
    state.executionResolution = null;
    setPhase(state, 'execution');
    return result(true, '投票結果を公開しました。処刑内容を確認してください。', { eventId: event.id });
  }
  captureDayEndPlayerRelationshipSnapshot(state, { sourceEventId: event.id });
  const winner = detectWinner(state);
  if (winner) detectGameResult(state, winner);
  else initializeNight(state, state.game.day);
  return result(true, '処刑なしを公開し、夜へ進みました。', { eventId: event.id });
}

export function resolveExecution(state, random = Math.random) {
  const guard = commandGuard(state, { phases: ['execution'] });
  if (guard) return guard;
  if (state.executionResolution?.status === 'resolved') return result(false, '処刑内容はすでに解決済みです。');
  const targetId = state.voteSession?.result?.targetId;
  const player = getPlayer(state, targetId);
  if (!player?.alive) return result(false, '処刑対象が不正です。');
  const baseResolution = resolveExecutionDeaths(state, targetId, random);
  const resolved = {
    ...baseResolution,
    deaths: resolveFollowUpDeaths(state, baseResolution.deaths),
  };
  const deadIds = resolved.deaths.map((death) => death.playerId);
  const collateralNames = resolved.deaths.filter((death) => death.playerId !== targetId).map((death) => getPlayer(state, death.playerId)?.name).filter(Boolean);
  const publicAnnouncement = collateralNames.length
    ? `投票の結果、${player.name}が処刑されました。さらに${collateralNames.join('、')}が死亡しました。`
    : `投票の結果、${player.name}が処刑されました。`;
  const aliveAfterResolution = state.players.filter((entry) => entry.alive && !deadIds.includes(entry.id));
  const testamentAvailability = getTestamentAvailability(state, targetId);
  state.executionResolution = {
    targetId,
    status: 'resolved',
    deaths: resolved.deaths,
    collateralPlayerId: resolved.collateralPlayerId,
    publicAnnouncement,
    winnerPreview: detectWinner(state, aliveAfterResolution),
    testament: {
      status: testamentAvailability.status,
      eventId: null,
      skippedReason: testamentAvailability.skippedReason,
      completedAt: testamentAvailability.status === 'skipped' ? nowIso() : null,
    },
  };
  return result(true, resolved.collateralPlayerId ? '猫又の道連れ対象を含む処刑内容を解決しました。' : '処刑内容を解決しました。');
}

export function publishExecution(state) {
  const guard = commandGuard(state, { phases: ['execution'] });
  if (guard) return guard;
  const resolution = state.executionResolution;
  if (!resolution || resolution.status !== 'resolved') return result(false, '先に処刑内容を解決してください。');
  if (resolution.testament?.status === 'pending') return result(false, '処刑対象の遺言を完了または辞退してください。');
  const executed = getPlayer(state, resolution.targetId);
  if (!executed?.alive) return result(false, '処刑対象が不正です。');
  requestMandatoryRestorePoint(state, RESTORE_POINT_TYPES.BEFORE_EXECUTION_PUBLISH);
  const deadPlayerIds = resolution.deaths.map((death) => death.playerId);
  resolution.deaths.forEach((death) => {
    const player = getPlayer(state, death.playerId);
    if (!player) return;
    player.alive = false;
    player.death = { day: state.game.day, phase: 'execution', cause: death.cause, announced: true };
  });
  const roleText = state.game.rules.vote.revealExecutedRole ? ` 役職は${getRoleNameLocal(state, resolution.targetId)}でした。` : '';
  const text = `${resolution.publicAnnouncement}${roleText}`;
  const collateralPlayerIds = deadPlayerIds.filter((id) => id !== resolution.targetId);
  const event = createEvent(state, {
    type: 'execution',
    targetIds: [...deadPlayerIds],
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload: {
      text,
      targetId: resolution.targetId,
      collateralPlayerIds,
      deadPlayerIds,
      revealedRoleId: state.game.rules.vote.revealExecutedRole ? executed.roleId : null,
    },
  });
  resolution.status = 'published';
  captureDayEndPlayerRelationshipSnapshot(state, { sourceEventId: event.id });
  const winner = detectWinner(state);
  if (winner) {
    detectGameResult(state, winner);
    return result(true, '処刑を公開し、勝敗を検出しました。', { eventId: event.id });
  }
  getPlayersByRole(state, 'medium', { aliveOnly: true }).forEach((medium) => {
    state.mediumResults.push({
      id: createId('medium-result'),
      mediumId: medium.id,
      executedPlayerId: resolution.targetId,
      result: mediumResult(state, resolution.targetId),
      availableFromDay: state.game.day + 1,
      delivered: false,
      expired: false,
      eventId: null,
    });
  });
  initializeNight(state, state.game.day);
  return result(true, '処刑を公開し、夜へ進みました。', { eventId: event.id });
}
