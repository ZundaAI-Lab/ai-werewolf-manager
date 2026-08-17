/**
 * 責務: JSON読込状態と復元履歴を領域別Validatorへ渡し、重複を除いた検査結果を返す。
 * 変更ルール: 状態を修正・補完・保存しない。検査責務はvalidators配下へ追加し、このファイルへ領域固有ルールを戻さない。
 */

import { createStateValidationContext } from './validators/coreStateValidator.js';
import { validatePlayerState } from './validators/playerStateValidator.js';
import { validateEventState } from './validators/eventStateValidator.js';
import { validateConversationNightVoteState } from './validators/conversationNightVoteValidator.js';
import { validateDerivedAndAiState } from './validators/derivedAiStateValidator.js';
import { validatePhaseAndResultState } from './validators/phaseResultStateValidator.js';
import { validateRelationshipSnapshots } from './validators/relationshipSnapshotValidator.js';
import { validateStoredEntityIds } from './validators/validatorShared.js';

function validateSnapshot(raw, label = 'ルート') {
  const context = createStateValidationContext(raw, label);
  if (context.stop) return context.errors;
  validatePlayerState(context);
  validateEventState(context);
  validateRelationshipSnapshots(context);
  validateConversationNightVoteState(context);
  validateDerivedAndAiState(context);
  validatePhaseAndResultState(context);
  return context.errors;
}

export function validateImportedState(raw) {
  const errors = validateSnapshot(raw);
  validateStoredEntityIds(raw?.restorePoints, 'restorePoints', errors);
  validateStoredEntityIds(raw?.undoStack, 'undoStack', errors);
  validateStoredEntityIds(raw?.redoStack, 'redoStack', errors);
  (raw?.restorePoints ?? []).forEach((point, index) => {
    if (!point?.id || !point?.state) errors.push(`復元ポイント[${index}]が不正です。`);
    else errors.push(...validateSnapshot(point.state, `復元ポイント「${point.label ?? point.id}」`));
  });
  (raw?.undoStack ?? []).forEach((entry, index) => {
    if (!entry?.id || !entry?.state) errors.push(`Undo履歴[${index}]が不正です。`);
    else errors.push(...validateSnapshot(entry.state, `Undo履歴「${entry.label ?? entry.id}」`));
  });
  (raw?.redoStack ?? []).forEach((entry, index) => {
    if (!entry?.id || !entry?.state) errors.push(`Redo履歴[${index}]が不正です。`);
    else errors.push(...validateSnapshot(entry.state, `Redo履歴「${entry.label ?? entry.id}」`));
  });
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}
