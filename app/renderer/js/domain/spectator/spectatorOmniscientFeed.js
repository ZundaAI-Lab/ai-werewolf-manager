/**
 * 責務: 神視点観戦へ開示してよい真役職・再生時点の現在陣営・登場役職の基本能力だけをGame Stateから専用Feedへ射影する。
 * 変更ルール: 心の声・内部メモ・私有会話・AI判断状態・未確定/非公開の投票先・襲撃先・能力対象を含めない。神視点は「役職開示」でありデバッグ情報開示ではない。追っかけ観戦では公開盤面の生死とcutoff以前に確定した動的陣営だけを使用し、未来の状態を混入させない。座敷わらしの家主情報そのものは開示しない。Prompt向け文字列化は行わず、構造化Feedのまま上位の安全なserializerへ渡す。
 */

import { ROLE_DEFINITIONS, TEAM_LABELS } from '../../config/constants.js';
import { getPlayerTeam } from '../roles/roleAttributes.js';

function cleanText(value) {
  return String(value ?? '').trim();
}

function roleDefinition(roleId) {
  return ROLE_DEFINITIONS[String(roleId ?? '')] ?? null;
}

function teamLabel(teamId) {
  return TEAM_LABELS[teamId] ?? (teamId ? String(teamId) : '所属未確定');
}

function resolvedTeamAtSequence(state, player, cutoffSequence) {
  if (player.roleId !== 'zashikiWarashi' || cutoffSequence === null) return getPlayerTeam(state, player);
  const resolved = (state.events ?? [])
    .filter((event) => event.type === 'private-result'
      && event.actorId === player.id
      && event.payload?.actionType === 'choose-owner'
      && Number(event.sequence ?? 0) <= cutoffSequence)
    .sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0))
    .at(-1);
  return resolved?.payload?.resolvedTeam ?? null;
}

export function buildSpectatorOmniscientFeed(state, { publicSnapshot = null, cutoffSequence = null } = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Game Stateがありません。');
  const publicPlayerById = new Map((publicSnapshot?.players ?? []).map((player) => [player.id, player]));
  const cutoff = cutoffSequence === null ? null : Math.max(0, Number(cutoffSequence ?? 0) || 0);
  const players = (state.players ?? []).map((player) => {
    const role = roleDefinition(player.roleId);
    const teamId = resolvedTeamAtSequence(state, player, cutoff);
    return {
      name: cleanText(player.name) || '不明',
      roleId: cleanText(player.roleId),
      roleName: role?.name ?? (cleanText(player.roleId) || '不明'),
      teamId: cleanText(teamId),
      teamName: teamLabel(teamId),
      alive: publicPlayerById.has(player.id) ? publicPlayerById.get(player.id).alive === true : player.alive === true,
    };
  });
  const seenRoles = new Set();
  const roleRules = [];
  for (const player of state.players ?? []) {
    const roleId = cleanText(player.roleId);
    if (!roleId || seenRoles.has(roleId)) continue;
    seenRoles.add(roleId);
    const role = roleDefinition(roleId);
    if (!role) continue;
    roleRules.push({
      roleId,
      roleName: role.name,
      description: cleanText(role.description),
    });
  }
  return {
    schemaVersion: 1,
    players,
    roleRules,
  };
}

export function spectatorOmniscientFactSignature(feed) {
  return JSON.stringify((feed?.players ?? []).map((player) => ({
    name: player.name,
    roleId: player.roleId,
    teamId: player.teamId,
    alive: player.alive,
  })));
}
