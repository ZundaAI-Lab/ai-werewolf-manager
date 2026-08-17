/**
 * 責務: テストでゲーム開始後相当の本人知識を、現行の役職属性と通信設定から決定的に再構築する。
 * 変更ルール: 本番状態の進行処理は呼ばず、テスト前提の同期だけを行う。役職IDの固定配列や参加順へ依存しない。
 */

import {
  canKnowMadmanPartners,
  canKnowWolfPartners,
  getPlayerTeam,
  isMadmanClass,
  countsAsWolf,
} from '../../../app/renderer/js/domain/roles/roleAttributes.js';

export function synchronizePlayerKnowledgeForTest(state) {
  const wolfIds = state.players.filter((player) => countsAsWolf(state, player)).map((player) => player.id);
  const madmanIds = state.players.filter((player) => isMadmanClass(state, player)).map((player) => player.id);
  const masonIds = state.players.filter((player) => player.roleId === 'mason').map((player) => player.id);
  state.playerKnowledge = Object.fromEntries(state.players.map((player) => [player.id, {
    knownWolfIds: canKnowWolfPartners(state, player) ? [...wolfIds] : [],
    knownMadmanIds: canKnowMadmanPartners(state, player) ? [...madmanIds] : [],
    knownMasonIds: player.roleId === 'mason' ? [...masonIds] : [],
    knownOwnerId: player.roleId === 'zashikiWarashi' ? player.roleState?.ownerId ?? null : null,
    knownOwnerRoleId: player.roleId === 'zashikiWarashi' ? player.roleState?.ownerRoleId ?? null : null,
    resolvedTeam: player.roleId === 'zashikiWarashi' ? player.roleState?.resolvedTeam ?? null : getPlayerTeam(state, player),
    roleNotifiedAt: null,
    knowledgeRevision: 0,
  }]));
  return state;
}
