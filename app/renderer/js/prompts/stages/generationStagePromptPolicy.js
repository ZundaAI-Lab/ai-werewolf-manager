/**
 * 責務: 工程、タスク種別、検証済み候補から、工程プロンプトへ含める文章フィールド、固定構造、本人可視情報、キャラクター情報、履歴範囲を許可リスト方式で決定する。
 * 変更ルール: プロンプト本文、API通信、DOM、ゲーム状態更新を扱わない。生のcontextや候補全体を文章化工程へ渡さず、新規区画・新規キーは明示登録されるまで出力対象にしない。decideは直接生成と同じ判断傾向を使うが口調情報を持たず、analyze/critiqueは人物設定を使わない客観分析とする。finalizeは客観分析を参考に人物の判断傾向と表現設定を戻して完成候補を作る。renderへ盤面全体を渡さず、currentMoment・characterSurface・callNamesと必要最小限の会話文脈だけを許可する。文字数値は各工程末尾の最終確認へ集約し、人間向け発言量ラベルや長さ区分を中間工程へ渡さない。「最終確認」以下は各工程の固定末尾として位置・内容を維持する。heartVoiceの文章化対象は通常昼発言系とpriority-answerだけに限定し、遺言・墓場会話では生成工程へ渡さない。
 */

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';
import { isPersonalNightActionTask } from '../../config/personalNightActionTasks.js';

const FIELD_TABLE = Object.freeze({
  speech: Object.freeze({ publicSpeech: 'public-dialogue', heartVoice: 'inner-voice' }),
  'speech-designated': Object.freeze({ publicSpeech: 'public-dialogue', heartVoice: 'inner-voice' }),
  'speech-free': Object.freeze({ publicSpeech: 'public-dialogue', heartVoice: 'inner-voice' }),
  'priority-answer': Object.freeze({ publicSpeech: 'public-dialogue', heartVoice: 'inner-voice' }),
  testament: Object.freeze({ publicSpeech: 'public-dialogue' }),
  'result-impression': Object.freeze({ publicSpeech: 'result-comment' }),
  vote: Object.freeze({ rationale: 'audit-rationale' }),
  'wolf-attack': Object.freeze({ rationale: 'audit-rationale' }),
  'wolf-conversation': Object.freeze({ wolfMessage: 'private-dialogue' }),
  'mason-conversation': Object.freeze({ masonMessage: 'private-dialogue' }),
  'graveyard-conversation': Object.freeze({ graveyardMessage: 'private-dialogue' }),
  'memo-consolidate': Object.freeze({ fullMemo: 'internal-memo' }),
});

const LOCK_FIELDS_BY_TASK = Object.freeze({
  speech: Object.freeze(['speechInteraction', 'coOperation', 'abilityClaims', 'decisionPatch']),
  'speech-designated': Object.freeze(['speechInteraction', 'coOperation', 'abilityClaims', 'decisionPatch', 'nextSpeakerPreference']),
  'speech-free': Object.freeze(['speechInteraction', 'coOperation', 'abilityClaims', 'decisionPatch', 'discussionPreference']),
  'priority-answer': Object.freeze(['coOperation', 'abilityClaims', 'decisionPatch']),
  testament: Object.freeze(['coOperation', 'abilityClaims']),
  vote: Object.freeze(['actionAnswer', 'decisionPatch']),
  'wolf-attack': Object.freeze(['actionAnswer', 'attackAssessment']),
  'wolf-conversation': Object.freeze(['sharedStrategy']),
  'mason-conversation': Object.freeze(['decisionPatch']),
  'graveyard-conversation': Object.freeze([]),
  'result-impression': Object.freeze([]),
  'memo-consolidate': Object.freeze([]),
});

const DECISION_CONTEXT_SECTIONS_BY_TASK = Object.freeze({
  speech: Object.freeze(['currentMoment', 'publicState', 'privateState', 'roleTaskData', 'characterReasoning', 'histories']),
  'speech-designated': Object.freeze(['currentMoment', 'publicState', 'privateState', 'roleTaskData', 'characterReasoning', 'histories']),
  'speech-free': Object.freeze(['currentMoment', 'publicState', 'privateState', 'roleTaskData', 'characterReasoning', 'histories']),
  'priority-answer': Object.freeze(['currentMoment', 'publicState', 'privateState', 'roleTaskData', 'characterReasoning', 'histories']),
  testament: Object.freeze(['currentMoment', 'publicState', 'privateState', 'roleTaskData', 'characterReasoning', 'histories']),
  vote: Object.freeze(['currentMoment', 'publicState', 'privateState', 'roleTaskData', 'characterReasoning', 'histories']),
  'result-impression': Object.freeze(['currentMoment', 'resultSummary', 'characterReasoning']),
  'wolf-conversation': Object.freeze(['currentMoment', 'publicState', 'privateState', 'roleTaskData', 'characterReasoning', 'recentWolfConversation', 'existingInternalMemo']),
  'mason-conversation': Object.freeze(['currentMoment', 'publicState', 'privateState', 'roleTaskData', 'characterReasoning', 'recentMasonConversation', 'existingInternalMemo']),
  'graveyard-conversation': Object.freeze(['currentMoment', 'publicState', 'privateState', 'roleTaskData', 'recentGraveyardConversation', 'pastGraveyardConversations', 'existingInternalMemo']),
  'memo-consolidate': Object.freeze(['currentMoment', 'existingInternalMemo']),
  'wolf-attack': Object.freeze(['currentMoment', 'publicState', 'privateState', 'roleTaskData', 'characterReasoning', 'histories']),
});

const CONTEXT_SECTIONS_BY_PURPOSE = Object.freeze({
  'public-dialogue': Object.freeze(['currentMoment', 'characterSurface', 'callNames', 'speechGuidance']),
  'result-comment': Object.freeze(['currentMoment', 'characterSurface', 'callNames', 'resultSummary']),
  'private-dialogue': Object.freeze(['currentMoment', 'characterSurface', 'participants', 'privateConversation', 'publicState']),
  'inner-voice': Object.freeze(['currentMoment', 'characterSurface', 'actionSummary']),
  'audit-rationale': Object.freeze(['currentMoment', 'actionSummary', 'publicEvidence']),
  'internal-memo': Object.freeze(['currentMoment', 'existingInternalMemo', 'memoLimits']),
});

function tableForTask(taskType) {
  if (Object.hasOwn(FIELD_TABLE, taskType)) return FIELD_TABLE[taskType];
  if (isPersonalNightActionTask(taskType)) return Object.freeze({ rationale: 'audit-rationale' });
  throw new RangeError(`生成工程で未対応のtaskTypeです: ${taskType}`);
}

function decisionContextSections(taskType) {
  if (Object.hasOwn(DECISION_CONTEXT_SECTIONS_BY_TASK, taskType)) return [...DECISION_CONTEXT_SECTIONS_BY_TASK[taskType]];
  if (isPersonalNightActionTask(taskType)) return ['currentMoment', 'publicState', 'privateState', 'roleTaskData', 'characterReasoning', 'histories'];
  throw new RangeError(`中間候補生成で未対応のtaskTypeです: ${taskType}`);
}

function objectiveContextSections(taskType) {
  return decisionContextSections(taskType).filter((section) => section !== 'characterReasoning');
}

export function textFieldsForTaskType(taskType) {
  return Object.keys(tableForTask(taskType));
}

export function textFieldPurpose(taskType, fieldName) {
  const table = tableForTask(taskType);
  if (!Object.hasOwn(table, fieldName)) throw new RangeError(`生成工程で未対応の文章フィールドです: ${taskType}.${fieldName}`);
  return table[fieldName];
}

export function targetTextFieldsForStage({ stageId, taskType, candidateObject, presentTopLevelKeys }) {
  if (stageId !== 'render') throw new RangeError(`文章工程ではないstageIdです: ${stageId}`);
  const allowedFields = textFieldsForTaskType(taskType);
  if (!candidateObject || typeof candidateObject !== 'object') return [];
  const present = new Set(Array.isArray(presentTopLevelKeys) ? presentTopLevelKeys : Object.keys(candidateObject));
  return allowedFields.filter((fieldName) => present.has(fieldName));
}

export function resolveGenerationStagePromptPolicy({
  stageId,
  taskType,
  candidateObject = null,
  presentTopLevelKeys = [],
} = {}) {
  if (!['decide', 'analyze', 'critique', 'finalize', 'render'].includes(stageId)) throw new RangeError(`未対応の生成工程です: ${stageId}`);
  if (['decide', 'analyze', 'critique', 'finalize'].includes(stageId)) {
    return {
      applicable: true,
      targetTextFields: [],
      requiredReturnFields: [],
      fieldPurposes: {},
      candidateLockFields: [],
      contextSections: ['analyze', 'critique'].includes(stageId) ? objectiveContextSections(taskType) : decisionContextSections(taskType),
      skipReason: null,
    };
  }
  const targetTextFields = targetTextFieldsForStage({ stageId, taskType, candidateObject, presentTopLevelKeys });
  if (!targetTextFields.length) {
    return {
      applicable: false,
      targetTextFields: [],
      requiredReturnFields: [],
      fieldPurposes: {},
      candidateLockFields: [],
      contextSections: [],
      skipReason: 'NO_APPLICABLE_TEXT_FIELD',
    };
  }
  const fieldPurposes = Object.fromEntries(targetTextFields.map((fieldName) => [fieldName, textFieldPurpose(taskType, fieldName)]));
  const candidateLockFields = [...(LOCK_FIELDS_BY_TASK[taskType] ?? (isPersonalNightActionTask(taskType) ? ['actionAnswer'] : []))]
    .filter((fieldName) => Object.hasOwn(candidateObject ?? {}, fieldName));
  const contextSections = [...new Set(targetTextFields.flatMap((fieldName) => CONTEXT_SECTIONS_BY_PURPOSE[fieldPurposes[fieldName]] ?? []))];
  return {
    applicable: true,
    targetTextFields,
    requiredReturnFields: [...targetTextFields],
    fieldPurposes,
    candidateLockFields,
    contextSections,
    skipReason: null,
  };
}
