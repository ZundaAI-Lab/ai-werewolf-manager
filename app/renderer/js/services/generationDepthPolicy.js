/**
 * 責務: AIプロファイルとタスク種別から生成深度・工程・工程担当プロファイルを決定する。
 * 変更ルール: API通信、プロンプト本文生成、DOM、ゲーム状態更新を行わない。モデル名から性能を推測せず、保存済み設定だけを正本とする。深度3と4のdraft・renderは同一配列を正本とし、深度4だけが通常の昼公開発言と回答優先発言へproofreadを後置する。
 */

import '../ai/responseRetryPolicy.js';
import { TASK_GENERATION_CATEGORY } from '../config/generationTaskCategories.js';
import { DISCUSSION_OPENING_PREFERENCE_TASK, isNormalSpeechTask } from '../config/discussionAiTaskTypes.js';

export { TASK_GENERATION_CATEGORY } from '../config/generationTaskCategories.js';

function responseRetryCallBudget() {
  const budget = Number(globalThis.AiWerewolfResponseRetryPolicy?.DEFAULT_CALL_BUDGET);
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error('AI応答再試行の共通呼び出し上限を取得できません。');
  }
  return budget;
}

export const GENERATION_DEPTHS = Object.freeze([1, 2, 3, 4]);
const STRUCTURED_BASE_STAGES = Object.freeze(['draft', 'render']);

const STAGES_BY_DEPTH = Object.freeze({
  1: Object.freeze(['direct']),
  2: Object.freeze(['direct', 'proofread']),
  3: STRUCTURED_BASE_STAGES,
  4: Object.freeze([...STRUCTURED_BASE_STAGES, 'proofread']),
});

export function generationTaskCategory(taskType) {
  return Object.hasOwn(TASK_GENERATION_CATEGORY, taskType) ? TASK_GENERATION_CATEGORY[taskType] : null;
}

export function stagesForGenerationDepth(depth, taskType = 'speech') {
  const normalized = Number(depth);
  const stageIds = [...(STAGES_BY_DEPTH[normalized] ?? [])];
  if (isNormalSpeechTask(taskType) || taskType === 'priority-answer') return stageIds;
  return stageIds.filter((stageId) => stageId !== 'proofread');
}

function executorReferenceKey(stageId) {
  return ({ draft: 'draftProfileId', render: 'renderProfileId', proofread: 'proofreadProfileId' })[stageId] ?? null;
}

function resolveExecutorProfileId(ownerProfile, profilesById, stageId) {
  const referenceKey = executorReferenceKey(stageId);
  if (!referenceKey) return ownerProfile.id;
  const requested = ownerProfile.generation?.[referenceKey] ?? null;
  if (requested === null) return ownerProfile.id;
  const profile = profilesById.get(String(requested));
  if (!profile) throw new RangeError(`生成工程担当プロファイルが存在しません: ${requested}`);
  if (!profile.enabled) throw new Error(`生成工程担当プロファイル「${profile.label}」は無効です。`);
  return profile.id;
}

export function resolveGenerationPlan({ ownerProfile, profiles, taskType }) {
  if (!ownerProfile?.id) throw new TypeError('親AIプロファイルがありません。');
  const taskCategory = generationTaskCategory(taskType);
  if (!taskCategory) throw new RangeError(`生成深度の対象外タスクです: ${taskType}`);
  const profileList = Array.isArray(profiles) ? profiles : [];
  const profilesById = new Map(profileList.map((profile) => [String(profile.id), profile]));
  if (!profilesById.has(String(ownerProfile.id))) profilesById.set(String(ownerProfile.id), ownerProfile);
  const standardDepth = Number(ownerProfile.generation?.depth ?? 1);
  const override = ownerProfile.generation?.taskOverrides?.[taskCategory] ?? null;
  const depth = taskType === DISCUSSION_OPENING_PREFERENCE_TASK
    ? 1
    : override === null ? standardDepth : Number(override);
  if (!GENERATION_DEPTHS.includes(depth)) throw new RangeError(`生成深度が不正です: ${depth}`);
  const stageIds = stagesForGenerationDepth(depth, taskType);
  const stages = stageIds.map((stageId) => ({
    stageId,
    executorProfileId: resolveExecutorProfileId(ownerProfile, profilesById, stageId),
  }));
  const normalCallCount = stages.length;
  const coreStageCount = stageIds.filter((stageId) => stageId !== 'proofread').length;
  const coreCallBudget = responseRetryCallBudget() + Math.max(0, coreStageCount - 1);
  const proofreadStageCount = stageIds.filter((stageId) => stageId === 'proofread').length;
  return {
    depth,
    taskCategory,
    ownerProfileId: String(ownerProfile.id),
    stages,
    normalCallCount,
    coreCallBudget,
    maximumCallBudget: coreCallBudget + proofreadStageCount,
  };
}
