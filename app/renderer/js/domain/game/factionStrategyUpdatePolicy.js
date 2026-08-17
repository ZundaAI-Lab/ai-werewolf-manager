/**
 * 責務: 公開済み情報と本人が知る仲間情報だけから、今回の陣営戦略差分が必要か、必要項目、詳細戦術区画の表示可否を決定する。
 * 変更ルール: 戦略本文を生成せず、戦略状態を更新しない。実配役を推測材料にせず、公開イベント・本人の既知人狼・現在タスクだけを使用する。更新契機は最後に保存した陣営戦略以後の新しい出来事だけを消費し、同じ契機を毎ターン再要求しない。
 */

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';
import { getPublishedPublicEvents } from '../events/eventStore.js';
import { getFactionStrategyProfile } from '../roles/roleAttributes.js';
import { getPlayer } from './standardRules.js';
import { getFactionStrategyFields, isSubstantiveFactionStrategyText } from './factionStrategyState.js';

function strategySourceTurn(state, player) {
  const sourceAiTurnId = player?.factionStrategyState?.sourceAiTurnId ?? null;
  if (!sourceAiTurnId) return null;
  return (state.aiTurns ?? []).find((turn) => turn.id === sourceAiTurnId) ?? null;
}

function sourceSequence(state, player) {
  const sourceTurn = strategySourceTurn(state, player);
  if (!sourceTurn) return null;
  const committedIds = new Set(sourceTurn.committedEntityIds ?? []);
  const sequences = (state.events ?? [])
    .filter((event) => committedIds.has(event.id))
    .map((event) => Number(event.sequence ?? NaN))
    .filter(Number.isFinite);
  return sequences.length ? Math.max(...sequences) : null;
}

function newPublicEvents(state, player) {
  const sequence = sourceSequence(state, player);
  if (Number.isFinite(sequence)) {
    return getPublishedPublicEvents(state).filter((event) => Number(event.sequence ?? 0) > sequence);
  }
  // 保存済み戦略の監査参照がない場合、既存の全公開履歴を未消費扱いにして再要求しない。
  // 新規作成前だけ、現在までの公開履歴を初回判断材料として扱う。
  return player?.factionStrategyState?.updatedAt ? [] : getPublishedPublicEvents(state);
}

function eventSequence(state, eventId) {
  return Number((state.events ?? []).find((event) => event.id === eventId)?.sequence ?? NaN);
}

function currentDaySpeeches(state) {
  return getPublishedPublicEvents(state).filter((event) => (
    event.type === 'public-speech' && Number(event.day) === Number(state.game.day)
  ));
}

function aliveKnownPartnerIds(state, player) {
  const alive = new Set(state.players.filter((item) => item.alive).map((item) => item.id));
  return [...new Set(state.playerKnowledge[player.id]?.knownWolfIds ?? [])]
    .filter((id) => id !== player.id && alive.has(id));
}

function wolfResultSequence(state, targetId) {
  return Math.max(
    ...state.publicAbilityClaims
      .filter((claim) => claim.status !== 'voided' && claim.targetId === targetId && claim.result === 'wolf')
      .map((claim) => eventSequence(state, claim.sourceEventId))
      .filter(Number.isFinite),
    -1,
  );
}

function publicVotePressureSequence(state, targetId) {
  return Math.max(
    ...getPublishedPublicEvents(state)
      .filter((event) => {
        if (event.type === 'vote-cast') return event.payload?.targetId === targetId;
        if (event.type !== 'vote-finalized') return false;
        return (event.payload?.tally ?? []).some((item) => item.targetId === targetId && Number(item.count ?? 0) >= 2);
      })
      .map((event) => Number(event.sequence ?? -1))
      .filter(Number.isFinite),
    -1,
  );
}

function pressureThresholdSequence(state, partnerIds) {
  return Math.max(
    ...partnerIds.flatMap((partnerId) => [
      wolfResultSequence(state, partnerId),
      publicVotePressureSequence(state, partnerId),
    ]),
    -1,
  );
}

function currentClaimOperationRequiresUpdate(coOperation) {
  return Boolean(coOperation && ['declare', 'change', 'withdraw'].includes(coOperation.action));
}

function desiredFields(profile, keys) {
  const desired = new Set(keys);
  return getFactionStrategyFields(profile).filter((key) => desired.has(key));
}


function missingRequiredStrategyFields(player, profile, requiredFields) {
  const state = player?.factionStrategyState ?? null;
  return requiredFields.filter((key) => {
    const value = String(state?.[key] ?? '').trim();
    if (key === 'partnerDisposition') return !value;
    return !isSubstantiveFactionStrategyText(value);
  });
}

function requiredFieldsForTriggers(profile, triggers) {
  if (triggers.includes('endgame')) return getFactionStrategyFields(profile);
  const desired = new Set();
  if (triggers.includes('vote')) {
    if (profile === 'wolf') ['dayWinPath', 'partnerDisposition'].forEach((key) => desired.add(key));
    if (profile === 'madman') ['dayWinPath', 'failureRisk'].forEach((key) => desired.add(key));
    if (profile === 'fox') ['pressureGoal', 'failureRisk'].forEach((key) => desired.add(key));
  }
  if (triggers.includes('black-result')) {
    ['publicWorld', 'dayWinPath', 'collapsePlan'].forEach((key) => desired.add(key));
  }
  if (triggers.includes('partner-pressure')) {
    ['dayWinPath', 'partnerDisposition', 'failureRisk'].forEach((key) => desired.add(key));
  }
  if (triggers.includes('role-structure-change')) {
    ['publicWorld', 'dayWinPath'].forEach((key) => desired.add(key));
  }
  if (triggers.includes('own-claim-change')) {
    ['publicWorld', 'dayWinPath', 'collapsePlan', 'fallbackRoute', 'nextDayPlan'].forEach((key) => desired.add(key));
  }
  return desiredFields(profile, desired);
}

export function resolveFactionStrategyUpdatePolicy(state, {
  playerId,
  taskType,
  coOperation = null,
} = {}) {
  const player = getPlayer(state, playerId);
  const profile = getFactionStrategyProfile(state, player);
  if (!player || !profile || !(isNormalSpeechTask(taskType) || ['priority-answer', 'vote'].includes(taskType))) {
    return Object.freeze({
      applicable: false,
      required: false,
      requiredFields: Object.freeze([]),
      missingRequiredFields: Object.freeze([]),
      triggers: Object.freeze([]),
      hasPreviousStrategy: false,
      keepAllowed: false,
      showTacticalDetail: false,
      showPartnerPublicPositions: false,
      showLatestFactionStrategy: false,
      requiresOnClaimChange: false,
    });
  }

  const triggers = [];
  const hasPreviousStrategy = Boolean(player.factionStrategyState?.updatedAt);
  const previousSequence = sourceSequence(state, player);
  const sourceTurn = strategySourceTurn(state, player);
  const partnerIds = profile === 'wolf' ? aliveKnownPartnerIds(state, player) : [];
  const newEvents = newPublicEvents(state, player);
  const hasNewRoleStructureChange = newEvents.some((event) => {
    if (event.type !== 'public-speech') return false;
    return ['declare', 'change', 'withdraw'].includes(event.payload?.structured?.coOperation?.action);
  });
  const hasNewOwnBlackResult = profile === 'wolf'
    && wolfResultSequence(state, player.id) > (Number.isFinite(previousSequence) ? previousSequence : -1);
  const partnerPressureSequence = profile === 'wolf' ? pressureThresholdSequence(state, partnerIds) : -1;
  const hasNewPartnerPressure = partnerPressureSequence > (Number.isFinite(previousSequence) ? previousSequence : -1);
  const currentPartnerPressure = partnerPressureSequence >= 0;
  const isEndgame = state.players.filter((item) => item.alive).length <= 5;
  const hasNewEndgame = isEndgame && (!hasPreviousStrategy || Number(sourceTurn?.day ?? -1) < Number(state.game.day));
  const hasReconsideration = Boolean(
    state.discussion?.reconsideration?.pending
    || state.discussion?.reconsideration?.active
    || state.discussion?.roundKind === 'targeted-response',
  );

  // 投票のたびに同じ秘密戦略全文を再要求しない。未作成時だけ初期戦略を要求する。
  if (taskType === 'vote' && !hasPreviousStrategy) triggers.push('vote');
  if (hasNewOwnBlackResult) triggers.push('black-result');
  if (hasNewPartnerPressure) triggers.push('partner-pressure');
  if (hasNewRoleStructureChange) triggers.push('role-structure-change');
  if (hasNewEndgame) triggers.push('endgame');
  if (currentClaimOperationRequiresUpdate(coOperation)) triggers.push('own-claim-change');

  const requiredFields = requiredFieldsForTriggers(profile, triggers)
    .filter((key) => !(profile === 'wolf' && partnerIds.length === 0 && key === 'partnerDisposition'));
  const missingRequiredFields = missingRequiredStrategyFields(player, profile, requiredFields);
  const required = triggers.length > 0;
  const keepAllowed = hasPreviousStrategy && missingRequiredFields.length === 0;
  const showTacticalDetail = taskType === 'vote' || required || hasReconsideration;
  const showPartnerPublicPositions = profile === 'wolf'
    && partnerIds.length > 0
    && (taskType === 'vote' || currentPartnerPressure || hasNewOwnBlackResult || isEndgame || hasReconsideration);

  return Object.freeze({
    applicable: true,
    required,
    requiredFields: Object.freeze(requiredFields),
    missingRequiredFields: Object.freeze(missingRequiredFields),
    triggers: Object.freeze(triggers),
    hasPreviousStrategy,
    keepAllowed,
    showTacticalDetail,
    showPartnerPublicPositions,
    showLatestFactionStrategy: hasPreviousStrategy && showTacticalDetail,
    requiresOnClaimChange: isNormalSpeechTask(taskType) || taskType === 'priority-answer',
  });
}
