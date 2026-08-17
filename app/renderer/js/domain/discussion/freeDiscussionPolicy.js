/**
 * 責務: 発言希望制の発言希望正規化、同優先度内抽選、DONEによる通常発言終了を決定する。
 * 変更ルール: 1巡目開始前はDONEを受理せず、希望値はGM内部制御だけに使用して公開履歴へ変換しない。
 */

import {
  FREE_DISCUSSION_OPENING_PREFERENCES,
  FREE_DISCUSSION_PREFERENCES,
} from '../../config/discussionAiTaskTypes.js';

const PREFERENCE_PRIORITY = Object.freeze(['EARLY', 'NORMAL', 'WAIT_CO']);

export function normalizeFreeDiscussionPreference(value, { opening = false } = {}) {
  const normalized = String(value ?? '').trim().toUpperCase();
  const allowed = opening ? FREE_DISCUSSION_OPENING_PREFERENCES : FREE_DISCUSSION_PREFERENCES;
  if (allowed.includes(normalized)) return normalized;
  return 'NORMAL';
}

function shuffle(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function buildFreeDiscussionQueue(playerIds, preferenceByPlayerId, {
  opening = false,
  random = Math.random,
} = {}) {
  const groups = new Map(PREFERENCE_PRIORITY.map((preference) => [preference, []]));
  for (const playerId of playerIds ?? []) {
    const preference = normalizeFreeDiscussionPreference(preferenceByPlayerId?.[playerId], { opening });
    if (!opening && preference === 'DONE') continue;
    groups.get(preference)?.push(playerId);
  }
  return PREFERENCE_PRIORITY.flatMap((preference) => shuffle(groups.get(preference) ?? [], random));
}

export function freeDiscussionDonePlayerIds(modeControl) {
  return [...new Set(modeControl?.donePlayerIds ?? [])];
}

export function isFreeDiscussionDone(modeControl, playerId) {
  return freeDiscussionDonePlayerIds(modeControl).includes(playerId);
}
