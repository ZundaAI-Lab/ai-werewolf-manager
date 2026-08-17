/**
 * 責務: 役職IDと役職固有状態から、陣営・人狼属性・狂人属性・悪い子属性・行動制御属性・占霊判定・共有権限を純粋関数として導出する。
 * 変更ルール: 状態を変更しない。個別役職を利用側で直接比較せず、ゲーム上の性質は本モジュールへ追加する。
 */

import { ROLE_DEFINITIONS } from '../../config/constants.js';

function asPlayer(state, playerOrId) {
  if (!playerOrId) return null;
  if (typeof playerOrId === 'object') return playerOrId;
  return state?.players?.find((player) => player.id === playerOrId) ?? null;
}

export function getRoleDefinition(playerOrRoleId) {
  const roleId = typeof playerOrRoleId === 'object' ? playerOrRoleId?.roleId : playerOrRoleId;
  return ROLE_DEFINITIONS[String(roleId ?? '')] ?? null;
}

export function getPlayerTeam(state, playerOrId) {
  const player = asPlayer(state, playerOrId);
  if (!player) return null;
  if (player.roleId === 'zashikiWarashi' && player.roleState?.resolvedTeam) {
    return player.roleState.resolvedTeam;
  }
  return getRoleDefinition(player)?.baseTeam ?? null;
}


export function isBadChild(state, playerOrId) {
  const player = asPlayer(state, playerOrId);
  return Boolean(player && getRoleDefinition(player)?.badChild);
}

export function getFearActionGroup(state, playerOrId) {
  const player = asPlayer(state, playerOrId);
  return player ? getRoleDefinition(player)?.fearActionGroup ?? null : null;
}

export function getFearActionParticipantIds(state, actionType) {
  return (state?.players ?? [])
    .filter((player) => player.alive && getFearActionGroup(state, player) === actionType)
    .map((player) => player.id);
}

export function countsAsWolf(state, playerOrId) {
  const player = asPlayer(state, playerOrId);
  return Boolean(player && getRoleDefinition(player)?.countsAsWolf);
}

export function isMadmanClass(state, playerOrId) {
  const player = asPlayer(state, playerOrId);
  if (!player) return false;
  if (player.roleId === 'zashikiWarashi') return getPlayerTeam(state, player) === 'wolf';
  return getRoleDefinition(player)?.roleClass === 'madman';
}

export function isActualFox(state, playerOrId) {
  const player = asPlayer(state, playerOrId);
  return player?.roleId === 'fox';
}

export function isFoxFactionMember(state, playerOrId) {
  return getPlayerTeam(state, playerOrId) === 'fox';
}

export function canParticipateInWolfAttack(state, playerOrId) {
  return countsAsWolf(state, playerOrId);
}

export function canKnowWolfPartners(state, playerOrId) {
  const player = asPlayer(state, playerOrId);
  if (!player) return false;
  if (countsAsWolf(state, player)) return true;
  const rules = state?.game?.rules?.wolfCommunication;
  return Boolean(rules?.enabled && rules.participantMode === 'wolves-and-madman' && isMadmanClass(state, player));
}

export function canKnowMadmanPartners(state, playerOrId) {
  const player = asPlayer(state, playerOrId);
  const rules = state?.game?.rules?.wolfCommunication;
  if (!player || !rules?.enabled || rules.participantMode !== 'wolves-and-madman') return false;
  return countsAsWolf(state, player) || isMadmanClass(state, player);
}

export function canJoinWolfConversation(state, playerOrId) {
  const player = asPlayer(state, playerOrId);
  if (!player?.alive || !state?.game?.rules?.wolfCommunication?.enabled) return false;
  if (countsAsWolf(state, player)) return true;
  return state.game.rules.wolfCommunication.participantMode === 'wolves-and-madman'
    && isMadmanClass(state, player);
}

export function getSeerResult(state, playerOrId) {
  const player = asPlayer(state, playerOrId);
  if (!player) return 'not-wolf';
  return getRoleDefinition(player)?.seerResult ?? (countsAsWolf(state, player) ? 'wolf' : 'not-wolf');
}

export function getMediumResult(state, playerOrId) {
  const player = asPlayer(state, playerOrId);
  if (!player) return 'not-wolf';
  return getRoleDefinition(player)?.mediumResult ?? (countsAsWolf(state, player) ? 'wolf' : 'not-wolf');
}

export function getFactionStrategyProfile(state, playerOrId) {
  const player = asPlayer(state, playerOrId);
  if (!player) return null;
  if (player.roleId === 'zashikiWarashi') {
    const team = getPlayerTeam(state, player);
    if (team === 'wolf') return 'madman';
    if (team === 'fox') return 'fox';
    return null;
  }
  return getRoleDefinition(player)?.strategyProfile ?? null;
}

export function countConfiguredRole(roleComposition = {}, roleId) {
  return Math.max(0, Number(roleComposition?.[roleId] ?? 0) || 0);
}

export function countConfiguredWolves(roleComposition = {}) {
  return Object.entries(roleComposition ?? {}).reduce((total, [roleId, count]) => (
    total + (getRoleDefinition(roleId)?.countsAsWolf ? Number(count ?? 0) : 0)
  ), 0);
}

export function countConfiguredMadmanSlots(roleComposition = {}) {
  return Object.entries(roleComposition ?? {}).reduce((total, [roleId, count]) => (
    total + (getRoleDefinition(roleId)?.roleClass === 'madman' ? Number(count ?? 0) : 0)
  ), 0);
}

function countConfiguredWolvesByAbilityResult(roleComposition, resultField, result) {
  return Object.entries(roleComposition ?? {}).reduce((total, [roleId, count]) => {
    const role = getRoleDefinition(roleId);
    if (!role?.countsAsWolf) return total;
    const abilityResult = role[resultField] ?? 'wolf';
    return total + (abilityResult === result ? Number(count ?? 0) : 0);
  }, 0);
}

export function countConfiguredWolvesBySeerResult(roleComposition = {}, result = 'wolf') {
  return countConfiguredWolvesByAbilityResult(roleComposition, 'seerResult', result);
}

export function countConfiguredWolvesByMediumResult(roleComposition = {}, result = 'wolf') {
  return countConfiguredWolvesByAbilityResult(roleComposition, 'mediumResult', result);
}

export function isNightActionActor(state, playerOrId, actionType) {
  const player = asPlayer(state, playerOrId);
  if (!player) return false;
  if (actionType === 'wolf-attack') return canParticipateInWolfAttack(state, player);
  return getRoleDefinition(player)?.nightAction === actionType;
}
