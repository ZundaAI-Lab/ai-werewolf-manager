/**
 * 責務: 読み取り専用キャラクターカタログから、ゲーム参加者へ適用するカード検索・プリセット生成APIを提供する。
 * 変更ルール:
 * - キャラクター固有データはJSONだけを正本とし、このモジュールへ直書きしない。
 * - グループは表示・権利管理上の分類であり、characterIdの一意性やゲーム上の参照条件には使わない。
 * - 旧形式への変換や互換処理は持たない。
 */

import {
  CHARACTER_CARDS,
  CHARACTER_CARD_BY_ID,
  CHARACTER_CARD_BY_NAME,
} from '../catalog/characterCatalog.js';

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export { CHARACTER_CARDS, CHARACTER_CARD_BY_ID, CHARACTER_CARD_BY_NAME };

export function getCharacterCard(idOrName) {
  return CHARACTER_CARD_BY_ID.get(idOrName)
    ?? CHARACTER_CARD_BY_NAME.get(idOrName)
    ?? null;
}

export function createCharacterPlayerPreset(idOrName) {
  const card = getCharacterCard(idOrName);
  if (!card) return null;
  return {
    name: card.name,
    aliases: clone(card.aliases),
    character: clone(card.character),
    metadata: {
      characterId: card.id,
      groupId: card.groupId,
    },
  };
}
