/**
 * 責務: 決選投票回数と同票処理による投票結果解決、および通常投票・決選投票で共用する人数勝敗分岐を検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { beginVote, finalizeVote, publishExecution, publishVoteResult, recordRandomVote, recordVote, reopenVoteInput, resolveExecution } from '../../../app/renderer/js/domain/vote/voteCommands.js';
import { resolveVoteResult } from '../../../app/renderer/js/domain/vote/voteResolution.js';
import { buildVotePopulationBranches } from '../../../app/renderer/js/domain/vote/votePopulationAnalysis.js';

import { createInitialState, StateStore } from '../../../app/renderer/js/state/stateStore.js';
import { getVoteCandidates } from '../../../app/renderer/js/domain/game/standardRules.js';
import { ROLE_DEFINITIONS } from '../../../app/renderer/js/config/constants.js';

function prepareCompletedDiscussion(state) {
  state.game.day = 1;
  state.game.phase = 'discussion';
  state.discussion = {
    day: 1,
    mode: 'ordered',
    modeControl: null,
    round: 1,
    roundKind: 'normal',
    roundStartedAtSequence: 0,
    roundEligiblePlayerIds: state.players.map((player) => player.id),
    queue: state.players.map((player) => player.id),
    currentIndex: state.players.length,
    remainingByPlayer: Object.fromEntries(state.players.map((player) => [player.id, 0])),
    spokenInCurrentRound: state.players.map((player) => player.id),
    deferredPlayerIds: [],
    deferredCountByPlayer: Object.fromEntries(state.players.map((player) => [player.id, 0])),
    allDeferred: false,
    designatedPlayerId: null,
    completed: true,
    reconsideration: {
      pending: false, active: false, items: [], reasons: [], sourceEventIds: [], affectedPlayerIds: [],
      updatedAt: null, handledRound: null,
    },
  };
}

function castTwoWayTie(state) {
  const [left, right, third, fourth] = state.players;
  const votes = new Map([
    [left.id, right.id],
    [right.id, left.id],
    [third.id, left.id],
    [fourth.id, right.id],
  ]);
  state.voteSession.eligibleVoterIds.forEach((voterId) => {
    assert.equal(recordVote(state, { voterId, targetId: votes.get(voterId) }).ok, true);
  });
}

test('新規ゲームの投票初期値は決選1回・ランダム吊り・自己投票禁止', () => {
  const state = createInitialState(4);
  assert.equal(state.game.rules.vote.runoffLimit, 1);
  assert.equal(state.game.rules.vote.tieResolution, 'random-execution');
  assert.equal(state.game.rules.vote.selfVoteAllowed, false);
  const voter = state.players[0];
  assert.equal(getVoteCandidates(state, voter.id).some((candidate) => candidate.id === voter.id), false);
  prepareCompletedDiscussion(state);
  assert.equal(beginVote(state).ok, true);
  assert.equal(recordVote(state, { voterId: voter.id, targetId: voter.id }).ok, false);

  const store = new StateStore(state);
  const executionTargetId = state.players[1].id;
  let response = null;
  store.getState().voteSession.eligibleVoterIds.forEach((voterId) => {
    const fallbackId = store.getState().voteSession.candidateIds.find((candidateId) => candidateId !== voterId && candidateId !== executionTargetId);
    const targetId = voterId === executionTargetId ? fallbackId : executionTargetId;
    store.commit('投票登録', (draft) => { response = recordVote(draft, { voterId, targetId }); });
    assert.equal(response.ok, true, response.message);
  });
  store.commit('投票確定', (draft) => { response = finalizeVote(draft, () => 0); });
  assert.equal(response.ok, true, response.message);
  let current = store.getState();
  const beforeVoteFinalize = current.restorePoints.find((point) => point.label === '投票確定前');
  assert.ok(beforeVoteFinalize);
  assert.equal(beforeVoteFinalize.state.voteSession.result, null);
  assert.equal(Object.keys(beforeVoteFinalize.state.voteSession.votes).length, beforeVoteFinalize.state.voteSession.eligibleVoterIds.length);

  store.commit('投票結果公開', (draft) => { response = publishVoteResult(draft); }, { publicBarrier: true });
  assert.equal(response.ok, true, response.message);
  store.commit('処刑内容解決', (draft) => { response = resolveExecution(draft, () => 0); });
  assert.equal(response.ok, true, response.message);
  store.commit('処刑公開', (draft) => { response = publishExecution(draft); }, { publicBarrier: true });
  assert.equal(response.ok, true, response.message);
  current = store.getState();
  const beforeExecutionPublish = current.restorePoints.find((point) => point.label === '処刑公開前');
  assert.ok(beforeExecutionPublish);
  assert.equal(beforeExecutionPublish.state.game.phase, 'execution');
  assert.equal(beforeExecutionPublish.state.players.find((player) => player.id === executionTargetId).alive, true, '処刑による生死反映前へ戻せる');
  assert.equal(current.players.find((player) => player.id === executionTargetId).alive, false);
  assert.equal(current.relationshipSnapshots.length, 1);
  assert.equal(current.relationshipSnapshots[0].day, 1);
  assert.equal(current.relationshipSnapshots[0].sourceEventId, response.eventId);
});


test('AI失敗時のランダム投票は注入した乱数で決定的に対象を選べる', () => {
  const state = createInitialState(4);
  prepareCompletedDiscussion(state);
  assert.equal(beginVote(state).ok, true);
  const voterId = state.voteSession.eligibleVoterIds[0];
  const candidates = getVoteCandidates(state, voterId, state.voteSession.candidateIds).map((player) => player.id);
  assert.ok(candidates.length >= 2);

  const response = recordRandomVote(state, voterId, '決定的ランダム投票テスト', { random: () => 0.999999 });
  assert.equal(response.ok, true, response.message);
  assert.equal(state.voteSession.votes[voterId], candidates.at(-1));
  const event = state.events.find((item) => item.id === response.eventId);
  assert.equal(event.payload.override.selectedBy, 'random');
});


test('逐次公開投票は全票公開後の再入力を拒否し集計可能状態を維持する', () => {
  const state = createInitialState(4);
  state.game.rules.vote.visibilityDuringInput = 'public';
  prepareCompletedDiscussion(state);
  assert.equal(beginVote(state).ok, true);

  state.voteSession.eligibleVoterIds.forEach((voterId) => {
    const targetId = state.voteSession.candidateIds.find((candidateId) => candidateId !== voterId);
    assert.equal(recordVote(state, { voterId, targetId }).ok, true);
  });
  assert.equal(state.voteSession.status, 'ready');

  const reopenReady = reopenVoteInput(state);
  assert.equal(reopenReady.ok, false);
  assert.match(reopenReady.message, /逐次公開済み/u);
  assert.equal(state.voteSession.status, 'ready');
  assert.equal(finalizeVote(state, () => 0).ok, true);

  const resultBeforeReopen = structuredClone(state.voteSession.result);
  const reopenFinalized = reopenVoteInput(state);
  assert.equal(reopenFinalized.ok, false);
  assert.equal(state.voteSession.status, 'finalized');
  assert.deepEqual(state.voteSession.result, resultBeforeReopen);
});

test('秘密投票は全票入力後に再入力へ戻して1票を修正するとreadyへ復帰する', () => {
  const state = createInitialState(4);
  state.game.rules.vote.visibilityDuringInput = 'secret';
  prepareCompletedDiscussion(state);
  assert.equal(beginVote(state).ok, true);

  state.voteSession.eligibleVoterIds.forEach((voterId) => {
    const targetId = state.voteSession.candidateIds.find((candidateId) => candidateId !== voterId);
    assert.equal(recordVote(state, { voterId, targetId }).ok, true);
  });
  assert.equal(state.voteSession.status, 'ready');

  const firstVoterId = state.voteSession.eligibleVoterIds[0];
  const previousTargetId = state.voteSession.votes[firstVoterId];
  const replacementTargetId = state.voteSession.candidateIds.find(
    (candidateId) => candidateId !== firstVoterId && candidateId !== previousTargetId,
  );
  assert.ok(replacementTargetId);

  const reopened = reopenVoteInput(state);
  assert.equal(reopened.ok, true, reopened.message);
  assert.equal(state.voteSession.status, 'input');
  assert.equal(state.voteSession.currentVoterIndex, 0);

  const changed = recordVote(state, { voterId: firstVoterId, targetId: replacementTargetId });
  assert.equal(changed.ok, true, changed.message);
  assert.equal(state.voteSession.votes[firstVoterId], replacementTargetId);
  assert.equal(state.voteSession.status, 'ready');
  assert.equal(state.voteSession.currentVoterIndex, state.voteSession.eligibleVoterIds.length);
});

test('処刑役職公開を有効にしても役職名を付けて処刑公開を完了する', () => {
  const state = createInitialState(4);
  state.game.rules.vote.revealExecutedRole = true;
  prepareCompletedDiscussion(state);
  assert.equal(beginVote(state).ok, true);
  const executionTarget = state.players[1];
  state.voteSession.eligibleVoterIds.forEach((voterId) => {
    const fallbackId = state.voteSession.candidateIds.find((candidateId) => candidateId !== voterId && candidateId !== executionTarget.id);
    const targetId = voterId === executionTarget.id ? fallbackId : executionTarget.id;
    assert.equal(recordVote(state, { voterId, targetId }).ok, true);
  });
  assert.equal(finalizeVote(state, () => 0).ok, true);
  assert.equal(publishVoteResult(state).ok, true);
  assert.equal(resolveExecution(state, () => 0).ok, true);
  const published = publishExecution(state);
  assert.equal(published.ok, true, published.message);
  const event = state.events.find((item) => item.id === published.eventId);
  assert.equal(event.payload.revealedRoleId, executionTarget.roleId);
  assert.match(event.payload.text, new RegExp(`役職は${ROLE_DEFINITIONS[executionTarget.roleId].name}でした。`, 'u'));
});


test('初回同票は設定された1回の決選投票へ進む', () => {
  const result = resolveVoteResult({
    tally: [{ targetId: 'a', count: 2 }, { targetId: 'b', count: 2 }],
    round: 1,
    runoffLimit: 1,
    tieResolution: 'random-execution',
  });
  assert.deepEqual(result, {
    type: 'runoff', targetId: null, tiedCandidateIds: ['a', 'b'], resolution: 'runoff',
  });
});


test('吊りなし設定では決選投票上限後の同票を処刑なしにする', () => {
  const state = createInitialState(4);
  state.game.rules.vote.tieResolution = 'no-execution';
  prepareCompletedDiscussion(state);
  assert.equal(beginVote(state).ok, true);
  castTwoWayTie(state);
  assert.equal(finalizeVote(state).ok, true);
  assert.equal(publishVoteResult(state).ok, true);
  castTwoWayTie(state);
  assert.equal(finalizeVote(state).ok, true);
  assert.deepEqual(state.voteSession.result, {
    type: 'no-execution',
    targetId: null,
    tiedCandidateIds: [state.players[1].id, state.players[0].id],
    resolution: 'tie-no-execution',
  });
  assert.equal(publishVoteResult(state).ok, true);
  assert.equal(state.game.phase, 'night');
  assert.equal(state.relationshipSnapshots.length, 1);
  assert.equal(state.relationshipSnapshots[0].day, 1);
  assert.equal(state.relationshipSnapshots[0].sourceEventId, state.events.filter((event) => event.type === 'vote-finalized').at(-1).id);
});


test('最多票候補は集計配列の並び順に依存しない', () => {
  const result = resolveVoteResult({
    tally: [
      { targetId: 'low', count: 1 },
      { targetId: 'top-a', count: 3 },
      { targetId: 'top-b', count: 3 },
    ],
    round: 2,
    runoffLimit: 1,
    tieResolution: 'no-execution',
  });
  assert.deepEqual(result.tiedCandidateIds, ['top-a', 'top-b']);
  assert.equal(result.resolution, 'tie-no-execution');
});

test('投票人数分岐は未知の生存人狼数を仮定分岐にし、誤処刑後の襲撃勝利まで計算する', () => {
  const branches = buildVotePopulationBranches({
    aliveCount: 6,
    configuredWolfCount: 2,
    exactKnownAliveWolfCount: null,
  });
  assert.deepEqual([...new Set(branches.map((branch) => branch.assumedAliveWolfCount))], [1, 2]);

  const twoWolvesNonWolfExecution = branches.find((branch) => (
    branch.assumedAliveWolfCount === 2 && branch.candidateAlignment === 'non-wolf'
  ));
  assert.equal(twoWolvesNonWolfExecution.executionOutcome, 'continue');
  assert.equal(twoWolvesNonWolfExecution.afterExecutionAliveCount, 5);
  assert.equal(twoWolvesNonWolfExecution.afterExecutionWolfCount, 2);
  assert.equal(twoWolvesNonWolfExecution.afterSuccessfulAttackAliveCount, 4);
  assert.equal(twoWolvesNonWolfExecution.successfulAttackOutcome, 'wolf-win');

  const oneWolfWolfExecution = branches.find((branch) => (
    branch.assumedAliveWolfCount === 1 && branch.candidateAlignment === 'wolf'
  ));
  assert.equal(oneWolfWolfExecution.executionOutcome, 'village-win');
  assert.equal(oneWolfWolfExecution.nightOccurs, false);
  assert.equal(oneWolfWolfExecution.afterSuccessfulAttackAliveCount, 5);
});

test('本人が生存人狼数と仲間を把握している場合は候補ごとの確定正体だけを投票分岐へ出す', () => {
  const branches = buildVotePopulationBranches({
    aliveCount: 6,
    configuredWolfCount: 2,
    exactKnownAliveWolfCount: 2,
    candidateIds: ['partner', 'villager-a', 'villager-b'],
    knownWolfIds: ['self', 'partner'],
  });
  assert.equal(branches.length, 3);
  assert.deepEqual([...new Set(branches.map((branch) => branch.assumedAliveWolfCount))], [2]);
  assert.equal(branches.find((branch) => branch.targetId === 'partner')?.candidateAlignment, 'wolf');
  assert.equal(branches.find((branch) => branch.targetId === 'villager-a')?.candidateAlignment, 'non-wolf');
  assert.equal(branches.filter((branch) => branch.targetId === 'villager-a').length, 1);
});

