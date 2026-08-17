/**
 * 責務: 座敷わらし本人へ通知済みの家主情報と、公開されている生存状態・人数だけから戦術分岐を純粋に導出する。
 * 変更ルール: 状態を変更しない。家主以外を含むGM内部の真役職・実際の生存人狼数・未通知のroleStateを参照せず、playerKnowledgeを本人知識の正本とする。
 */

import { getRoleDefinition } from '../roles/roleAttributes.js';

function getPlayer(state, playerOrId) {
  if (!playerOrId) return null;
  if (typeof playerOrId === 'object') return playerOrId;
  return state?.players?.find((player) => player.id === playerOrId) ?? null;
}

function knowledgeFor(state, playerId) {
  return state?.playerKnowledge?.[playerId] ?? null;
}

function resolveVariant(resolvedTeam, ownerRole) {
  if (!ownerRole || !resolvedTeam) return 'unresolved';
  if (resolvedTeam === 'village') return 'village-host';
  if (resolvedTeam === 'wolf') return ownerRole.countsAsWolf ? 'werewolf-host' : 'werewolf-support-host';
  if (resolvedTeam === 'fox') return 'third-party-host';
  return 'unresolved';
}

export function buildZashikiWarashiStrategy(state, playerOrId) {
  const player = getPlayer(state, playerOrId);
  if (player?.roleId !== 'zashikiWarashi') return null;

  const knowledge = knowledgeFor(state, player.id);
  const ownerId = knowledge?.knownOwnerId ?? null;
  const ownerRoleId = knowledge?.knownOwnerRoleId ?? null;
  const resolvedTeam = knowledge?.resolvedTeam ?? null;
  const owner = getPlayer(state, ownerId);
  const ownerRole = getRoleDefinition(ownerRoleId);
  const variant = resolveVariant(resolvedTeam, ownerRole);
  const aliveCountBefore = state.players.filter((entry) => entry.alive).length;
  const ownerAlive = Boolean(owner?.alive);
  const selfWouldDie = Boolean(player.alive && ownerAlive);
  const ownerWouldDie = ownerAlive;
  const simultaneousDeathCount = Number(selfWouldDie) + Number(ownerWouldDie);
  const ownerCountsAsWolfForVictory = Boolean(ownerRole?.countsAsWolf);
  const wolfCountDelta = ownerWouldDie && ownerCountsAsWolfForVictory ? -1 : 0;
  const nonWolfCountDelta = -(Number(selfWouldDie) + Number(ownerWouldDie && !ownerCountsAsWolfForVictory));
  const aliveCountAfterOwnerFollowDeath = Math.max(0, aliveCountBefore - simultaneousDeathCount);

  return {
    variant,
    resolvedTeam,
    ownerId,
    ownerName: owner?.name ?? null,
    ownerRoleId,
    ownerRoleName: ownerRole?.name ?? null,
    ownerCountsAsWolfForVictory,
    ownerAlive,
    selfAlive: Boolean(player.alive),
    aliveCountBefore,
    aliveCountAfterOwnerFollowDeath,
    simultaneousDeathCount,
    wolfCountDelta,
    nonWolfCountDelta,
    wolfWinThresholdAfterOwnerFollowDeath: Math.ceil(aliveCountAfterOwnerFollowDeath / 2),
  };
}
