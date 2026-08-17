/**
 * 責務: 訂正モード、公開発言・確定イベント・役職割当の訂正と派生進行再構築を実行する。
 * 変更ルール: 訂正は原子的に行い、失敗時は完全復元する。履歴系譜と必須復元点を保持し、旧状態を併存させない。
 */

import {
  getAlivePlayers,
  getNightActionCandidates,
  getPlayer,
  isValidVoteTarget,
} from '../game/standardRules.js';
import { buildNightPlan } from '../night/nightPlanner.js';
import {
  addCorrectionEvent,
  createEvent,
  getEvent,
  voidEvent,
} from '../events/eventStore.js';
import { nowIso } from '../../shared/utils.js';
import {
  rebuildPublicDerivedState,
  validatePublicStructuredHistory,
} from '../events/publicDerivation.js';
import {
  deriveSpeechInteraction,
  validateSpeechInteractionForCommit,
} from '../discussion/discussionOpportunity.js';
import { normalizeCoOperation } from '../claims/claimRolePolicy.js';
import {
  createEmptyInternalMemory,
  createEmptyMemoryLedger,
  voidActionRationalesForDay,
} from '../memory/memoryLedger.js';
import { createEmptyDecisionState } from '../game/decisionState.js';
import { createEmptyFactionStrategyState } from '../game/factionStrategyState.js';
import { getFactionStrategyProfile } from '../roles/roleAttributes.js';
import { createRoleState } from '../roles/roleState.js';
import { assignPlayerRole } from '../roles/roleAssignment.js';
import {
  canSpeakDuringDay,
  getDiscussionEligiblePlayerIds,
  getVoteEligiblePlayerIds,
} from '../game/playerStatus.js';


import {
  result,
  cloneStateForAtomicCorrection,
  restoreStateAfterFailedCorrection,
  commandGuard,
  freezeKnowledge,
} from '../game/gameRuntimeShared.js';
import { initializeNight } from '../night/nightRuntime.js';

export function enterCorrectionMode(state, reason) {
  if (!String(reason ?? '').trim()) return result(false, '訂正モードの理由を入力してください。');
  if (state.game.correctionMode.enabled) return result(false, 'すでに訂正モード中です。');
  state.game.correctionMode = { enabled: true, reason: String(reason).trim(), startedAt: nowIso() };
  return result(true, '訂正モードを開始しました。');
}

export function exitCorrectionMode(state) {
  if (!state.game.correctionMode.enabled) return result(false, '訂正モードではありません。');
  state.game.correctionMode = { enabled: false, reason: '', startedAt: null };
  return result(true, '訂正モードを終了しました。');
}

export function correctPublicSpeech(state, {
  targetEventId,
  reason,
  replacementText,
  replacementQuestionTargetId = 'preserve',
  replacementStructured = null,
}) {
  const guard = commandGuard(state, { allowCorrection: true });
  if (guard) return guard;
  if (!state.game.correctionMode.enabled) return result(false, '訂正モードで実行してください。');
  const target = getEvent(state, targetEventId);
  if (!target || target.status !== 'published' || target.audience.type !== 'public') return result(false, '公開済みイベントを選択してください。');
  const replacementSpeechText = String(replacementText ?? '');
  if (!String(reason ?? '').trim() || !replacementSpeechText.trim()) return result(false, '訂正理由と訂正文を入力してください。');
  if (target.type !== 'public-speech') {
    if (['vote-finalized', 'execution', 'dawn', 'game-result'].includes(target.type)) {
      return result(false, '投票結果・処刑・夜明け・ゲーム結果は派生状態を伴うため、公開直前の復元ポイントへ戻して進行をやり直してください。');
    }
    const correction = addCorrectionEvent(state, {
      targetEventId,
      reason: String(reason).trim(),
      replacementText: String(replacementText).trim(),
    });
    return result(true, '公開済みイベントを訂正しました。', { correctionEventId: correction.id });
  }

  const correctionSnapshot = cloneStateForAtomicCorrection(state);
  const previousStructured = target.payload?.structured ?? {};
  const preservedInteraction = deriveSpeechInteraction(state, {
    actorId: target.actorId,
    interaction: previousStructured.interaction ?? null,
  });
  let correctedInteraction = preservedInteraction;
  if (replacementQuestionTargetId !== 'preserve') {
    if (target.payload?.speechKind === 'priority-answer') {
      return result(false, '優先回答発言の質問先は訂正できません。');
    }
    const requestedQuestionTargetIds = replacementQuestionTargetId === 'none'
      ? []
      : [replacementQuestionTargetId];
    const interactionValidation = validateSpeechInteractionForCommit(state, {
      actorId: target.actorId,
      interaction: {
        questionTargetIds: requestedQuestionTargetIds,
        answersEventIds: preservedInteraction.answersEventIds,
      },
    });
    if (!interactionValidation.ok) return result(false, interactionValidation.errors.join('\n'));
    if (state.game.rules.discussion.answerPriorityEnabled && requestedQuestionTargetIds.length === 1
      && !canSpeakDuringDay(state, requestedQuestionTargetIds[0])) {
      return result(false, '回答優先モードでは、昼会話できない人物を質問先へ指定できません。');
    }
    correctedInteraction = interactionValidation.interaction;
  }
  const structured = replacementStructured === null
    ? {
      coOperation: { ...(previousStructured.coOperation ?? { action: 'none', roleId: 'none' }) },
      interaction: correctedInteraction,
      abilityClaims: (previousStructured.abilityClaims ?? []).map((claim) => ({ ...claim, evidenceEventIds: [...(claim.evidenceEventIds ?? [])] })),
    }
    : {
      coOperation: normalizeCoOperation(replacementStructured.coOperation),
      interaction: correctedInteraction,
      abilityClaims: (replacementStructured.abilityClaims ?? []).map((claim) => ({ ...claim, evidenceEventIds: [...(claim.evidenceEventIds ?? [])] })),
    };

  const correction = addCorrectionEvent(state, {
    targetEventId,
    reason: String(reason).trim(),
    replacementText: `GM訂正: #${target.sequence}の公開発言を訂正しました。理由: ${String(reason).trim()}`,
    payload: { replacementSpeechText },
  });
  const replacement = createEvent(state, {
    type: 'public-speech',
    actorId: target.actorId,
    audience: { type: 'public', targetIds: [] },
    payload: {
      // GMが明示入力した訂正文だけを保存し、構造化能力履歴から文言を生成しない。
      text: replacementSpeechText,
      pass: Boolean(target.payload?.pass),
      speechKind: target.payload?.speechKind ?? 'normal',
      sourceQuestionEventId: target.payload?.sourceQuestionEventId ?? null,
      round: target.payload?.round ?? null,
      roundKind: target.payload?.roundKind ?? 'gm-designated',
      opportunityContext: { ...(target.payload?.opportunityContext ?? {}) },
      correctsEventId: target.id,
      structured,
    },
    status: 'published',
  });
  replacement.day = target.day;
  replacement.phase = target.phase;
  rebuildPublicDerivedState(state);
  const historyErrors = validatePublicStructuredHistory(state);
  if (historyErrors.length) {
    restoreStateAfterFailedCorrection(state, correctionSnapshot);
    return result(false, `訂正後の公開履歴が成立しません。関連する後続発言を先に訂正してください。\n${historyErrors.join('\n')}`);
  }
  reconcileDiscussionAfterCorrection(state);
  return result(true, '公開発言と、その発言に明示されたCO・能力結果を訂正しました。', {
    correctionEventId: correction.id,
    replacementEventId: replacement.id,
  });
}

export function correctPublicEvent(state, payload) {
  return correctPublicSpeech(state, payload);
}

export function editConfirmedEvent(state, { eventId, payload, reason }) {
  const guard = commandGuard(state, { allowCorrection: true });
  if (guard) return guard;
  const event = getEvent(state, eventId);
  if (!event || !['draft', 'confirmed'].includes(event.status)) return result(false, '公開前イベントだけを部分修正できます。');
  if (!String(reason ?? '').trim()) return result(false, '修正理由を入力してください。');

  if (event.type === 'vote-cast') {
    const session = state.voteSession;
    if (!session || session.id !== event.payload?.voteSessionId || !['input', 'ready', 'finalized'].includes(session.status)) return result(false, '現在の投票入力として修正できません。');
    const targetId = payload?.targetId;
    if (!isValidVoteTarget(state, event.actorId, targetId, session.candidateIds)) return result(false, '修正後の投票先が不正です。');
    session.votes[event.actorId] = targetId;
    session.tally = [];
    session.result = null;
    if (session.status === 'finalized') session.status = 'ready';
    event.targetIds = targetId === 'abstain' ? [] : [targetId];
  } else if (event.type === 'night-action') {
    if (state.game.phase !== 'night' || state.night?.status === 'resolved') return result(false, '夜行動解決後は通常の部分修正を行えません。');
    const slot = state.night?.slots.find((item) => item.actorId === event.actorId && item.type === event.payload?.actionType && item.targetId === event.payload?.targetId);
    if (!slot) return result(false, '対応する現在夜の行動スロットがありません。');
    const targetId = payload?.targetId;
    const candidates = getNightActionCandidates(state, slot.type, slot.actorId);
    if (!candidates.some((player) => player.id === targetId)) return result(false, '修正後の夜行動対象が不正です。');
    slot.targetId = targetId;
    event.targetIds = [targetId];
  } else if (['wolf-conversation', 'mason-conversation', 'graveyard-conversation'].includes(event.type)) {
    const sessions = event.type === 'wolf-conversation'
      ? state.wolfConversations
      : event.type === 'mason-conversation'
        ? state.masonConversations
        : state.graveyardConversations;
    const session = sessions.find((item) => item.id === event.payload?.conversationId);
    const message = session?.messages.find((item) => item.id === event.payload?.messageId);
    const wolfLocked = event.type === 'wolf-conversation' && state.night?.wolfAttack?.status === 'confirmed';
    if (!session || !message || state.game.phase !== 'night' || wolfLocked) return result(false, event.type === 'wolf-conversation' ? '襲撃先投票確定後は共有発言を通常修正できません。' : '夜フェーズ終了後は機密会話を通常修正できません。');
    const content = String(payload?.content ?? '').trim();
    if (!content) return result(false, '修正後の共有発言を入力してください。');
    message.content = content;
  } else {
    return result(false, 'この種類のイベントは通常の部分修正対象ではありません。');
  }

  event.payload = { ...event.payload, ...payload, editReason: String(reason).trim(), editedAt: nowIso() };
  return result(true, '公開前イベントと対応する進行状態を修正しました。');
}

export function correctRoleAssignment(state, { playerId, correctedRoleId, reason }) {
  const guard = commandGuard(state, { allowCorrection: true });
  if (guard) return guard;
  if (!state.game.correctionMode.enabled) return result(false, '訂正モードで実行してください。');
  if (!['setup', 'briefing'].includes(state.game.phase)) return result(false, '役職訂正は公開発言が始まる前だけ実行できます。公開後はゲーム開始前の復元ポイントへ戻してください。');
  if (state.events.some((event) => event.status === 'published' && event.type === 'public-speech')) {
    return result(false, '公開発言後の役職訂正はできません。ゲーム開始前の復元ポイントへ戻してください。');
  }
  const player = getPlayer(state, playerId);
  if (!player) return result(false, 'プレイヤーが存在しません。');
  if (!String(reason ?? '').trim()) return result(false, '訂正理由を入力してください。');
  if (!correctedRoleId) return result(false, '訂正後の役職を指定してください。');
  const beforeRoleId = player.roleId;
  try {
    assignPlayerRole(player, correctedRoleId);
  } catch (error) {
    return result(false, error.message);
  }

  if (state.game.phase === 'briefing') {
    freezeKnowledge(state);
    state.events
      .filter((event) => event.status !== 'voided' && event.type === 'role-notified')
      .forEach((event) => voidEvent(state, event.id));
    const ids = state.players.map((item) => item.id);
    state.briefing = {
      roleAssignmentFrozen: true,
      eligiblePlayerIds: ids,
      noticeStatusByPlayerId: Object.fromEntries(ids.map((id) => [id, 'pending'])),
      aiContextReadyByPlayerId: Object.fromEntries(ids.map((id) => [id, false])),
      forcedReasonByPlayerId: {},
      completed: false,
    };
    state.players.forEach((item) => {
      item.aiContextStatus = 'not-ready';
      item.heartVoice = '';
      item.heartVoiceUpdatedAt = null;
      item.heartVoiceHistory = [];
      item.internalMemory = createEmptyInternalMemory();
      item.memoryLedger = createEmptyMemoryLedger();
      item.memoHistory = [];
      item.decisionState = createEmptyDecisionState();
      item.roleState = createRoleState(item.roleId);
      item.statusEffects = [];
      item.factionStrategyState = createEmptyFactionStrategyState(getFactionStrategyProfile(state, item) ?? item.roleId);
    });
  }
  const correction = createEvent(state, {
    type: 'correction',
    actorId: playerId,
    audience: { type: 'gm', targetIds: [] },
    payload: {
      reason: String(reason).trim(),
      correctionType: 'role-assignment',
      beforeRoleId,
      correctedRoleId,
    },
  });
  return result(true, '役職を訂正しました。役職通知は最初からやり直してください。', { correctionEventId: correction.id });
}

export function reconcileDiscussionAfterCorrection(state) {
  const discussion = state.discussion;
  if (!discussion || state.game.phase !== 'discussion') return;
  const aliveIds = getDiscussionEligiblePlayerIds(state);
  const configured = Number(state.game.rules.speechCountPerDay ?? 0);
  const speechCounts = Object.fromEntries(aliveIds.map((id) => [id, 0]));
  state.events
    .filter((event) => event.status !== 'voided' && event.type === 'public-speech' && event.payload?.speechKind === 'normal' && event.day === state.game.day)
    .forEach((event) => {
      if (event.actorId in speechCounts) speechCounts[event.actorId] += 1;
    });
  Object.keys(discussion.remainingByPlayer ?? {}).forEach((id) => {
    if (!aliveIds.includes(id)) discussion.remainingByPlayer[id] = 0;
  });
  aliveIds.forEach((id) => {
    const spoken = speechCounts[id] ?? 0;
    const previousRemaining = Number(discussion.remainingByPlayer[id] ?? 0);
    const entitlement = Math.max(configured, spoken + previousRemaining);
    discussion.remainingByPlayer[id] = Math.max(0, entitlement - spoken);
  });
  discussion.spokenInCurrentRound = (discussion.spokenInCurrentRound ?? []).filter((id) => aliveIds.includes(id));
  discussion.deferredPlayerIds = (discussion.deferredPlayerIds ?? []).filter((id) => aliveIds.includes(id));
  discussion.allDeferred = false;
  if (discussion.designatedPlayerId && !aliveIds.includes(discussion.designatedPlayerId)) discussion.designatedPlayerId = null;
  if (discussion.mode === 'ordered') {
    const eligible = aliveIds.filter((id) => (discussion.remainingByPlayer[id] ?? 0) > 0);
    const preserved = (discussion.queue ?? []).filter((id) => eligible.includes(id));
    discussion.queue = [...preserved, ...eligible.filter((id) => !preserved.includes(id))];
    discussion.currentIndex = Math.min(discussion.currentIndex ?? 0, Math.max(0, discussion.queue.length - 1));
    discussion.completed = eligible.length === 0;
  } else if (discussion.mode === 'designated') {
    const control = discussion.modeControl?.type === 'designated' ? discussion.modeControl : null;
    if (control && control.preferredNextSpeakerId && !aliveIds.includes(control.preferredNextSpeakerId)) control.preferredNextSpeakerId = null;
    const roundEligible = (discussion.roundEligiblePlayerIds ?? []).filter((id) => aliveIds.includes(id) && (discussion.remainingByPlayer[id] ?? 0) > 0);
    const spoken = new Set((discussion.spokenInCurrentRound ?? []).filter((id) => roundEligible.includes(id)));
    const currentAndLater = (discussion.queue ?? []).slice(Math.max(0, Number(discussion.currentIndex ?? 0))).filter((id) => roundEligible.includes(id) && !spoken.has(id));
    const unspoken = [...currentAndLater, ...roundEligible.filter((id) => !spoken.has(id) && !currentAndLater.includes(id))];
    discussion.queue = [...(discussion.queue ?? []).slice(0, Math.max(0, Number(discussion.currentIndex ?? 0))), ...unspoken];
    discussion.designatedPlayerId = unspoken[0] ?? null;
    discussion.completed = aliveIds.every((id) => (discussion.remainingByPlayer[id] ?? 0) <= 0);
  } else if (discussion.mode === 'free') {
    const control = discussion.modeControl?.type === 'free' ? discussion.modeControl : null;
    if (control) {
      control.donePlayerIds = (control.donePlayerIds ?? []).filter((id) => aliveIds.includes(id));
      control.openingPreferenceByPlayerId = Object.fromEntries(Object.entries(control.openingPreferenceByPlayerId ?? {}).filter(([id]) => aliveIds.includes(id)));
      control.nextPreferenceByPlayerId = Object.fromEntries(Object.entries(control.nextPreferenceByPlayerId ?? {}).filter(([id]) => aliveIds.includes(id)));
      if (control.stage === 'opening-preference') {
        discussion.queue = [];
        discussion.currentIndex = 0;
        discussion.designatedPlayerId = null;
        discussion.completed = false;
      } else {
        const done = new Set(control.donePlayerIds);
        const eligible = aliveIds.filter((id) => (discussion.remainingByPlayer[id] ?? 0) > 0 && !done.has(id));
        const preserved = (discussion.queue ?? []).filter((id) => eligible.includes(id));
        discussion.queue = [...preserved, ...eligible.filter((id) => !preserved.includes(id))];
        discussion.currentIndex = Math.min(Number(discussion.currentIndex ?? 0), Math.max(0, discussion.queue.length - 1));
        discussion.designatedPlayerId = discussion.queue[discussion.currentIndex] ?? null;
        discussion.completed = eligible.length === 0;
      }
    }
  }
}

/**
 * 責務: AIによる内部メモ整理本文を取得できない場合に、現在の内部メモを変更せず、失敗監査ターンだけを記録して整理タスクを完了扱いにする。
 * 変更ルール: 既存メモを空文字・定型文・部分回答で上書きせず、AI生成の整理結果として捏造しない。
 */
