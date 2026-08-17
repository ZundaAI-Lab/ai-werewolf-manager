/**
 * 責務: 昼議論、通常発言、優先回答、発言順、再検討、公開CO・能力結果主張の原子的登録を実行する。
 * 変更ルール: 正常AI公開本文を変更せず、質問回答関係は保存済み構造化interactionだけで処理する。通常発言回数は議論方式を問わずspeechCountPerDayを上限とし、発言希望制はDONEまたは残回数0で次巡対象から外す。人間入力・AI入力はいずれも公開コマンド境界で許可キーを限定し、未知項目を黙って破棄しない。
 */

import { isNormalSpeechTask, speechTaskTypeForDiscussionMode } from '../../config/discussionAiTaskTypes.js';
import {
  getAlivePlayers,
  getPlayer,
} from '../game/standardRules.js';
import { createEvent } from '../events/eventStore.js';
import {
  createId,
  nowIso,
  unique,
} from '../../shared/utils.js';
import { rebuildPublicDerivedState } from '../events/publicDerivation.js';
import { assertAiPublicSpeechUnmodified } from '../policies/publicAbilityClaimNarrative.js';
import {
  createSpeechOpportunitySnapshot,
  deriveSpeechInteraction,
  validateSpeechInteractionForCommit,
} from './discussionOpportunity.js';
import { resolvePublicClaimCommit } from '../claims/publicClaimCommitPolicy.js';
import {
  getCurrentNormalSpeechAnswerTasks,
  getCurrentPriorityAnswerTask,
} from './priorityAnswerPolicy.js';
import { applyInternalMemoryUpdate } from '../memory/memoryLedger.js';
import { applyDesignatedSpeakerPreference, normalizeDesignatedSpeakerPreference } from './designatedDiscussionPolicy.js';
import { buildFreeDiscussionQueue, isFreeDiscussionDone, normalizeFreeDiscussionPreference } from './freeDiscussionPolicy.js';
import {
  canSpeakDuringDay,
  getDiscussionEligiblePlayerIds,
} from '../game/playerStatus.js';


import {
  result,
  commandGuard,
  setPhase,
  setHeartVoice,
  resolveDecisionUpdateForCommit,
  resolveFactionStrategyForCommit,
  setFactionStrategyState,
  recordAiTurn,
} from '../game/gameRuntimeShared.js';

export function initializeDiscussion(state) {
  // 日付更新規則: AI回答の永続判断状態は変更せず、利用側がsourceDayから現在盤面向けへ射影する。
  setPhase(state, 'discussion');
  const aliveIds = getDiscussionEligiblePlayerIds(state);
  const mode = state.game.rules.discussion.mode;
  state.discussion = {
    day: state.game.day,
    mode,
    round: 1,
    roundKind: 'normal',
    roundStartedAtSequence: Number(state.game.eventSequence ?? 0),
    roundEligiblePlayerIds: [...aliveIds],
    queue: ['ordered', 'designated'].includes(mode) ? [...aliveIds] : [],
    currentIndex: 0,
    designatedPlayerId: mode === 'designated' ? aliveIds[0] ?? null : null,
    spokenInCurrentRound: [],
    deferredPlayerIds: [],
    deferredCountByPlayer: Object.fromEntries(aliveIds.map((id) => [id, 0])),
    allDeferred: false,
    remainingByPlayer: Object.fromEntries(aliveIds.map((id) => [id, state.game.rules.speechCountPerDay])),
    modeControl: mode === 'designated'
      ? { type: 'designated', preferredNextSpeakerId: null }
      : mode === 'free'
        ? { type: 'free', stage: 'opening-preference', openingPreferenceByPlayerId: {}, nextPreferenceByPlayerId: {}, donePlayerIds: [] }
        : null,
    reconsideration: {
      pending: false,
      active: false,
      items: [],
      reasons: [],
      sourceEventIds: [],
      affectedPlayerIds: [],
      updatedAt: null,
      handledRound: null,
    },
    completed: false,
  };
}

export function beginDiscussionRound(state, { playerIds, kind = 'normal' }) {
  const discussion = state.discussion;
  const targets = unique(playerIds ?? []);
  discussion.round = Number(discussion.round ?? 0) + 1;
  discussion.roundKind = kind;
  discussion.roundStartedAtSequence = Number(state.game.eventSequence ?? 0);
  discussion.roundEligiblePlayerIds = [...targets];
  discussion.queue = ['ordered', 'designated'].includes(discussion.mode) ? [...targets] : [...targets];
  discussion.currentIndex = 0;
  discussion.designatedPlayerId = ['designated', 'free'].includes(discussion.mode) ? targets[0] ?? null : null;
  discussion.spokenInCurrentRound = [];
  discussion.deferredPlayerIds = [];
  discussion.allDeferred = false;
  discussion.completed = false;
}

export function orderAlivePlayerIds(state, playerIds) {
  const targetIds = new Set(unique(playerIds ?? []));
  return getAlivePlayers(state)
    .filter((player) => targetIds.has(player.id))
    .map((player) => player.id);
}

export function orderedEligibleIds(state) {
  const discussion = state.discussion;
  return getDiscussionEligiblePlayerIds(state).filter((id) => (discussion.remainingByPlayer[id] ?? 0) > 0);
}

export function advanceOrderedDiscussion(state) {
  const discussion = state.discussion;
  const eligible = orderedEligibleIds(state);
  if (!eligible.length) {
    discussion.completed = true;
    return;
  }
  discussion.currentIndex += 1;
  if (discussion.currentIndex >= discussion.queue.length) {
    beginDiscussionRound(state, { playerIds: eligible, kind: 'normal' });
    return;
  }
  while (discussion.queue.length && !eligible.includes(discussion.queue[discussion.currentIndex])) {
    discussion.currentIndex += 1;
    if (discussion.currentIndex >= discussion.queue.length) {
      beginDiscussionRound(state, { playerIds: eligible, kind: 'normal' });
      return;
    }
  }
}


export function getPendingDiscussionOpeningPreferencePlayerId(state) {
  const discussion = state.discussion;
  if (discussion?.mode !== 'free' || discussion.modeControl?.type !== 'free' || discussion.modeControl.stage !== 'opening-preference') return null;
  const submitted = discussion.modeControl.openingPreferenceByPlayerId ?? {};
  return getDiscussionEligiblePlayerIds(state).find((id) => !Object.hasOwn(submitted, id)) ?? null;
}

export function recordDiscussionOpeningPreference(state, { playerId, preference } = {}) {
  const guard = commandGuard(state, { phases: ['discussion'] });
  if (guard) return guard;
  const discussion = state.discussion;
  if (discussion.mode !== 'free' || discussion.modeControl?.type !== 'free') return result(false, '発言希望制でのみ開始時の発言希望を登録できます。');
  if (discussion.modeControl.stage !== 'opening-preference') return result(false, '発言希望制の開始時希望受付は完了しています。');
  if (!getDiscussionEligiblePlayerIds(state).includes(playerId)) return result(false, '現在の昼議論参加者を指定してください。');
  if (Object.hasOwn(discussion.modeControl.openingPreferenceByPlayerId, playerId)) return result(false, 'このプレイヤーの開始時希望は登録済みです。');
  discussion.modeControl.openingPreferenceByPlayerId[playerId] = normalizeFreeDiscussionPreference(preference, { opening: true });
  const pendingId = getPendingDiscussionOpeningPreferencePlayerId(state);
  if (!pendingId) {
    const eligibleIds = getDiscussionEligiblePlayerIds(state);
    discussion.queue = buildFreeDiscussionQueue(eligibleIds, discussion.modeControl.openingPreferenceByPlayerId, { opening: true });
    discussion.currentIndex = 0;
    discussion.designatedPlayerId = discussion.queue[0] ?? null;
    discussion.spokenInCurrentRound = [];
    discussion.roundEligiblePlayerIds = [...discussion.queue];
    discussion.modeControl.stage = 'discussion';
  }
  return result(true, '発言希望制の開始時発言希望を登録しました。', { preference: discussion.modeControl.openingPreferenceByPlayerId[playerId] });
}


export function recordAiDiscussionOpeningPreference(state, {
  playerId,
  preference,
  rawResponse = '',
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  warnings = [],
  generationRun = null,
  resolvedInternalReasoningDirective = null,
} = {}) {
  const response = recordDiscussionOpeningPreference(state, { playerId, preference });
  if (!response.ok) return response;
  const normalized = response.preference;
  const turn = recordAiTurn(state, {
    taskType: 'discussion-opening-preference',
    playerId,
    promptText,
    promptFingerprint,
    promptMode,
    publicSequenceAtGeneration,
    rawResponse,
    generationRun,
    parsedActionAnswer: normalized,
    warnings,
    resolvedInternalReasoningDirective,
    committedEntityIds: [],
  });
  return result(true, response.message, { preference: normalized, aiTurnId: turn.id });
}

function advanceDesignatedDiscussion(state, preferredNextSpeakerId = null) {
  const discussion = state.discussion;
  if (discussion.modeControl?.type === 'designated') {
    discussion.modeControl.preferredNextSpeakerId = normalizeDesignatedSpeakerPreference(preferredNextSpeakerId);
    applyDesignatedSpeakerPreference(discussion, discussion.modeControl.preferredNextSpeakerId);
  }
  discussion.currentIndex += 1;
  if (discussion.currentIndex < discussion.queue.length) {
    discussion.designatedPlayerId = discussion.queue[discussion.currentIndex] ?? null;
    return;
  }
  const eligible = getDiscussionEligiblePlayerIds(state).filter((id) => Number(discussion.remainingByPlayer[id] ?? 0) > 0);
  if (!eligible.length) {
    discussion.designatedPlayerId = null;
    discussion.completed = true;
    return;
  }
  beginDiscussionRound(state, { playerIds: orderAlivePlayerIds(state, eligible), kind: 'normal' });
  if (discussion.modeControl?.type === 'designated') discussion.modeControl.preferredNextSpeakerId = null;
}

function advanceFreeDiscussion(state, playerId, preference) {
  const discussion = state.discussion;
  const control = discussion.modeControl;
  if (control?.type !== 'free') return;
  const normalized = normalizeFreeDiscussionPreference(preference);
  control.nextPreferenceByPlayerId[playerId] = normalized;
  if (normalized === 'DONE' && !control.donePlayerIds.includes(playerId)) control.donePlayerIds.push(playerId);
  discussion.currentIndex += 1;
  if (discussion.currentIndex < discussion.queue.length) {
    discussion.designatedPlayerId = discussion.queue[discussion.currentIndex] ?? null;
    return;
  }
  const eligible = getDiscussionEligiblePlayerIds(state).filter((id) => (discussion.remainingByPlayer[id] ?? 0) > 0 && !isFreeDiscussionDone(control, id));
  if (!eligible.length) {
    discussion.designatedPlayerId = null;
    discussion.completed = true;
    return;
  }
  discussion.round = Number(discussion.round ?? 0) + 1;
  discussion.roundKind = 'normal';
  discussion.roundStartedAtSequence = Number(state.game.eventSequence ?? 0);
  discussion.queue = buildFreeDiscussionQueue(eligible, control.nextPreferenceByPlayerId);
  discussion.roundEligiblePlayerIds = [...discussion.queue];
  discussion.currentIndex = 0;
  discussion.designatedPlayerId = discussion.queue[0] ?? null;
  discussion.spokenInCurrentRound = [];
  discussion.deferredPlayerIds = [];
  discussion.allDeferred = false;
}

export function designateDiscussionSpeaker(state, playerId) {
  const guard = commandGuard(state, { phases: ['discussion'] });
  if (guard) return guard;
  const discussion = state.discussion;
  const player = getPlayer(state, playerId);
  if (!player?.alive) return result(false, '生存者を指定してください。');
  if (!canSpeakDuringDay(state, playerId)) return result(false, '凍結中のため昼会話には参加できません。');
  if (discussion.mode === 'free') return result(false, '発言希望制では発言者を直接指定できません。');
  if ((discussion.remainingByPlayer[playerId] ?? 0) <= 0) return result(false, '発言回数が残っていません。');
  if (discussion.mode === 'designated' && (discussion.spokenInCurrentRound ?? []).includes(playerId)) {
    return result(false, 'この巡ですでに発言したプレイヤーは再指名できません。');
  }
  discussion.designatedPlayerId = playerId;
  discussion.allDeferred = false;
  return result(true, `${player.name}を次の発言者に指定しました。`);
}


const HUMAN_SPEECH_INPUT_KEYS = Object.freeze(new Set(['playerId', 'content', 'coOperation', 'questionTargetId', 'nextSpeakerPreference', 'discussionPreference']));
const AI_SPEECH_INPUT_KEYS = Object.freeze(new Set([
  'playerId',
  'content',
  'heartVoice',
  'internalMemoUpdate',
  'rawResponse',
  'generationRun',
  'promptText',
  'promptFingerprint',
  'promptMode',
  'publicSequenceAtGeneration',
  'warnings',
  'coOperation',
  'speechInteraction',
  'parsedSpeechInteraction',
  'decisionUpdate',
  'parsedDecisionUpdate',
  'factionStrategyUpdate',
  'parsedFactionStrategyUpdate',
  'abilityClaims',
  'parsedAbilityClaims',
  'resolvedInternalReasoningDirective',
  'nextSpeakerPreference',
  'discussionPreference',
  'aiTaskType',
]));
const HUMAN_PRIORITY_ANSWER_INPUT_KEYS = Object.freeze(new Set(['playerId', 'questionEventId', 'content', 'coOperation', 'abilityClaims']));
const AI_PRIORITY_ANSWER_INPUT_KEYS = Object.freeze(new Set([
  'playerId',
  'questionEventId',
  'content',
  'heartVoice',
  'internalMemoUpdate',
  'rawResponse',
  'generationRun',
  'promptText',
  'promptFingerprint',
  'promptMode',
  'publicSequenceAtGeneration',
  'warnings',
  'decisionUpdate',
  'parsedDecisionUpdate',
  'factionStrategyUpdate',
  'parsedFactionStrategyUpdate',
  'coOperation',
  'abilityClaims',
  'parsedAbilityClaims',
  'resolvedInternalReasoningDirective',
]));

export function mergeRequiredNormalSpeechAnswers(interaction, requiredAnswerEventIds) {
  if (!requiredAnswerEventIds.length) return interaction;
  if (interaction === null || interaction === undefined) {
    return {
      questionTargetIds: [],
      answersEventIds: [...requiredAnswerEventIds],
    };
  }
  if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) return interaction;
  if (!Array.isArray(interaction.questionTargetIds) || !Array.isArray(interaction.answersEventIds)) return interaction;
  return {
    ...interaction,
    answersEventIds: unique([...interaction.answersEventIds, ...requiredAnswerEventIds]),
  };
}

export function recordSkippedNormalSpeechAnswers(state, answerTasks, sourceType) {
  if (!answerTasks.length) return [];
  const aiFallback = sourceType === 'ai-fallback';
  const reason = aiFallback
    ? '次の通常発言がAI回答本文未取得によるパスとなったため'
    : '次の通常発言をGM判断でパスしたため';
  return answerTasks.map((task) => createEvent(state, {
    type: 'priority-answer-resolution',
    actorId: null,
    targetIds: [task.targetPlayerId],
    audience: { type: 'gm', targetIds: [] },
    payload: {
      questionEventId: task.questionEventId,
      targetPlayerId: task.targetPlayerId,
      resolution: 'skipped',
      reason,
      ...(aiFallback ? { source: 'ai-fallback' } : {}),
    },
    status: 'confirmed',
  }));
}

export function recordSpeechCore(state, {
  sourceType,
  playerId,
  content,
  heartVoice = '',
  internalMemoUpdate = null,
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  warnings = [],
  pass = false,
  coOperation = null,
  speechInteraction = null,
  parsedSpeechInteraction = null,
  questionTargetId = null,
  decisionUpdate = null,
  parsedDecisionUpdate = null,
  factionStrategyUpdate = null,
  parsedFactionStrategyUpdate = null,
  abilityClaims = [],
  parsedAbilityClaims = null,
  resolvedInternalReasoningDirective = null,
  nextSpeakerPreference = null,
  discussionPreference = null,
  aiTaskType = 'speech',
}) {
  const guard = commandGuard(state, { phases: ['discussion'] });
  if (guard) return guard;
  const discussion = state.discussion;
  const speaker = getPlayer(state, playerId);
  if (!speaker?.alive) return result(false, '死亡者は発言できません。');
  if (!canSpeakDuringDay(state, playerId)) return result(false, '凍結中のため昼会話には参加できません。');
  const expectedId = discussion.mode === 'ordered'
    ? discussion.queue[discussion.currentIndex]
    : discussion.designatedPlayerId;
  if (expectedId !== playerId) return result(false, '現在の発言者ではありません。');
  if ((discussion.remainingByPlayer[playerId] ?? 0) <= 0) return result(false, '発言回数が残っていません。');
  if (pass && discussion.mode === 'free' && sourceType !== 'ai-fallback') {
    return result(false, '発言希望制では通常発言をパスできません。発言後に話し切った場合はDONEを選択してください。');
  }

  if (discussion.mode === 'ordered' && (nextSpeakerPreference !== null || discussionPreference !== null)) return result(false, '順番制の通常発言では発言順制御を指定できません。');
  if (discussion.mode === 'designated' && discussionPreference !== null) return result(false, '指名制では発言希望制の発言希望を指定できません。');
  if (discussion.mode === 'free' && nextSpeakerPreference !== null) return result(false, '発言希望制では指名制の次発言者希望を指定できません。');
  if (['ai', 'ai-fallback'].includes(sourceType)) {
    const expectedTaskType = speechTaskTypeForDiscussionMode(discussion.mode);
    if (!isNormalSpeechTask(aiTaskType) || aiTaskType !== expectedTaskType) return result(false, '現在の昼議論方式とAI発言タスク種別が一致しません。');
  }

  const aiLikeSource = ['ai', 'ai-fallback'].includes(sourceType);
  const submittedText = String(content ?? '');
  const text = pass ? '発言なし' : submittedText;
  if (!text.trim()) return result(false, '公開発言を入力してください。');
  if (sourceType === 'ai' && !pass) assertAiPublicSpeechUnmodified(submittedText, text);

  const publicClaims = resolvePublicClaimCommit(state, {
    playerId,
    coOperation: pass ? null : coOperation,
    abilityClaims: sourceType === 'ai' && !pass ? abilityClaims : [],
  });
  if (!publicClaims.ok) return result(false, publicClaims.errors.join('\n'));
  const operation = publicClaims.operation;
  const normalizedAbilityClaims = publicClaims.abilityClaims;

  const opportunityContext = createSpeechOpportunitySnapshot(state, playerId);
  const normalSpeechAnswerTasks = getCurrentNormalSpeechAnswerTasks(state, playerId);
  const requiredAnswerEventIds = normalSpeechAnswerTasks.map((task) => task.questionEventId);
  const humanInteraction = sourceType === 'human'
    ? {
      questionTargetIds: questionTargetId ? [questionTargetId] : [],
      answersEventIds: [...requiredAnswerEventIds],
    }
    : null;
  const aiInteraction = sourceType === 'ai'
    ? mergeRequiredNormalSpeechAnswers(speechInteraction, requiredAnswerEventIds)
    : null;
  const interactionValidation = sourceType === 'ai'
    ? validateSpeechInteractionForCommit(state, { actorId: playerId, interaction: aiInteraction })
    : sourceType === 'human'
      ? validateSpeechInteractionForCommit(state, { actorId: playerId, interaction: humanInteraction })
      : { ok: true, interaction: deriveSpeechInteraction(state, { actorId: playerId, interaction: null }), errors: [] };
  if (!interactionValidation.ok) return result(false, interactionValidation.errors.join('\n'));
  const committedSpeechInteraction = interactionValidation.interaction;
  if (state.game.rules.discussion.answerPriorityEnabled === true && committedSpeechInteraction.questionTargetIds.length === 1) {
    const targetId = committedSpeechInteraction.questionTargetIds[0];
    if (!canSpeakDuringDay(state, targetId)) return result(false, '回答優先モードでは、現在昼会話できない相手を個人質問先に指定できません。');
  }
  const committedDecisionUpdate = aiLikeSource
    ? resolveDecisionUpdateForCommit(state, playerId, decisionUpdate, { taskType: 'speech' })
    : null;
  const factionStrategy = aiLikeSource
    ? resolveFactionStrategyForCommit(state, playerId, factionStrategyUpdate)
    : { ok: true, update: null, errors: [] };
  if (!factionStrategy.ok) return result(false, factionStrategy.errors.join('\n'));
  const committedFactionStrategyUpdate = factionStrategy.update;

  const speechEvent = createEvent(state, {
    type: 'public-speech',
    actorId: playerId,
    audience: { type: 'public', targetIds: [] },
    payload: {
      text,
      pass,
      speechKind: 'normal',
      sourceQuestionEventId: null,
      round: discussion.round,
      roundKind: discussion.roundKind ?? 'normal',
      opportunityContext,
      structured: {
        coOperation: operation,
        interaction: committedSpeechInteraction,
        abilityClaims: normalizedAbilityClaims.map((claim) => ({ ...claim, evidenceEventIds: [...claim.evidenceEventIds] })),
      },
    },
    status: 'published',
  });

  const skippedNormalSpeechAnswerEvents = pass
    ? recordSkippedNormalSpeechAnswers(state, normalSpeechAnswerTasks, sourceType)
    : [];
  if (aiLikeSource) setHeartVoice(state, playerId, heartVoice);
  discussion.remainingByPlayer[playerId] -= 1;
  discussion.spokenInCurrentRound.push(playerId);
  discussion.designatedPlayerId = null;

  let turn = null;
  if (aiLikeSource) {
    turn = recordAiTurn(state, {
      taskType: pass && sourceType === 'ai-fallback' && aiTaskType === 'speech' ? 'speech-fallback' : aiTaskType,
      playerId,
      promptText,
      promptFingerprint,
      promptMode,
      publicSequenceAtGeneration,
      rawResponse,
      generationRun,
      parsedPublicSpeech: submittedText,
      parsedSpeechInteraction: parsedSpeechInteraction ?? null,
      resolvedSpeechInteraction: committedSpeechInteraction,
      parsedHeartVoice: heartVoice,
      parsedInternalMemoUpdate: internalMemoUpdate,
      warnings,
      parsedCoOperation: operation,
      parsedAbilityClaims: parsedAbilityClaims ?? null,
      resolvedAbilityClaims: normalizedAbilityClaims,
      parsedDecisionUpdate: parsedDecisionUpdate ?? null,
      resolvedDecisionUpdate: committedDecisionUpdate,
      parsedFactionStrategyUpdate: parsedFactionStrategyUpdate ?? null,
      resolvedFactionStrategyUpdate: committedFactionStrategyUpdate,
      resolvedInternalReasoningDirective,
      committedEntityIds: [
        speechEvent.id,
        ...skippedNormalSpeechAnswerEvents.map((event) => event.id),
        ['declare', 'change'].includes(operation.action) ? `claim:${speechEvent.id}` : null,
        ...normalizedAbilityClaims.map((claim, index) => `ability-claim:${speechEvent.id}:${index}`),
      ].filter(Boolean),
    });
    setFactionStrategyState(state, playerId, committedFactionStrategyUpdate, turn.id);
    applyInternalMemoryUpdate(state, playerId, internalMemoUpdate, turn.id);
  }

  rebuildPublicDerivedState(state);
  if (discussion.mode === 'ordered') advanceOrderedDiscussion(state);
  else if (discussion.mode === 'designated') advanceDesignatedDiscussion(state, nextSpeakerPreference);
  else if (discussion.mode === 'free') advanceFreeDiscussion(state, playerId, discussionPreference);
  return result(true, pass ? 'パスを登録しました。' : '公開発言を登録しました。', { eventId: speechEvent.id, aiTurnId: turn?.id ?? null });
}

/**
 * 責務: 人間が明示入力した公開発言本文と任意COだけを登録する。
 * 変更ルール: 許可キー以外を拒否し、AI私有情報・能力結果・判断・進行指定を受け取らない。
 */

export function recordHumanSpeech(state, input = {}) {
  const forbiddenKeys = Object.keys(input).filter((key) => !HUMAN_SPEECH_INPUT_KEYS.has(key));
  if (forbiddenKeys.length) return result(false, `人間の公開発言入力では指定できない項目です: ${forbiddenKeys.join(', ')}`);
  return recordSpeechCore(state, { ...input, sourceType: 'human', pass: false });
}

/**
 * 責務: AI応答契約の公開発言と既存の構造化・私有情報を、それぞれ正しい保存先へ登録する。
 * 変更ルール: 公開イベントへは公開ゲーム事実だけを保存し、心の声・内部メモ・判断・陣営戦略を混入させない。
 */

export function recordAiSpeech(state, input = {}) {
  const forbiddenKeys = Object.keys(input).filter((key) => !AI_SPEECH_INPUT_KEYS.has(key));
  if (forbiddenKeys.length) return result(false, `AI公開発言入力では指定できない項目です: ${forbiddenKeys.join(', ')}`);
  return recordSpeechCore(state, { ...input, sourceType: 'ai', pass: false });
}

/**
 * 責務: AI必須本文を取得できない自動代替を、本人限定項目を保持しつつ発言フォールバックとして登録する。
 * 変更ルール: 正常なAI回答の代替には使用せずspeech-fallbackとして監査する。公開本文・CO・能力結果・質問関連を補完せず、公開イベントはpassとして記録する。
 */

export function recordAiSpeechPass(state, input = {}) {
  const forbiddenKeys = ['sourceType', 'pass', 'content', 'fallback'].filter((key) => Object.hasOwn(input, key));
  if (forbiddenKeys.length) return result(false, `AI発言フォールバック登録では指定できない項目です: ${forbiddenKeys.join(', ')}`);
  return recordSpeechCore(state, {
    ...input,
    sourceType: 'ai-fallback',
    content: '',
    pass: true,
    coOperation: null,
    abilityClaims: [],
    speechInteraction: null,
    parsedSpeechInteraction: null,
  });
}

export function recordPriorityAnswerCore(state, {
  sourceType,
  playerId,
  questionEventId,
  content,
  heartVoice = '',
  internalMemoUpdate = null,
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  warnings = [],
  decisionUpdate = null,
  parsedDecisionUpdate = null,
  factionStrategyUpdate = null,
  parsedFactionStrategyUpdate = null,
  coOperation = null,
  abilityClaims = [],
  parsedAbilityClaims = null,
  resolvedInternalReasoningDirective = null,
}) {
  const guard = commandGuard(state, { phases: ['discussion'] });
  if (guard) return guard;
  const pending = getCurrentPriorityAnswerTask(state);
  if (!pending) return result(false, '現在、回答優先フェーズはありません。');
  if (pending.questionEventId !== questionEventId || pending.targetPlayerId !== playerId) {
    return result(false, '現在の回答優先対象と一致しません。');
  }
  const speaker = getPlayer(state, playerId);
  if (!speaker?.alive) return result(false, '死亡者は回答できません。');
  if (!canSpeakDuringDay(state, playerId)) return result(false, '凍結中のため昼会話には参加できません。');
  const submittedText = String(content ?? '');
  if (!submittedText.trim()) return result(false, '質問への回答を入力してください。');
  if (sourceType === 'ai') assertAiPublicSpeechUnmodified(submittedText, submittedText);

  const publicClaims = resolvePublicClaimCommit(state, {
    playerId,
    coOperation,
    abilityClaims,
  });
  if (!publicClaims.ok) return result(false, publicClaims.errors.join('\n'));
  const operation = publicClaims.operation;
  const normalizedAbilityClaims = publicClaims.abilityClaims;
  const committedDecisionUpdate = sourceType === 'ai'
    ? resolveDecisionUpdateForCommit(state, playerId, decisionUpdate, { taskType: 'priority-answer' })
    : null;
  const factionStrategy = sourceType === 'ai'
    ? resolveFactionStrategyForCommit(state, playerId, factionStrategyUpdate)
    : { ok: true, update: null, errors: [] };
  if (!factionStrategy.ok) return result(false, factionStrategy.errors.join('\n'));
  const committedFactionStrategyUpdate = factionStrategy.update;
  const opportunityContext = createSpeechOpportunitySnapshot(state, playerId);
  const committedInteraction = {
    questionTargetIds: [],
    answersEventIds: [questionEventId],
  };
  const speechEvent = createEvent(state, {
    type: 'public-speech',
    actorId: playerId,
    audience: { type: 'public', targetIds: [] },
    payload: {
      text: submittedText,
      pass: false,
      speechKind: 'priority-answer',
      sourceQuestionEventId: questionEventId,
      round: state.discussion?.round ?? null,
      roundKind: state.discussion?.roundKind ?? 'normal',
      opportunityContext,
      structured: {
        coOperation: operation,
        interaction: committedInteraction,
        abilityClaims: normalizedAbilityClaims.map((claim) => ({ ...claim, evidenceEventIds: [...claim.evidenceEventIds] })),
      },
    },
    status: 'published',
  });

  let turn = null;
  if (sourceType === 'ai') {
    setHeartVoice(state, playerId, heartVoice);
    turn = recordAiTurn(state, {
      taskType: 'priority-answer',
      playerId,
      promptText,
      promptFingerprint,
      promptMode,
      publicSequenceAtGeneration,
      rawResponse,
      generationRun,
      parsedPublicSpeech: submittedText,
      parsedSpeechInteraction: null,
      resolvedSpeechInteraction: committedInteraction,
      parsedHeartVoice: heartVoice,
      parsedInternalMemoUpdate: internalMemoUpdate,
      warnings,
      parsedCoOperation: operation,
      parsedAbilityClaims: parsedAbilityClaims ?? null,
      resolvedAbilityClaims: normalizedAbilityClaims,
      parsedDecisionUpdate: parsedDecisionUpdate ?? null,
      resolvedDecisionUpdate: committedDecisionUpdate,
      parsedFactionStrategyUpdate: parsedFactionStrategyUpdate ?? null,
      resolvedFactionStrategyUpdate: committedFactionStrategyUpdate,
      resolvedInternalReasoningDirective,
      committedEntityIds: [
        speechEvent.id,
        ['declare', 'change'].includes(operation.action) ? `claim:${speechEvent.id}` : null,
        ...normalizedAbilityClaims.map((claim, index) => `ability-claim:${speechEvent.id}:${index}`),
      ].filter(Boolean),
    });
    setFactionStrategyState(state, playerId, committedFactionStrategyUpdate, turn.id);
    applyInternalMemoryUpdate(state, playerId, internalMemoUpdate, turn.id);
  }

  rebuildPublicDerivedState(state);
  return result(true, '質問への回答を登録しました。', { eventId: speechEvent.id, aiTurnId: turn?.id ?? null });
}

/**
 * 責務: 人間が回答優先フェーズで入力した回答と任意のCO・能力結果公開を、無料の公開回答として登録する。
 * 変更ルール: 通常発言数・巡・発言順を変更せず、質問関連はシステムが固定し、CO・能力結果は通常発言と同じ公開検証を通す。
 */

export function recordHumanPriorityAnswer(state, input = {}) {
  const forbiddenKeys = Object.keys(input).filter((key) => !HUMAN_PRIORITY_ANSWER_INPUT_KEYS.has(key));
  if (forbiddenKeys.length) return result(false, `人間の優先回答入力では指定できない項目です: ${forbiddenKeys.join(', ')}`);
  return recordPriorityAnswerCore(state, { ...input, sourceType: 'human' });
}

/**
 * 責務: AIの回答優先フェーズ出力と任意のCO・能力結果・判断・陣営戦略更新を、通常発言進行を消費しない公開回答として登録する。
 * 変更ルール: 質問先・回答元はシステムが固定し、公開情報と本人限定の判断・陣営戦略を別保存先へ登録する。回答から新しい質問は登録しない。
 */

export function recordAiPriorityAnswer(state, input = {}) {
  const forbiddenKeys = Object.keys(input).filter((key) => !AI_PRIORITY_ANSWER_INPUT_KEYS.has(key));
  if (forbiddenKeys.length) return result(false, `AI優先回答登録では指定できない項目です: ${forbiddenKeys.join(', ')}`);
  return recordPriorityAnswerCore(state, { ...input, sourceType: 'ai' });
}

/**
 * 責務: AI必須回答本文を取得できない場合に、質問解決だけをスキップし、回収済みの本人限定判断・戦略・心の声・内部メモを保存する。
 * 変更ルール: 公開回答、CO、能力結果を捏造せず、GM限定の解決イベントとAIフォールバック監査ターンを分離して記録する。
 */

export function skipAiPriorityAnswer(state, {
  playerId,
  questionEventId,
  reason,
  heartVoice = '',
  internalMemoUpdate = null,
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  warnings = [],
  decisionUpdate = null,
  parsedDecisionUpdate = null,
  factionStrategyUpdate = null,
  parsedFactionStrategyUpdate = null,
  parsedAbilityClaims = null,
  resolvedInternalReasoningDirective = null,
} = {}) {
  const guard = commandGuard(state, { phases: ['discussion'] });
  if (guard) return guard;
  const pending = getCurrentPriorityAnswerTask(state);
  if (!pending) return result(false, '現在、回答優先フェーズはありません。');
  if (pending.questionEventId !== questionEventId || pending.targetPlayerId !== playerId) {
    return result(false, '現在の回答優先対象と一致しません。');
  }
  const normalizedReason = String(reason ?? '').trim();
  if (!normalizedReason) return result(false, '回答をスキップする理由を入力してください。');
  const committedDecisionUpdate = resolveDecisionUpdateForCommit(state, playerId, decisionUpdate, { taskType: 'priority-answer' });
  const factionStrategy = resolveFactionStrategyForCommit(state, playerId, factionStrategyUpdate);
  if (!factionStrategy.ok) return result(false, factionStrategy.errors.join('\n'));
  const resolutionEvent = createEvent(state, {
    type: 'priority-answer-resolution',
    actorId: null,
    targetIds: [pending.targetPlayerId],
    audience: { type: 'gm', targetIds: [] },
    payload: {
      questionEventId: pending.questionEventId,
      targetPlayerId: pending.targetPlayerId,
      resolution: 'skipped',
      reason: normalizedReason,
      source: 'ai-fallback',
    },
    status: 'confirmed',
  });
  setHeartVoice(state, playerId, heartVoice);
  const turn = recordAiTurn(state, {
    taskType: 'priority-answer-fallback',
    playerId,
    promptText,
    promptFingerprint,
    promptMode,
    publicSequenceAtGeneration,
    rawResponse,
    generationRun,
    parsedPublicSpeech: '',
    parsedHeartVoice: heartVoice,
    parsedInternalMemoUpdate: internalMemoUpdate,
    warnings,
    parsedCoOperation: { action: 'none', roleId: 'none' },
    parsedAbilityClaims: parsedAbilityClaims ?? null,
    resolvedAbilityClaims: [],
    parsedDecisionUpdate: parsedDecisionUpdate ?? null,
    resolvedDecisionUpdate: committedDecisionUpdate,
    parsedFactionStrategyUpdate: parsedFactionStrategyUpdate ?? null,
    resolvedFactionStrategyUpdate: factionStrategy.update,
    resolvedInternalReasoningDirective,
    committedEntityIds: [resolutionEvent.id],
  });
  setFactionStrategyState(state, playerId, factionStrategy.update, turn.id);
  applyInternalMemoryUpdate(state, playerId, internalMemoUpdate, turn.id);
  rebuildPublicDerivedState(state);
  return result(true, 'AI回答本文を取得できないため、質問への優先回答をスキップしました。', {
    resolutionEventId: resolutionEvent.id,
    aiTurnId: turn.id,
  });
}

/**
 * 責務: GM進行操作として現在話者のパスを登録する。
 * 変更ルール: 自由文の「なし」等から推定せず、明示操作だけで実行する。
 */

export function recordSpeechPass(state, { playerId } = {}) {
  return recordSpeechCore(state, { sourceType: 'gm', playerId, content: '', pass: true });
}

export function deferSpeech(state, playerId) {
  const guard = commandGuard(state, { phases: ['discussion'] });
  if (guard) return guard;
  const discussion = state.discussion;
  if (discussion.mode !== 'ordered') return result(false, '後回しは順番制でのみ使用できます。');
  if (discussion.queue[discussion.currentIndex] !== playerId) return result(false, '現在の発言者ではありません。');
  if (discussion.deferredPlayerIds.includes(playerId)) return result(false, '同じ巡で再度後回しにはできません。');
  discussion.deferredCountByPlayer ??= {};
  discussion.deferredCountByPlayer[playerId] = Number(discussion.deferredCountByPlayer[playerId] ?? 0) + 1;
  discussion.queue.splice(discussion.currentIndex, 1);
  discussion.queue.push(playerId);
  discussion.deferredPlayerIds.push(playerId);
  const eligible = orderedEligibleIds(state);
  if (eligible.length && eligible.every((id) => discussion.deferredPlayerIds.includes(id))) {
    discussion.allDeferred = true;
    return result(true, '発言可能者全員が後回しを選択しました。GM判断が必要です。', { allDeferred: true });
  }
  if (discussion.currentIndex >= discussion.queue.length) discussion.currentIndex = 0;
  return result(true, '発言者をこの巡の最後へ移動しました。');
}

export function resolveAllDeferred(state, action, playerId = null) {
  const guard = commandGuard(state, { phases: ['discussion'] });
  if (guard) return guard;
  if (!state.discussion?.allDeferred) return result(false, '全員後回し状態ではありません。');
  if (action === 'complete') {
    state.discussion.completed = true;
      return result(true, 'GM判断で昼議論を終了しました。');
  }
  state.discussion.deferredPlayerIds = [];
  state.discussion.allDeferred = false;
  if (action === 'designate' && playerId) {
    const index = state.discussion.queue.indexOf(playerId);
    if (index < 0) return result(false, '指定したプレイヤーは現在の発言候補ではありません。');
    state.discussion.currentIndex = index;
    return result(true, `${getPlayer(state, playerId).name}を発言者に指定しました。`);
  }
  return result(true, '後回し状態を解除し、同じ巡を再開しました。');
}

export function grantTargetedDiscussionReconsideration(state, playerIds = null) {
  const guard = commandGuard(state, { phases: ['discussion'] });
  if (guard) return guard;
  const discussion = state.discussion;
  const reconsideration = discussion?.reconsideration;
  if (!reconsideration?.pending) return result(false, '3巡目のCO後に追加発言が必要な対象者はいません。');
  const requested = playerIds?.length ? playerIds : reconsideration.affectedPlayerIds;
  const eligibleIds = new Set(getDiscussionEligiblePlayerIds(state));
  // 保存済み状態や明示指定の並びに依存せず、現在発言できる人物だけを通常巡と同じ順へ正規化する。
  const targets = orderAlivePlayerIds(
    state,
    (requested ?? []).filter((id) => eligibleIds.has(id)),
  );
  if (!targets.length) return result(false, '追加発言の対象者がいません。');
  targets.forEach((id) => {
    discussion.remainingByPlayer[id] = Number(discussion.remainingByPlayer[id] ?? 0) + 1;
  });
  beginDiscussionRound(state, { playerIds: targets, kind: 'targeted-response' });
  reconsideration.pending = false;
  reconsideration.active = true;
  reconsideration.handledRound = discussion.round;
  reconsideration.updatedAt = nowIso();
  return result(true, `${targets.length}人へCO再検討発言を1回ずつ許可しました。`, { playerIds: targets });
}

export function skipPriorityAnswer(state, { questionEventId, reason } = {}) {
  const guard = commandGuard(state, { phases: ['discussion'] });
  if (guard) return guard;
  const pending = getCurrentPriorityAnswerTask(state);
  if (!pending) return result(false, '現在、回答優先フェーズはありません。');
  if (pending.questionEventId !== questionEventId) return result(false, '現在の回答優先対象と一致しません。');
  const normalizedReason = String(reason ?? '').trim();
  if (!normalizedReason) return result(false, '回答をスキップする理由を入力してください。');
  const resolutionEvent = createEvent(state, {
    type: 'priority-answer-resolution',
    actorId: null,
    targetIds: [pending.targetPlayerId],
    audience: { type: 'gm', targetIds: [] },
    payload: {
      questionEventId: pending.questionEventId,
      targetPlayerId: pending.targetPlayerId,
      resolution: 'skipped',
      reason: normalizedReason,
    },
    status: 'confirmed',
  });
  return result(true, '質問への優先回答をGM判断でスキップしました。', { resolutionEventId: resolutionEvent.id });
}

export function finishDiscussion(state) {
  const guard = commandGuard(state, { phases: ['discussion'] });
  if (guard) return guard;
  if (getCurrentPriorityAnswerTask(state)) return result(false, '質問への優先回答を完了してから昼議論を終了してください。');
  state.discussion.completed = true;
  state.discussion.designatedPlayerId = null;
  return result(true, 'GM判断で昼議論を終了しました。');
}
