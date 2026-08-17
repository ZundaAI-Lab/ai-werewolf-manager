/**
 * 責務: 共有者・妖狐・猫又の配役、機密会話、死亡解決、勝敗、公開情報を横断して検証する。
 * 変更ルール: 各役職の固有能力と複合死亡を実際の公開コマンドまで確認し、旧役職だけの前提を再導入しない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESET_ROLES } from '../../../app/renderer/js/config/constants.js';
import { startGame, recordMasonMessage, resolveNight, publishDawn, resolveExecution, publishExecution } from '../../../app/renderer/js/domain/game/gameRuntime.js';
import { resolveExecutionDeaths, resolveNightDeaths } from '../../../app/renderer/js/domain/game/deathResolution.js';
import { buildNightPlan } from '../../../app/renderer/js/domain/night/nightPlanner.js';
import { detectWinner } from '../../../app/renderer/js/domain/game/standardRules.js';
import { buildPlayerVisibleContext } from '../../../app/renderer/js/prompts/context/promptContext.js';
import { buildPromptContext } from '../../../app/renderer/js/prompts/promptBuilder.js';
import { buildPublicSnapshot } from '../../../app/renderer/js/public/publicSnapshot.js';
import { createInitialState, StateStore } from '../../../app/renderer/js/state/stateStore.js';
import { createRoleState } from '../../../app/renderer/js/domain/roles/roleState.js';
import { createEmptyFactionStrategyState } from '../../../app/renderer/js/domain/game/factionStrategyState.js';

function setRoles(state, roleIds) {
  state.players.forEach((player, index) => {
    player.roleId = roleIds[index];
    player.roleState = createRoleState(roleIds[index]);
    player.factionStrategyState = createEmptyFactionStrategyState(roleIds[index]);
    player.alive = true;
    player.death = null;
  });
}


test('ゲーム開始時に共有者だけが共有者全員を知る', () => {
  const state = createInitialState(10);
  const started = startGame(state);
  assert.equal(started.ok, true, started.message);
  const masonIds = state.players.filter((player) => player.roleId === 'mason').map((player) => player.id);
  assert.equal(masonIds.length, 2);
  masonIds.forEach((id) => assert.deepEqual(state.playerKnowledge[id].knownMasonIds, masonIds));
  state.players.filter((player) => player.roleId !== 'mason').forEach((player) => {
    assert.deepEqual(state.playerKnowledge[player.id].knownMasonIds, []);
  });
});


test('妖狐は襲撃では死亡せず占われると占殺される', () => {
  const state = createInitialState(6);
  setRoles(state, ['fox', 'seer', 'wolf', 'villager', 'guard', 'villager']);
  const fox = state.players[0];
  const seer = state.players[1];

  let resolved = resolveNightDeaths(state, { attackedTargetId: fox.id });
  assert.equal(resolved.attackOutcome, 'fox-immune');
  assert.deepEqual(resolved.deaths, []);

  resolved = resolveNightDeaths(state, {
    attackedTargetId: state.players[3].id,
    inspections: [{ actorId: seer.id, targetId: fox.id }],
  });
  assert.equal(resolved.inspectedFoxIds.includes(fox.id), true);
  const foxDeath = resolved.deaths.find((death) => death.playerId === fox.id && death.cause === 'fox-divination');
  assert.deepEqual(foxDeath?.sourcePlayerIds, [seer.id]);
  assert.equal(resolved.deaths.some((death) => death.playerId === state.players[3].id && death.cause === 'wolf-attack'), true);
  assert.equal(seer.roleId, 'seer');
});

test('猫又は襲撃死時に生存人狼を道連れにし護衛時は発動しない', () => {
  const state = createInitialState(6);
  setRoles(state, ['cat', 'wolf', 'wolf', 'seer', 'guard', 'villager']);
  const cat = state.players[0];
  const firstWolf = state.players[1];

  let resolved = resolveNightDeaths(state, { attackedTargetId: cat.id, random: () => 0 });
  assert.equal(resolved.attackOutcome, 'killed');
  assert.equal(resolved.catCollateralWolfId, firstWolf.id);
  assert.deepEqual(resolved.deaths.map((death) => [death.playerId, death.cause]), [
    [cat.id, 'wolf-attack'],
    [firstWolf.id, 'cat-revenge'],
  ]);

  resolved = resolveNightDeaths(state, { attackedTargetId: cat.id, guardedTargetIds: [cat.id], random: () => 0 });
  assert.equal(resolved.attackOutcome, 'guarded');
  assert.equal(resolved.catCollateralWolfId, null);
  assert.deepEqual(resolved.deaths, []);
});


test('妖狐生存中は通常勝利条件を妖狐勝利へ置き換える', () => {
  const state = createInitialState(4);
  setRoles(state, ['wolf', 'fox', 'villager', 'seer']);
  state.players[2].alive = false;
  state.players[3].alive = false;
  assert.equal(detectWinner(state)?.winner, 'fox');

  state.players[0].alive = false;
  assert.equal(detectWinner(state)?.winner, 'fox');

  state.players[1].alive = false;
  assert.equal(detectWinner(state)?.winner, 'village');
});

test('占殺・猫又襲撃・人狼道連れを一つの夜として解決してから公開する', () => {
  const state = createInitialState(6);
  setRoles(state, ['seer', 'fox', 'cat', 'wolf', 'wolf', 'villager']);
  state.game.status = 'running';
  state.game.phase = 'night';
  state.game.day = 1;
  const [seer, fox, cat, firstWolf, secondWolf] = state.players;
  state.night = {
    day: 1,
    status: 'input',
    aliveAtStartIds: state.players.map((player) => player.id),
    plan: {
      masonConversationRequired: false, masonConversationParticipantIds: [],
      wolfConversationRequired: false, wolfConversationPurpose: 'attack-planning', wolfAttackRequired: true,
      inspectActorIds: [seer.id], guardActorIds: [], mediumResultRecipientIds: [],
    },
    currentSlotIndex: 0,
    graveyardConversationId: null,
    masonConversationId: null,
    wolfConversationId: null,
    wolfAttack: {
      conversationId: null,
      voterWolfIds: [firstWolf.id, secondWolf.id],
      voteByWolfId: { [firstWolf.id]: cat.id, [secondWolf.id]: cat.id },
      rationaleByWolfId: { [firstWolf.id]: '猫又とは知らず脅威を排除', [secondWolf.id]: '同じ対象へ投票' },
      overrideByWolfId: { [firstWolf.id]: null, [secondWolf.id]: null },
      tally: {
        countsByTargetId: { [cat.id]: 2 },
        topTargetIds: [cat.id],
        resolutionMethod: 'plurality',
      },
      finalTargetId: cat.id,
      status: 'confirmed',
    },
    slots: [{
      id: 'inspect-slot', type: 'inspect', actorId: seer.id, targetId: fox.id,
      status: 'submitted', override: null, rationale: '発言を確認するため', aiTurnId: null,
    }],
    resolution: null,
  };

  const store = new StateStore(state);
  let resolved = null;
  store.commit('夜解決', (draft) => { resolved = resolveNight(draft, () => 0); });
  assert.equal(resolved.ok, true, resolved.message);
  let current = store.getState();
  assert.deepEqual(new Set(current.night.resolution.deaths.map((death) => death.playerId)), new Set([fox.id, cat.id, firstWolf.id]));
  assert.equal(current.game.phase, 'dawn');
  assert.equal(current.players.every((player) => player.alive), true);
  const beforeNightResolve = current.restorePoints.find((point) => point.label === '夜解決前');
  assert.ok(beforeNightResolve);
  assert.equal(beforeNightResolve.state.game.phase, 'night');
  assert.equal(beforeNightResolve.state.night.resolution, null);

  let published = null;
  store.commit('夜明け公開', (draft) => { published = publishDawn(draft); }, { publicBarrier: true });
  assert.equal(published.ok, true, published.message);
  current = store.getState();
  assert.equal(current.players.find((player) => player.id === fox.id).alive, false);
  assert.equal(current.players.find((player) => player.id === cat.id).alive, false);
  assert.equal(current.players.find((player) => player.id === firstWolf.id).alive, false);
  assert.equal(current.players.find((player) => player.id === secondWolf.id).alive, true);
  const beforeDawnPublish = current.restorePoints.find((point) => point.label === '夜明け公開前');
  assert.ok(beforeDawnPublish);
  assert.equal(beforeDawnPublish.state.game.phase, 'dawn');
  assert.equal(beforeDawnPublish.state.players.every((player) => player.alive), true, '死亡反映前へ戻せる');
  const dawn = current.events.find((event) => event.type === 'dawn');
  assert.deepEqual(new Set(dawn.payload.deadPlayerIds), new Set([fox.id, cat.id, firstWolf.id]));
});


