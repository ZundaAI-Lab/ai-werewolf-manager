/**
 * 責務: 全イベント共通のID・公開状態・訂正系譜と、プレイヤー知識・議論・投票セッションの参照整合を検査し、イベント種別固有規則をeventTypeValidatorsへ委譲する。
 * 変更ルール: 公開本文の意味を推定せず、保存済み構造化情報、公開範囲、訂正系譜、参照順序だけを検査する。
 */

import {
  canKnowMadmanPartners,
  canKnowWolfPartners,
  countsAsWolf,
  getPlayerTeam,
  isMadmanClass,
} from '../../domain/roles/roleAttributes.js';
import {
  canSpeakDuringDay,
  canVoteDuringDay,
} from '../../domain/game/playerStatus.js';
import {
  VOTE_RESULT_RESOLUTIONS,
  getTopTiedCandidateIds,
} from '../../domain/vote/voteResolution.js';

import { validateEventType } from './eventTypeValidators.js';
import {
  DISCUSSION_ROUND_KINDS,
  validateStoredEntityId,
  validateStoredEntityIds,
} from './validatorShared.js';

export function validateEventState(context) {
  const { raw, label, errors, playerIds, playerIdSet, checkId, checkIds } = context;
  const events = Array.isArray(raw.events) ? raw.events : [];
  validateStoredEntityIds(events, `${label}: events`, errors);
  validateStoredEntityIds(raw.aiTurns, `${label}: aiTurns`, errors);
  validateStoredEntityIds(raw.mediumResults, `${label}: mediumResults`, errors);
  validateStoredEntityIds(raw.claims, `${label}: claims`, errors);
  validateStoredEntityIds(raw.publicAbilityClaims, `${label}: publicAbilityClaims`, errors);
  if (raw.voteSession) validateStoredEntityId(raw.voteSession.id, `${label}: voteSession.id`, errors);
  (raw.wolfConversations ?? []).forEach((session, sessionIndex) => {
    validateStoredEntityId(session?.id, `${label}: wolfConversations[${sessionIndex}].id`, errors);
    validateStoredEntityIds(session?.messages, `${label}: wolfConversations[${sessionIndex}].messages`, errors);
  });
  (raw.masonConversations ?? []).forEach((session, sessionIndex) => {
    validateStoredEntityId(session?.id, `${label}: masonConversations[${sessionIndex}].id`, errors);
    validateStoredEntityIds(session?.messages, `${label}: masonConversations[${sessionIndex}].messages`, errors);
  });
  (raw.graveyardConversations ?? []).forEach((session, sessionIndex) => {
    validateStoredEntityId(session?.id, `${label}: graveyardConversations[${sessionIndex}].id`, errors);
    validateStoredEntityIds(session?.messages, `${label}: graveyardConversations[${sessionIndex}].messages`, errors);
  });
  validateStoredEntityIds(raw.night?.slots, `${label}: night.slots`, errors);
  const eventIds = events.map((event) => event.id);
  const eventIdSet = new Set(eventIds);
  const checkEventIds = (ids, referenceLabel) => {
    if (!Array.isArray(ids)) return;
    ids.forEach((id) => {
      if (id && !eventIdSet.has(id)) errors.push(`${label}: ${referenceLabel}が存在しないイベントを参照しています: ${id}`);
    });
  };
  if (eventIdSet.size !== eventIds.length) errors.push(`${label}: イベントIDが重複しています。`);
  const sequences = events.map((event) => Number(event.sequence));
  if (new Set(sequences).size !== sequences.length) errors.push(`${label}: イベントsequenceが重複しています。`);
  const maxSequence = sequences.length ? Math.max(...sequences) : 0;
  if (Number(raw.game.eventSequence ?? 0) < maxSequence) errors.push(`${label}: game.eventSequenceが実イベントより小さいです。`);
  events.forEach((event, index) => {
    if (!event.id) errors.push(`${label}: events[${index}]にIDがありません。`);
    checkId(event.actorId, 'イベントactorId');
    if (event.type === 'correction') checkEventIds(event.targetIds, '訂正対象イベント');
    else checkIds(event.targetIds, 'イベントtargetIds');
    checkIds(event.audience?.targetIds, 'イベント公開対象');
    if (!['draft', 'confirmed', 'published', 'voided'].includes(event.status)) errors.push(`${label}: イベント${event.id ?? index}の状態が不正です。`);
    if (event.status === 'published' && event.audience?.type === 'public' && !event.publishedAt) errors.push(`${label}: 公開イベント${event.id}にpublishedAtがありません。`);
    if (event.voidedByEventId) {
      const correction = events.find((item) => item.id === event.voidedByEventId);
      if (!correction) errors.push(`${label}: イベント${event.id}の訂正参照先が存在しません。`);
      else if (correction.type !== 'correction') errors.push(`${label}: イベント${event.id}のvoidedByEventIdが訂正イベントではありません。`);
    }
    validateEventType(event, { raw, label, errors, index, events, checkId, checkIds, checkEventIds });
  });

  const publishedGameResult = events
    .filter((event) => event.type === 'game-result' && event.status === 'published' && event.audience?.type === 'public')
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0))
    .at(-1) ?? null;
  const resultImpressions = events
    .filter((event) => event.type === 'result-impression' && event.status === 'published')
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0));
  if (resultImpressions.length && !publishedGameResult) errors.push(`${label}: ゲーム結果公開前に勝敗後感想があります。`);
  if (publishedGameResult && resultImpressions.some((event) => Number(event.sequence ?? 0) <= Number(publishedGameResult.sequence ?? 0))) {
    errors.push(`${label}: 勝敗後感想がゲーム結果公開より前に記録されています。`);
  }
  const impressionActorIds = resultImpressions.map((event) => event.actorId);
  if (new Set(impressionActorIds).size !== impressionActorIds.length) errors.push(`${label}: 同じプレイヤーの勝敗後感想が重複しています。`);
  const expectedImpressionActorIds = raw.players.slice(0, impressionActorIds.length).map((player) => player.id);
  if (JSON.stringify(impressionActorIds) !== JSON.stringify(expectedImpressionActorIds)) {
    errors.push(`${label}: 勝敗後感想の順序がプレイヤー順と一致しません。`);
  }

  Object.entries(raw.playerKnowledge ?? {}).forEach(([ownerId, knowledge]) => {
    checkId(ownerId, 'playerKnowledgeの所有者');
    checkIds(knowledge?.knownWolfIds, '既知の人狼');
    checkIds(knowledge?.knownMadmanIds, '既知の狂人');
    checkIds(knowledge?.knownMasonIds, '既知の共有者');
  });
  if (raw.game.phase !== 'setup') {
    const allWolfIds = raw.players.filter((player) => countsAsWolf(raw, player)).map((player) => player.id).sort();
    const allMadmanIds = raw.players.filter((player) => isMadmanClass(raw, player)).map((player) => player.id).sort();
    const allMasonIds = raw.players.filter((player) => player.roleId === 'mason').map((player) => player.id).sort();
    raw.players.forEach((player) => {
      const knowledge = raw.playerKnowledge?.[player.id] ?? {};
      const expectedWolfIds = canKnowWolfPartners(raw, player) ? allWolfIds : [];
      const expectedMadmanIds = canKnowMadmanPartners(raw, player) ? allMadmanIds : [];
      const expectedMasonIds = player.roleId === 'mason' ? allMasonIds : [];
      if (JSON.stringify([...(knowledge.knownWolfIds ?? [])].sort()) !== JSON.stringify(expectedWolfIds)) errors.push(`${label}: ${player.name}の既知人狼情報が役職属性と通信設定に一致しません。`);
      if (JSON.stringify([...(knowledge.knownMadmanIds ?? [])].sort()) !== JSON.stringify(expectedMadmanIds)) errors.push(`${label}: ${player.name}の既知狂人情報が役職属性と通信設定に一致しません。`);
      if (JSON.stringify([...(knowledge.knownMasonIds ?? [])].sort()) !== JSON.stringify(expectedMasonIds)) errors.push(`${label}: ${player.name}の既知共有者情報が開始時配役と一致しません。`);
      const expectedOwnerId = player.roleId === 'zashikiWarashi' ? player.roleState?.ownerId ?? null : null;
      const expectedOwnerRoleId = player.roleId === 'zashikiWarashi' ? player.roleState?.ownerRoleId ?? null : null;
      const expectedResolvedTeam = player.roleId === 'zashikiWarashi' ? player.roleState?.resolvedTeam ?? null : getPlayerTeam(raw, player);
      if ((knowledge.knownOwnerId ?? null) !== expectedOwnerId || (knowledge.knownOwnerRoleId ?? null) !== expectedOwnerRoleId || (knowledge.resolvedTeam ?? null) !== expectedResolvedTeam) errors.push(`${label}: ${player.name}の家主・確定陣営情報が役職状態と一致しません。`);
    });
  }

  if (raw.briefing) {
    checkIds(raw.briefing.eligiblePlayerIds, '役職通知対象');
    Object.keys(raw.briefing.noticeStatusByPlayerId ?? {}).forEach((id) => checkId(id, '役職通知状態の所有者'));
    Object.keys(raw.briefing.aiContextReadyByPlayerId ?? {}).forEach((id) => checkId(id, 'AI準備状態の所有者'));
  }

  if (raw.discussion) {
    checkIds(raw.discussion.queue, '昼議論キュー');
    checkIds(raw.discussion.spokenInCurrentRound, '発言済みプレイヤー');
    checkIds(raw.discussion.deferredPlayerIds, '後回しプレイヤー');
    if (!Array.isArray(raw.discussion.roundEligiblePlayerIds)) errors.push(`${label}: 巡の発言対象者が配列ではありません。`);
    else checkIds(raw.discussion.roundEligiblePlayerIds, '巡の発言対象者');
    checkId(raw.discussion.designatedPlayerId, '指名発言者');
    const discussionMemberIds = [
      ...(raw.discussion.queue ?? []),
      ...(raw.discussion.spokenInCurrentRound ?? []),
      ...(raw.discussion.deferredPlayerIds ?? []),
      ...(raw.discussion.roundEligiblePlayerIds ?? []),
      ...(raw.discussion.designatedPlayerId ? [raw.discussion.designatedPlayerId] : []),
    ];
    if (raw.game.phase === 'discussion') {
      discussionMemberIds.forEach((id) => {
        if (!canSpeakDuringDay(raw, id)) errors.push(`${label}: 凍結中または死亡中の人物が昼議論対象に含まれています: ${id}`);
      });
    }
    if (!DISCUSSION_ROUND_KINDS.has(raw.discussion.roundKind)) errors.push(`${label}: 昼議論の巡種別が不正です。`);
    if (!Number.isInteger(Number(raw.discussion.roundStartedAtSequence)) || Number(raw.discussion.roundStartedAtSequence) < 0) errors.push(`${label}: 昼議論の巡開始sequenceが不正です。`);
    Object.keys(raw.discussion.remainingByPlayer ?? {}).forEach((id) => checkId(id, '発言回数の所有者'));
    const modeControl = raw.discussion.modeControl;
    if (raw.discussion.mode === 'ordered') {
      if (modeControl !== null) errors.push(`${label}: 順番制の昼議論にモード固有制御が混入しています。`);
    } else if (raw.discussion.mode === 'designated') {
      if (!modeControl || modeControl.type !== 'designated') errors.push(`${label}: 指名制のモード固有制御が不正です。`);
      else if (modeControl.preferredNextSpeakerId !== null && modeControl.preferredNextSpeakerId !== undefined) checkId(modeControl.preferredNextSpeakerId, '指名制の次発言者希望');
    } else if (raw.discussion.mode === 'free') {
      const allowedPreferences = new Set(['EARLY', 'NORMAL', 'WAIT_CO', 'DONE']);
      const allowedOpening = new Set(['EARLY', 'NORMAL', 'WAIT_CO']);
      if (!modeControl || modeControl.type !== 'free') errors.push(`${label}: 発言希望制のモード固有制御が不正です。`);
      else {
        if (!['opening-preference', 'discussion'].includes(modeControl.stage)) errors.push(`${label}: 発言希望制の進行段階が不正です。`);
        const opening = modeControl.openingPreferenceByPlayerId;
        const next = modeControl.nextPreferenceByPlayerId;
        if (!opening || typeof opening !== 'object' || Array.isArray(opening)) errors.push(`${label}: 発言希望制の開始時希望辞書が不正です。`);
        else Object.entries(opening).forEach(([id, preference]) => {
          checkId(id, '発言希望制の開始時希望所有者');
          if (!allowedOpening.has(preference)) errors.push(`${label}: 発言希望制の開始時希望が不正です: ${id}`);
        });
        if (!next || typeof next !== 'object' || Array.isArray(next)) errors.push(`${label}: 発言希望制の次巡希望辞書が不正です。`);
        else Object.entries(next).forEach(([id, preference]) => {
          checkId(id, '発言希望制の次巡希望所有者');
          if (!allowedPreferences.has(preference)) errors.push(`${label}: 発言希望制の次巡希望が不正です: ${id}`);
        });
        checkIds(modeControl.donePlayerIds, '発言希望制の発言終了者');
      }
    }
    if (!raw.discussion.deferredCountByPlayer || typeof raw.discussion.deferredCountByPlayer !== 'object' || Array.isArray(raw.discussion.deferredCountByPlayer)) {
      errors.push(`${label}: 昼議論の後回し回数辞書がありません。`);
    } else {
      Object.entries(raw.discussion.deferredCountByPlayer).forEach(([id, count]) => {
        checkId(id, '後回し回数の所有者');
        if (!Number.isInteger(Number(count)) || Number(count) < 0) errors.push(`${label}: 後回し回数が不正です: ${id}`);
      });
    }
    const reconsideration = raw.discussion.reconsideration;
    if (!reconsideration || typeof reconsideration !== 'object' || Array.isArray(reconsideration)) errors.push(`${label}: 昼議論の再検討状態がありません。`);
    else {
      checkIds(reconsideration.affectedPlayerIds, '再検討対象者');
      (reconsideration.sourceEventIds ?? []).forEach((eventId) => { if (eventId && !eventIdSet.has(eventId)) errors.push(`${label}: 再検討元イベントが存在しません: ${eventId}`); });
      if (!Array.isArray(reconsideration.reasons) || !Array.isArray(reconsideration.items)) errors.push(`${label}: 再検討理由または項目が配列ではありません。`);
      (reconsideration.items ?? []).forEach((item, itemIndex) => {
        validateStoredEntityId(item?.id, `${label}: 再検討項目[${itemIndex}].id`, errors);
        if (item.sourceEventId && !eventIdSet.has(item.sourceEventId)) errors.push(`${label}: 再検討項目の元イベントが存在しません。`);
        checkIds(item.targetPlayerIds, '再検討項目対象者');
      });
    }
  }

  if (raw.voteSession) {
    const session = raw.voteSession;
    if (session.type === 'runoff') {
      if (!session.parentSessionId) errors.push(`${label}: 決選投票にparentSessionIdがありません。`);
      if (!session.triggerVoteResultEventId) errors.push(`${label}: 決選投票にtriggerVoteResultEventIdがありません。`);
      const trigger = events.find((event) => event.id === session.triggerVoteResultEventId);
      if (!trigger) errors.push(`${label}: 決選投票の元投票結果イベントが存在しません。`);
      else {
        if (trigger.type !== 'vote-finalized') errors.push(`${label}: 決選投票のtriggerVoteResultEventIdが投票結果イベントではありません。`);
        if (session.parentSessionId && trigger.payload?.sessionId !== session.parentSessionId) errors.push(`${label}: 決選投票の親セッションと投票結果イベントが一致しません。`);
        const tied = [...(trigger.payload?.result?.tiedCandidateIds ?? [])].sort();
        if (tied.length && JSON.stringify(tied) !== JSON.stringify([...(session.candidateIds ?? [])].sort())) errors.push(`${label}: 決選投票候補が親投票の同票候補と一致しません。`);
      }
    } else if (session.parentSessionId || session.triggerVoteResultEventId) {
      errors.push(`${label}: 通常投票に決選投票の親参照が残っています。`);
    }
    checkIds(session.eligibleVoterIds, '投票者');
    checkIds(session.candidateIds, '投票候補');
    if (['vote', 'runoff'].includes(raw.game.phase)) {
      session.eligibleVoterIds.forEach((id) => {
        if (!canVoteDuringDay(raw, id)) errors.push(`${label}: 凍結中または死亡中の人物が投票者に含まれています: ${id}`);
      });
      const expectedEligibleVoterIds = raw.players.filter((player) => canVoteDuringDay(raw, player.id)).map((player) => player.id);
      if (JSON.stringify(session.eligibleVoterIds) !== JSON.stringify(expectedEligibleVoterIds)) errors.push(`${label}: 投票者一覧が当日の参加資格と一致しません。`);
    }
    Object.entries(session.votes ?? {}).forEach(([voterId, targetId]) => {
      checkId(voterId, '投票者');
      checkId(targetId, '投票先', { allowAbstain: true });
      if (!session.eligibleVoterIds.includes(voterId)) errors.push(`${label}: 投票資格のない人物の票があります。`);
      if (targetId !== 'abstain' && !session.candidateIds.includes(targetId)) errors.push(`${label}: 投票候補外への票があります。`);
    });
    Object.values(session.voteEventIdByVoterId ?? {}).forEach((eventId) => { if (eventId && !eventIdSet.has(eventId)) errors.push(`${label}: 投票イベント参照先がありません。`); });
    if (session.status === 'ready' && Object.keys(session.votes ?? {}).length !== session.eligibleVoterIds.length) errors.push(`${label}: readyの投票に全員分の票がありません。`);
    if (['finalized', 'published'].includes(session.status)) {
      const counts = new Map();
      Object.values(session.votes ?? {}).forEach((targetId) => { if (targetId !== 'abstain') counts.set(targetId, (counts.get(targetId) ?? 0) + 1); });
      const expectedTally = [...counts.entries()].map(([targetId, count]) => ({ targetId, count })).sort((a, b) => b.count - a.count || a.targetId.localeCompare(b.targetId));
      const actualTally = [...(session.tally ?? [])].sort((a, b) => b.count - a.count || a.targetId.localeCompare(b.targetId));
      if (JSON.stringify(expectedTally) !== JSON.stringify(actualTally)) errors.push(`${label}: 投票集計が票内容と一致しません。`);
      const tied = getTopTiedCandidateIds(expectedTally);
      const result = session.result;
      if (!result || !['execution', 'runoff', 'no-execution'].includes(result.type)) errors.push(`${label}: 投票結果種別が不正です。`);
      if (!VOTE_RESULT_RESOLUTIONS.includes(result?.resolution)) errors.push(`${label}: 投票結果の解決方法が不正です。`);
      if (result?.type === 'execution') {
        if (result.resolution === 'single-max') {
          if (tied.length !== 1 || result.targetId !== tied[0] || (result.tiedCandidateIds ?? []).length) errors.push(`${label}: 単独最多の処刑対象が集計結果と一致しません。`);
        } else if (result.resolution === 'random-tie-break') {
          if (tied.length < 2 || session.round <= raw.game.rules.vote.runoffLimit || raw.game.rules.vote.tieResolution !== 'random-execution') errors.push(`${label}: ランダム吊りの実行条件が不正です。`);
          if (!tied.includes(result.targetId)) errors.push(`${label}: ランダム吊り対象が同票候補ではありません。`);
          if (JSON.stringify([...(result.tiedCandidateIds ?? [])].sort()) !== JSON.stringify([...tied].sort())) errors.push(`${label}: ランダム吊り候補が同票者と一致しません。`);
        } else {
          errors.push(`${label}: 処刑結果の解決方法が不正です。`);
        }
      }
      if (result?.type === 'runoff') {
        if (result.resolution !== 'runoff' || tied.length < 2 || session.round > raw.game.rules.vote.runoffLimit) errors.push(`${label}: 決選投票の実行条件が不正です。`);
        if (JSON.stringify([...(result.tiedCandidateIds ?? [])].sort()) !== JSON.stringify([...tied].sort())) errors.push(`${label}: 決選候補が同票者と一致しません。`);
      }
      if (result?.type === 'no-execution') {
        if (result.resolution === 'no-valid-votes') {
          if (tied.length) errors.push(`${label}: 有効票なしの判定が集計結果と一致しません。`);
        } else if (result.resolution === 'tie-no-execution') {
          if (tied.length < 2 || session.round <= raw.game.rules.vote.runoffLimit || raw.game.rules.vote.tieResolution !== 'no-execution') errors.push(`${label}: 吊りなしの実行条件が不正です。`);
          if (JSON.stringify([...(result.tiedCandidateIds ?? [])].sort()) !== JSON.stringify([...tied].sort())) errors.push(`${label}: 吊りなしの同票候補が集計結果と一致しません。`);
        } else {
          errors.push(`${label}: 処刑なし結果の解決方法が不正です。`);
        }
      }
    }
  }
  Object.assign(context, { events, eventIdSet, checkEventIds, resultImpressions });
}
