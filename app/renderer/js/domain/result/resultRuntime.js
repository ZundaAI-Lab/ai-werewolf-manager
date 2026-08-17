/**
 * 責務: 私有結果確認、勝敗検出・確認・公開、全員の勝敗後感想を実行する。
 * 変更ルール: 勝敗判定はstandardRules、感想完了判定はresultImpressionsを正本とし、公開前の情報を混入させない。各機密会話を公開する場合も許可された会話記録だけを射影し、別責務の内部情報を公開イベントへ含めない。
 */

import {
  MAX_RESULT_IMPRESSION_LENGTH,
  ROLE_DEFINITIONS,
} from '../../config/constants.js';
import { getPlayer } from '../game/standardRules.js';
import { createEvent } from '../events/eventStore.js';
import { nowIso } from '../../shared/utils.js';
import { assertAiPublicSpeechUnmodified } from '../policies/publicAbilityClaimNarrative.js';
import { formatInternalMemoryText } from '../memory/memoryLedger.js';
import {
  areResultImpressionsComplete,
  getPendingResultImpressionPlayerId,
} from './resultImpressions.js';
import {
  requestMandatoryRestorePoint,
  RESTORE_POINT_TYPES,
} from '../correction/restorePointPolicy.js';


import {
  result,
  commandGuard,
  setPhase,
  setHeartVoice,
  recordAiTurn,
} from '../game/gameRuntimeShared.js';

export function acknowledgePrivateResults(state, playerId) {
  const guard = commandGuard(state, { phases: ['night', 'discussion'] });
  if (guard) return guard;
  const player = getPlayer(state, playerId);
  if (!player || player.controller !== 'human') return result(false, '人間プレイヤーの個人結果通知ではありません。');
  const events = state.events.filter((event) => event.type === 'private-result'
    && event.status === 'confirmed'
    && event.audience?.type === 'player'
    && event.audience.targetIds?.includes(playerId)
    && !event.payload?.acknowledgedAt);
  if (!events.length) return result(false, '未確認の個人結果はありません。');
  const acknowledgedAt = nowIso();
  events.forEach((event) => { event.payload.acknowledgedAt = acknowledgedAt; });
  return result(true, `${player.name}の個人結果通知を確認済みにしました。`, { eventIds: events.map((event) => event.id) });
}

export function getRoleNameLocal(state, playerId) {
  const roleId = getPlayer(state, playerId)?.roleId;
  return ROLE_DEFINITIONS[roleId]?.name ?? roleId;
}

export function detectGameResult(state, winner) {
  state.game.winner = winner.winner;
  state.game.winnerReason = winner.reason;
  state.game.status = 'result-pending';
  state.result = {
    winner: winner.winner,
    reason: winner.reason,
    status: 'detected',
    revealAllRoles: true,
    revealWolfConversation: false,
    revealMasonConversation: false,
    revealGraveyardConversation: false,
    revealInternalMemos: false,
    publishedAt: null,
  };
  setPhase(state, 'result');
}

export function confirmGameResult(state, options = {}) {
  const guard = commandGuard(state, { phases: ['result'] });
  if (guard) return guard;
  if (!state.result || state.result.status !== 'detected') return result(false, '確認待ちのゲーム結果がありません。');
  Object.assign(state.result, {
    revealAllRoles: options.revealAllRoles ?? true,
    revealWolfConversation: options.revealWolfConversation ?? false,
    revealMasonConversation: options.revealMasonConversation ?? false,
    revealGraveyardConversation: options.revealGraveyardConversation ?? false,
    revealInternalMemos: options.revealInternalMemos ?? false,
    status: 'confirmed',
  });
  return result(true, 'ゲーム結果と公開範囲を確認しました。');
}

export function publishGameResult(state) {
  const guard = commandGuard(state, { phases: ['result'] });
  if (guard) return guard;
  if (!state.result || state.result.status !== 'confirmed') return result(false, '先にゲーム結果と公開範囲を確認してください。');
  requestMandatoryRestorePoint(state, RESTORE_POINT_TYPES.BEFORE_RESULT_PUBLISH);
  state.result.status = 'published';
  state.result.publishedAt = nowIso();
  const payload = {
    text: `${state.result.winner === 'village' ? '村人陣営' : state.result.winner === 'wolf' ? '人狼陣営' : state.result.winner === 'fox' ? '妖狐陣営' : '引き分け'}。${state.result.reason}`,
    winner: state.result.winner,
    reason: state.result.reason,
    roles: state.result.revealAllRoles ? state.players.map((player) => ({ playerId: player.id, roleId: player.roleId })) : [],
    wolfConversations: state.result.revealWolfConversation ? state.wolfConversations.map((session) => ({
      id: session.id,
      day: session.day,
      purpose: session.purpose,
      participantIds: [...session.participantIds],
      messages: session.messages.map((message) => ({ speakerId: message.speakerId, content: message.content, sequence: message.sequence })),
    })) : [],
    masonConversations: state.result.revealMasonConversation ? state.masonConversations.map((session) => ({
      id: session.id,
      day: session.day,
      participantIds: [...session.participantIds],
      messages: session.messages.map((message) => ({ speakerId: message.speakerId, content: message.content, sequence: message.sequence })),
    })) : [],
    graveyardConversations: state.result.revealGraveyardConversation ? state.graveyardConversations.map((session) => ({
      id: session.id,
      day: session.day,
      participantIds: [...session.participantIds],
      messages: session.messages.map((message) => ({ speakerId: message.speakerId, content: message.content, sequence: message.sequence })),
    })) : [],
    internalMemos: state.result.revealInternalMemos ? state.players.map((player) => ({ playerId: player.id, heartVoice: player.heartVoice, memo: formatInternalMemoryText(player) })) : [],
  };
  const event = createEvent(state, {
    type: 'game-result',
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload,
  });
  state.game.status = 'result-impressions';
  return result(true, 'ゲーム結果を公開しました。各キャラクターの感想へ進みます。', { eventId: event.id });
}

export function recordResultImpression(state, {
  playerId,
  content,
  heartVoice = '',
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'manual',
  publicSequenceAtGeneration = 0,
  warnings = [],
} = {}) {
  const guard = commandGuard(state, { phases: ['result'] });
  if (guard) return guard;
  if (state.result?.status !== 'published') return result(false, '先にゲーム結果を公開してください。');
  const player = getPlayer(state, playerId);
  if (!player) return result(false, '対象プレイヤーが存在しません。');
  const pendingPlayerId = getPendingResultImpressionPlayerId(state);
  if (!pendingPlayerId) return result(false, '全員の感想は登録済みです。');
  if (pendingPlayerId !== playerId) return result(false, '現在の感想対象プレイヤーではありません。');
  const text = String(content ?? '');
  if (!text.trim()) return result(false, '公開する感想を入力してください。');
  if (text.length > MAX_RESULT_IMPRESSION_LENGTH) {
    return result(false, `感想は${MAX_RESULT_IMPRESSION_LENGTH}文字以内で入力してください。`);
  }
  if (rawResponse) assertAiPublicSpeechUnmodified(content, text);

  let turn = null;
  if (rawResponse) {
    turn = recordAiTurn(state, {
      taskType: 'result-impression',
      playerId,
      promptText,
      promptFingerprint,
      promptMode,
      publicSequenceAtGeneration,
      rawResponse,
      generationRun,
      parsedPublicSpeech: text,
      parsedHeartVoice: heartVoice,
      warnings,
      committedEntityIds: [],
    });
  }
  setHeartVoice(state, playerId, heartVoice);
  const event = createEvent(state, {
    type: 'result-impression',
    actorId: playerId,
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload: { text },
  });
  if (turn) turn.committedEntityIds = [event.id];

  if (areResultImpressionsComplete(state)) {
    state.game.status = 'ended';
    setPhase(state, 'ended');
    return result(true, `${player.name}の感想を公開し、ゲームを終了しました。`, { eventId: event.id, aiTurnId: turn?.id ?? null });
  }
  return result(true, `${player.name}の感想を公開しました。`, { eventId: event.id, aiTurnId: turn?.id ?? null });
}

/**
 * 責務: 勝敗後感想の必須本文を取得できない場合に、AI発言を捏造せずシステム上のスキップ表示で感想順を進め、回収済みの心の声を本人限定状態へ保持する。
 * 変更ルール: 公開イベント本文はAI生成文として扱わず、AI監査ターンはresult-impression-fallbackとして区別する。
 */

export function skipResultImpression(state, {
  playerId,
  reason,
  heartVoice = '',
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  warnings = [],
} = {}) {
  const guard = commandGuard(state, { phases: ['result'] });
  if (guard) return guard;
  if (state.result?.status !== 'published') return result(false, '先にゲーム結果を公開してください。');
  const player = getPlayer(state, playerId);
  if (!player) return result(false, '対象プレイヤーが存在しません。');
  const pendingPlayerId = getPendingResultImpressionPlayerId(state);
  if (!pendingPlayerId) return result(false, '全員の感想は登録済みです。');
  if (pendingPlayerId !== playerId) return result(false, '現在の感想対象プレイヤーではありません。');
  const normalizedReason = String(reason ?? '').trim();
  if (!normalizedReason) return result(false, '感想をスキップする理由を入力してください。');
  const systemText = '感想生成をスキップしました。';
  setHeartVoice(state, playerId, heartVoice);
  const event = createEvent(state, {
    type: 'result-impression',
    actorId: playerId,
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload: { text: systemText, skipped: true, reason: normalizedReason },
  });
  const turn = recordAiTurn(state, {
    taskType: 'result-impression-fallback',
    playerId,
    promptText,
    promptFingerprint,
    promptMode,
    publicSequenceAtGeneration,
    rawResponse,
    generationRun,
    parsedPublicSpeech: '',
    parsedHeartVoice: heartVoice,
    warnings,
    committedEntityIds: [event.id],
  });
  if (areResultImpressionsComplete(state)) {
    state.game.status = 'ended';
    setPhase(state, 'ended');
    return result(true, `${player.name}の感想をスキップし、ゲームを終了しました。`, { eventId: event.id, aiTurnId: turn.id });
  }
  return result(true, `${player.name}の感想をスキップしました。`, { eventId: event.id, aiTurnId: turn.id });
}
