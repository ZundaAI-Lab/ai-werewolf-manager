/**
 * 責務: 自動保存用スナップショットが現在状態と訂正用復元ポイントを保持し、セッション内履歴だけを除外することを確認する。
 * 変更ルール: 完全JSON出力の契約と混同せず、自動復元専用の投影だけを検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutosaveState } from '../../../app/renderer/js/state/autosaveState.js';

test('自動保存はUndoとRedoだけを除外し訂正用復元ポイントを維持する', () => {
  const current = {
    revision: 25,
    game: { id: 'game-a', phase: 'discussion' },
    events: [{ id: 'event-a', payload: { text: '現在状態' } }],
    undoStack: Array.from({ length: 80 }, (_, index) => ({ id: `undo-${index}`, state: { events: [{ payload: { text: '履歴'.repeat(100) } }] } })),
    redoStack: [{ id: 'redo-a', state: { revision: 24 } }],
    restorePoints: [{ id: 'restore-a', state: { revision: 10, events: [{ payload: { text: '訂正地点' } }] } }],
  };

  const snapshot = createAutosaveState(current);
  assert.deepEqual(snapshot.undoStack, []);
  assert.deepEqual(snapshot.redoStack, []);
  assert.equal(snapshot.restorePoints, current.restorePoints);
  assert.equal(snapshot.events, current.events);
  assert.ok(JSON.stringify(snapshot).length < JSON.stringify(current).length / 10);
  assert.equal(current.undoStack.length, 80, '現在状態そのものは変更しない');
});
