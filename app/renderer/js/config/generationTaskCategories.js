/**
 * 責務: AI生成タスク種別と生成設定カテゴリの固定対応を一元管理する。
 * 変更ルール: 生成工程、API通信、監査記録を実行しない。AIが実際に生成するタスクだけを登録し、個人夜行動はpersonalNightActionTasks.jsの正本から展開する。監査専用fallback種別をここへ混ぜない。
 */

import { PERSONAL_NIGHT_ACTION_TASK_TYPES } from './personalNightActionTasks.js';

export const TASK_GENERATION_CATEGORY = Object.freeze({
  speech: 'speech',
  'speech-designated': 'speech',
  'speech-free': 'speech',
  'discussion-opening-preference': 'speech',
  'priority-answer': 'speech',
  testament: 'speech',
  vote: 'vote',
  'result-impression': 'resultImpression',
  'wolf-conversation': 'privateConversation',
  'mason-conversation': 'privateConversation',
  'graveyard-conversation': 'privateConversation',
  'memo-consolidate': 'memoConsolidate',
  'wolf-attack': 'nightAction',
  ...Object.fromEntries(PERSONAL_NIGHT_ACTION_TASK_TYPES.map((taskType) => [taskType, 'nightAction'])),
});
