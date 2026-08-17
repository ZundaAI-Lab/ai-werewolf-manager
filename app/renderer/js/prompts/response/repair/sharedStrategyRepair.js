/**
 * 責務: 人狼共有戦略差分を許可キーと開始夜制約へ合わせて補正する。
 * 変更ルール: 共有戦略を生成せず、keep/patch形式と入力済みキーだけを扱う。
 */

import {
  isPlainObject,
  operation,
} from './jsonObjectRecovery.js';
import {
  normalizeEnumField,
  repairExactKeys,
} from './repairUtilities.js';
import { SHARED_STRATEGY_KEYS } from './repairConstants.js';

function repairSharedStrategy(state, payload, operations) {
  if (!Object.hasOwn(payload, 'sharedStrategyUpdate')) return;
  if (!isPlainObject(payload.sharedStrategyUpdate)) {
    delete payload.sharedStrategyUpdate;
    operation(operations, 'INVALID_OPTIONAL_SECTION_REMOVED', 'sharedStrategyUpdate', 'オブジェクトでないsharedStrategyUpdateを省略しました。');
    return;
  }
  const update = repairExactKeys(payload.sharedStrategyUpdate, 'sharedStrategyUpdate', ['mode', 'changes'], operations);
  normalizeEnumField(update, 'mode', 'sharedStrategyUpdate', operations);
  if (!Object.hasOwn(update, 'changes')) update.changes = {};
  if (!isPlainObject(update.changes)) {
    delete payload.sharedStrategyUpdate;
    operation(operations, 'INVALID_OPTIONAL_SECTION_REMOVED', 'sharedStrategyUpdate', 'changesがオブジェクトでないsharedStrategyUpdateを省略しました。');
    return;
  }
  repairExactKeys(update.changes, 'sharedStrategyUpdate.changes', SHARED_STRATEGY_KEYS, operations);
  Object.keys(update.changes).forEach((key) => {
    if (typeof update.changes[key] !== 'string' || !update.changes[key].trim()) {
      delete update.changes[key];
      operation(operations, 'EMPTY_OPTIONAL_VALUE_REMOVED', `sharedStrategyUpdate.changes.${key}`, `空の共有戦略${key}を省略しました。`);
    } else {
      update.changes[key] = update.changes[key].trim();
    }
  });
  const opening = state.night?.plan?.wolfConversationPurpose === 'opening-strategy';
  if (opening && Object.hasOwn(update.changes, 'attackPlan')) {
    delete update.changes.attackPlan;
    operation(operations, 'DAY0_ATTACK_PLAN_REMOVED', 'sharedStrategyUpdate.changes.attackPlan', 'Day 0では無効なattackPlanを除外しました。');
  }
  if (!update.mode && Object.keys(update.changes).length) {
    update.mode = 'patch';
    operation(operations, 'MISSING_OPTIONAL_MODE_INFERRED', 'sharedStrategyUpdate.mode', '有効なchangesからsharedStrategyUpdate.modeをpatchへ補正しました。');
  }
  if (!update.mode && !Object.keys(update.changes).length) {
    delete payload.sharedStrategyUpdate;
    operation(operations, 'EMPTY_OPTIONAL_SECTION_REMOVED', 'sharedStrategyUpdate', '有効な共有戦略更新がないsharedStrategyUpdateを省略しました。');
    return;
  }
  if (update.mode === 'keep' && Object.keys(update.changes).length) {
    update.mode = 'patch';
    operation(operations, 'KEEP_WITH_CHANGES_NORMALIZED', 'sharedStrategyUpdate.mode', 'changesがあるためsharedStrategyUpdate.modeをpatchへ修正しました。');
  }
  if (update.mode === 'patch' && !Object.keys(update.changes).length) {
    if (opening) {
      delete payload.sharedStrategyUpdate;
      operation(operations, 'EMPTY_OPTIONAL_SECTION_REMOVED', 'sharedStrategyUpdate', 'Day 0で有効な変更がないsharedStrategyUpdateを省略しました。');
    } else {
      update.mode = 'keep';
      operation(operations, 'EMPTY_PATCH_NORMALIZED', 'sharedStrategyUpdate.mode', '変更のないpatchをkeepへ修正しました。');
    }
  }
  if (opening && update.mode === 'keep') {
    delete payload.sharedStrategyUpdate;
    operation(operations, 'INAPPLICABLE_KEEP_REMOVED', 'sharedStrategyUpdate', '初夜の共有作戦で意味を持たないkeepを省略しました。');
  }
}


export { repairSharedStrategy };
