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
