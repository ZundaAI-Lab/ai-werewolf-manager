/**
 * 責務: AI生成タスク分類の正本同士が矛盾せず、通常生成タスクと監査専用fallback種別を混在させないことを構造データで検証する。
 * 変更ルール: タスク説明文やプロンプト文言を固定しない。configモジュールが公開する分類値だけを検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_GENERATION_CATEGORY } from '../../../app/renderer/js/config/generationTaskCategories.js';
import { PERSONAL_NIGHT_ACTION_TASK_TYPES } from '../../../app/renderer/js/config/personalNightActionTasks.js';
import { NORMAL_SPEECH_TASK_TYPES } from '../../../app/renderer/js/config/discussionAiTaskTypes.js';

test('通常発言と個人夜行動は各分類正本へ一貫して所属する', () => {
  NORMAL_SPEECH_TASK_TYPES.forEach((taskType) => {
    assert.equal(TASK_GENERATION_CATEGORY[taskType], 'speech', taskType);
  });
  PERSONAL_NIGHT_ACTION_TASK_TYPES.forEach((taskType) => {
    assert.equal(TASK_GENERATION_CATEGORY[taskType], 'nightAction', taskType);
  });
});

test('fallback監査種別は通常生成タスク分類へ混在しない', () => {
  for (const taskType of Object.keys(TASK_GENERATION_CATEGORY)) {
    assert.equal(taskType.endsWith('-fallback'), false, taskType);
  }
});
