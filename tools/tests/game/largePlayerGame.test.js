/**
 * 責務: 16人プリセットで役職通知から最終結果公開まで、人数依存の全主要フェーズが完走することを検証する。
 * 変更ルール: フェーズを直接書き換えず、公開コマンドだけで進行する。猫又・妖狐をテスト配役へ追加しない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { markBriefingShown, acknowledgeRole } from '../../../app/renderer/js/domain/briefing/briefingCommands.js';
import { startGame } from '../../../app/renderer/js/domain/game/gameCommands.js';
import { recordAiSpeech, recordSpeechPass } from '../../../app/renderer/js/domain/discussion/discussionCommands.js';
import {
  publishDawn,
  recordMasonMessage,
  recordNightAction,
  recordWolfAttackVote,
  recordWolfMessage,
  resolveNight,
} from '../../../app/renderer/js/domain/night/nightCommands.js';
import { confirmGameResult, publishGameResult, recordResultImpression } from '../../../app/renderer/js/domain/result/resultCommands.js';
import { getNightActionCandidates } from '../../../app/renderer/js/domain/game/standardRules.js';
import { buildPromptContext } from '../../../app/renderer/js/prompts/promptBuilder.js';
import {
  beginVote,
  finalizeVote,
  publishExecution,
  publishVoteResult,
  recordVote,
  resolveExecution,
} from '../../../app/renderer/js/domain/vote/voteCommands.js';
import { createInitialState, StateStore } from '../../../app/renderer/js/state/stateStore.js';
import { getCurrentDecisionProjection } from '../../../app/renderer/js/domain/game/decisionTargetPolicy.js';
import { validateImportedState } from '../../../app/renderer/js/state/stateValidator.js';

function assertOk(response, label) {
  assert.equal(response?.ok, true, `${label}: ${response?.message ?? '応答なし'}`);
}

function validateState(state, label) {
  const validation = validateImportedState(state);
  assert.equal(validation.ok, true, `${label}: ${validation.errors.join(' / ')}`);
}

function finishBriefing(state) {
  state.players.forEach((player) => {
    assertOk(markBriefingShown(state, player.id), `${player.name}の役職表示`);
    assertOk(acknowledgeRole(state, player.id), `${player.name}の役職確認`);
  });
}

function finishPrivateConversations(state) {
  const masonSession = state.masonConversations.find((session) => session.id === state.night?.masonConversationId);
  if (masonSession?.status === 'open') {
    masonSession.participantIds.forEach((speakerId) => {
      assertOk(recordMasonMessage(state, { speakerId, content: '共有事項なし' }), '共有者会話');
    });
    assert.equal(masonSession.status, 'closed');
  }

  const wolfSession = state.wolfConversations.find((session) => session.id === state.night?.wolfConversationId);
  if (wolfSession?.status === 'open') {
    wolfSession.participantIds.forEach((speakerId) => {
      assertOk(recordWolfMessage(state, { speakerId, content: '公開情報を見て判断する' }), '人狼共有会話');
    });
    assert.equal(wolfSession.status, 'closed');
  }
}

function finishNight(state, attackTargetId = null) {
  assert.equal(state.game.phase, 'night');

  if (state.night.plan.ownerSelectionRequired) {
    const ownerSlot = state.night.slots.find((slot) => slot.type === 'choose-owner' && slot.status === 'pending');
    assert.ok(ownerSlot, '家主選択スロットが存在する');
    const owner = getNightActionCandidates(state, ownerSlot.type, ownerSlot.actorId)[0];
    assert.ok(owner, '家主候補が存在する');
    assertOk(recordNightAction(state, {
      slotId: ownerSlot.id,
      actorId: ownerSlot.actorId,
      targetId: owner.id,
      actionRationale: '統合テストの固定家主',
    }), '家主選択');
    assert.equal(state.night.plan.ownerSelectionRequired, false);
  }

  finishPrivateConversations(state);

  if (state.night.plan.wolfAttackRequired) {
    assert.ok(attackTargetId, '襲撃が必要な夜には対象を指定する');
    const wolfIds = [...state.night.wolfAttack.voterWolfIds];
    wolfIds.forEach((wolfId) => {
      assertOk(recordWolfAttackVote(state, {
        actorId: wolfId,
        targetId: attackTargetId,
        actionRationale: '大人数進行テストの固定襲撃票',
        random: () => 0,
  }), '人狼襲撃投票');
    });
    assert.equal(state.night.wolfAttack.status, 'confirmed');
  }

  state.night.slots.filter((slot) => slot.status === 'pending').forEach((slot) => {
    const candidates = getNightActionCandidates(state, slot.type, slot.actorId);
    const target = slot.type === 'guard'
      ? candidates.find((candidate) => candidate.id !== attackTargetId) ?? candidates[0]
      : candidates[0];
    assert.ok(target, `${slot.type}の候補が存在する`);
    assertOk(recordNightAction(state, {
      slotId: slot.id,
      actorId: slot.actorId,
      targetId: target.id,
      actionRationale: '統合テストの固定能力対象',
    }), `${slot.type}登録`);
  });

  assertOk(resolveNight(state, () => 0), '夜解決');
  assert.equal(state.game.phase, 'dawn');
  assertOk(publishDawn(state), '夜明け公開');
  validateState(state, `Day ${state.game.day}夜明け後`);
}

function finishDiscussion(state) {
  assert.equal(state.game.phase, 'discussion');
  let safety = 0;
  while (!state.discussion.completed && safety < 64) {
    const playerId = state.discussion.queue[state.discussion.currentIndex];
    assert.ok(playerId, '現在の発言者が存在する');
    assertOk(recordSpeechPass(state, { playerId }), '公開発言');
    safety += 1;
  }
  assert.equal(state.discussion.completed, true, '全生存者の発言巡が完了する');
  assert.ok(safety <= 16, '1日1回設定では生存人数以内で議論が完了する');
}

function executeByVote(state, targetId) {
  finishDiscussion(state);
  assertOk(beginVote(state), '投票開始');
  const voterIds = [...state.voteSession.eligibleVoterIds];
  voterIds.forEach((voterId) => {
    const fallbackId = state.voteSession.candidateIds.find((candidateId) => candidateId !== voterId && candidateId !== targetId)
      ?? state.voteSession.candidateIds.find((candidateId) => candidateId !== voterId);
    const voteTargetId = voterId === targetId ? fallbackId : targetId;
    assert.ok(voteTargetId, '自己投票を避けた投票先が存在する');
    assertOk(recordVote(state, { voterId, targetId: voteTargetId }), '投票登録');
  });
  assert.equal(Object.keys(state.voteSession.votes).length, voterIds.length);
  assertOk(finalizeVote(state, () => 0), '投票集計');
  assert.equal(state.voteSession.result.targetId, targetId);
  assertOk(publishVoteResult(state), '投票結果公開');
  assert.equal(state.game.phase, 'execution');
  assertOk(resolveExecution(state, () => 0), '処刑内容解決');
  assertOk(publishExecution(state), '処刑公開');
  validateState(state, `Day ${state.game.day}処刑後`);
}


test('16人プリセットで役職通知・複数日・3人人狼共有・投票・勝敗公開まで完走する', () => {
  const state = createInitialState(16);
  state.game.rules.speechCountPerDay = 1;

  assert.equal(state.players.length, 16);
  assert.equal(state.players.filter((player) => player.roleId === 'wolf').length, 3);
  assert.equal(state.players.some((player) => ['cat', 'fox'].includes(player.roleId)), false);
  assertOk(startGame(state), 'ゲーム開始');
  finishBriefing(state);
  assert.equal(state.game.phase, 'night');
  validateState(state, '初夜開始時');

  finishNight(state);
  assert.equal(state.game.day, 1);
  assert.equal(state.game.phase, 'discussion');
  state.players.forEach((player) => {
    const built = buildPromptContext(state, player.id, { taskType: 'speech' });
    assert.equal(typeof built.text, 'string');
    assert.ok(built.text.includes(player.name), `${player.name}の16人用発言プロンプトを生成できる`);
  });

  const firstExecutedVillager = state.players.find((player) => player.alive && player.roleId === 'villager');
  assert.ok(firstExecutedVillager);
  executeByVote(state, firstExecutedVillager.id);
  assert.equal(state.game.phase, 'night');

  for (let index = 0; index < 3; index += 1) {
    const attackTarget = state.players.find((player) => player.alive && player.roleId === 'villager');
    assert.ok(attackTarget, `Day ${state.game.day}の襲撃用村人が存在する`);
    finishNight(state, attackTarget.id);
    assert.equal(state.game.phase, 'discussion');

    const wolfTarget = state.players.find((player) => player.alive && player.roleId === 'wolf');
    assert.ok(wolfTarget, `Day ${state.game.day}の処刑用人狼が存在する`);
    executeByVote(state, wolfTarget.id);
  }

  assert.equal(state.game.phase, 'result');
  assert.equal(state.result.winner, 'village');
  assert.equal(state.players.filter((player) => player.alive && player.roleId === 'wolf').length, 0);
  assertOk(confirmGameResult(state, {
    revealAllRoles: true,
    revealWolfConversation: true,
    revealMasonConversation: true,
    revealInternalMemos: false,
  }), '結果確認');
  const resultStore = new StateStore(state);
  let resultPublishResponse = null;
  resultStore.commit('ゲーム結果公開', (draft) => { resultPublishResponse = publishGameResult(draft); }, { publicBarrier: true });
  assertOk(resultPublishResponse, 'StateStore経由の結果公開');
  const beforeResultPublish = resultStore.getState().restorePoints.find((point) => point.label === 'ゲーム結果公開前');
  assert.ok(beforeResultPublish);
  assert.equal(beforeResultPublish.state.result.status, 'confirmed');
  assert.equal(beforeResultPublish.state.events.some((event) => event.type === 'game-result'), false, '結果公開イベント追加前へ戻せる');
  assertOk(publishGameResult(state), '結果公開');
  assert.equal(state.game.phase, 'result');
  assert.equal(state.game.status, 'result-impressions');
  const gameResultEvent = state.events.findLast((event) => event.type === 'game-result');
  assert.equal(gameResultEvent.payload.roles.length, 16);
  state.players.forEach((player, index) => {
    assertOk(recordResultImpression(state, { playerId: player.id, content: `${player.name}の勝敗後感想です。` }), `${player.name}の感想公開`);
    assert.equal(state.game.phase, index === state.players.length - 1 ? 'ended' : 'result');
  });
  assert.equal(state.game.status, 'ended');
  assert.equal(state.events.filter((event) => event.type === 'result-impression').length, 16);
  validateState(state, '16人ゲーム終了時');
});
