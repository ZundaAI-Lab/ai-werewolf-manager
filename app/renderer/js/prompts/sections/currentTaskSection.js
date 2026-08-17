/**
 * 責務: 現在のAIタスクに必要な対象、質問、結果感想、秘密会話目的を最小データへ変換する。
 * 変更ルール: タスク契約にない項目を追加せず、個人夜行動では必ずcurrent-task.validTargetsを出す。対象IDは可視コンテキストの正式表示名へ変換し、雪女の推定契約で明示的にIDが必要な対象だけIDと表示名を併記する。監査専用イベントIDはプロンプトへ出さない。
 */

import { isPersonalNightActionTask } from '../../config/personalNightActionTasks.js';
import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';
import { resolveSnowWomanEstimateLimit } from '../../domain/night/snowWomanEstimatePolicy.js';
import { playerName } from './promptFormatters.js';

function withoutAuditReferences(value) {
  if (Array.isArray(value)) return value.map(withoutAuditReferences);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['sourceEventIds', 'eventId', 'eventIds'].includes(key))
    .map(([key, child]) => [key, withoutAuditReferences(child)]));
}

export function currentTaskData(context, taskType, { decision = null } = {}) {
  const validTargets = context.task.validTargetIds.map((id) => playerName(context, id));
  if (taskType === 'discussion-opening-preference') {
    return {
      choices: ['EARLY', 'NORMAL', 'WAIT_CO'],
      meaning: {
        EARLY: 'CO・対抗CO・重要情報の提示などのため、できるだけ早く発言したい',
        NORMAL: '特に発言順の希望はない',
        WAIT_CO: '他者のCO状況を確認してから発言したい',
      },
    };
  }
  if (taskType === 'speech-designated') {
    const discussion = context.game.discussion ?? {};
    const spoken = new Set(discussion.spokenInCurrentRound ?? []);
    const candidates = (discussion.queue ?? [])
      .slice(Number(discussion.currentIndex ?? 0) + 1)
      .filter((id) => !spoken.has(id));
    return {
      nextSpeakerCandidates: candidates.map((id) => playerName(context, id)),
      instruction: '候補内で次に発言してほしい相手がいる場合だけnextSpeakerPreferenceへ正式表示名を指定する。指名しない場合は空文字。',
    };
  }
  if (taskType === 'speech-free') {
    return {
      nextRoundChoices: ['EARLY', 'NORMAL', 'WAIT_CO', 'DONE'],
      doneMeaning: '今回までに、現時点で公開すべき推理・疑い・質問・CO・弁明などをすべて話し切った。情報不足や話題が思いつかないだけでは選ばない。',
    };
  }
  if (taskType === 'freeze') {
    return {
      alivePlayers: context.board.alive.map((player) => ({ id: player.id, name: player.name })),
      validTargets: context.task.validTargetIds.map((id) => ({ id, name: playerName(context, id) })),
      estimateLimit: resolveSnowWomanEstimateLimit(context.task.validTargetIds.length),
    };
  }
  if (taskType === 'priority-answer') {
    const answer = context.task.priorityAnswer ?? {};
    return {
      questionRef: `#${answer.questionSequence ?? ''}`,
      asker: answer.askerName ?? '',
      questionText: answer.questionText ?? '',
    };
  }
  if (isNormalSpeechTask(taskType) && context.task.normalSpeechAnswers?.length) {
    return {
      requiredAnswers: context.task.normalSpeechAnswers.map((answer) => ({
        questionSequence: answer.questionSequence,
        asker: answer.askerName,
        questionText: answer.questionText,
      })),
    };
  }
  if (taskType === 'result-impression') {
    const impressionContext = context.task.resultImpression ?? {};
    return withoutAuditReferences({
      gameResult: impressionContext.gameResult ?? null,
      yourResult: impressionContext.yourResult ?? null,
      allRoles: impressionContext.allRoles ?? [],
      gameFlow: impressionContext.gameFlow ?? [],
    });
  }
  if (taskType === 'guard') {
    const previousGuard = [...(context.ownHistory?.nightActions ?? [])]
      .reverse()
      .find((event) => event.payload?.actionType === 'guard');
    const previousTargetName = previousGuard?.payload?.targetId
      ? playerName(context, previousGuard.payload.targetId)
      : null;
    return {
      ...(validTargets.length ? { validTargets } : {}),
      guardRules: {
        selfGuardAllowed: Boolean(context.game.rules?.guard?.selfGuardAllowed),
        consecutiveGuardAllowed: Boolean(context.game.rules?.guard?.consecutiveGuardAllowed),
        previousGuardTarget: previousTargetName,
        previousGuardTargetSelectable: previousTargetName ? validTargets.includes(previousTargetName) : null,
        invalidTargetsAreExcludedFromValidTargets: true,
      },
      publicClaims: (context.board.claims ?? []).map((claim) => ({
        player: playerName(context, claim.actorId),
        role: claim.roleId,
        alive: context.board.alive.some((player) => player.id === claim.actorId),
      })),
      ...(decision?.population ? {
        population: {
          aliveCount: decision.population.aliveCount,
          majorityThreshold: decision.population.majorityThreshold,
          configuredWolfCount: decision.population.configuredWolfCount,
          knownAliveWolfCount: decision.population.knownAliveWolfCount,
        },
      } : {}),
    };
  }
  if (isPersonalNightActionTask(taskType)) {
    return { validTargets };
  }
  if (['vote', 'wolf-attack'].includes(taskType)) {
    return {
      ...(validTargets.length ? { validTargets } : {}),
      ...(taskType === 'vote' && context.game.vote?.type ? { voteType: context.game.vote.type } : {}),
    };
  }
  if (taskType === 'testament') {
    return {
      executionTarget: context.player.name,
      instruction: '処刑確定後・死亡処理前の一度限りの公開遺言。質問・回答・再議論は発生しない。',
    };
  }
  if (taskType === 'graveyard-conversation') {
    return {
      participants: (context.graveyardCommunication.current?.participantIds ?? []).map((id) => playerName(context, id)),
      knowledgeCutoffSequence: context.task.knowledgeCutoffSequence ?? null,
      publicKnowledgeFrozenAtDeath: Boolean(context.task.publicKnowledgeFrozenAtDeath),
      instruction: '死亡後の地上情報は自動取得しない。墓場参加者の発言で共有された情報だけ追加で知る。',
    };
  }
  if (taskType === 'wolf-conversation') {
    return {
      purpose: context.task.wolfConversationPurpose,
      attackRequired: Boolean(context.task.wolfAttackRequired),
      ...(validTargets.length ? { validTargets } : {}),
    };
  }
  return null;
}
