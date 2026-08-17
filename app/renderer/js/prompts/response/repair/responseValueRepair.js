/**
 * 責務: 行動理由、内部メモ、トップレベルキーの決定的な長さ・空値・表記補正を行う。
 * 変更ルール: 必須本文や行動対象を補完せず、任意テキストと契約キーだけを扱う。
 */

import {
  MAX_FREEZE_ACTION_RATIONALE_LENGTH,
  MAX_NIGHT_ACTION_RATIONALE_LENGTH,
} from '../../../config/constants.js';
import { isPersonalNightActionTask } from '../../../config/personalNightActionTasks.js';
import {
  getRequiredResponseTopLevelKeys,
  getResponseTopLevelKeys,
} from '../responseContract.js';
import { operation } from './jsonObjectRecovery.js';
import {
  removeNullOptionalFields,
  repairExactKeys,
} from './repairUtilities.js';

function truncateAtSentenceBoundary(text, limit) {
  const value = String(text ?? '').trim();
  if (value.length <= limit) return value;
  const head = value.slice(0, limit);
  const boundary = Math.max(...['。', '！', '？', '!', '?'].map((mark) => head.lastIndexOf(mark)));
  return boundary >= Math.floor(limit * 0.45) ? head.slice(0, boundary + 1).trim() : head.trim();
}

function repairActionRationale(taskType, payload, operations) {
  if (!Object.hasOwn(payload, 'actionRationale') || typeof payload.actionRationale !== 'string') return;
  if (!(isPersonalNightActionTask(taskType) || taskType === 'wolf-attack')) return;
  const limit = taskType === 'freeze' ? MAX_FREEZE_ACTION_RATIONALE_LENGTH : MAX_NIGHT_ACTION_RATIONALE_LENGTH;
  if (payload.actionRationale.trim().length <= limit) return;
  payload.actionRationale = truncateAtSentenceBoundary(payload.actionRationale, limit);
  operation(operations, 'OPTIONAL_TEXT_TRUNCATED', 'actionRationale', `actionRationaleを${limit}文字以内へ短縮しました。`);
}

function repairInternalMemo(payload, operations) {
  if (!Object.hasOwn(payload, 'memoAdd')) return;
  if (typeof payload.memoAdd !== 'string' || !payload.memoAdd.trim()) {
    delete payload.memoAdd;
    operation(operations, 'EMPTY_OPTIONAL_VALUE_REMOVED', 'memoAdd', '空または文字列でないmemoAddを省略しました。');
    return;
  }
  payload.memoAdd = payload.memoAdd.trim();
}

function repairTopLevel(payload, mode, operations) {
  repairExactKeys(payload, '', getResponseTopLevelKeys(mode), operations);
  const required = new Set(getRequiredResponseTopLevelKeys(mode));
  removeNullOptionalFields(payload, required, '', operations);
  Object.keys(payload).forEach((key) => {
    if (required.has(key) || typeof payload[key] !== 'string' || payload[key].trim()) return;
    delete payload[key];
    operation(operations, 'EMPTY_OPTIONAL_VALUE_REMOVED', key, `空の任意項目${key}を省略しました。`);
  });
}


export { repairActionRationale, repairInternalMemo, repairTopLevel };
