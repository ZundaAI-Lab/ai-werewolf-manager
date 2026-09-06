/**
 * 責務: Renderer側自動保存直列化が訂正用restorePointsを保持し、Undo/Redoだけを除外したJSON文字列を生成することを検証する。
 * 変更ルール: Main永続化やmigrationは扱わず、IPC送信直前の保存表現だけを固定する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { esmSourceAsVmScript } = require('./esmTestSource.js');

const source = readFileSync(join(__dirname, '..', '..', '..', 'app', 'renderer', 'js', 'state', 'autosaveState.js'), 'utf8');

function loadSerializer() {
  const context = vm.createContext({ JSON, Object, Array, TypeError });
  vm.runInContext(esmSourceAsVmScript(source), context, { filename: 'autosaveState.js' });
  return vm.runInContext('serializeAutosaveState', context);
}

test('自動保存はRendererで直列化しrestorePointsを保持してUndo/Redoを除外する', () => {
  const serializeAutosaveState = loadSerializer();
  const serialized = serializeAutosaveState({
    schemaVersion: 7,
    revision: 42,
    restorePoints: [{ id: 'restore-1', revision: 40 }],
    undoStack: [{ revision: 41 }],
    redoStack: [{ revision: 43 }],
  });
  assert.equal(typeof serialized, 'string');
  const saved = JSON.parse(serialized);
  assert.equal(saved.revision, 42);
  assert.deepEqual(saved.restorePoints, [{ id: 'restore-1', revision: 40 }]);
  assert.deepEqual(saved.undoStack, []);
  assert.deepEqual(saved.redoStack, []);
});
