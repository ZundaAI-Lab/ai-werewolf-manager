/**
 * 責務: 夜開始時点の生存スナップショットと、その夜に必要な共有会話・襲撃・能力入力計画を生成する。
 * 変更ルール: 状態保存・DOM操作・イベント公開を行わない。役職属性とルールだけから計画を返し、座敷わらしの初夜家主選択を他の全夜処理より優先する。訪問と凍結の対象制限は共通の直前対象方式を使う。
 */

import { createId } from '../../shared/utils.js';
import { getAlivePlayers, getPlayersByRole } from '../game/standardRules.js';
import { canJoinWolfConversation, countsAsWolf, isActualFox } from '../roles/roleAttributes.js';
import { getMasonConversationParticipantIds } from './masonConversationPolicy.js';
import { getGraveyardConversationParticipantIds } from './graveyardConversationPolicy.js';

function randomItem(values, random = Math.random) {
  if (!values.length) return null;
  return values[Math.floor(random() * values.length)] ?? null;
}

export function getWolfConversationParticipantIds(state) {
  return getAlivePlayers(state).filter((player) => canJoinWolfConversation(state, player)).map((player) => player.id);
}

export function getWolfConversationPurpose({ isFirstNight, wolfAttackRequired }) {
  if (isFirstNight && !wolfAttackRequired) return 'opening-strategy';
  if (isFirstNight) return 'opening-strategy-and-attack';
  return 'attack-planning';
}

function emptyPlan(state, day, ownerSelectionRequired = false) {
  return {
    day,
    aliveAtStartIds: getAlivePlayers(state).map((player) => player.id),
    ownerSelectionRequired,
    graveyardConversationRequired: false,
    graveyardConversationParticipantIds: [],
    masonConversationRequired: false,
    masonConversationParticipantIds: [],
    wolfConversationRequired: false,
    wolfConversationPurpose: 'opening-strategy',
    wolfConversationParticipantIds: [],
    wolfAttackRequired: false,
    inspectActorIds: [],
    guardActorIds: [],
    visitActorIds: [],
    freezeActorIds: [],
    mediumResultRecipientIds: [],
    slots: [],
  };
}

export function buildNightPlan(state, day, random = Math.random) {
  const isFirstNight = day === 0;
  const unresolvedZashiki = isFirstNight
    ? getPlayersByRole(state, 'zashikiWarashi', { aliveOnly: true }).find((player) => !player.roleState?.ownerId)
    : null;
  if (unresolvedZashiki) {
    const plan = emptyPlan(state, day, true);
    plan.slots.push({
      id: createId('slot'),
      type: 'choose-owner',
      actorId: unresolvedZashiki.id,
      targetId: null,
      status: 'pending',
      override: null,
    });
    return plan;
  }

  const plan = emptyPlan(state, day, false);
  const graveyardConversationParticipants = getGraveyardConversationParticipantIds(state);
  const conversationParticipants = getWolfConversationParticipantIds(state);
  const masonConversationParticipants = getMasonConversationParticipantIds(state);
  plan.graveyardConversationRequired = state.game.rules.graveyardCommunication.enabled
    && graveyardConversationParticipants.length >= 2;
  plan.graveyardConversationParticipantIds = graveyardConversationParticipants;
  const communicationEnabled = state.game.rules.wolfCommunication.enabled
    && (!isFirstNight || state.game.rules.firstNight.wolfCommunicationEnabled);
  plan.wolfConversationRequired = communicationEnabled && conversationParticipants.length >= 2;
  plan.wolfConversationParticipantIds = conversationParticipants;
  plan.masonConversationRequired = state.game.rules.masonCommunication.enabled
    && masonConversationParticipants.length >= 2;
  plan.masonConversationParticipantIds = masonConversationParticipants;
  plan.wolfAttackRequired = !isFirstNight || state.game.rules.firstNight.wolfAttackEnabled;
  plan.wolfConversationPurpose = getWolfConversationPurpose({
    isFirstNight,
    wolfAttackRequired: plan.wolfAttackRequired,
  });

  const seerMode = isFirstNight ? state.game.rules.firstNight.seerMode : 'choose';
  const guardEnabled = !isFirstNight || state.game.rules.firstNight.guardEnabled;
  const seers = seerMode === 'disabled' ? [] : getPlayersByRole(state, 'seer', { aliveOnly: true });
  const guards = guardEnabled ? getPlayersByRole(state, 'guard', { aliveOnly: true }) : [];
  const namahages = !isFirstNight ? getPlayersByRole(state, 'namahage', { aliveOnly: true }) : [];
  const snowWomen = !isFirstNight ? getPlayersByRole(state, 'snowWoman', { aliveOnly: true }) : [];

  seers.forEach((seer) => {
    if (isFirstNight && seerMode === 'random-non-wolf') {
      const candidates = getAlivePlayers(state).filter((player) => player.id !== seer.id && !countsAsWolf(state, player) && !isActualFox(state, player));
      const target = randomItem(candidates, random);
      plan.slots.push({
        id: createId('slot'),
        type: 'inspect',
        actorId: seer.id,
        targetId: target?.id ?? null,
        status: target ? 'gm-override' : 'waived-by-rule',
        override: target ? { reason: '初日ランダム白占い', selectedBy: 'random' } : null,
      });
    } else {
      plan.slots.push({ id: createId('slot'), type: 'inspect', actorId: seer.id, targetId: null, status: 'pending', override: null });
    }
  });
  guards.forEach((guard) => {
    plan.slots.push({ id: createId('slot'), type: 'guard', actorId: guard.id, targetId: null, status: 'pending', override: null });
  });
  namahages.forEach((namahage) => {
    const candidates = getAlivePlayers(state).filter((player) => player.id !== namahage.id && player.id !== namahage.roleState?.lastTargetId);
    plan.slots.push({
      id: createId('slot'), type: 'visit', actorId: namahage.id, targetId: null,
      status: candidates.length ? 'pending' : 'waived-by-rule', override: null,
    });
  });
  snowWomen.forEach((snowWoman) => {
    const candidates = getAlivePlayers(state).filter((player) => player.id !== snowWoman.id && player.id !== snowWoman.roleState?.lastTargetId);
    plan.slots.push({
      id: createId('slot'), type: 'freeze', actorId: snowWoman.id, targetId: null,
      status: candidates.length ? 'pending' : 'waived-by-rule', override: null,
    });
  });

  plan.inspectActorIds = seers.map((player) => player.id);
  plan.guardActorIds = guards.map((player) => player.id);
  plan.visitActorIds = namahages.map((player) => player.id);
  plan.freezeActorIds = snowWomen.map((player) => player.id);
  plan.mediumResultRecipientIds = getPlayersByRole(state, 'medium', { aliveOnly: true }).map((player) => player.id);
  return plan;
}

export function nightHasWork(plan) {
  return Boolean(plan.ownerSelectionRequired || plan.graveyardConversationRequired || plan.masonConversationRequired || plan.wolfConversationRequired || plan.wolfAttackRequired || plan.slots.length);
}
