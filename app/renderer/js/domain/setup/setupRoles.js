/**
 * 責務: ゲーム準備中の役職割り当てを、共通の役職変更ドメイン処理へ接続する。
 * 変更ルール: 準備フェーズ以外の役職訂正には使用しない。役職ID検証と依存状態同期はroleAssignment.jsへ委譲し、このモジュールへ重複実装しない。
 */

import { assignPlayerRole } from '../roles/roleAssignment.js';

export function assignSetupPlayerRole(player, roleId) {
  return assignPlayerRole(player, roleId);
}

export function applySetupRoles(players, roleIds) {
  if (!Array.isArray(players) || !Array.isArray(roleIds)) {
    throw new TypeError('参加者と役職は配列で指定してください。');
  }
  if (players.length !== roleIds.length) {
    throw new Error(`参加者数と役職数が一致していません: ${players.length}人 / ${roleIds.length}役職`);
  }

  players.forEach((player, index) => assignSetupPlayerRole(player, roleIds[index]));
  return players;
}
