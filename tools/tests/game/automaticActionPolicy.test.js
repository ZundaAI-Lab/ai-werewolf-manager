/**
 * 責務: 全自動進行の次操作がDOMなしでゲーム状態だけから決定される契約を検証する。
 * 変更ルール: 表示ラベルやdata-actionを固定せず、正式な状態とコマンド種別だけを検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { startGame } from '../../../app/renderer/js/domain/game/gameCommands.js';
import { resolveAutomaticAction } from '../../../app/renderer/js/domain/game/automaticActionPolicy.js';

test('準備状態とAI役職通知はDOMなしで正式コマンドへ解決する', () => {
  const state = createInitialState(6);
  assert.deepEqual(resolveAutomaticAction(state), {
    kind: 'command', command: 'start-game', label: 'ゲーム開始',
  });
  assert.equal(startGame(state).ok, true);
  const action = resolveAutomaticAction(state);
  assert.equal(action.kind, 'command');
  assert.equal(action.command, 'complete-ai-briefing');
  assert.equal(state.players.some((player) => player.id === action.playerId), true);
});

test('人間の役職通知は直接操作せず本人確認待ちとして停止する', () => {
  const state = createInitialState(6);
  state.players[0].controller = 'human';
  assert.equal(startGame(state).ok, true);
  const action = resolveAutomaticAction(state);
  assert.equal(action.kind, 'human-private');
  assert.equal(action.taskType, 'briefing');
  assert.equal(action.playerId, state.players[0].id);
});

test('全自動進行の機密会話は直前話者の次の参加者を通常次話者にする', () => {
  for (const config of [
    { taskType: 'graveyard-conversation', planKey: 'graveyardConversationRequired', stateKey: 'graveyardConversations', idKey: 'graveyardConversationId' },
    { taskType: 'mason-conversation', planKey: 'masonConversationRequired', stateKey: 'masonConversations', idKey: 'masonConversationId' },
    { taskType: 'wolf-conversation', planKey: 'wolfConversationRequired', stateKey: 'wolfConversations', idKey: 'wolfConversationId' },
  ]) {
    const state = createInitialState(6);
    state.game.status = 'running';
    state.game.phase = 'night';
    const [first, second, third] = state.players;
    [first, second, third].forEach((player) => { player.controller = 'ai'; });
    const sessionId = `${config.taskType}-session`;
    const session = {
      id: sessionId,
      status: 'open',
      participantIds: [first.id, second.id, third.id],
      messages: [{ speakerId: first.id }],
      speechCountPerParticipant: 2,
      remainingByParticipant: { [first.id]: 1, [second.id]: 2, [third.id]: 2 },
    };
    state[config.stateKey] = [session];
    state.night = {
      status: 'conversation',
      plan: {
        graveyardConversationRequired: false,
        masonConversationRequired: false,
        wolfConversationRequired: false,
        wolfAttackRequired: false,
      },
      [config.idKey]: sessionId,
    };
    state.night.plan[config.planKey] = true;

    const action = resolveAutomaticAction(state);
    assert.equal(action.kind, 'ai-task', config.taskType);
    assert.equal(action.taskRequest.taskType, config.taskType);
    assert.equal(action.taskRequest.playerId, second.id, `${config.taskType}は直前話者の次へ進む`);
  }
});
