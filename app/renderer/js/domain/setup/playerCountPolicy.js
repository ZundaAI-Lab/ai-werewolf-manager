/**
 * 責務: 対応する参加人数と、その人数に完全一致する標準配役プリセットを提供する。
 * 変更ルール: 未対応人数や不完全なプリセットを補完・代替しない。状態更新・DOM操作・ランダム化を行わない。
 */

import {
  MAX_PLAYER_COUNT,
  MIN_PLAYER_COUNT,
  PRESET_NOTES,
  PRESET_ROLES,
  SUPPORTED_PLAYER_COUNTS,
} from '../../config/constants.js';

const SUPPORTED_PLAYER_COUNT_SET = new Set(SUPPORTED_PLAYER_COUNTS);

export function isSupportedPlayerCount(count) {
  return Number.isInteger(count)
    && count >= MIN_PLAYER_COUNT
    && count <= MAX_PLAYER_COUNT
    && SUPPORTED_PLAYER_COUNT_SET.has(count);
}

export function getPresetRolesForPlayerCount(count) {
  if (!isSupportedPlayerCount(count)) {
    throw new RangeError(`参加人数は${MIN_PLAYER_COUNT}～${MAX_PLAYER_COUNT}人にしてください: ${count}`);
  }

  if (!Object.hasOwn(PRESET_ROLES, count)) {
    throw new Error(`${count}人用の推奨配役が定義されていません。`);
  }

  const roles = PRESET_ROLES[count];
  if (!Array.isArray(roles) || roles.length !== count) {
    throw new Error(`${count}人用の推奨配役が参加人数と一致していません。`);
  }

  return [...roles];
}


export function getPresetNoteForPlayerCount(count) {
  if (!isSupportedPlayerCount(count)) {
    throw new RangeError(`参加人数は${MIN_PLAYER_COUNT}～${MAX_PLAYER_COUNT}人にしてください: ${count}`);
  }

  if (!Object.hasOwn(PRESET_NOTES, count) || !String(PRESET_NOTES[count]).trim()) {
    throw new Error(`${count}人用の推奨配役説明が定義されていません。`);
  }

  return PRESET_NOTES[count];
}
