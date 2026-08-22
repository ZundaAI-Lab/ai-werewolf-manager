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
  if (!Object.hasOwn(payload, 'sharedStrategy')) return;
  if (!isPlainObject(payload.sharedStrategy)) {
    delete payload.sharedStrategy;
    operation(operations, 'INVALID_OPTIONAL_SECTION_REMOVED', 'sharedStrategy', 'オブジェクトでないsharedStrategyを省略しました。');
    return;
  }
  const update = repairExactKeys(payload.sharedStrategy, 'sharedStrategy', ['mode', 'changes'], operations);
  normalizeEnumField(update, 'mode', 'sharedStrategy', operations);
  if (!Object.hasOwn(update, 'changes')) update.changes = {};
  if (!isPlainObject(update.changes)) {
    delete payload.sharedStrategy;
    operation(operations, 'INVALID_OPTIONAL_SECTION_REMOVED', 'sharedStrategy', 'changesがオブジェクトでないsharedStrategyを省略しました。');
    return;
  }
  repairExactKeys(update.changes, 'sharedStrategy.changes', SHARED_STRATEGY_KEYS, operations);
  Object.keys(update.changes).forEach((key) => {
    if (typeof update.changes[key] !== 'string' || !update.changes[key].trim()) {
      delete update.changes[key];
      operation(operations, 'EMPTY_OPTIONAL_VALUE_REMOVED', `sharedStrategy.changes.${key}`, `空の共有戦略${key}を省略しました。`);
    } else {
      update.changes[key] = update.changes[key].trim();
    }
  });
  const opening = state.night?.plan?.wolfConversationPurpose === 'opening-strategy';
  if (opening && Object.hasOwn(update.changes, 'attackPlan')) {
    delete update.changes.attackPlan;
    operation(operations, 'DAY0_ATTACK_PLAN_REMOVED', 'sharedStrategy.changes.attackPlan', 'Day 0では無効なattackPlanを除外しました。');
  }
  if (!update.mode && Object.keys(update.changes).length) {
    update.mode = 'patch';
    operation(operations, 'MISSING_OPTIONAL_MODE_INFERRED', 'sharedStrategy.mode', '有効なchangesからsharedStrategy.modeをpatchへ補正しました。');
  }
  if (!update.mode && !Object.keys(update.changes).length) {
    delete payload.sharedStrategy;
    operation(operations, 'EMPTY_OPTIONAL_SECTION_REMOVED', 'sharedStrategy', '有効な共有戦略更新がないsharedStrategyを省略しました。');
    return;
  }
  if (update.mode === 'keep' && Object.keys(update.changes).length) {
    update.mode = 'patch';
    operation(operations, 'KEEP_WITH_CHANGES_NORMALIZED', 'sharedStrategy.mode', 'changesがあるためsharedStrategy.modeをpatchへ修正しました。');
  }
  if (update.mode === 'patch' && !Object.keys(update.changes).length) {
    if (opening) {
      delete payload.sharedStrategy;
      operation(operations, 'EMPTY_OPTIONAL_SECTION_REMOVED', 'sharedStrategy', 'Day 0で有効な変更がないsharedStrategyを省略しました。');
    } else {
      update.mode = 'keep';
      operation(operations, 'EMPTY_PATCH_NORMALIZED', 'sharedStrategy.mode', '変更のないpatchをkeepへ修正しました。');
    }
  }
  if (opening && update.mode === 'keep') {
    delete payload.sharedStrategy;
    operation(operations, 'INAPPLICABLE_KEEP_REMOVED', 'sharedStrategy', '初夜の共有作戦で意味を持たないkeepを省略しました。');
  }
}


export { repairSharedStrategy };
