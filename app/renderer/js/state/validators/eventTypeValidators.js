/**
 * 責務: イベント種別固有の保存構造・参照・AI登録整合を種別テーブルで検査する。
 * 変更ルール: 全イベント共通のID・公開状態・訂正系譜検査はeventStateValidator.jsへ残し、種別固有規則だけを本テーブルへ追加する。
 */

import { MAX_RESULT_IMPRESSION_LENGTH } from '../../config/constants.js';
import { getLogicalEventSequence, resolveCorrectionHeadAtSequence } from '../../domain/events/correctionLineage.js';
import { PUBLIC_ABILITY_RESULTS } from '../../domain/policies/publicAbilityClaimPolicy.js';
import { validateAiPublicSpeechUnmodified } from '../../domain/policies/publicAbilityClaimNarrative.js';
import { getPlayerTeam } from '../../domain/roles/roleAttributes.js';
import {
  PUBLIC_ABILITY_ROLE_ID_SET,
  ABILITY_SELECTION_BASE_SET,
  DISCUSSION_ROUND_KINDS,
  validateWolfSharedStrategyPatch,
  validateExactObjectShape,
} from './validatorShared.js';

function validateWolfConversationEvent(event, context) {
  const { label, errors, index } = context;
    validateWolfSharedStrategyPatch(
      event.payload?.sharedStrategyUpdate,
      `${label}: イベント${event.id ?? index}の共有作戦更新`,
      errors,
      { openingStrategy: event.payload?.purpose === 'opening-strategy' },
    );

}

function validatePrivateResultEvent(event, context) {
  const { raw, label, errors } = context;
    const actionType = event.payload?.actionType;
    const target = raw.players.find((player) => player.id === event.payload?.targetId);
    if (actionType === 'choose-owner') {
      const actor = raw.players.find((player) => player.id === event.actorId);
      if (actor?.roleId !== 'zashikiWarashi') errors.push(`${label}: 家主通知${event.id}の対象者が座敷わらしではありません。`);
      if (!target) errors.push(`${label}: 家主通知${event.id}の家主が存在しません。`);
      if (event.payload?.ownerRoleId !== target?.roleId) errors.push(`${label}: 家主通知${event.id}の正確な役職が家主と一致しません。`);
      if (event.payload?.resolvedTeam !== getPlayerTeam(raw, target)) errors.push(`${label}: 家主通知${event.id}の所属陣営が家主と一致しません。`);
      if (Object.hasOwn(event.payload ?? {}, 'result')) errors.push(`${label}: 家主通知${event.id}に占霊結果用resultが残っています。`);
    } else if (['inspect', 'medium'].includes(actionType)) {
      if (!['wolf', 'not-wolf'].includes(event.payload?.result)) errors.push(`${label}: 能力結果${event.id}の占霊判定が不正です。`);
      if (Object.hasOwn(event.payload ?? {}, 'ownerRoleId')) errors.push(`${label}: 占霊結果${event.id}に家主役職が混入しています。`);
    } else {
      errors.push(`${label}: 本人限定能力結果${event.id}のactionTypeが不正です。`);
    }

}

function validatePriorityAnswerResolutionEvent(event, context) {
  const { label, errors, events, checkId, checkEventIds } = context;
    const questionEventId = event.payload?.questionEventId;
    const targetPlayerId = event.payload?.targetPlayerId;
    const sourceQuestion = resolveCorrectionHeadAtSequence(events, questionEventId, Number(event.sequence ?? 0) - 1);
    const questionTargets = sourceQuestion?.payload?.structured?.interaction?.questionTargetIds ?? [];
    if (event.status !== 'confirmed') errors.push(`${label}: 回答優先解決${event.id}はGM確認済み状態でなければなりません。`);
    if (event.audience?.type !== 'gm' || (event.audience?.targetIds ?? []).length) errors.push(`${label}: 回答優先解決${event.id}はGM限定情報でなければなりません。`);
    if (event.actorId !== null) errors.push(`${label}: 回答優先解決${event.id}に参加者を実行者として設定できません。`);
    if (event.payload?.resolution !== 'skipped') errors.push(`${label}: 回答優先解決${event.id}の解決種別が不正です。`);
    if (typeof event.payload?.reason !== 'string' || !event.payload.reason.trim()) errors.push(`${label}: 回答優先解決${event.id}にGM理由がありません。`);
    if (event.payload?.source !== undefined && event.payload.source !== 'ai-fallback') errors.push(`${label}: 回答優先解決${event.id}の自動代替元が不正です。`);
    checkId(targetPlayerId, '回答優先解決対象');
    checkEventIds([questionEventId], '回答優先解決元質問');
    if (!sourceQuestion || sourceQuestion.type !== 'public-speech' || sourceQuestion.payload?.speechKind !== 'normal') {
      errors.push(`${label}: 回答優先解決${event.id}の質問参照が過去の通常発言ではありません。`);
    } else if (getLogicalEventSequence(events, questionEventId) >= Number(event.sequence ?? 0)) {
      errors.push(`${label}: 回答優先解決${event.id}の質問参照が過去の発言ではありません。`);
    } else if (questionTargets.length !== 1 || questionTargets[0] !== targetPlayerId) {
      errors.push(`${label}: 回答優先解決${event.id}の対象者が質問先と一致しません。`);
    }
    if (JSON.stringify(event.targetIds ?? []) !== JSON.stringify([targetPlayerId])) errors.push(`${label}: 回答優先解決${event.id}の対象参照が質問先と一致しません。`);

}

function validatePublicSpeechEvent(event, context) {
  const { raw, label, errors, events, checkId, checkIds, checkEventIds } = context;
    const speechKind = event.payload?.speechKind;
    if (!['normal', 'priority-answer', 'testament'].includes(speechKind)) errors.push(`${label}: 公開発言${event.id}の発言種別が不正です。`);
    if (speechKind === 'normal' && event.payload?.sourceQuestionEventId !== null) errors.push(`${label}: 通常発言${event.id}に回答元質問が設定されています。`);
    if (speechKind === 'priority-answer' && typeof event.payload?.sourceQuestionEventId !== 'string') errors.push(`${label}: 優先回答${event.id}に回答元質問がありません。`);
    if (speechKind === 'testament' && event.payload?.sourceQuestionEventId !== null) errors.push(`${label}: 遺言${event.id}に回答元質問が設定されています。`);
    if (!DISCUSSION_ROUND_KINDS.has(event.payload?.roundKind)) errors.push(`${label}: 公開発言${event.id}の巡種別が不正です。`);
    const opportunity = event.payload?.opportunityContext;
    if (!opportunity || typeof opportunity !== 'object' || Array.isArray(opportunity)) {
      errors.push(`${label}: 公開発言${event.id}に発言機会情報がありません。`);
    } else {
      if (!['ordered', 'designated', 'free'].includes(opportunity.mode)) errors.push(`${label}: 公開発言${event.id}の発言機会モードが不正です。`);
      if (!Number.isInteger(Number(opportunity.priorSpeechCountToday)) || Number(opportunity.priorSpeechCountToday) < 0) errors.push(`${label}: 公開発言${event.id}の以前の発言回数が不正です。`);
      if (!Number.isInteger(Number(opportunity.priorDeferralCountToday)) || Number(opportunity.priorDeferralCountToday) < 0) errors.push(`${label}: 公開発言${event.id}の後回し回数が不正です。`);
      if (typeof opportunity.hadPriorRecordedOpportunity !== 'boolean') errors.push(`${label}: 公開発言${event.id}の以前の発言機会判定が不正です。`);
      const remainingSnapshot = opportunity.remainingByPlayerAtSpeechStart;
      if (!remainingSnapshot || typeof remainingSnapshot !== 'object' || Array.isArray(remainingSnapshot)) {
        errors.push(`${label}: 公開発言${event.id}に発言開始時点の残り回数スナップショットがありません。`);
      } else {
        Object.entries(remainingSnapshot).forEach(([playerId, count]) => {
          checkId(playerId, '発言開始時点の残り回数対象');
          if (count !== null && (!Number.isInteger(Number(count)) || Number(count) < 0)) errors.push(`${label}: 公開発言${event.id}の残り回数スナップショットが不正です。`);
        });
      }
    }
    const structured = event.payload?.structured;
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
      errors.push(`${label}: 公開発言${event.id}に構造化データがありません。`);
    } else {
      validateExactObjectShape(
        structured,
        { coOperation: { action: '', roleId: '' }, interaction: { questionTargetIds: [], answersEventIds: [] }, abilityClaims: [] },
        `${label}: 公開発言${event.id}の公開構造`,
        errors,
      );
      if (!['none', 'declare', 'change', 'withdraw'].includes(structured.coOperation?.action)) errors.push(`${label}: 公開発言${event.id}のCO操作が不正です。`);
      if (typeof structured.coOperation?.roleId !== 'string') errors.push(`${label}: 公開発言${event.id}のCO役職が文字列ではありません。`);
      if (!structured.interaction || typeof structured.interaction !== 'object' || Array.isArray(structured.interaction)) {
        errors.push(`${label}: 公開発言${event.id}の質問・回答関連が不正です。`);
      } else {
        const interactionKeys = Object.keys(structured.interaction).sort();
        if (interactionKeys.join(',') !== 'answersEventIds,questionTargetIds') errors.push(`${label}: 公開発言${event.id}の質問・回答関連キーが不正です。`);
        checkIds(structured.interaction.questionTargetIds, '公開発言の明示質問先');
        checkEventIds(structured.interaction.answersEventIds, '公開発言の明示回答元');
        if (!Array.isArray(structured.interaction.questionTargetIds) || !Array.isArray(structured.interaction.answersEventIds)) {
          errors.push(`${label}: 公開発言${event.id}の質問・回答関連は配列で指定してください。`);
        } else {
          if (new Set(structured.interaction.questionTargetIds).size !== structured.interaction.questionTargetIds.length) errors.push(`${label}: 公開発言${event.id}の明示質問先が重複しています。`);
          if (structured.interaction.questionTargetIds.includes(event.actorId)) errors.push(`${label}: 公開発言${event.id}の明示質問先に本人が含まれています。`);
          if (new Set(structured.interaction.answersEventIds).size !== structured.interaction.answersEventIds.length) errors.push(`${label}: 公開発言${event.id}の明示回答元が重複しています。`);
          structured.interaction.answersEventIds.forEach((answerEventId) => {
            const answerSource = resolveCorrectionHeadAtSequence(events, answerEventId, Number(event.sequence ?? 0) - 1);
            if (!answerSource || answerSource.type !== 'public-speech') {
              errors.push(`${label}: 公開発言${event.id}の明示回答元が公開済み発言またはその訂正版ではありません: ${answerEventId}`);
              return;
            }
            const logicalSequence = getLogicalEventSequence(events, answerEventId);
            if (logicalSequence >= Number(event.sequence ?? 0)) errors.push(`${label}: 公開発言${event.id}の明示回答元が過去の発言ではありません: ${answerEventId}`);
            if (answerSource.actorId === event.actorId) errors.push(`${label}: 公開発言${event.id}が本人自身の発言へ回答しています。`);
            if (!(answerSource.payload?.structured?.interaction?.questionTargetIds ?? []).includes(event.actorId)) {
              errors.push(`${label}: 公開発言${event.id}の明示回答元は本人への質問ではありません: ${answerEventId}`);
            }
          });
        }
      }
      if (speechKind === 'testament') {
        if ((structured.interaction?.questionTargetIds ?? []).length || (structured.interaction?.answersEventIds ?? []).length) errors.push(`${label}: 遺言${event.id}では質問・回答を登録できません。`);
      }
      if (speechKind === 'priority-answer') {
        const sourceQuestionId = event.payload?.sourceQuestionEventId;
        const sourceQuestion = resolveCorrectionHeadAtSequence(events, sourceQuestionId, Number(event.sequence ?? 0) - 1);
        const questionTargets = sourceQuestion?.payload?.structured?.interaction?.questionTargetIds ?? [];
        if (!sourceQuestion || sourceQuestion.type !== 'public-speech' || sourceQuestion.payload?.speechKind !== 'normal') {
          errors.push(`${label}: 優先回答${event.id}の回答元が公開済み通常発言またはその訂正版ではありません。`);
        } else if (getLogicalEventSequence(events, sourceQuestionId) >= Number(event.sequence ?? 0)) {
          errors.push(`${label}: 優先回答${event.id}の回答元が過去の質問ではありません。`);
        } else if (questionTargets.length !== 1 || questionTargets[0] !== event.actorId) {
          errors.push(`${label}: 優先回答${event.id}の回答元が本人だけを指定した質問ではありません。`);
        }
        if (event.payload?.pass !== false) errors.push(`${label}: 優先回答${event.id}をパスとして登録できません。`);
        if ((structured.interaction?.questionTargetIds ?? []).length) errors.push(`${label}: 優先回答${event.id}から新しい質問を登録できません。`);
        if (JSON.stringify(structured.interaction?.answersEventIds ?? []) !== JSON.stringify([sourceQuestionId])) errors.push(`${label}: 優先回答${event.id}の回答参照が回答元質問と一致しません。`);
      }
      if (!Array.isArray(structured.abilityClaims)) {
        errors.push(`${label}: 公開発言${event.id}の能力履歴が配列ではありません。`);
      } else {
        structured.abilityClaims.forEach((claim, index) => {
          checkId(claim?.targetId, `公開発言の能力履歴${index + 1}対象`);
          checkEventIds(claim?.evidenceEventIds, `公開発言の能力履歴${index + 1}根拠イベント`);
          if (claim?.action !== 'publish') errors.push(`${label}: 公開発言${event.id}の能力履歴${index + 1}actionが不正です。`);
          if (!PUBLIC_ABILITY_ROLE_ID_SET.has(claim?.claimedRoleId)) errors.push(`${label}: 公開発言${event.id}の能力履歴${index + 1}役職が不正です。`);
          if (!PUBLIC_ABILITY_RESULTS.includes(claim?.result)) errors.push(`${label}: 公開発言${event.id}の能力履歴${index + 1}resultが不正です。`);
          if (!ABILITY_SELECTION_BASE_SET.has(claim?.selectionBasis)) errors.push(`${label}: 公開発言${event.id}の能力履歴${index + 1}selectionBasisが不正です。`);
          if (typeof (claim?.selectionReasonAtTime ?? '') !== 'string') errors.push(`${label}: 公開発言${event.id}の能力履歴${index + 1}selectionReasonAtTimeが文字列ではありません。`);
        });
      }
    }
    const sourceTurns = (raw.aiTurns ?? []).filter((turn) => (turn.committedEntityIds ?? []).includes(event.id));
    if (sourceTurns.length > 1) errors.push(`${label}: 公開発言${event.id}を複数のAIターンが参照しています。`);
    const sourceTurn = sourceTurns[0] ?? null;
    if (sourceTurn) {
      const fallbackSpeech = event.payload?.speechKind === 'normal' && event.payload?.pass === true;
      const expectedTaskTypes = event.payload?.speechKind === 'priority-answer'
        ? ['priority-answer']
        : event.payload?.speechKind === 'testament'
          ? ['testament']
          : fallbackSpeech
            ? ['speech', 'speech-fallback', 'speech-designated', 'speech-free']
            : ['speech', 'speech-designated', 'speech-free'];
      if (!expectedTaskTypes.includes(sourceTurn.taskType) || sourceTurn.playerId !== event.actorId) errors.push(`${label}: 公開発言${event.id}のAIターン参照が話者またはタスクと一致しません。`);
      else if (!fallbackSpeech && !validateAiPublicSpeechUnmodified(sourceTurn.parsedPublicSpeech, event.payload?.text)) errors.push(`${label}: 製造規約違反: 公開発言${event.id}がAI回答のpublicSpeech本文から変更されています。`);
      else if (JSON.stringify(sourceTurn.resolvedSpeechInteraction) !== JSON.stringify(event.payload?.structured?.interaction)) errors.push(`${label}: 公開発言${event.id}の質問・回答関連がAI明示構造と一致しません。`);
      else if (JSON.stringify(sourceTurn.parsedCoOperation ?? { action: 'none', roleId: 'none' }) !== JSON.stringify(event.payload?.structured?.coOperation)) errors.push(`${label}: 公開発言${event.id}のCO操作がAI明示構造と一致しません。`);
      else if (JSON.stringify(sourceTurn.resolvedAbilityClaims ?? []) !== JSON.stringify(event.payload?.structured?.abilityClaims ?? [])) errors.push(`${label}: 公開発言${event.id}の能力結果がAI明示構造と一致しません。`);
    }

}

function validateGraveyardConversationEvent(event, context) {
  const { raw, label, errors, checkId } = context;
  const session = (raw.graveyardConversations ?? []).find((item) => item.id === event.payload?.conversationId) ?? null;
  checkId(event.actorId, '墓場会話話者');
  if (!session) {
    errors.push(`${label}: 墓場会話イベント${event.id}のセッションがありません。`);
    return;
  }
  if (!(session.participantIds ?? []).includes(event.actorId)) errors.push(`${label}: 墓場会話イベント${event.id}の話者が参加者ではありません。`);
  const expectedAudience = [...(session.participantIds ?? [])].sort();
  const actualAudience = [...(event.audience?.targetIds ?? [])].sort();
  if (event.audience?.type !== 'participants' || JSON.stringify(actualAudience) !== JSON.stringify(expectedAudience)) errors.push(`${label}: 墓場会話イベント${event.id}の公開範囲が参加者と一致しません。`);
  const message = (session.messages ?? []).find((item) => item.id === event.payload?.messageId) ?? null;
  if (!message || message.speakerId !== event.actorId || message.content !== event.payload?.content) errors.push(`${label}: 墓場会話イベント${event.id}が保存メッセージと一致しません。`);
  const sourceTurns = (raw.aiTurns ?? []).filter((turn) => (turn.committedEntityIds ?? []).includes(event.id));
  const sourceTurn = sourceTurns[0] ?? null;
  if (sourceTurns.length > 1) errors.push(`${label}: 墓場会話イベント${event.id}を複数のAIターンが参照しています。`);
  if (sourceTurn && (sourceTurn.taskType !== 'graveyard-conversation' || sourceTurn.playerId !== event.actorId || sourceTurn.parsedGraveyardConversationMessage !== event.payload?.content)) errors.push(`${label}: 墓場会話イベント${event.id}のAIターン参照が話者・本文・タスクと一致しません。`);
}

function validateVoteCastEvent(event, context) {
  const { label, errors } = context;
  if (Object.hasOwn(event.payload ?? {}, 'structured')) {
    errors.push(`${label}: 投票イベント${event.id}にAI私有判断が格納されています。`);
  }
}

function validateResultImpressionEvent(event, context) {
  const { raw, label, errors } = context;
    const text = String(event.payload?.text ?? '').trim();
    if (!event.actorId) errors.push(`${label}: 勝敗後感想${event.id}に話者がありません。`);
    if (event.phase !== 'result') errors.push(`${label}: 勝敗後感想${event.id}の記録フェーズがresultではありません。`);
    if (event.status !== 'published' || event.audience?.type !== 'public') errors.push(`${label}: 勝敗後感想${event.id}が公開済み公開イベントではありません。`);
    if (!text) errors.push(`${label}: 勝敗後感想${event.id}の本文が空です。`);
    if (text.length > MAX_RESULT_IMPRESSION_LENGTH) errors.push(`${label}: 勝敗後感想${event.id}が${MAX_RESULT_IMPRESSION_LENGTH}文字を超えています。`);
    if (Object.hasOwn(event.payload ?? {}, 'skipped') && event.payload.skipped !== true) {
      errors.push(`${label}: 勝敗後感想${event.id}のskippedはtrue以外を設定できません。`);
    }
    if (event.payload?.skipped === true) {
      if (typeof event.payload?.reason !== 'string' || !event.payload.reason.trim()) errors.push(`${label}: 勝敗後感想${event.id}の自動スキップ理由がありません。`);
    } else if (Object.hasOwn(event.payload ?? {}, 'reason')) {
      errors.push(`${label}: 通常の勝敗後感想${event.id}にスキップ理由を設定できません。`);
    }
    const sourceTurns = (raw.aiTurns ?? []).filter((turn) => (turn.committedEntityIds ?? []).includes(event.id));
    if (sourceTurns.length > 1) errors.push(`${label}: 勝敗後感想${event.id}を複数のAIターンが参照しています。`);
    const sourceTurn = sourceTurns[0] ?? null;
    if (sourceTurn) {
      const skipped = event.payload?.skipped === true;
      const expectedTaskType = skipped ? 'result-impression-fallback' : 'result-impression';
      if (sourceTurn.taskType !== expectedTaskType || sourceTurn.playerId !== event.actorId) errors.push(`${label}: 勝敗後感想${event.id}のAIターン参照が話者またはタスクと一致しません。`);
      else if (!skipped && !validateAiPublicSpeechUnmodified(sourceTurn.parsedPublicSpeech, event.payload?.text)) errors.push(`${label}: 製造規約違反: 勝敗後感想${event.id}がAI回答のpublicSpeech本文から変更されています。`);
    }

}

const EVENT_TYPE_VALIDATORS = Object.freeze({
  'wolf-conversation': validateWolfConversationEvent,
  'graveyard-conversation': validateGraveyardConversationEvent,
  'private-result': validatePrivateResultEvent,
  'priority-answer-resolution': validatePriorityAnswerResolutionEvent,
  'public-speech': validatePublicSpeechEvent,
  'vote-cast': validateVoteCastEvent,
  'result-impression': validateResultImpressionEvent,
});

export function validateEventType(event, context) {
  EVENT_TYPE_VALIDATORS[event?.type]?.(event, context);
}
