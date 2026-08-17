/**
 * 責務: 各画面で共有する選択肢、役職表示、プレイヤー表示などの純粋HTML部品を生成する。
 * 変更ルール: 状態更新・イベント登録・ゲーム規則判定を行わない。
 */

import { ROLE_DEFINITIONS, ROLE_IDS } from '../../config/constants.js';
import { escapeHtml, selected } from '../../shared/utils.js';

export function option(value, label, current, disabled = false) {
  return `<option value="${escapeHtml(value)}"${selected(current, value)}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</option>`;
}

export function roleOptions(current) {
  return ROLE_IDS.map((id) => option(id, ROLE_DEFINITIONS[id].name, current)).join('');
}

export function playerOptions(players, current = '', placeholder = '選択してください', { allowAbstain = false } = {}) {
  const abstain = allowAbstain ? option('abstain', '棄権', current) : '';
  return `<option value="">${escapeHtml(placeholder)}</option>${abstain}${players.map((player) => option(player.id, player.name, current)).join('')}`;
}
