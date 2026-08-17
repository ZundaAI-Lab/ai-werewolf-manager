/**
 * 責務: AIプロンプトへ表示する説明の選択に必要な局面フラグを、可視コンテキストと戦況計算から導出する。
 * 変更ルール: 文面を生成せず、ゲーム状態を更新せず、可視情報を削除・追加しない。新しい判定を追加する場合は客観的な状態だけを使用する。順番制の最終巡判断は、残り通常発言1回以下を境界として通常発言と優先回答へ同じフラグを与え、質問回答と本人発言の順序で判断粒度を変えない。
 */

import { PERSONAL_NIGHT_ACTION_TASK_TYPES, isPersonalNightActionTask } from '../../config/personalNightActionTasks.js';
import { DISCUSSION_OPENING_PREFERENCE_TASK, NORMAL_SPEECH_TASK_TYPES, isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';
import { countConfiguredMadmanSlots, countConfiguredWolves } from '../../domain/roles/roleAttributes.js';
import { isInitialClaimDecisionSituation } from './openingSpeechPolicy.js';

const DAY_DECISION_TASKS = new Set([...NORMAL_SPEECH_TASK_TYPES, 'priority-answer', 'vote', DISCUSSION_OPENING_PREFERENCE_TASK]);
const ATTACK_TASKS = new Set(['wolf-conversation', 'wolf-attack']);
const PRIVATE_NIGHT_CONVERSATION_TASKS = new Set(['mason-conversation', 'wolf-conversation', 'graveyard-conversation']);
const NIGHT_TASKS = new Set([
  ...PERSONAL_NIGHT_ACTION_TASK_TYPES,
  ...PRIVATE_NIGHT_CONVERSATION_TASKS,
  'wolf-attack',
]);

function activeClaimRoleId(context, playerId) {
  return context.board.claims.find((claim) => claim.actorId === playerId)?.roleId ?? null;
}

function isUnderBlackResult(context) {
  return context.board.publicAbilityClaims.some((claim) => (
    claim.targetId === context.player.id && claim.result === 'wolf'
  ));
}

function hasNewClaimSincePreviousDecision(decision) {
  return (decision.decisionDelta?.newPublicEvents ?? []).some((event) => {
    if (event.type !== 'public-speech') return false;
    const operation = event.payload?.structured?.coOperation ?? null;
    return Boolean(operation && ['declare', 'change', 'withdraw'].includes(operation.action));
  });
}

function isFinalDiscussionDecisionWindow(context, taskType) {
  if (!(isNormalSpeechTask(taskType) || taskType === 'priority-answer')) return false;
  const discussion = context.game.discussion;
  if (!discussion || discussion.mode !== 'ordered') return false;
  const remaining = Number(discussion.remainingByPlayer?.[context.player.id] ?? 0);
  // 残り通常発言が1回以下になった時点から、その前後に割り込む優先回答も同じ最終巡判断として扱う。
  // 優先回答は通常発言数を消費しないため、本人発言→回答 / 回答→本人発言の順序差で判断粒度を変えない。
  return remaining <= 1;
}

function hasOwnGuardHistory(context) {
  if (context.player.roleId !== 'guard') return false;
  return context.ownHistory.nightActions.some((event) => event.payload?.actionType === 'guard');
}

function hasReconsideration(context) {
  const discussion = context.game.discussion;
  const reconsideration = discussion?.reconsideration;
  return Boolean(
    reconsideration?.pending
    || reconsideration?.active
    || discussion?.roundKind === 'targeted-response',
  );
}

export function buildPromptSituation(context, decision, { taskType = context.task.type } = {}) {
  const isSpeech = isNormalSpeechTask(taskType);
  const isPriorityAnswer = taskType === 'priority-answer';
  const isVote = taskType === 'vote';
  const isTestament = taskType === 'testament';
  const isDayDecision = DAY_DECISION_TASKS.has(taskType);
  const configuredWolfSlots = countConfiguredWolves(context.game.roleComposition);
  const configuredMadmanSlots = countConfiguredMadmanSlots(context.game.roleComposition);
  const endgameFactionTacticsThreshold = 2 * (configuredWolfSlots + configuredMadmanSlots);
  const isEndgameFactionTactics = (isSpeech || isPriorityAnswer || isVote)
    && endgameFactionTacticsThreshold > 0
    && context.board.alive.length <= endgameFactionTacticsThreshold;
  const ownClaimRoleId = activeClaimRoleId(context, context.player.id);
  const aliveSeerClaims = context.board.claims.filter((claim) => (
    claim.roleId === 'seer' && context.board.alive.some((player) => player.id === claim.actorId)
  ));
  const guardClaims = context.board.claims.filter((claim) => claim.roleId === 'guard');

  return Object.freeze({
    taskType,
    roleId: context.player.roleId,
    strategyProfile: context.player.strategyProfile ?? null,
    ownClaimRoleId,
    isSpeech,
    isPriorityAnswer,
    isVote,
    isTestament,
    isDayDecision,
    isSimpleNightAction: isPersonalNightActionTask(taskType),
    isPrivateNightConversation: PRIVATE_NIGHT_CONVERSATION_TASKS.has(taskType),
    isNightTask: NIGHT_TASKS.has(taskType),
    isAttackTask: ATTACK_TASKS.has(taskType) && Boolean(decision.attack),
    isMemo: taskType === 'memo-consolidate',
    isResultImpression: taskType === 'result-impression',
    isBriefing: taskType === 'briefing',
    isInitialClaimDecision: isDayDecision && !isVote && isInitialClaimDecisionSituation(context),
    isUnderBlackResult: isDayDecision && !isVote && isUnderBlackResult(context),
    hasNewClaimSincePreviousDecision: isDayDecision && hasNewClaimSincePreviousDecision(decision),
    hasPreviousDecision: Boolean(decision.decisionDelta?.hasPreviousDecision),
    hasNewPublicEvents: Boolean((decision.decisionDelta?.newPublicEvents ?? []).length),
    hasClaimTimingFacts: Boolean((context.board.claimTimingFacts ?? []).length),
    hasTwoAliveSeerClaims: aliveSeerClaims.length === 2,
    isRunoff: isVote && context.game.vote?.type === 'runoff',
    isEndgame: context.board.alive.length <= 5,
    isEndgameFactionTactics,
    endgameFactionTacticsThreshold,
    isFinalDiscussionDecisionWindow: isFinalDiscussionDecisionWindow(context, taskType),
    hasGuardClaim: guardClaims.length > 0,
    hasOwnGuardHistory: hasOwnGuardHistory(context),
    hasReconsideration: hasReconsideration(context),
    attackRequired: Boolean(context.task.wolfAttackRequired),
  });
}
