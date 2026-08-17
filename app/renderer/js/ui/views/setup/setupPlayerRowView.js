/**
 * 責務: ゲーム準備画面の参加者1行とキャラクターカード選択肢のHTML生成を所有する。
 * 変更ルール: 状態更新やDOM局所同期を行わず、受け取った参加者状態だけをエスケープして描画する。準備画面の局所更新契約で使用するdata-player-field / data-player-id / data-character-card属性は本ファイルを正本とする。
 */

import { CHARACTER_CARD_BY_ID, getCharacterGroups } from '../../../characters/catalog/characterCatalog.js';
import { PLAYER_NAME_MAX_LENGTH } from '../../../domain/policies/playerIdentityPolicy.js';
import { escapeHtml, selected } from '../../../shared/utils.js';
import { option, roleOptions } from '../../components/components.js';

export function characterCardOptions(players, player) {
  const assignedToOthers = new Set(players
    .filter((item) => item.id !== player.id && item.characterCardId)
    .map((item) => item.characterCardId));
  const groups = getCharacterGroups()
    .filter((group) => group.characters.length && (group.enabled || group.characters.some((card) => card.id === player.characterCardId)))
    .map((group) => {
      const visibleCards = group.enabled
        ? group.characters
        : group.characters.filter((card) => card.id === player.characterCardId);
      const options = visibleCards.map((card) => {
        const unavailable = assignedToOthers.has(card.id) || (!group.enabled && card.id !== player.characterCardId);
        const disabled = unavailable ? ' disabled' : '';
        const suffix = group.enabled ? '' : '（使用停止中）';
        return `<option value="${escapeHtml(card.id)}"${selected(player.characterCardId, card.id)}${disabled}>${escapeHtml(card.name)}${suffix}</option>`;
      }).join('');
      const groupSuffix = group.enabled ? '' : '（使用停止中）';
      return `<optgroup label="${escapeHtml(group.name)}${groupSuffix}">${options}</optgroup>`;
    }).join('');
  const missingCurrent = player.characterCardId && !CHARACTER_CARD_BY_ID.has(player.characterCardId)
    ? `<option value="${escapeHtml(player.characterCardId)}" selected disabled>削除済みカード（現在の設定を保持）</option>`
    : '';
  return `<option value=""${selected(player.characterCardId, null)}>手動設定</option>${missingCurrent}${groups}`;
}

export function renderSetupPlayerRow({ players, player, index, locked }) {
  const playerId = escapeHtml(player.id);
  const playerName = escapeHtml(player.name);
  const disabled = locked ? 'disabled' : '';
  return `<div class="player-editor">
    <span class="player-number">${index + 1}</span>
    <select class="character-card-select" data-character-card data-player-id="${playerId}" ${disabled}>${characterCardOptions(players, player)}</select>
    <input class="player-name-input" data-player-field="name" data-player-id="${playerId}" maxlength="${PLAYER_NAME_MAX_LENGTH}" value="${playerName}" ${disabled}>
    <select class="controller-select" data-player-field="controller" data-player-id="${playerId}" ${disabled}>${option('ai', 'AI', player.controller)}${option('human', '人間', player.controller)}</select>
    <select class="role-select" data-player-field="roleId" data-player-id="${playerId}" ${disabled}>${roleOptions(player.roleId)}</select>
    <div class="player-order-actions">
      <button class="button small ghost" data-action="move-player-up" data-player-id="${playerId}" type="button" aria-label="${playerName}を上へ移動" title="上へ移動" ${locked || index === 0 ? 'disabled' : ''}>↑</button>
      <button class="button small ghost" data-action="move-player-down" data-player-id="${playerId}" type="button" aria-label="${playerName}を下へ移動" title="下へ移動" ${locked || index === players.length - 1 ? 'disabled' : ''}>↓</button>
    </div>
    <button class="button small ghost player-detail-button" data-action="edit-player" data-player-id="${playerId}" type="button">詳細</button>
  </div>`;
}
