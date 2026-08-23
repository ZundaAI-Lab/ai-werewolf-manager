/**
 * 責務: 客観的な局面フラグから、プロンプトの説明区画と詳細度をタスク別に選択する。
 * 変更ルール: 可視データ本体、公開履歴、既存説明文へ介入せず、文章を生成せず、ゲーム状態を更新しない。区画の追加・削除はタスク別の必要情報だけで判断し、同じ確定情報を複数区画へ重複表示しない。継続アンカー・当日カプセルへ依存せず、最新判断・正式本人履歴を必要タスクへ直接表示する。保存済みheartVoiceは次回プロンプトの判断材料へ再投入しない。投票の人口・同票・処刑分岐はdecisionTaskSectionへ一元化し、一般人口区画を重ねない。実行タスクは役職通知の保持を前提にせず、本人プロフィールをその都度選択する。相手別呼称は公開・秘密の会話文章を生成するタスクだけへ表示し、構造化行動タスクへ表示しない。昼の発言状況と質問可能範囲は一つの会話状況区画として選択する。回答フェーズは通常発言数を消費しないがCO可能な公開判断機会なので、役職固有判断・CO戦術・公開順序・陣営戦術を通常議論と同じ正本から表示する。墓場会話は生前判断の継続ではなく秘密共有・答え合わせ・感想を目的とするため、latestDecision を再投入しない。判断材料を完全非表示にする変更は対応テストを追加してから行う。
 */

import { PERSONAL_NIGHT_ACTION_TASK_TYPES, isPersonalNightActionTask } from '../../config/personalNightActionTasks.js';
import { DISCUSSION_OPENING_PREFERENCE_TASK, NORMAL_SPEECH_TASK_TYPES } from '../../config/discussionAiTaskTypes.js';
import { resolvePublicHistoryMode } from './publicHistoryPolicy.js';

const FULL_GAME_STATE_TASKS = new Set(['briefing', ...NORMAL_SPEECH_TASK_TYPES, DISCUSSION_OPENING_PREFERENCE_TASK, 'priority-answer', 'vote', 'testament']);
const COMPACT_GAME_STATE_TASKS = new Set([
  ...PERSONAL_NIGHT_ACTION_TASK_TYPES,
  'mason-conversation', 'wolf-conversation', 'graveyard-conversation', 'wolf-attack',
]);
const FULL_PRIVATE_INFORMATION_TASKS = new Set([
  'briefing', ...NORMAL_SPEECH_TASK_TYPES, DISCUSSION_OPENING_PREFERENCE_TASK, 'priority-answer', 'vote',
  'mason-conversation', 'wolf-conversation', 'graveyard-conversation', 'wolf-attack',
]);
const FULL_OWN_HISTORY_TASKS = new Set([...NORMAL_SPEECH_TASK_TYPES, DISCUSSION_OPENING_PREFERENCE_TASK, 'priority-answer', 'vote', 'testament']);
const WOLF_HISTORY_TASKS = new Set(['wolf-conversation', 'wolf-attack']);
const LATEST_DECISION_TASKS = new Set([
  ...NORMAL_SPEECH_TASK_TYPES, DISCUSSION_OPENING_PREFERENCE_TASK, 'priority-answer', 'vote',
  ...PERSONAL_NIGHT_ACTION_TASK_TYPES,
  'mason-conversation', 'wolf-conversation', 'wolf-attack',
]);
const DAY_SHARED_COMMUNICATION_TASKS = new Set([...NORMAL_SPEECH_TASK_TYPES, DISCUSSION_OPENING_PREFERENCE_TASK, 'priority-answer', 'vote']);
const WOLF_PRIVATE_TASKS = new Set(['wolf-conversation', 'wolf-attack']);
const INTERNAL_MEMORY_TASKS = new Set([
  ...NORMAL_SPEECH_TASK_TYPES, DISCUSSION_OPENING_PREFERENCE_TASK, 'priority-answer', 'vote',
  ...PERSONAL_NIGHT_ACTION_TASK_TYPES,
  'mason-conversation', 'wolf-conversation', 'graveyard-conversation', 'wolf-attack', 'memo-consolidate',
]);
const CALL_NAME_TASKS = new Set([
  'briefing', ...NORMAL_SPEECH_TASK_TYPES, 'priority-answer', 'testament',
  'mason-conversation', 'wolf-conversation', 'graveyard-conversation', 'result-impression',
]);

function resolveGameStateMode(taskType) {
  if (FULL_GAME_STATE_TASKS.has(taskType)) return 'full';
  if (COMPACT_GAME_STATE_TASKS.has(taskType)) return 'night-compact';
  return 'none';
}

function resolvePrivateInformationMode(taskType) {
  if (FULL_PRIVATE_INFORMATION_TASKS.has(taskType)) return 'full';
  if (isPersonalNightActionTask(taskType)) return 'night-action';
  return 'none';
}

function resolveOwnHistoryMode(taskType) {
  if (FULL_OWN_HISTORY_TASKS.has(taskType)) return 'full';
  if (isPersonalNightActionTask(taskType)) return 'night-actions-only';
  if (WOLF_HISTORY_TASKS.has(taskType)) return 'wolf-strategy';
  return 'none';
}

export function resolvePromptSectionPolicy(situation, {
  factionStrategyPolicy = null,
  includeInitial = false,
  publicHistoryPolicy = null,
} = {}) {
  const taskType = situation.taskType;
  const showDayPublicResponse = Boolean(situation.isSpeech || situation.isPriorityAnswer || situation.isTestament);
  const showUnclaimedGuardDecision = showDayPublicResponse
    && situation.roleId === 'guard'
    && situation.ownClaimRoleId !== 'guard';
  const detailedGuardDecision = showUnclaimedGuardDecision && (
    situation.isFinalDiscussionDecisionWindow
    || situation.hasGuardClaim
    || situation.hasOwnGuardHistory
    || situation.isEndgame
    || situation.hasReconsideration
  );
  const showDayFactionStrategy = DAY_SHARED_COMMUNICATION_TASKS.has(taskType);
  const showWolfTacticalDetail = showDayFactionStrategy
    && Boolean(factionStrategyPolicy?.showTacticalDetail);

  return Object.freeze({
    showPlayerProfile: taskType !== 'memo-consolidate',
    characterProfileMode: includeInitial
      ? 'initial-full'
      : situation.isResultImpression
        ? 'result-compact'
        : situation.isNightTask
          ? 'night-compact'
          : showDayPublicResponse
            ? 'day-dialogue-compact'
            : 'day-compact',
    callNameMode: CALL_NAME_TASKS.has(taskType) ? 'full' : 'none',
    gameStateMode: resolveGameStateMode(taskType),
    publicHistoryMode: resolvePublicHistoryMode(situation, publicHistoryPolicy ?? {}),
    showDaySpeechOrderPrinciple: situation.isSpeech,
    showDayConversationStatus: situation.isSpeech,
    showClaimTiming: showDayPublicResponse && situation.hasClaimTimingFacts,
    showReasoningPolicy: showDayPublicResponse,
    showExecutionValuePolicy: situation.isVote || situation.isFinalDiscussionDecisionWindow,
    showRoleGuidance: !situation.isMemo && !situation.isResultImpression,
    privateInformationMode: resolvePrivateInformationMode(taskType),
    ownHistoryMode: resolveOwnHistoryMode(taskType),
    showLatestDecision: LATEST_DECISION_TASKS.has(taskType),
    showLatestFactionStrategy: showDayFactionStrategy
      && Boolean(factionStrategyPolicy?.showLatestFactionStrategy),
    showWolfTacticalDetail,
    showPartnerPublicPositions: showDayFactionStrategy
      && Boolean(factionStrategyPolicy?.showPartnerPublicPositions),
    showDiscussionReconsideration: showDayPublicResponse,
    showRoleDecision: situation.isDayDecision,
    showEndgameFactionTactics: (showDayPublicResponse || (situation.isVote && situation.strategyProfile === 'madman')) && situation.isEndgameFactionTactics,
    showAbilityClaimTimeline: Boolean(situation.isSpeech || situation.isPriorityAnswer || situation.isTestament),
    // 正式な本人情報はprivate-informationとown-historyへ集約し、同内容の再掲区画は出さない。
    showSystemMemory: false,
    showInternalMemory: INTERNAL_MEMORY_TASKS.has(taskType),
    showSharedCommunication: taskType === 'mason-conversation'
      || DAY_SHARED_COMMUNICATION_TASKS.has(taskType),
    showGraveyardCommunication: taskType === 'graveyard-conversation',
    showWolfSharedCommunication: WOLF_PRIVATE_TASKS.has(taskType)
      || (showDayFactionStrategy && situation.strategyProfile === 'wolf' && showWolfTacticalDetail),
    showPopulation: showDayPublicResponse || situation.isAttackTask || taskType === 'guard',
    showMadmanClaimBranch: showDayPublicResponse,
    showOwnPublicClaimConsistency: Boolean(situation.isSpeech || situation.isPriorityAnswer || situation.isTestament),
    guardClaimDecisionMode: showUnclaimedGuardDecision
      ? (detailedGuardDecision ? 'detailed' : 'compact')
      : 'none',
  });
}
