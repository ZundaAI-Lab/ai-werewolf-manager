/**
 * 責務: ゲーム開始時だけ適用する役職再配置と役職欠けを処理し、再開始用の開始前プレイヤー別配役と、役職欠け使用時の公開用役職構成を固定する。
 * 変更ルール: 準備画面の手動配役変更や進行中の役職訂正には使用しない。開始前配役を保存してから、役職欠け使用時は公開用構成も保存し、「開始時シャッフル→役職欠け」の順で実配役だけを変更する。再開始用のプレイヤー別配役と公開用の人数構成は用途が異なるため統合しない。村人を含む人狼系以外を抽選し、村人が選ばれた場合は実質的な欠けなしとする。
 */

import { shuffle } from '../../shared/utils.js';
import { countRoleComposition } from '../roles/roleComposition.js';
import { getRoleMissingCandidates } from '../roles/roleMissingPolicy.js';
import { applySetupRoles, assignSetupPlayerRole } from './setupRoles.js';

export function applyStartRoleAssignmentRules(state) {
  const rules = state?.game?.rules?.roleAssignment ?? {};
  state.game.setupRoleAssignments = Object.fromEntries(
    state.players.map((player) => [player.id, player.roleId]),
  );
  state.game.publicRoleComposition = rules.roleMissingEnabled === true
    ? countRoleComposition(state.players)
    : null;

  if (rules.shuffleOnStart === true) {
    applySetupRoles(state.players, shuffle(state.players.map((player) => player.roleId)));
  }

  if (rules.roleMissingEnabled === true) {
    const candidates = getRoleMissingCandidates(state.players);
    if (!candidates.length) throw new Error('役職欠けありを適用できる役職がありません。');
    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    assignSetupPlayerRole(selected, 'villager');
  }
}
