/**
 * 責務: 4～16人の対応人数、正式プリセット、初期状態生成を検証する。
 * 変更ルール: 未対応人数の補完や旧上限へのフォールバックを許容するテストを追加しない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PLAYER_COUNT,
  MIN_PLAYER_COUNT,
  PRESET_ROLES,
  ROLE_IDS,
  SUPPORTED_PLAYER_COUNTS,
} from '../../../app/renderer/js/config/constants.js';
import {
  getPresetNoteForPlayerCount,
  getPresetRolesForPlayerCount,
  isSupportedPlayerCount,
} from '../../../app/renderer/js/domain/setup/playerCountPolicy.js';
import { validateComposition } from '../../../app/renderer/js/domain/game/standardRules.js';
import { startGame } from '../../../app/renderer/js/domain/game/gameRuntime.js';
import { createInitialState, createPlayer, StateStore } from '../../../app/renderer/js/state/stateStore.js';
import { applySetupRoles } from '../../../app/renderer/js/domain/setup/setupRoles.js';

const EXPECTED_COUNTS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

const EXPECTED_LARGE_PRESETS = Object.freeze({
  11: ['villager', 'villager', 'villager', 'mason', 'mason', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf'],
  12: ['villager', 'villager', 'villager', 'villager', 'mason', 'mason', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf'],
  13: ['villager', 'villager', 'villager', 'villager', 'mason', 'mason', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf', 'wolf'],
  14: ['villager', 'villager', 'villager', 'villager', 'villager', 'mason', 'mason', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf', 'wolf'],
  15: ['villager', 'villager', 'villager', 'villager', 'villager', 'villager', 'mason', 'mason', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf', 'wolf'],
  16: ['villager', 'villager', 'villager', 'villager', 'villager', 'villager', 'villager', 'mason', 'mason', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf', 'wolf'],
});

test('対応人数は4～16人だけで、全人数に正式プリセットがある', () => {
  assert.equal(MIN_PLAYER_COUNT, 4);
  assert.equal(MAX_PLAYER_COUNT, 16);
  assert.deepEqual(SUPPORTED_PLAYER_COUNTS, EXPECTED_COUNTS);
  assert.deepEqual(Object.keys(PRESET_ROLES).map(Number).sort((a, b) => a - b), EXPECTED_COUNTS);

  EXPECTED_COUNTS.forEach((count) => {
    assert.equal(isSupportedPlayerCount(count), true);
    const roles = getPresetRolesForPlayerCount(count);
    assert.equal(roles.length, count);
    roles.forEach((roleId) => assert.equal(ROLE_IDS.includes(roleId), true));
    assert.equal(roles.filter((roleId) => roleId === 'wolf').length >= 1, true);
    assert.equal(getPresetNoteForPlayerCount(count).length > 0, true);
  });
});


test('9～16人の初期状態を要求人数どおり生成し開始できる', () => {
  [9, 10, 11, 12, 13, 14, 15, 16].forEach((count) => {
    const state = createInitialState(count);
    assert.equal(state.players.length, count);
    assert.equal(validateComposition(state).ok, true);
    const started = startGame(state);
    assert.equal(started.ok, true);
    assert.equal(state.briefing.eligiblePlayerIds.length, count);
    assert.equal(Object.keys(state.briefing.noticeStatusByPlayerId).length, count);
    assert.equal(Object.keys(state.game.callNameSnapshot.bySpeakerId).length, count);
    state.players.forEach((speaker) => {
      assert.equal(Object.keys(state.game.callNameSnapshot.bySpeakerId[speaker.id]).length, count - 1);
    });
  });
});


