/**
 * 責務: 共通役職変更ドメイン処理と役職訂正APIが、未対応役職IDを状態へ確定せず、役職依存状態を同時同期することを検証する。
 * 変更ルール: setup・correctionの画面挙動は検証せず、役職変更のドメイン境界だけを固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  correctRoleAssignment,
  enterCorrectionMode,
} from '../../../app/renderer/js/domain/game/gameRuntime.js';
import { assignPlayerRole } from '../../../app/renderer/js/domain/roles/roleAssignment.js';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';

test('共通役職変更は未対応役職IDを拒否し状態を変更しない', () => {
  const state = createInitialState(4);
  const player = state.players[0];
  const before = structuredClone(player);
  assert.throws(() => assignPlayerRole(player, 'not-a-role'), /未対応の役職ID/u);
  assert.deepEqual(player, before);
});

test('役職訂正は未対応役職IDを失敗結果として返し不正状態を作らない', () => {
  const state = createInitialState(4);
  const player = state.players[0];
  const beforeRoleId = player.roleId;
  const beforeRoleState = structuredClone(player.roleState);
  assert.equal(enterCorrectionMode(state, '役職訂正テスト').ok, true);

  const corrected = correctRoleAssignment(state, {
    playerId: player.id,
    correctedRoleId: 'not-a-role',
    reason: '入力境界テスト',
  });

  assert.equal(corrected.ok, false);
  assert.match(corrected.message, /未対応の役職ID/u);
  assert.equal(player.roleId, beforeRoleId);
  assert.deepEqual(player.roleState, beforeRoleState);
});

test('共通役職変更は役職固有状態・状態異常・陣営戦略を同時に初期化する', () => {
  const state = createInitialState(4);
  const player = state.players[0];
  player.statusEffects = [{ type: 'fear', day: 1, sourcePlayerId: state.players[1].id }];
  assignPlayerRole(player, 'namahage');
  assert.equal(player.roleId, 'namahage');
  assert.deepEqual(player.roleState, { lastTargetId: null });
  assert.deepEqual(player.statusEffects, []);
  assert.equal(player.factionStrategyState, null);
});
