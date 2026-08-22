/**
 * 責務: 人狼Game Stateと自由チャットStateから独立した観戦セッションの状態、推理観戦/神視点観戦、追っかけ再生位置、観戦者個別内部メモ、公開情報既読カーソル、公開更新リアクションキュー、プレイヤー観戦発言、質問回答/手動優先ターンを管理する。
 * 変更ルール: Game State・DOM・AI通信・Prompt生成を扱わない。追っかけ/リアルタイムはfollowingLiveとplaybackEventSequenceを正本とし、Game State自体を巻き戻さない。神視点でも秘密情報そのものは保存しない。観戦者内部メモと既読カーソルは本人ごとに分離し、質問回答は通常リアクション枠を消費しない。新しいゲームへ切り替わる場合は旧ゲームの観戦文脈を引き継がない。
 */

import { DATA_SCHEMA_KIND, getCurrentDataSchemaVersion } from '../../config/dataCompatibilityAdapter.js';
import { createId, nowIso } from '../../shared/utils.js';

export const SPECTATOR_ROOM_SCHEMA_VERSION = getCurrentDataSchemaVersion(DATA_SCHEMA_KIND.SPECTATOR_ROOM);
const MAX_MESSAGES = 1200;
const MAX_MEMORY_ITEMS = 24;
const MAX_MEMORY_ITEM_CHARS = 200;
const MAX_MEMORY_CHARS = 3200;
const MAX_UNRESOLVED_QUESTIONS = 256;
const MAX_PENDING_TURNS = 64;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function cleanId(value, fallback = '') {
  const id = String(value ?? '').trim();
  return ID_PATTERN.test(id) ? id : fallback;
}

function cleanParticipant(value) {
  return { characterId: String(value?.characterId ?? '').trim(), profileId: String(value?.profileId ?? '').trim() };
}

function uniqueParticipants(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).map(cleanParticipant).filter((item) => {
    if (!item.characterId || seen.has(item.characterId)) return false;
    seen.add(item.characterId);
    return true;
  });
}

export function normalizeSpectatorMemory(values) {
  const seen = new Set();
  const result = [];
  let total = 0;
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, MAX_MEMORY_ITEM_CHARS);
    if (!text || seen.has(text)) continue;
    if (total + text.length > MAX_MEMORY_CHARS) break;
    seen.add(text);
    result.push(text);
    total += text.length;
    if (result.length >= MAX_MEMORY_ITEMS) break;
  }
  return result;
}

function touch(state) {
  state.revision = Math.max(0, Number(state.revision ?? 0) || 0) + 1;
  state.updatedAt = nowIso();
}

function participantIds(state) {
  return state.participants.map((item) => item.characterId);
}

function participantIdSet(state) {
  return new Set(participantIds(state));
}

export function createSpectatorRoomState({ participants = [] } = {}) {
  const timestamp = nowIso();
  return {
    schemaVersion: SPECTATOR_ROOM_SCHEMA_VERSION,
    revision: 0,
    id: createId('spectator'),
    status: 'setup',
    sourceGameId: '',
    sourceGameTitle: '',
    observationMode: 'deduction',
    autoComment: true,
    reactionLevel: 'standard',
    startLogNumber: null,
    followingLive: true,
    playerName: 'プレイヤー',
    participants: uniqueParticipants(participants),
    messages: [],
    characterMemories: {},
    observerCursors: {},
    unresolvedQuestions: [],
    priorityTurns: [],
    reactionTurns: [],
    reactionCursor: 0,
    lastSpeakerId: null,
    playbackPublicRevision: 0,
    playbackEventSequence: 0,
    playbackFactSignature: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function normalizeSpectatorRoomState(raw) {
  if (!raw || Number(raw.schemaVersion) !== SPECTATOR_ROOM_SCHEMA_VERSION) return createSpectatorRoomState();
  const base = createSpectatorRoomState({ participants: raw.participants });
  const ids = new Set(base.participants.map((item) => item.characterId));
  const messages = (Array.isArray(raw.messages) ? raw.messages : []).slice(-MAX_MESSAGES).map((message, index) => ({
    id: cleanId(message?.id, createId('spectator-msg')),
    sequence: Math.max(1, Number(message?.sequence ?? index + 1) || index + 1),
    kind: ['ai', 'human', 'system', 'public'].includes(message?.kind) ? message.kind : 'system',
    speakerId: ids.has(String(message?.speakerId ?? '')) ? String(message.speakerId) : null,
    speakerName: String(message?.speakerName ?? ''),
    targetName: String(message?.targetName ?? ''),
    text: String(message?.text ?? ''),
    questionTargetIds: [...new Set((Array.isArray(message?.questionTargetIds) ? message.questionTargetIds : []).map(String))].filter((id) => ids.has(id)),
    answersMessageIds: (Array.isArray(message?.answersMessageIds) ? message.answersMessageIds : []).map(String),
    sourcePublicRevision: Math.max(0, Number(message?.sourcePublicRevision ?? 0) || 0),
    sourceRef: Math.max(0, Number(message?.sourceRef ?? 0) || 0),
    createdAt: String(message?.createdAt ?? nowIso()),
  }));
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const unresolvedQuestions = (Array.isArray(raw.unresolvedQuestions) ? raw.unresolvedQuestions : []).map((item) => ({
    messageId: String(item?.messageId ?? ''),
    fromId: String(item?.fromId ?? ''),
    fromName: String(item?.fromName ?? messageById.get(String(item?.messageId ?? ''))?.speakerName ?? ''),
    targetId: String(item?.targetId ?? ''),
    text: String(item?.text ?? messageById.get(String(item?.messageId ?? ''))?.text ?? ''),
    createdAt: String(item?.createdAt ?? nowIso()),
  })).filter((item, index, source) => (!item.fromId || ids.has(item.fromId)) && ids.has(item.targetId) && item.messageId
    && source.findIndex((other) => other.messageId === item.messageId && other.targetId === item.targetId) === index).slice(-MAX_UNRESOLVED_QUESTIONS);
  const unresolvedKeys = new Set(unresolvedQuestions.map((item) => `${item.messageId}\u0000${item.targetId}`));
  const normalizeTurn = (turn) => ({
    kind: turn?.kind === 'manual' ? 'manual' : turn?.kind === 'answer' ? 'answer' : 'reaction',
    speakerId: String(turn?.speakerId ?? ''),
    questionMessageId: turn?.questionMessageId ? String(turn.questionMessageId) : null,
    sourcePublicRevision: Math.max(0, Number(turn?.sourcePublicRevision ?? 0) || 0),
  });
  const priorityTurns = (Array.isArray(raw.priorityTurns) ? raw.priorityTurns : []).map(normalizeTurn).filter((turn) => {
    if (!ids.has(turn.speakerId)) return false;
    return turn.kind === 'manual' || (turn.kind === 'answer' && turn.questionMessageId && unresolvedKeys.has(`${turn.questionMessageId}\u0000${turn.speakerId}`));
  }).slice(0, MAX_PENDING_TURNS);
  const reactionTurns = (Array.isArray(raw.reactionTurns) ? raw.reactionTurns : []).map(normalizeTurn)
    .filter((turn) => turn.kind === 'reaction' && ids.has(turn.speakerId)).slice(0, MAX_PENDING_TURNS);
  const characterMemories = {};
  const observerCursors = {};
  ids.forEach((id) => {
    const memory = normalizeSpectatorMemory(raw.characterMemories?.[id]);
    if (memory.length) characterMemories[id] = memory;
    const cursor = raw.observerCursors?.[id];
    observerCursors[id] = {
      publicRevision: Math.max(0, Number(cursor?.publicRevision ?? 0) || 0),
      eventSequence: Math.max(0, Number(cursor?.eventSequence ?? 0) || 0),
    };
  });
  return {
    ...base,
    id: cleanId(raw.id, base.id),
    revision: Math.max(0, Number(raw.revision ?? 0) || 0),
    status: raw.status === 'active' ? 'active' : 'setup',
    sourceGameId: String(raw.sourceGameId ?? ''),
    sourceGameTitle: String(raw.sourceGameTitle ?? ''),
    observationMode: raw.observationMode === 'omniscient' ? 'omniscient' : 'deduction',
    autoComment: raw.autoComment !== false,
    reactionLevel: ['quiet', 'standard', 'lively'].includes(raw.reactionLevel) ? raw.reactionLevel : 'standard',
    playerName: String(raw.playerName ?? 'プレイヤー').trim().slice(0, 80) || 'プレイヤー',
    startLogNumber: raw.startLogNumber === null || raw.startLogNumber === undefined ? null : Math.max(1, Math.trunc(Number(raw.startLogNumber) || 1)),
    followingLive: raw.followingLive !== false,
    messages,
    characterMemories,
    observerCursors,
    unresolvedQuestions,
    priorityTurns,
    reactionTurns,
    reactionCursor: Math.max(0, Number(raw.reactionCursor ?? 0) || 0),
    lastSpeakerId: ids.has(String(raw.lastSpeakerId ?? '')) ? String(raw.lastSpeakerId) : null,
    playbackPublicRevision: Math.max(0, Number(raw.playbackPublicRevision ?? 0) || 0),
    playbackEventSequence: Math.max(0, Number(raw.playbackEventSequence ?? 0) || 0),
    playbackFactSignature: String(raw.playbackFactSignature ?? ''),
    createdAt: String(raw.createdAt ?? base.createdAt),
    updatedAt: String(raw.updatedAt ?? base.updatedAt),
  };
}

export function beginSpectatorRoom(state, { sourceGameId, sourceGameTitle } = {}) {
  if (state.participants.length < 2) throw new RangeError('観戦者は2人以上選択してください。');
  state.status = 'active';
  state.sourceGameId = String(sourceGameId ?? '');
  state.sourceGameTitle = String(sourceGameTitle ?? '');
  state.messages = [];
  state.characterMemories = {};
  state.observerCursors = Object.fromEntries(participantIds(state).map((id) => [id, { publicRevision: 0, eventSequence: 0 }]));
  state.unresolvedQuestions = [];
  state.priorityTurns = [];
  state.reactionTurns = [];
  state.reactionCursor = 0;
  state.lastSpeakerId = null;
  state.playbackPublicRevision = 0;
  state.playbackEventSequence = 0;
  state.playbackFactSignature = '';
  state.followingLive = true;
  touch(state);
  return state;
}

export function resetSpectatorForNewGame(state) {
  const next = createSpectatorRoomState({ participants: state.participants });
  next.observationMode = state.observationMode === 'omniscient' ? 'omniscient' : 'deduction';
  next.autoComment = state.autoComment;
  next.reactionLevel = state.reactionLevel;
  next.startLogNumber = state.startLogNumber;
  next.playerName = state.playerName;
  return next;
}

export function replaceSpectatorParticipants(state, participants) {
  const before = participantIds(state);
  const nextParticipants = uniqueParticipants(participants);
  const nextIds = new Set(nextParticipants.map((item) => item.characterId));
  const addedIds = nextParticipants.map((item) => item.characterId).filter((id) => !before.includes(id));
  const removedIds = before.filter((id) => !nextIds.has(id));
  state.participants = nextParticipants;
  removedIds.forEach((id) => {
    delete state.characterMemories[id];
    delete state.observerCursors[id];
  });
  addedIds.forEach((id) => { state.observerCursors[id] = { publicRevision: 0, eventSequence: 0 }; });
  state.unresolvedQuestions = state.unresolvedQuestions.filter((item) => nextIds.has(item.fromId) && nextIds.has(item.targetId));
  const unresolved = new Set(state.unresolvedQuestions.map((item) => `${item.messageId}\u0000${item.targetId}`));
  state.priorityTurns = state.priorityTurns.filter((turn) => nextIds.has(turn.speakerId)
    && (turn.kind === 'manual' || (turn.kind === 'answer' && unresolved.has(`${turn.questionMessageId}\u0000${turn.speakerId}`))));
  state.reactionTurns = state.reactionTurns.filter((turn) => nextIds.has(turn.speakerId));
  if (state.lastSpeakerId && !nextIds.has(state.lastSpeakerId)) state.lastSpeakerId = null;
  state.reactionCursor %= Math.max(1, nextParticipants.length);
  touch(state);
  return { addedIds, removedIds, orderChanged: before.join('\u0000') !== nextParticipants.map((item) => item.characterId).join('\u0000') };
}

export function reconcileSpectatorParticipants(state, availableCharacterIds) {
  const allowed = new Set((Array.isArray(availableCharacterIds) ? availableCharacterIds : []).map(String));
  const removedIds = state.participants.map((item) => item.characterId).filter((id) => !allowed.has(id));
  if (!removedIds.length) return { removedIds: [], insufficientParticipants: state.participants.length < 2 };
  replaceSpectatorParticipants(state, state.participants.filter((item) => allowed.has(item.characterId)));
  return { removedIds, insufficientParticipants: state.participants.length < 2 };
}

function addMessage(state, message) {
  const entry = {
    id: createId('spectator-msg'),
    sequence: (state.messages.at(-1)?.sequence ?? 0) + 1,
    kind: message.kind,
    speakerId: message.speakerId ?? null,
    speakerName: String(message.speakerName ?? ''),
    targetName: String(message.targetName ?? ''),
    text: String(message.text ?? '').trim(),
    questionTargetIds: [...new Set((message.questionTargetIds ?? []).map(String))],
    answersMessageIds: [...new Set((message.answersMessageIds ?? []).map(String))],
    sourcePublicRevision: Math.max(0, Number(message.sourcePublicRevision ?? 0) || 0),
    sourceRef: Math.max(0, Number(message.sourceRef ?? 0) || 0),
    createdAt: nowIso(),
  };
  state.messages.push(entry);
  if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  touch(state);
  return entry;
}

export function addSpectatorSystemMessage(state, text) {
  return addMessage(state, { kind: 'system', text });
}

export function addSpectatorPublicUpdate(state, text, { publicRevision = 0, eventSequence = 0 } = {}) {
  return addMessage(state, { kind: 'public', text, sourcePublicRevision: publicRevision, sourceRef: eventSequence });
}

function resolveAnsweredQuestions(state, speakerId, answersMessageIds) {
  const answered = new Set((answersMessageIds ?? []).map(String));
  if (!answered.size) return;
  state.unresolvedQuestions = state.unresolvedQuestions.filter((item) => !(item.targetId === speakerId && answered.has(item.messageId)));
  state.priorityTurns = state.priorityTurns.filter((turn) => !(turn.kind === 'answer' && turn.speakerId === speakerId && answered.has(String(turn.questionMessageId ?? ''))));
}

function scheduleQuestions(state, message) {
  const ids = participantIdSet(state);
  for (const targetId of message.questionTargetIds) {
    if (!ids.has(targetId) || targetId === message.speakerId) continue;
    const exists = state.unresolvedQuestions.some((item) => item.messageId === message.id && item.targetId === targetId);
    if (exists) continue;
    state.unresolvedQuestions.push({
      messageId: message.id,
      fromId: message.speakerId,
      fromName: message.speakerName,
      targetId,
      text: message.text,
      createdAt: message.createdAt,
    });
    if (!state.priorityTurns.some((turn) => turn.kind === 'answer' && turn.speakerId === targetId && turn.questionMessageId === message.id)) {
      state.priorityTurns.push({ kind: 'answer', speakerId: targetId, questionMessageId: message.id, sourcePublicRevision: message.sourcePublicRevision });
    }
  }
  if (state.unresolvedQuestions.length > MAX_UNRESOLVED_QUESTIONS) state.unresolvedQuestions.splice(0, state.unresolvedQuestions.length - MAX_UNRESOLVED_QUESTIONS);
  if (state.priorityTurns.length > MAX_PENDING_TURNS) state.priorityTurns.splice(MAX_PENDING_TURNS);
}

export function addSpectatorHumanMessage(state, { text, targetId = null, targetName = '', speakerName = state.playerName } = {}) {
  const ids = participantIdSet(state);
  const resolvedTargetId = targetId && ids.has(String(targetId)) ? String(targetId) : null;
  const message = addMessage(state, {
    kind: 'human',
    speakerId: null,
    speakerName: String(speakerName ?? state.playerName ?? 'プレイヤー').trim().slice(0, 80) || 'プレイヤー',
    targetName: resolvedTargetId ? String(targetName ?? '') : '',
    text,
    questionTargetIds: resolvedTargetId ? [resolvedTargetId] : [],
    sourcePublicRevision: state.playbackPublicRevision,
    sourceRef: state.playbackEventSequence,
  });
  if (resolvedTargetId) {
    scheduleQuestions(state, message);
    const answerIndex = state.priorityTurns.findIndex((turn) => turn.kind === 'answer' && turn.speakerId === resolvedTargetId && turn.questionMessageId === message.id);
    if (answerIndex > 0) state.priorityTurns.unshift(state.priorityTurns.splice(answerIndex, 1)[0]);
  }
  return message;
}

export function addSpectatorAiMessage(state, { speakerId, speakerName, text, questionTargetIds = [], answersMessageIds = [], sourcePublicRevision = 0, sourceRef = 0 } = {}) {
  resolveAnsweredQuestions(state, speakerId, answersMessageIds);
  const message = addMessage(state, { kind: 'ai', speakerId, speakerName, text, questionTargetIds, answersMessageIds, sourcePublicRevision, sourceRef });
  scheduleQuestions(state, message);
  state.lastSpeakerId = speakerId;
  touch(state);
  return message;
}

export function getSpectatorMemory(state, characterId) {
  return normalizeSpectatorMemory(state.characterMemories?.[characterId]);
}

export function setSpectatorMemory(state, characterId, memory) {
  if (!participantIdSet(state).has(characterId)) return false;
  state.characterMemories[characterId] = normalizeSpectatorMemory(memory);
  touch(state);
  return true;
}

export function pendingSpectatorQuestionsFor(state, characterId) {
  return state.unresolvedQuestions.filter((item) => item.targetId === characterId);
}

export function scheduleSpectatorReactionTurns(state, { count = 0, sourcePublicRevision = 0 } = {}) {
  const ids = participantIds(state);
  if (!ids.length) return 0;
  let scheduled = 0;
  let cursor = state.reactionCursor % ids.length;
  const existingForRevision = new Set(state.reactionTurns.filter((turn) => turn.sourcePublicRevision === sourcePublicRevision).map((turn) => turn.speakerId));
  for (let attempts = 0; attempts < ids.length * 2 && scheduled < count && state.reactionTurns.length < MAX_PENDING_TURNS; attempts += 1) {
    const speakerId = ids[cursor % ids.length];
    cursor += 1;
    if (existingForRevision.has(speakerId)) continue;
    existingForRevision.add(speakerId);
    state.reactionTurns.push({ kind: 'reaction', speakerId, questionMessageId: null, sourcePublicRevision: Math.max(0, Number(sourcePublicRevision ?? 0) || 0) });
    scheduled += 1;
  }
  state.reactionCursor = cursor % ids.length;
  if (scheduled) touch(state);
  return scheduled;
}

export function forceSpectatorSpeaker(state, characterId) {
  if (!participantIdSet(state).has(characterId)) return false;
  state.priorityTurns = state.priorityTurns.filter((turn) => !(turn.kind === 'manual' && turn.speakerId === characterId));
  state.priorityTurns.unshift({ kind: 'manual', speakerId: characterId, questionMessageId: null, sourcePublicRevision: state.playbackPublicRevision });
  touch(state);
  return true;
}

export function ensureSpectatorNextTurn(state) {
  const ids = participantIdSet(state);
  state.priorityTurns = state.priorityTurns.filter((turn) => ids.has(turn.speakerId));
  state.reactionTurns = state.reactionTurns.filter((turn) => ids.has(turn.speakerId));
  return state.priorityTurns[0] ?? state.reactionTurns[0] ?? null;
}

export function consumeSpectatorNextTurn(state) {
  const next = ensureSpectatorNextTurn(state);
  if (!next) return null;
  const turn = state.priorityTurns[0] === next ? state.priorityTurns.shift() : state.reactionTurns.shift();
  touch(state);
  return turn;
}

export function setSpectatorObserverCursor(state, characterId, { publicRevision = 0, eventSequence = 0 } = {}) {
  if (!participantIdSet(state).has(characterId)) return false;
  state.observerCursors[characterId] = {
    publicRevision: Math.max(0, Number(publicRevision ?? 0) || 0),
    eventSequence: Math.max(0, Number(eventSequence ?? 0) || 0),
  };
  touch(state);
  return true;
}

export function setSpectatorPlayback(state, { followingLive = state.followingLive, publicRevision = state.playbackPublicRevision, eventSequence = state.playbackEventSequence, factSignature = state.playbackFactSignature } = {}) {
  const nextFollowingLive = followingLive === true;
  const nextPublicRevision = Math.max(0, Number(publicRevision ?? 0) || 0);
  const nextEventSequence = Math.max(0, Number(eventSequence ?? 0) || 0);
  const nextSignature = String(factSignature ?? '');
  if (state.followingLive === nextFollowingLive
    && state.playbackPublicRevision === nextPublicRevision
    && state.playbackEventSequence === nextEventSequence
    && state.playbackFactSignature === nextSignature) return false;
  state.followingLive = nextFollowingLive;
  state.playbackPublicRevision = nextPublicRevision;
  state.playbackEventSequence = nextEventSequence;
  state.playbackFactSignature = nextSignature;
  touch(state);
  return true;
}

export function updateSpectatorSettings(state, { observationMode = state.observationMode, autoComment = state.autoComment, reactionLevel = state.reactionLevel, playerName = state.playerName, startLogNumber = state.startLogNumber } = {}) {
  const nextMode = observationMode === 'omniscient' ? 'omniscient' : 'deduction';
  const nextLevel = ['quiet', 'standard', 'lively'].includes(reactionLevel) ? reactionLevel : 'standard';
  const nextAutoComment = autoComment !== false;
  const nextPlayerName = String(playerName ?? state.playerName ?? 'プレイヤー').trim().slice(0, 80) || 'プレイヤー';
  const nextStartLogNumber = startLogNumber === null || startLogNumber === undefined || startLogNumber === ''
    ? null
    : Math.max(1, Math.trunc(Number(startLogNumber) || 1));
  if (state.observationMode === nextMode && state.autoComment === nextAutoComment && state.reactionLevel === nextLevel
    && state.playerName === nextPlayerName && state.startLogNumber === nextStartLogNumber) return false;
  state.observationMode = nextMode;
  state.autoComment = nextAutoComment;
  state.reactionLevel = nextLevel;
  state.playerName = nextPlayerName;
  state.startLogNumber = nextStartLogNumber;
  touch(state);
  return true;
}
