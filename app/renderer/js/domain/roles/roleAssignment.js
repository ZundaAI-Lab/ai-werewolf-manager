/**
 * 責務: 役職IDを検証し、プレイヤーの役職と役職依存状態を一括して同期する。
 * 変更ルール: 準備画面・開始時処理・訂正処理から共通利用し、役職変更時はroleIdだけを直接書き換えない。役職固有状態・状態異常・陣営戦略初期状態を同時に更新する。
 */

import { ROLE_IDS } from '../../config/constants.js';
import { createEmptyFactionStrategyState } from '../game/factionStrategyState.js';
import { createRoleState } from './roleState.js';

export function assignPlayerRole(player, roleId) {
  if (!player || typeof player !== 'object') {
    throw new TypeError('役職を割り当てる参加者が不正です。');
  }
  if (!ROLE_IDS.includes(roleId)) {
    throw new RangeError(`未対応の役職IDです: ${roleId}`);
  }

  player.roleId = roleId;
  player.roleState = createRoleState(roleId);
  player.statusEffects = [];
  player.factionStrategyState = createEmptyFactionStrategyState(roleId);
  return player;
}
