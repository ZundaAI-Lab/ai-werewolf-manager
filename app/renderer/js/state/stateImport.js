/**
 * 責務: 保存JSONを製品schema migration後に現在利用できる構造・型へ整え、イベント／AI履歴を一次情報として公開派生状態と記憶台帳を決定的な順序で再構築した後に読込検証する。
 * 変更ルール: schema互換・安全な欠落補完・履歴個別除外はstateImportCompatibilityPolicy.jsへ委譲し、本モジュールへ旧schema分岐を追加しない。game.rulesの正式な欠落補完はgameRulePolicy.jsだけを正本とする。判断状態を先に再構築し、その確定結果を使ってmemoryLedgerを再構築する順序を崩さない。
 */

import { rebuildPublicDerivedState } from '../domain/events/publicDerivation.js';
import { rebuildAllMemoryLedgers } from '../domain/memory/memoryLedger.js';
import { prepareStateForImport } from './stateImportCompatibilityPolicy.js';
import { normalizeState } from './stateStore.js';
import { validateImportedState } from './stateValidator.js';

const HISTORY_KEYS = Object.freeze(['undoStack', 'redoStack', 'restorePoints']);

function rebuildSnapshotDerivedState(state) {
  rebuildPublicDerivedState(state, { deterministicTimestamps: true });
  rebuildAllMemoryLedgers(state, { deterministicTimestamps: true });
  HISTORY_KEYS.forEach((key) => {
    (state[key] ?? []).forEach((entry) => {
      if (entry?.state) rebuildSnapshotDerivedState(entry.state);
    });
  });
  return state;
}

function removeInvalidHistoryEntries(state, warnings) {
  HISTORY_KEYS.forEach((key) => {
    state[key] = (state[key] ?? []).filter((entry, index) => {
      if (!entry?.state) return false;
      const validation = validateImportedState(entry.state);
      if (validation.ok) return true;
      warnings.push(`${key}[${index}]は現在のゲーム事実・参照検証を満たさないため除外しました: ${validation.errors[0] ?? '不明な検証エラー'}`);
      return false;
    });
  });
  return state;
}

export function prepareImportedState(raw, { onWarning = null } = {}) {
  const warnings = [];
  const current = prepareStateForImport(raw, { warnings });
  const normalized = normalizeState(current);
  rebuildSnapshotDerivedState(normalized);
  removeInvalidHistoryEntries(normalized, warnings);
  const validation = validateImportedState(normalized);
  if (!validation.ok) throw new Error(validation.errors.join('\n'));
  if (warnings.length && typeof onWarning === 'function') onWarning([...warnings]);
  return normalized;
}
