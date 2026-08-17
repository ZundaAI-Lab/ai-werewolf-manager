/**
 * 責務: 生存人狼ごとの秘密襲撃投票、最多票集計、同率抽選、AI失敗時の個別ランダム票を検証する。
 * 変更ルール: 全票を正式コマンドで登録し、AI失敗時の個別抽選と最多同率時の抽選結果が状態へ一度だけ固定されることを確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeRole,
  markBriefingShown,
  recordRandomWolfAttackVote,
  recordWolfAttackVote,
  startGame,
} from '../../../app/renderer/js/domain/game/gameRuntime.js';
import { getAttackCandidates } from '../../../app/renderer/js/domain/game/standardRules.js';
import { buildRequiredFieldFallbackCandidate } from '../../../app/renderer/js/services/aiTaskFallbackService.js';
import { createInitialState, StateStore } from '../../../app/renderer/js/state/stateStore.js';
import { validateImportedState } from '../../../app/renderer/js/state/stateValidator.js';

function assertOk(response, label) {
  assert.equal(response?.ok, true, `${label}: ${response?.message ?? '応答なし'}`);
}

function createVotingState(roleIds) {
  const state = createInitialState(roleIds.length);
  state.players.forEach((player, index) => {
    player.roleId = roleIds[index];
    player.controller = 'ai';
  });
  state.game.rules.firstNight.wolfAttackEnabled = true;
  state.game.rules.firstNight.wolfCommunicationEnabled = false;
  assertOk(startGame(state), 'ゲーム開始');
  state.players.forEach((player) => {
    assertOk(markBriefingShown(state, player.id), `${player.name}の役職表示`);
    assertOk(acknowledgeRole(state, player.id), `${player.name}の役職確認`);
  });
  assert.equal(state.game.phase, 'night');
  assert.equal(state.night.wolfAttack.status, 'voting');
  return state;
}

function assertValid(state) {
  const validation = validateImportedState(state);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
}

test('通常人狼と白狼だけが一票ずつ持ち、狂人は襲撃投票へ参加しない', () => {
  const state = createVotingState(['wolf', 'whiteWolf', 'madman', 'villager', 'seer']);
  const expected = state.players.filter((player) => ['wolf', 'whiteWolf'].includes(player.roleId)).map((player) => player.id);
  assert.deepEqual(state.night.wolfAttack.voterWolfIds, expected);
  assert.equal(state.night.wolfAttack.voterWolfIds.includes(state.players[2].id), false);
  assertValid(state);
});


test('最多票が同率なら正式襲撃対象確定前を保存し、同率1位から一度だけランダムに確定する', () => {
  const store = new StateStore(createVotingState(['wolf', 'whiteWolf', 'madman', 'villager', 'seer']));
  let state = store.getState();
  const [firstWolfId, secondWolfId] = state.night.wolfAttack.voterWolfIds;
  const [firstTarget, secondTarget] = getAttackCandidates(state);
  assert.ok(firstTarget && secondTarget);

  store.commit('同率1票目', (draft) => {
    assertOk(recordWolfAttackVote(draft, {
      actorId: firstWolfId,
      targetId: firstTarget.id,
      random: () => 0,
    }), '同率1票目');
  });
  store.commit('同率2票目', (draft) => {
    assertOk(recordWolfAttackVote(draft, {
      actorId: secondWolfId,
      targetId: secondTarget.id,
      random: () => 0.999999,
    }), '同率2票目');
  });

  state = store.getState();
  assert.equal(state.night.wolfAttack.tally.resolutionMethod, 'random-tie');
  assert.deepEqual(state.night.wolfAttack.tally.topTargetIds, [firstTarget.id, secondTarget.id]);
  assert.equal(state.night.wolfAttack.finalTargetId, secondTarget.id);
  const restorePoints = state.restorePoints.filter((point) => point.label === '正式襲撃対象確定前');
  assert.equal(restorePoints.length, 1, '入力経路に依存せず正式確定直前を一度だけ保存する');
  assert.equal(restorePoints[0].state.night.wolfAttack.voteByWolfId[secondWolfId], null, '最後の票を登録する前へ戻せる');
  const fixedTargetId = state.night.wolfAttack.finalTargetId;
  const retry = recordWolfAttackVote(structuredClone(state), { actorId: firstWolfId, targetId: secondTarget.id }, { random: () => 0 });
  assert.equal(retry.ok, false);
  assert.equal(state.night.wolfAttack.finalTargetId, fixedTargetId, '確定後に抽選し直さない');
  assertValid(state);
});


