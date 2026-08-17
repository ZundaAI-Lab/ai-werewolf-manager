/**
 * 責務: キャラクターJSONに内包された有向呼称データをcharacterId同士で参照する。
 * 変更ルール:
 * - 呼称の正本は各キャラクターJSONのcallNamesとし、このモジュールに呼称値を直書きしない。
 * - グループ境界を参照条件にせず、全体一意のcharacterIdだけで解決する。
 * - 未登録時の表示名フォールバックはresolver側の責務とする。
 */

import { CHARACTER_CARD_BY_ID } from '../catalog/characterCatalog.js';

export function getCharacterCallNameEntry(speakerCharacterId, targetCharacterId) {
  const entry = CHARACTER_CARD_BY_ID.get(speakerCharacterId)?.callNames?.[targetCharacterId];
  if (!entry) return null;
  const preferred = String(entry.preferred ?? '').trim();
  if (!preferred) return null;
  return { preferred, status: 'configured' };
}
