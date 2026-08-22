/**
 * 責務: ゲーム開始時役職シャッフル・役職欠けと、変更前配役を公開し続ける情報境界を検証する。
 * 変更ルール: ランダム結果の個別配置を仕様化しすぎず、役職数・欠け対象・公開構成・同時使用の契約だけを固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES } from '../../../app/renderer/js/config/constants.js';
import { startGame } from '../../../app/renderer/js/domain/game/gameRuntime.js';
import { validateComposition } from '../../../app/renderer/js/domain/game/standardRules.js';
import { applySetupRoles } from '../../../app/renderer/js/domain/setup/setupRoles.js';
import { resolvePublicClaimCommit } from '../../../app/renderer/js/domain/claims/publicClaimCommitPolicy.js';
import { countRoleComposition } from '../../../app/renderer/js/domain/roles/roleComposition.js';


import { createInitialState, createRestartedGameState } from '../../../app/renderer/js/state/stateStore.js';



function fixedState(roleIds) {
  const state = createInitialState(roleIds.length);
  applySetupRoles(state.players, roleIds);
  return state;
}

function withFixedRandom(value, action) {
  const original = Math.random;
  Math.random = () => value;
  try {
    return action();
  } finally {
    Math.random = original;
  }
}

test('開始時役職変更オプションは両方とも既定OFF', () => {
  assert.equal(DEFAULT_RULES.roleAssignment.shuffleOnStart, false);
  assert.equal(DEFAULT_RULES.roleAssignment.roleMissingEnabled, false);
  const state = fixedState(['wolf', 'seer', 'villager', 'guard']);
  const before = state.players.map((player) => player.roleId);
  assert.equal(startGame(state).ok, true);
  assert.deepEqual(state.players.map((player) => player.roleId), before);
  assert.equal(state.game.publicRoleComposition, null);
});

test('ゲーム開始時シャッフルは役職構成を変えずに担当だけを再配置する', () => {
  const state = fixedState(['wolf', 'seer', 'villager', 'guard']);
  state.game.rules.roleAssignment.shuffleOnStart = true;
  const beforeRoles = state.players.map((player) => player.roleId);
  const beforeComposition = countRoleComposition(state.players);
  const started = withFixedRandom(0, () => startGame(state));
  assert.equal(started.ok, true, started.message);
  assert.notDeepEqual(state.players.map((player) => player.roleId), beforeRoles);
  assert.deepEqual(countRoleComposition(state.players), beforeComposition);
  assert.equal(state.game.publicRoleComposition, null);
});

test('役職欠けありは人狼系以外の1枠だけを村人へ変更する', () => {
  const state = fixedState(['wolf', 'seer', 'villager', 'guard']);
  state.game.rules.roleAssignment.roleMissingEnabled = true;
  const beforeComposition = countRoleComposition(state.players);
  const started = withFixedRandom(0, () => startGame(state));
  assert.equal(started.ok, true, started.message);
  assert.deepEqual(state.game.publicRoleComposition, beforeComposition);
  assert.equal(state.players[0].roleId, 'wolf', '人狼は欠け候補にしない');
  assert.equal(state.players[1].roleId, 'villager', '最初の欠け候補である占い師が村人へ変わる');
  assert.equal(countRoleComposition(state.players).villager, 2);
  assert.equal(countRoleComposition(state.players).seer ?? 0, 0);
});

test('役職欠けありで村人が選ばれた場合は実質的に役職が欠けない', () => {
  const state = fixedState(['wolf', 'villager', 'seer', 'guard']);
  state.game.rules.roleAssignment.roleMissingEnabled = true;
  const beforeRoles = state.players.map((player) => player.roleId);
  const beforeComposition = countRoleComposition(state.players);
  const started = withFixedRandom(0, () => startGame(state));
  assert.equal(started.ok, true, started.message);
  assert.deepEqual(state.game.publicRoleComposition, beforeComposition);
  assert.deepEqual(state.players.map((player) => player.roleId), beforeRoles, '最初の欠け候補である村人が選ばれ、実配役は変化しない');
  assert.deepEqual(countRoleComposition(state.players), beforeComposition);
});

test('役職欠けありでは人狼系だけを除外し、人狼陣営の非人狼役職は候補に含める', () => {
  const state = fixedState(['wolf', 'madman', 'snowWoman', 'villager']);
  state.game.rules.roleAssignment.roleMissingEnabled = true;
  const started = withFixedRandom(0, () => startGame(state));
  assert.equal(started.ok, true, started.message);
  assert.equal(state.players[0].roleId, 'wolf', '人狼は欠け候補にしない');
  assert.equal(state.players[1].roleId, 'villager', '狂人は人狼系ではないため欠け候補に含める');
});

test('役職シャッフルと役職欠けを同時使用でき、公開構成は開始前のまま維持する', () => {
  const state = fixedState(['wolf', 'seer', 'villager', 'guard']);
  state.game.rules.roleAssignment.shuffleOnStart = true;
  state.game.rules.roleAssignment.roleMissingEnabled = true;
  const beforeComposition = countRoleComposition(state.players);
  const started = withFixedRandom(0, () => startGame(state));
  assert.equal(started.ok, true, started.message);
  assert.deepEqual(state.game.publicRoleComposition, beforeComposition);
  assert.equal(state.players.length, 4);
  assert.equal(Object.values(countRoleComposition(state.players)).reduce((sum, count) => sum + count, 0), 4);
  assert.equal(countRoleComposition(state.players).villager, 2, '欠けた1枠だけが村人へ置換される');
});


test('役職欠け後の設定引継ぎ再開始は開始前のプレイヤー別配役を復元し、再戦を重ねても役職設定を失わない', () => {
  const originalRoles = ['wolf', 'seer', 'villager', 'guard'];
  const state = fixedState(originalRoles);
  state.game.rules.roleAssignment.roleMissingEnabled = true;
  const originalAssignments = Object.fromEntries(state.players.map((player) => [player.id, player.roleId]));

  assert.equal(withFixedRandom(0, () => startGame(state)).ok, true);
  assert.deepEqual(state.game.setupRoleAssignments, originalAssignments);
  assert.notDeepEqual(state.players.map((player) => player.roleId), originalRoles, '1戦目では占い師が欠けて実配役が変化する');

  const restarted = createRestartedGameState(state);
  assert.deepEqual(restarted.players.map((player) => player.roleId), originalRoles, '再開始時は欠け適用後ではなく開始前配役へ戻る');
  assert.equal(restarted.game.setupRoleAssignments, null, '新しい準備状態では開始前配役スナップショットを未確定へ戻す');

  assert.equal(withFixedRandom(0, () => startGame(restarted)).ok, true);
  const restartedAgain = createRestartedGameState(restarted);
  assert.deepEqual(restartedAgain.players.map((player) => player.roleId), originalRoles, '再戦を重ねても元の配役設定を維持する');
});

test('村人だけが欠け候補でも役職欠けありを開始できる', () => {
  const state = fixedState(['wolf', 'villager', 'villager', 'villager']);
  state.game.rules.roleAssignment.roleMissingEnabled = true;
  const validation = validateComposition(state);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  const beforeComposition = countRoleComposition(state.players);
  assert.equal(withFixedRandom(0, () => startGame(state)).ok, true);
  assert.deepEqual(countRoleComposition(state.players), beforeComposition, '村人抽選なので実質的な欠けなし');
});

test('役職欠け後も公開CO検証から欠けた役職を推測できない', () => {
  const state = fixedState(['wolf', 'seer', 'villager', 'guard']);
  state.game.rules.roleAssignment.roleMissingEnabled = true;
  assert.equal(withFixedRandom(0, () => startGame(state)).ok, true);
  assert.equal(countRoleComposition(state.players).seer ?? 0, 0, '実配役では占い師が欠けている');
  const result = resolvePublicClaimCommit(state, {
    playerId: state.players[2].id,
    coOperation: { action: 'declare', roleId: 'seer' },
  });
  assert.equal(result.ok, true, result.errors.join('\n'));
});
