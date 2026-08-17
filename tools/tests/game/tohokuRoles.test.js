/**
 * 責務: 東北モチーフ役職の属性、初夜優先行動、夜解決、昼参加制限、後追いと勝敗を横断して検証する。
 * 変更ルール: 役職IDの個別例外ではなく公開された属性APIと実際のゲームコマンドを通して確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeRole,
  beginVote,
  grantTargetedDiscussionReconsideration,
  markBriefingShown,
  recordNightAction,
  recordHumanSpeech,
  recordVote,
  startGame,
} from '../../../app/renderer/js/domain/game/gameRuntime.js';
import { resolveExecutionDeaths, resolveFollowUpDeaths, resolveNightDeaths } from '../../../app/renderer/js/domain/game/deathResolution.js';
import { resolveNightActions } from '../../../app/renderer/js/domain/night/nightResolution.js';
import { applyResolvedFearStatuses } from '../../../app/renderer/js/domain/night/actionExecutionPolicy.js';
import {
  detectWinner,
  getAttackCandidates,
  getVisitCandidates,
  inspectResult,
  mediumResult,
  validateComposition,
} from '../../../app/renderer/js/domain/game/standardRules.js';
import { applySetupRoles } from '../../../app/renderer/js/domain/setup/setupRoles.js';
import { createRoleState } from '../../../app/renderer/js/domain/roles/roleState.js';
import { countConfiguredMadmanSlots, countConfiguredWolves, countsAsWolf, getFactionStrategyProfile, getPlayerTeam, isActualFox, isBadChild } from '../../../app/renderer/js/domain/roles/roleAttributes.js';
import { canSpeakDuringDay, canVoteDuringDay } from '../../../app/renderer/js/domain/game/playerStatus.js';
import { buildPromptContext } from '../../../app/renderer/js/prompts/promptBuilder.js';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { validateImportedState } from '../../../app/renderer/js/state/stateValidator.js';

function setRoles(state, roleIds) {
  applySetupRoles(state.players, roleIds);
  state.players.forEach((player) => {
    player.alive = true;
    player.death = null;
  });
}

function completeBriefing(state) {
  state.players.forEach((player) => {
    assert.equal(markBriefingShown(state, player.id).ok, true);
    assert.equal(acknowledgeRole(state, player.id).ok, true);
  });
}

test('終盤判定の固定枠は人狼枠・狂人枠の属性から数え、遅延所属の座敷わらしを含めない', () => {
  assert.equal(countConfiguredWolves({ wolf: 1, whiteWolf: 1, madman: 1, snowWoman: 1, zashikiWarashi: 1 }), 2);
  assert.equal(countConfiguredMadmanSlots({ wolf: 1, whiteWolf: 1, madman: 1, snowWoman: 1, zashikiWarashi: 1 }), 2);
  assert.equal(countConfiguredMadmanSlots({ zashikiWarashi: 2, whiteWolf: 1 }), 0);
});

test('白狼は占い結果だけを偽装し、それ以外は人狼属性として扱う', () => {
  const state = createInitialState(6);
  setRoles(state, ['whiteWolf', 'cat', 'seer', 'medium', 'guard', 'villager']);
  const whiteWolf = state.players[0];
  assert.equal(countsAsWolf(state, whiteWolf), true);
  assert.equal(getFactionStrategyProfile(state, whiteWolf), 'wolf');
  assert.equal(inspectResult(state, whiteWolf.id), 'not-wolf');
  assert.equal(mediumResult(state, whiteWolf.id), 'wolf');
  assert.equal(getAttackCandidates(state).some((player) => player.id === whiteWolf.id), false);

  const cat = state.players[1];
  const resolved = resolveNightDeaths(state, { attackedTargetId: cat.id, random: () => 0 });
  assert.equal(resolved.catCollateralWolfId, whiteWolf.id);
  assert.equal(resolved.deaths.some((death) => death.playerId === whiteWolf.id && death.cause === 'cat-revenge'), true);
});


test('全生存人狼が恐怖になった夜だけ襲撃全体を阻害し、阻害後に恐怖を解除する', () => {
  const state = createInitialState(7);
  setRoles(state, ['namahage', 'wolf', 'whiteWolf', 'snowWoman', 'guard', 'villager', 'seer']);
  const [namahage, wolf, whiteWolf, , , victim] = state.players;
  state.night = { day: 2 };
  wolf.statusEffects.push({ type: 'fear', day: 1, sourcePlayerId: namahage.id });

  const resolution = resolveNightActions(state, {
    attackedTargetId: victim.id,
    visitSlots: [{ actorId: namahage.id, targetId: whiteWolf.id }],
  });
  const attackExecution = resolution.actionExecutions.find((entry) => entry.actionType === 'wolf-attack');
  assert.equal(attackExecution.executionState, 'blocked');
  assert.equal(attackExecution.blockReason, 'fear');
  assert.deepEqual(attackExecution.fearfulActorIds, [wolf.id, whiteWolf.id]);
  assert.deepEqual(attackExecution.consumedFearPlayerIds, [wolf.id, whiteWolf.id]);
  assert.equal(resolution.attackedTargetId, null);
  assert.equal(resolution.attackOutcome, 'not-executed');
  assert.equal(resolution.deaths.length, 0);

  applyResolvedFearStatuses(state, resolution, []);
  assert.equal(wolf.statusEffects.some((effect) => effect.type === 'fear'), false);
  assert.equal(whiteWolf.statusEffects.some((effect) => effect.type === 'fear'), false);
});



test('雪女の凍結は護衛対象には失敗し、夜行動自体は確定済みとして残る', () => {
  const state = createInitialState(6);
  setRoles(state, ['snowWoman', 'guard', 'namahage', 'whiteWolf', 'villager', 'seer']);
  const [snowWoman, guard, , , target] = state.players;
  const resolution = resolveNightActions(state, {
    guardSlots: [{ actorId: guard.id, targetId: target.id }],
    freezeSlots: [{ actorId: snowWoman.id, targetId: target.id }],
  });
  const freezeExecution = resolution.actionExecutions.find((entry) => entry.actionType === 'freeze');
  assert.equal(freezeExecution.executionState, 'executed');
  assert.equal(resolution.freezeOutcome, 'guarded');
  assert.equal(resolution.freezeTargetId, target.id);
  assert.equal(resolution.frozenPlayerId, null);
});


test('凍結者は翌日の昼発言と投票を失い、処刑候補には残る', () => {
  const state = createInitialState(6);
  setRoles(state, ['snowWoman', 'whiteWolf', 'villager', 'seer', 'guard', 'namahage']);
  state.game.status = 'running';
  state.game.phase = 'discussion';
  state.game.day = 2;
  const frozen = state.players[2];
  frozen.statusEffects.push({ type: 'frozen', day: 2, sourcePlayerId: state.players[0].id });
  state.discussion = { completed: true, reconsideration: { pending: false } };

  assert.equal(canSpeakDuringDay(state, frozen.id), false);
  assert.equal(canVoteDuringDay(state, frozen.id), false);
  const begun = beginVote(state);
  assert.equal(begun.ok, true, begun.message);
  assert.equal(state.voteSession.eligibleVoterIds.includes(frozen.id), false);
  assert.equal(state.voteSession.candidateIds.includes(frozen.id), true);
  state.voteSession.inputMode = 'list';
  const directVote = recordVote(state, { voterId: frozen.id, targetId: state.players[1].id });
  assert.equal(directVote.ok, false);
  assert.equal(directVote.message, '投票資格がありません。');
});


test('座敷わらしは家主の死因を問わず後追いし、妖狐家主とは同じ第三陣営で勝利する', () => {
  const state = createInitialState(6);
  setRoles(state, ['zashikiWarashi', 'fox', 'seer', 'whiteWolf', 'villager', 'guard']);
  const [zashiki, fox, seer] = state.players;
  zashiki.roleState = createRoleState('zashikiWarashi', {
    ownerId: fox.id,
    ownerRoleId: 'fox',
    resolvedTeam: 'fox',
  });
  assert.equal(isActualFox(state, zashiki), false);
  assert.equal(getPlayerTeam(state, zashiki), 'fox');
  assert.equal(detectWinner(state), null);

  const resolved = resolveNightActions(state, {
    inspectSlots: [{ actorId: seer.id, targetId: fox.id }],
  });
  assert.equal(resolved.deaths.some((death) => death.playerId === fox.id && death.cause === 'fox-divination'), true);
  assert.equal(resolved.deaths.some((death) => death.playerId === zashiki.id && death.cause === 'owner-follow'), true);

  const villageState = createInitialState(4);
  setRoles(villageState, ['zashikiWarashi', 'villager', 'whiteWolf', 'seer']);
  const follower = villageState.players[0];
  const owner = villageState.players[1];
  follower.roleState = createRoleState('zashikiWarashi', {
    ownerId: owner.id,
    ownerRoleId: owner.roleId,
    resolvedTeam: 'village',
  });
  const baseExecution = resolveExecutionDeaths(villageState, owner.id, () => 0);
  const executionDeaths = resolveFollowUpDeaths(villageState, baseExecution.deaths);
  assert.equal(executionDeaths.some((death) => death.playerId === follower.id && death.cause === 'owner-follow'), true);
});

