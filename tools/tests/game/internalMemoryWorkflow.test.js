/**
 * 責務: 自由内部メモの重複抑止・保持上限と、整理推奨を通常進行前の正式AIタスクへ接続する契約を確認する。
 * 変更ルール: メモ本文の品質を固定せず、無制限蓄積と自動進行からの整理漏れを防ぐ境界だけを検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { applyInternalMemoryUpdate } from '../../../app/renderer/js/domain/memory/memoryLedger.js';
import { skipAiMemoConsolidation } from '../../../app/renderer/js/domain/memory/memoryRuntime.js';
import { getCurrentGmTask } from '../../../app/renderer/js/domain/game/workflow.js';


test('内部メモは直近の完全一致を重複保存せず新しい20件だけを保持する', () => {
  const state = createInitialState(4);
  const player = state.players[0];

  assert.equal(applyInternalMemoryUpdate(state, player.id, { mode: 'add', text: '同じ観察' }, 'turn-1').changed, true);
  const duplicate = applyInternalMemoryUpdate(state, player.id, { mode: 'add', text: '  同じ観察  ' }, 'turn-2');
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(player.internalMemory.notes.length, 1);

  for (let index = 1; index <= 25; index += 1) {
    applyInternalMemoryUpdate(state, player.id, { mode: 'add', text: `固有メモ${index}` }, `turn-${index + 2}`);
  }
  assert.equal(player.internalMemory.notes.length, 20);
  assert.equal(player.internalMemory.notes[0].text, '固有メモ6');
  assert.equal(player.internalMemory.notes.at(-1).text, '固有メモ25');
  assert.equal(player.internalMemory.consolidationRecommended, true);
});


test('整理推奨中のAIを通常フェーズより先に一人ずつ処理しスキップ後は即時再提示しない', () => {
  const state = createInitialState(4);
  const player = state.players[0];
  state.game.phase = 'discussion';
  player.internalMemory.consolidationRecommended = true;

  assert.deepEqual(getCurrentGmTask(state), {
    type: 'memo-consolidate',
    label: '内部メモ整理',
    playerId: player.id,
  });

  const skipped = skipAiMemoConsolidation(state, {
    playerId: player.id,
    reason: '生成結果を採用できなかったため次の追記まで保留',
  });
  assert.equal(skipped.ok, true);
  assert.equal(player.internalMemory.consolidationRecommended, false);
});
