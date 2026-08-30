/**
 * 責務: AIプロファイルとタスク種別から生成深度・工程・工程担当プロファイルを決定する。
 * 変更ルール: API通信、プロンプト本文生成、DOM、ゲーム状態更新を行わない。モデル名から性能を推測せず、保存済み設定だけを正本とする。深度1は既存の直接生成を一切変更せず、深度2は判断→キャラ発言化、深度3は客観分析→最終回答、深度4は客観分析→批判的検証→最終回答とする。保存済みreasoningProfileIdはdecide/analyze、outputProfileIdはrender/finalize、critiqueProfileIdはcritiqueの担当参照として利用する。
 */

import '../ai/responseRetryPolicy.js';
import { TASK_GENERATION_CATEGORY } from '../config/generationTaskCategories.js';
import { DISCUSSION_OPENING_PREFERENCE_TASK } from '../config/discussionAiTaskTypes.js';

export { TASK_GENERATION_CATEGORY } from '../config/generationTaskCategories.js';

function responseRetryCallBudget() {
  const budget = Number(globalThis.AiWerewolfResponseRetryPolicy?.DEFAULT_CALL_BUDGET);
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error('AI応答再試行の共通呼び出し上限を取得できません。');
  }
  return budget;
}

export const GENERATION_DEPTHS = Object.freeze([1, 2, 3, 4]);

const STAGES_BY_DEPTH = Object.freeze({
  1: Object.freeze(['direct']),
  2: Object.freeze(['decide', 'render']),
  3: Object.freeze(['analyze', 'finalize']),
  4: Object.freeze(['analyze', 'critique', 'finalize']),
});

export function generationTaskCategory(taskType) {
  return Object.hasOwn(TASK_GENERATION_CATEGORY, taskType) ? TASK_GENERATION_CATEGORY[taskType] : null;
}

export function stagesForGenerationDepth(depth) {
  const normalized = Number(depth);
  return [...(STAGES_BY_DEPTH[normalized] ?? [])];
}

function executorReferenceKey(stageId) {
  return ({
    decide: 'reasoningProfileId',
    analyze: 'reasoningProfileId',
    critique: 'critiqueProfileId',
    render: 'outputProfileId',
    finalize: 'outputProfileId',
  })[stageId] ?? null;
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
  const stageIds = stagesForGenerationDepth(depth);
  const stages = stageIds.map((stageId) => ({
    stageId,
    executorProfileId: resolveExecutorProfileId(ownerProfile, profilesById, stageId),
  }));
  const normalCallCount = stages.length;
  const maximumCallBudget = responseRetryCallBudget() + Math.max(0, normalCallCount - 1);
  return {
    depth,
    taskCategory,
    ownerProfileId: String(ownerProfile.id),
    stages,
    normalCallCount,
    coreCallBudget: maximumCallBudget,
    maximumCallBudget,
  };
}
