/**
 * 責務: ゲーム開始時の役職再配置ルール適用、役職通知確認、初日または夜への開始遷移を実行し、新規開始時に前ゲームの相関スナップショットを初期化する。
 * 変更ルール: 開始前検証と開始時役職変更は専用setupモジュールへ委譲し、通知確認だけを扱う。夜・議論の具体処理と日終了スナップショット保存は各Runtimeへ委譲する。
 */

import { createGameCallNameSnapshot } from '../../characters/callNames/callNameResolver.js';
import {
  getPlayer,
  validateComposition,
} from './standardRules.js';
import {
  buildNightPlan,
  nightHasWork,
} from '../night/nightPlanner.js';
import { createEvent } from '../events/eventStore.js';
import { nowIso } from '../../shared/utils.js';
import {
  createEmptyInternalMemory,
  createEmptyMemoryLedger,
} from '../memory/memoryLedger.js';
import { createEmptyDecisionState } from './decisionState.js';
import { createEmptyFactionStrategyState } from './factionStrategyState.js';
import { getFactionStrategyProfile } from '../roles/roleAttributes.js';
import { createRoleState } from '../roles/roleState.js';
import { applyStartRoleAssignmentRules } from '../setup/startRoleAssignment.js';
import {
  requestMandatoryRestorePoint,
  RESTORE_POINT_TYPES,
} from '../correction/restorePointPolicy.js';


import {
  result,
  commandGuard,
  setPhase,
  freezeKnowledge,
} from '../game/gameRuntimeShared.js';
import { initializeNight } from '../night/nightRuntime.js';
import { initializeDiscussion } from '../discussion/discussionRuntime.js';

export function startGame(state) {
  const guard = commandGuard(state, { phases: ['setup'] });
  if (guard) return guard;
  const validation = validateComposition(state);
  if (!validation.ok) return result(false, validation.errors.join('\n'), { validation });
  requestMandatoryRestorePoint(state, RESTORE_POINT_TYPES.BEFORE_ROLE_CONFIRM);
  applyStartRoleAssignmentRules(state);
  state.game.status = 'running';
  state.game.day = 0;
  state.game.winner = null;
  state.game.winnerReason = '';
  state.game.correctionMode = { enabled: false, reason: '', startedAt: null };
  state.game.callNameSnapshot = createGameCallNameSnapshot(state.players, {
    enabled: state.game.rules.callNames?.enabled !== false,
  });
  const preservedCorrectionEvents = state.events
    .filter((event) => ['correction', 'correction-audit'].includes(event.type))
    .map((event) => ({ ...event, targetIds: [...(event.targetIds ?? [])], audience: { ...event.audience, targetIds: [...(event.audience?.targetIds ?? [])] }, payload: structuredClone(event.payload) }));
  state.result = null;
  state.events = preservedCorrectionEvents;
  state.aiTurns = [];
  state.claims = [];
  state.publicAbilityClaims = [];
  state.relationshipSnapshots = [];
  state.mediumResults = [];
  state.wolfConversations = [];
  state.masonConversations = [];
  state.graveyardConversations = [];
  state.executionResolution = null;
  state.voteSession = null;
  state.discussion = null;
  state.night = null;
  state.publicRevision = preservedCorrectionEvents.filter((event) => event.audience?.type === 'public' && event.status === 'published').length;
  state.game.eventSequence = Math.max(0, ...preservedCorrectionEvents.map((event) => Number(event.sequence ?? 0)));
  state.players.forEach((player) => {
    player.alive = true;
    player.death = null;
    player.roleState = createRoleState(player.roleId);
    player.statusEffects = [];
    player.heartVoice = '';
    player.heartVoiceUpdatedAt = null;
    player.heartVoiceHistory = [];
    player.internalMemory = createEmptyInternalMemory();
    player.memoryLedger = createEmptyMemoryLedger();
    player.memoHistory = [];
    player.aiContextStatus = 'not-ready';
    player.decisionState = createEmptyDecisionState();
    player.factionStrategyState = createEmptyFactionStrategyState(getFactionStrategyProfile(state, player) ?? player.roleId);
  });
  freezeKnowledge(state);
  const ids = state.players.map((player) => player.id);
  state.briefing = {
    roleAssignmentFrozen: true,
    eligiblePlayerIds: ids,
    noticeStatusByPlayerId: Object.fromEntries(ids.map((id) => [id, 'pending'])),
    aiContextReadyByPlayerId: Object.fromEntries(ids.map((id) => [id, false])),
    forcedReasonByPlayerId: {},
    completed: false,
  };
  setPhase(state, 'briefing');
  createEvent(state, {
    type: 'system',
    audience: { type: 'gm', targetIds: [] },
    payload: { text: '配役を確定し、役職通知を開始しました。' },
  });
  return result(true, '配役を確定しました。役職通知を行ってください。', { validation });
}

export function markBriefingShown(state, playerId) {
  const guard = commandGuard(state, { phases: ['briefing'] });
  if (guard) return guard;
  const player = getPlayer(state, playerId);
  if (!player) return result(false, 'プレイヤーが存在しません。');
  if (!state.briefing.eligiblePlayerIds.includes(playerId)) return result(false, '役職通知対象ではありません。');
  if (state.briefing.noticeStatusByPlayerId[playerId] === 'pending') {
    state.briefing.noticeStatusByPlayerId[playerId] = 'shown';
  }
  if (player.controller === 'ai') player.aiContextStatus = 'prompt-copied';
  return result(true, `${player.name}へ役職情報を提示しました。`);
}

export function acknowledgeRole(state, playerId, { forcedReason = '' } = {}) {
  const guard = commandGuard(state, { phases: ['briefing'] });
  if (guard) return guard;
  const player = getPlayer(state, playerId);
  if (!player) return result(false, 'プレイヤーが存在しません。');
  const current = state.briefing.noticeStatusByPlayerId[playerId];
  if (!['shown', 'gm-forced'].includes(current) && !forcedReason) return result(false, '先に本人または対象AIへ役職情報を提示してください。');
  const status = forcedReason ? 'gm-forced' : 'acknowledged';
  state.briefing.noticeStatusByPlayerId[playerId] = status;
  state.briefing.aiContextReadyByPlayerId[playerId] = player.controller === 'ai';
  state.briefing.forcedReasonByPlayerId[playerId] = forcedReason;
  state.playerKnowledge[playerId].roleNotifiedAt = nowIso();
  player.aiContextStatus = player.controller === 'ai' ? 'initialized' : player.aiContextStatus;
  const event = createEvent(state, {
    type: 'role-notified',
    actorId: playerId,
    audience: { type: 'player', targetIds: [playerId] },
    payload: { roleId: player.roleId, status, forcedReason },
  });
  const complete = state.briefing.eligiblePlayerIds.every((id) => ['acknowledged', 'gm-forced'].includes(state.briefing.noticeStatusByPlayerId[id]));
  if (complete) {
    requestMandatoryRestorePoint(state, RESTORE_POINT_TYPES.BEFORE_GAME_START);
    state.briefing.completed = true;
    beginNightOrDay(state, 0);
  }
  return result(true, complete ? '全員の役職通知が完了しました。' : `${player.name}の役職通知を確認済みにしました。`, { eventId: event.id });
}

export function forceAcknowledgeRole(state, playerId, reason) {
  if (!String(reason ?? '').trim()) return result(false, '強制完了の理由を入力してください。');
  if (state.briefing?.noticeStatusByPlayerId[playerId] === 'pending') markBriefingShown(state, playerId);
  return acknowledgeRole(state, playerId, { forcedReason: String(reason).trim() });
}

export function beginNightOrDay(state, day) {
  const plan = buildNightPlan(state, day);
  if (!nightHasWork(plan)) {
    state.game.day = Math.max(1, day + 1);
    initializeDiscussion(state);
    return result(true, '夜に必要な処理がないため昼議論へ進みました。');
  }
  initializeNight(state, day, plan);
  return result(true, '夜を開始しました。');
}
