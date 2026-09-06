/**
 * 責務: 独立AI行動の並列候補が秘密投票・人狼襲撃投票・独立夜行動だけから導出され、公開投票や人間操作境界を越えないことを確認する。
 * 変更ルール: API並列数やAutomation実装を検証せず、ゲーム状態だけを入力するdomain policyの契約に限定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutomaticAiBatch } from '../../../app/renderer/js/domain/game/automaticAiBatchPolicy.js';

function player(id, controller = 'ai') {
  return { id, name: id, controller, internalMemory: {} };
}

function voteState({ visibility = 'secret', controllers = ['ai', 'ai', 'ai'] } = {}) {
  const players = controllers.map((controller, index) => player(`p${index + 1}`, controller));
  return {
    game: { phase: 'vote', correctionMode: { enabled: false }, rules: { vote: { visibilityDuringInput: visibility } } },
    players,
    voteSession: {
      status: 'input', inputMode: 'sequential', currentVoterIndex: 0,
      eligibleVoterIds: players.map((item) => item.id), votes: {},
    },
  };
}

function nightBase(players) {
  return {
    game: { phase: 'night', correctionMode: { enabled: false } },
    players,
    events: [],
    graveyardConversations: [],
    masonConversations: [],
    wolfConversations: [],
  };
}

test('秘密投票は連続するAI投票者を同一バッチへまとめる', () => {
  const batch = resolveAutomaticAiBatch(voteState());
  assert.equal(batch.kind, 'ai-task-batch');
  assert.deepEqual(batch.taskRequests.map((item) => item.playerId), ['p1', 'p2', 'p3']);
  assert.ok(batch.taskRequests.every((item) => item.taskType === 'vote'));
});

test('公開逐次投票は並列候補を返さない', () => {
  const batch = resolveAutomaticAiBatch(voteState({ visibility: 'public' }));
  assert.equal(batch.kind, 'none');
});

test('秘密投票は次の人間投票者を越えて後続AIを先行生成しない', () => {
  const batch = resolveAutomaticAiBatch(voteState({ controllers: ['ai', 'ai', 'human', 'ai'] }));
  assert.equal(batch.kind, 'ai-task-batch');
  assert.deepEqual(batch.taskRequests.map((item) => item.playerId), ['p1', 'p2']);
});

test('人狼襲撃投票は未投票AI狼をまとめる', () => {
  const state = nightBase([player('w1'), player('w2'), player('v1')]);
  state.night = {
    plan: {
      graveyardConversationRequired: false,
      masonConversationRequired: false,
      wolfConversationRequired: false,
      wolfAttackRequired: true,
    },
    wolfAttack: {
      status: 'voting', voterWolfIds: ['w1', 'w2'], voteByWolfId: { w1: null, w2: null },
    },
    slots: [],
  };
  const batch = resolveAutomaticAiBatch(state);
  assert.equal(batch.kind, 'ai-task-batch');
  assert.deepEqual(batch.taskRequests.map((item) => [item.playerId, item.taskType]), [['w1', 'wolf-attack'], ['w2', 'wolf-attack']]);
});

test('占い・護衛・訪問・凍結のpending夜行動を計画順にまとめる', () => {
  const state = nightBase([player('s'), player('g'), player('n'), player('f')]);
  state.night = {
    plan: {
      graveyardConversationRequired: false,
      masonConversationRequired: false,
      wolfConversationRequired: false,
      wolfAttackRequired: false,
    },
    wolfAttack: { status: 'not-required', voterWolfIds: [], voteByWolfId: {} },
    slots: [
      { id: 'slot-s', type: 'inspect', actorId: 's', status: 'pending' },
      { id: 'slot-g', type: 'guard', actorId: 'g', status: 'pending' },
      { id: 'slot-n', type: 'visit', actorId: 'n', status: 'pending' },
      { id: 'slot-f', type: 'freeze', actorId: 'f', status: 'pending' },
    ],
  };
  const batch = resolveAutomaticAiBatch(state);
  assert.equal(batch.kind, 'ai-task-batch');
  assert.deepEqual(batch.taskRequests.map((item) => item.taskType), ['inspect', 'guard', 'visit', 'freeze']);
  assert.deepEqual(batch.taskRequests.map((item) => item.slotId), ['slot-s', 'slot-g', 'slot-n', 'slot-f']);
});

test('家主選択は並列対象にしない', () => {
  const state = nightBase([player('z')]);
  state.night = {
    plan: {
      graveyardConversationRequired: false,
      masonConversationRequired: false,
      wolfConversationRequired: false,
      wolfAttackRequired: false,
    },
    wolfAttack: { status: 'not-required', voterWolfIds: [], voteByWolfId: {} },
    slots: [{ id: 'owner', type: 'choose-owner', actorId: 'z', status: 'pending' }],
  };
  assert.equal(resolveAutomaticAiBatch(state).kind, 'none');
});

test('内部メモ整理推奨AIは全員を並列対象にし、通信中プレイヤーは候補から除外する', () => {
  const players = [player('p1'), player('p2'), player('p3')];
  for (const item of players) item.internalMemory.consolidationRecommended = true;
  const state = {
    game: { phase: 'discussion', day: 1, correctionMode: { enabled: false } },
    players,
    events: [],
    discussion: { mode: 'ordered', completed: false, remainingByPlayer: { p1: 1, p2: 1, p3: 1 } },
  };
  const batch = resolveAutomaticAiBatch(state, { ignoredMemoConsolidationPlayerIds: ['p1'] });
  assert.equal(batch.kind, 'ai-task-batch');
  assert.equal(batch.source, 'memo-consolidation');
  assert.deepEqual(batch.taskRequests.map((item) => item.playerId), ['p2', 'p3']);
});

test('役職通知は連続AI分をcommand batchへまとめ、人間境界を越えない', () => {
  const state = {
    game: { phase: 'briefing', correctionMode: { enabled: false } },
    players: [player('p1'), player('p2'), player('p3', 'human'), player('p4')],
    briefing: {
      eligiblePlayerIds: ['p1', 'p2', 'p3', 'p4'],
      noticeStatusByPlayerId: { p1: 'pending', p2: 'pending', p3: 'pending', p4: 'pending' },
    },
  };
  const batch = resolveAutomaticAiBatch(state);
  assert.equal(batch.kind, 'command-batch');
  assert.equal(batch.source, 'briefing');
  assert.deepEqual(batch.commandRequests.map((item) => item.playerId), ['p1', 'p2']);
});

test('発言希望制の開始時希望は連続AIを並列生成し、人間境界を越えない', () => {
  const players = [player('p1'), player('p2'), player('p3', 'human'), player('p4')];
  for (const item of players) item.alive = true;
  const state = {
    game: { phase: 'discussion', day: 1, correctionMode: { enabled: false } },
    players,
    events: [],
    discussion: {
      mode: 'free',
      modeControl: { type: 'free', stage: 'opening-preference', openingPreferenceByPlayerId: {} },
    },
  };
  const batch = resolveAutomaticAiBatch(state);
  assert.equal(batch.kind, 'ai-task-batch');
  assert.equal(batch.source, 'discussion-opening-preference');
  assert.deepEqual(batch.taskRequests.map((item) => item.playerId), ['p1', 'p2']);
});

test('勝敗後感想は連続AIを並列生成し、人間境界を越えない', () => {
  const state = {
    game: { phase: 'result', correctionMode: { enabled: false } },
    result: { status: 'published' },
    players: [player('p1'), player('p2'), player('p3', 'human'), player('p4')],
    events: [],
  };
  const batch = resolveAutomaticAiBatch(state);
  assert.equal(batch.kind, 'ai-task-batch');
  assert.equal(batch.source, 'result-impression');
  assert.deepEqual(batch.taskRequests.map((item) => item.playerId), ['p1', 'p2']);
});
