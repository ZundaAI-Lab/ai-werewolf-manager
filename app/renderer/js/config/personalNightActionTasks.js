/**
 * 責務: AIが個別に選択する夜行動タスク種別の正本と、その所属判定を提供する。
 * 変更ルール: 候補算出、応答形式、プロンプト表示、UI文言を持たない。個人夜行動を追加・削除するときはこの一覧だけを分類正本として更新し、各責務モジュールはこの判定を参照する。
 */

export const PERSONAL_NIGHT_ACTION_TASK_TYPES = Object.freeze([
  'inspect',
  'guard',
  'visit',
  'freeze',
  'choose-owner',
]);

const PERSONAL_NIGHT_ACTION_TASK_TYPE_SET = new Set(PERSONAL_NIGHT_ACTION_TASK_TYPES);

export function isPersonalNightActionTask(taskType) {
  return PERSONAL_NIGHT_ACTION_TASK_TYPE_SET.has(String(taskType ?? '').trim());
}
