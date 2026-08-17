/**
 * 責務: 人狼進行から独立したチャットルームの状態生成、revision、プレイヤー名、キャラクター個別内部メモ、参加者差し替え・カタログ整合、通常巡回、質問回答/手動の優先ターン、会話きっかけ履歴、発言登録を決定的に扱う。
 * 変更ルール: DOM・AI通信・キャラクタープロンプト生成を行わない。通常巡回は原則1巡1人1回を維持し、明示質問への回答は通常巡回枠を消費しない専用ターンとして質問1件ごとに保持する。AI質問の専用回答化はquestionPriorityがONのときだけ、プレイヤーの特定キャラ指定は設定に関係なく専用回答化する。手動の「次に話す」は通常巡回枠の移動として扱う。内部メモは共有せずキャラクターIDごとに完成版を置換保存する。会話中の参加者変更では履歴・お題・プレイヤー名と継続参加者の内部メモを保持し、通常巡回だけを新構成で再開する。外部カタログから参加キャラクターが消えた場合は履歴を保持したまま孤立参照だけを除去し、2人未満なら会話を停止せず参加者補充待ちとして扱う。未解決質問は質問者名を保持して上限件数へ丸める。会話きっかけ履歴は選択済みcueのIDだけを短期保持し、Prompt文面や候補選択はprompts/chat配下へ委譲する。
 */

import { DATA_SCHEMA_KIND, getCurrentDataSchemaVersion } from '../../config/dataCompatibilityAdapter.js';
import { createId, nowIso, shuffle } from '../../shared/utils.js';
import { normalizeChatCharacterMemory } from './chatRoomMemory.js';

export const CHAT_ROOM_SCHEMA_VERSION = getCurrentDataSchemaVersion(DATA_SCHEMA_KIND.CHAT_ROOM);
const MAX_MESSAGES = 1200;
const MAX_UNRESOLVED_QUESTIONS = 512;
const MAX_PRIORITY_TURNS = 512;
const MAX_CONVERSATION_CUE_HISTORY = 12;
const CHAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function cleanChatId(value, fallback) {
  const id = String(value ?? '').trim();
  return CHAT_ID_PATTERN.test(id) ? id : fallback;
}

function cleanParticipant(value) {
  return {
    characterId: String(value?.characterId ?? '').trim(),
    profileId: String(value?.profileId ?? '').trim(),
  };
}

function uniqueParticipants(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).map(cleanParticipant).filter((item) => {
    if (!item.characterId || seen.has(item.characterId)) return false;
    seen.add(item.characterId);
    return true;
  });
}

export function createChatRoomState({ participants = [] } = {}) {
  const timestamp = nowIso();
  return {
    schemaVersion: CHAT_ROOM_SCHEMA_VERSION,
    revision: 0,
    id: createId('chat'),
    status: 'setup',
    topic: '',
    playerName: 'プレイヤー',
    speakerMode: 'random',
    questionPriority: true,
    autoBatchSize: 10,
    participants: uniqueParticipants(participants),
    queue: [],
    priorityTurns: [],
    spokenThisRound: [],
    round: 0,
    lastSpeakerId: null,
    opening: { speakerId: null, seed: null, consumed: false },
    messages: [],
    characterMemories: {},
    unresolvedQuestions: [],
    conversationCueHistory: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function normalizeChatRoomState(raw) {
  if (!raw || Number(raw.schemaVersion) !== CHAT_ROOM_SCHEMA_VERSION) return createChatRoomState();
  const base = createChatRoomState({ participants: raw.participants });
  const participantIds = new Set(base.participants.map((item) => item.characterId));
  const cleanIds = (items) => [...new Set((Array.isArray(items) ? items : []).map(String).filter((id) => participantIds.has(id)))];
  const status = raw.status === 'active' ? 'active' : 'setup';
  const playerName = String(raw.playerName ?? '').trim().slice(0, 80) || 'プレイヤー';
  const characterMemories = Object.fromEntries([...participantIds].map((characterId) => [
    characterId,
    normalizeChatCharacterMemory(raw.characterMemories?.[characterId]),
  ]).filter(([, memory]) => memory.length));
  const messages = (Array.isArray(raw.messages) ? raw.messages : []).slice(-MAX_MESSAGES).map((message, index) => ({
    id: String(message?.id ?? createId('chat-msg')),
    sequence: Number(message?.sequence ?? index + 1) || index + 1,
    kind: ['ai', 'human', 'system'].includes(message?.kind) ? message.kind : 'system',
    speakerId: message?.speakerId ? String(message.speakerId) : null,
    speakerName: String(message?.speakerName ?? ''),
    targetId: message?.targetId ? String(message.targetId) : null,
    targetName: String(message?.targetName ?? ''),
    text: String(message?.text ?? ''),
    questionTargetIds: cleanIds(message?.questionTargetIds),
    answersMessageIds: (Array.isArray(message?.answersMessageIds) ? message.answersMessageIds : []).map(String),
    createdAt: String(message?.createdAt ?? nowIso()),
  }));
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const seenQuestions = new Set();
  const unresolvedQuestions = (Array.isArray(raw.unresolvedQuestions) ? raw.unresolvedQuestions : []).map((item) => {
    const messageId = String(item?.messageId ?? '');
    const fromId = item?.fromId ? String(item.fromId) : null;
    const source = messageById.get(messageId);
    return {
      messageId,
      fromId,
      fromName: String(item?.fromName ?? source?.speakerName ?? (fromId === 'human' ? playerName : fromId ?? '')),
      targetId: String(item?.targetId ?? ''),
      text: String(item?.text ?? source?.text ?? ''),
      createdAt: String(item?.createdAt ?? source?.createdAt ?? nowIso()),
    };
  }).filter((item) => {
    if (!item.messageId || !participantIds.has(item.targetId)) return false;
    if (item.fromId && item.fromId !== 'human' && !participantIds.has(item.fromId)) return false;
    const key = `${item.messageId}\u0000${item.targetId}`;
    if (seenQuestions.has(key)) return false;
    seenQuestions.add(key);
    return true;
  }).slice(-MAX_UNRESOLVED_QUESTIONS);
  const unresolvedKeys = new Set(unresolvedQuestions.map((item) => `${item.messageId}\u0000${item.targetId}`));
  const seenPriorityAnswers = new Set();
  const seenPriorityManual = new Set();
  const priorityTurns = (Array.isArray(raw.priorityTurns) ? raw.priorityTurns : []).map((turn) => ({
    kind: turn?.kind === 'manual' ? 'manual' : 'answer',
    speakerId: String(turn?.speakerId ?? ''),
    questionMessageId: turn?.questionMessageId ? String(turn.questionMessageId) : null,
  })).filter((turn) => {
    if (!participantIds.has(turn.speakerId)) return false;
    if (turn.kind === 'manual') {
      if (seenPriorityManual.has(turn.speakerId)) return false;
      seenPriorityManual.add(turn.speakerId);
      return true;
    }
    const key = `${turn.questionMessageId ?? ''}\u0000${turn.speakerId}`;
    if (!turn.questionMessageId || !unresolvedKeys.has(key) || seenPriorityAnswers.has(key)) return false;
    seenPriorityAnswers.add(key);
    return true;
  }).slice(0, MAX_PRIORITY_TURNS);
  return {
    ...base,
    id: cleanChatId(raw.id, base.id),
    revision: Math.max(0, Number(raw.revision ?? 0) || 0),
    status,
    topic: String(raw.topic ?? ''),
    playerName,
    speakerMode: raw.speakerMode === 'fixed' ? 'fixed' : 'random',
    questionPriority: raw.questionPriority !== false,
    autoBatchSize: Math.min(100, Math.max(1, Number(raw.autoBatchSize ?? 10) || 10)),
    queue: cleanIds(raw.queue),
    priorityTurns,
    spokenThisRound: cleanIds(raw.spokenThisRound),
    round: Math.max(0, Number(raw.round ?? 0) || 0),
    lastSpeakerId: participantIds.has(String(raw.lastSpeakerId ?? '')) ? String(raw.lastSpeakerId) : null,
    opening: {
      speakerId: participantIds.has(String(raw.opening?.speakerId ?? '')) ? String(raw.opening.speakerId) : null,
      seed: raw.opening?.seed && typeof raw.opening.seed === 'object'
        ? {
          id: String(raw.opening.seed.id ?? ''),
          source: raw.opening.seed.source === 'system' ? 'system' : 'character',
          subject: String(raw.opening.seed.subject ?? ''),
          tone: String(raw.opening.seed.tone ?? ''),
        }
        : null,
      consumed: raw.opening?.consumed === true,
    },
    characterMemories,
    messages,
    unresolvedQuestions,
    conversationCueHistory: [...new Set((Array.isArray(raw.conversationCueHistory) ? raw.conversationCueHistory : []).map((value) => String(value ?? '').trim()).filter(Boolean))].slice(-MAX_CONVERSATION_CUE_HISTORY),
    createdAt: String(raw.createdAt ?? base.createdAt),
    updatedAt: String(raw.updatedAt ?? base.updatedAt),
  };
}

function participantIds(state) {
  return state.participants.map((item) => item.characterId);
}

function touchState(state, timestamp = nowIso()) {
  state.revision = Math.max(0, Number(state.revision ?? 0) || 0) + 1;
  state.updatedAt = timestamp;
  return state.revision;
}

function trimUnresolvedQuestions(state) {
  if (state.unresolvedQuestions.length > MAX_UNRESOLVED_QUESTIONS) {
    state.unresolvedQuestions.splice(0, state.unresolvedQuestions.length - MAX_UNRESOLVED_QUESTIONS);
  }
}

function createRoundQueue(state) {
  const ids = participantIds(state);
  state.spokenThisRound = [];
  state.round += 1;
  const orderedIds = state.speakerMode === 'random' ? shuffle(ids) : ids;
  state.queue = [...orderedIds];
  if (state.queue.length > 1 && state.queue[0] === state.lastSpeakerId) {
    const swapIndex = state.queue.findIndex((id) => id !== state.lastSpeakerId);
    if (swapIndex > 0) [state.queue[0], state.queue[swapIndex]] = [state.queue[swapIndex], state.queue[0]];
  }
}

export function beginChatRoom(state, { openingSeed = null } = {}) {
  if (state.participants.length < 2) throw new RangeError('チャットルームには2人以上のキャラクターが必要です。');
  state.status = 'active';
  state.queue = [];
  state.priorityTurns = [];
  state.spokenThisRound = [];
  state.round = 0;
  state.lastSpeakerId = null;
  state.messages = [];
  state.characterMemories = {};
  state.unresolvedQuestions = [];
  state.conversationCueHistory = [];
  createRoundQueue(state);
  state.opening = {
    speakerId: state.queue[0] ?? null,
    seed: openingSeed ? {
      id: String(openingSeed.id ?? ''),
      source: openingSeed.source === 'system' ? 'system' : 'character',
      subject: String(openingSeed.subject ?? ''),
      tone: String(openingSeed.tone ?? ''),
    } : null,
    consumed: false,
  };
  touchState(state);
  return state;
}

function unresolvedQuestionKeys(state) {
  return new Set((Array.isArray(state.unresolvedQuestions) ? state.unresolvedQuestions : []).map((item) => `${String(item?.messageId ?? '')}\u0000${String(item?.targetId ?? '')}`));
}

function prunePriorityTurns(state) {
  const ids = new Set(participantIds(state));
  const unresolved = unresolvedQuestionKeys(state);
  const seenAnswers = new Set();
  const seenManual = new Set();
  state.priorityTurns = (Array.isArray(state.priorityTurns) ? state.priorityTurns : []).map((turn) => ({
    kind: turn?.kind === 'manual' ? 'manual' : 'answer',
    speakerId: String(turn?.speakerId ?? ''),
    questionMessageId: turn?.questionMessageId ? String(turn.questionMessageId) : null,
  })).filter((turn) => {
    if (!ids.has(turn.speakerId)) return false;
    if (turn.kind === 'manual') {
      if (seenManual.has(turn.speakerId)) return false;
      seenManual.add(turn.speakerId);
      return true;
    }
    if (!turn.questionMessageId) return false;
    const key = `${turn.questionMessageId}\u0000${turn.speakerId}`;
    if (!unresolved.has(key) || seenAnswers.has(key)) return false;
    seenAnswers.add(key);
    return true;
  }).slice(0, MAX_PRIORITY_TURNS);
}

export function ensureNextTurn(state) {
  if (state.status !== 'active') return null;
  prunePriorityTurns(state);
  if (state.priorityTurns.length) return { ...state.priorityTurns[0] };
  if (state.participants.length < 2) {
    const speakerId = state.queue[0] ?? state.participants[0]?.characterId ?? null;
    return speakerId ? { kind: 'round', speakerId, questionMessageId: null } : null;
  }
  if (!state.queue.length) createRoundQueue(state);
  const speakerId = state.queue[0] ?? null;
  return speakerId ? { kind: 'round', speakerId, questionMessageId: null } : null;
}

export function consumeNextTurn(state) {
  const turn = ensureNextTurn(state);
  if (!turn) return null;
  if (turn.kind === 'answer') {
    state.priorityTurns.shift();
  } else if (turn.kind === 'manual') {
    state.priorityTurns.shift();
    state.queue = state.queue.filter((candidate) => candidate !== turn.speakerId);
    if (!state.spokenThisRound.includes(turn.speakerId)) state.spokenThisRound.push(turn.speakerId);
  } else {
    state.queue.shift();
    if (!state.spokenThisRound.includes(turn.speakerId)) state.spokenThisRound.push(turn.speakerId);
  }
  state.lastSpeakerId = turn.speakerId;
  touchState(state);
  return turn;
}

function enqueueAnswerTurn(state, targetId, questionMessageId, { ignoreQuestionPriority = false } = {}) {
  const speakerId = String(targetId ?? '');
  const messageId = String(questionMessageId ?? '');
  if ((!state.questionPriority && !ignoreQuestionPriority) || !participantIds(state).includes(speakerId) || !messageId) return false;
  prunePriorityTurns(state);
  if (state.priorityTurns.some((turn) => turn.kind === 'answer' && turn.speakerId === speakerId && turn.questionMessageId === messageId)) return false;
  state.priorityTurns.push({ kind: 'answer', speakerId, questionMessageId: messageId });
  if (state.priorityTurns.length > MAX_PRIORITY_TURNS) state.priorityTurns.splice(MAX_PRIORITY_TURNS);
  touchState(state);
  return true;
}

export function forceNextSpeaker(state, targetId) {
  const id = String(targetId ?? '');
  if (!participantIds(state).includes(id)) return false;
  prunePriorityTurns(state);
  state.priorityTurns = state.priorityTurns.filter((turn) => !(turn.kind === 'manual' && turn.speakerId === id));
  state.queue = state.queue.filter((candidate) => candidate !== id);
  state.priorityTurns.unshift({ kind: 'manual', speakerId: id, questionMessageId: null });
  touchState(state);
  return true;
}

function appendMessage(state, message) {
  const next = {
    id: createId('chat-msg'),
    sequence: (state.messages.at(-1)?.sequence ?? 0) + 1,
    createdAt: nowIso(),
    questionTargetIds: [],
    answersMessageIds: [],
    targetId: null,
    targetName: '',
    ...message,
  };
  state.messages.push(next);
  if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  touchState(state, next.createdAt);
  return next;
}

export function addSystemMessage(state, text) {
  return appendMessage(state, { kind: 'system', speakerId: null, speakerName: 'システム', text: String(text ?? '') });
}

export function addHumanMessage(state, { text, targetId = null, targetName = '', speakerName = '' } = {}) {
  const message = appendMessage(state, {
    kind: 'human',
    speakerId: 'human',
    speakerName: String(speakerName ?? '').trim().slice(0, 80) || String(state.playerName ?? '').trim().slice(0, 80) || 'プレイヤー',
    targetId: targetId ? String(targetId) : null,
    targetName: String(targetName ?? ''),
    text: String(text ?? '').trim(),
    questionTargetIds: targetId ? [String(targetId)] : [],
  });
  if (targetId) {
    state.unresolvedQuestions.push({
      messageId: message.id,
      fromId: 'human',
      fromName: message.speakerName,
      targetId: String(targetId),
      text: message.text,
      createdAt: message.createdAt,
    });
    trimUnresolvedQuestions(state);
    enqueueAnswerTurn(state, targetId, message.id, { ignoreQuestionPriority: true });
  }
  return message;
}

export function addAiMessage(state, { speakerId, speakerName, text, questionTargetIds = [], answersMessageIds = [], consumeOpening = true } = {}) {
  const participantSet = new Set(participantIds(state));
  const targets = [...new Set((Array.isArray(questionTargetIds) ? questionTargetIds : []).map(String))]
    .filter((id) => participantSet.has(id) && id !== String(speakerId));
  const answerIds = [...new Set((Array.isArray(answersMessageIds) ? answersMessageIds : []).map(String))];
  const message = appendMessage(state, {
    kind: 'ai',
    speakerId: String(speakerId ?? ''),
    speakerName: String(speakerName ?? ''),
    text: String(text ?? '').trim(),
    questionTargetIds: targets,
    answersMessageIds: answerIds,
  });
  if (answerIds.length) {
    const answerSet = new Set(answerIds);
    state.unresolvedQuestions = state.unresolvedQuestions.filter((item) => !(item.targetId === String(speakerId) && answerSet.has(item.messageId)));
  }
  targets.forEach((targetId) => {
    state.unresolvedQuestions.push({
      messageId: message.id,
      fromId: String(speakerId),
      fromName: message.speakerName,
      targetId,
      text: message.text,
      createdAt: message.createdAt,
    });
    trimUnresolvedQuestions(state);
    enqueueAnswerTurn(state, targetId, message.id);
  });
  prunePriorityTurns(state);
  if (consumeOpening && !state.opening.consumed && state.opening.speakerId === String(speakerId)) state.opening.consumed = true;
  return message;
}



export function rememberConversationCue(state, cueId) {
  const id = String(cueId ?? '').trim();
  if (!id) return false;
  const history = (Array.isArray(state.conversationCueHistory) ? state.conversationCueHistory : []).filter((value) => value !== id);
  history.push(id);
  state.conversationCueHistory = history.slice(-MAX_CONVERSATION_CUE_HISTORY);
  touchState(state);
  return true;
}

export function getCharacterMemory(state, characterId) {
  return normalizeChatCharacterMemory(state?.characterMemories?.[String(characterId ?? '')]);
}

export function setCharacterMemory(state, characterId, memory) {
  const id = String(characterId ?? '');
  if (!participantIds(state).includes(id)) return false;
  const next = normalizeChatCharacterMemory(memory);
  if (!state.characterMemories || typeof state.characterMemories !== 'object' || Array.isArray(state.characterMemories)) state.characterMemories = {};
  if (next.length) state.characterMemories[id] = next;
  else delete state.characterMemories[id];
  touchState(state);
  return true;
}

export function replaceChatRoomParticipants(state, participants) {
  const previous = uniqueParticipants(state?.participants);
  const next = uniqueParticipants(participants);
  if (state?.status === 'active' && next.length < 2) throw new RangeError('会話中の参加者は2人以上必要です。');

  const previousIds = new Set(previous.map((item) => item.characterId));
  const nextIds = new Set(next.map((item) => item.characterId));
  const addedIds = next.filter((item) => !previousIds.has(item.characterId)).map((item) => item.characterId);
  const removedIds = previous.filter((item) => !nextIds.has(item.characterId)).map((item) => item.characterId);
  const orderChanged = previous.map((item) => item.characterId).join('\u0000') !== next.map((item) => item.characterId).join('\u0000');
  const participantSetChanged = addedIds.length > 0 || removedIds.length > 0 || orderChanged;
  const hadSpokenThisRound = (Array.isArray(state.spokenThisRound) ? state.spokenThisRound : []).some((id) => previousIds.has(String(id)));

  state.participants = next;
  if (!participantSetChanged) {
    touchState(state);
    return { addedIds, removedIds, orderChanged: false };
  }

  state.queue = [];
  state.priorityTurns = (Array.isArray(state.priorityTurns) ? state.priorityTurns : [])
    .filter((turn) => turn?.kind === 'answer' && nextIds.has(String(turn?.speakerId ?? '')));
  state.spokenThisRound = [];
  state.lastSpeakerId = nextIds.has(String(state.lastSpeakerId ?? '')) ? String(state.lastSpeakerId) : null;
  state.unresolvedQuestions = (Array.isArray(state.unresolvedQuestions) ? state.unresolvedQuestions : [])
    .filter((item) => {
      const fromId = item?.fromId ? String(item.fromId) : null;
      return nextIds.has(String(item?.targetId ?? '')) && (!fromId || fromId === 'human' || nextIds.has(fromId));
    });
  prunePriorityTurns(state);

  if (!state.characterMemories || typeof state.characterMemories !== 'object' || Array.isArray(state.characterMemories)) state.characterMemories = {};
  Object.keys(state.characterMemories).forEach((characterId) => {
    if (!nextIds.has(characterId)) delete state.characterMemories[characterId];
  });

  if (state.status === 'active') {
    if (hadSpokenThisRound) state.round = Math.max(0, Number(state.round ?? 0) || 0);
    else state.round = Math.max(1, Number(state.round ?? 1) || 1) - 1;
    createRoundQueue(state);
    if (!state.opening?.consumed) {
      state.opening = { speakerId: state.queue[0] ?? null, seed: null, consumed: false };
    }
  }

  touchState(state);
  return { addedIds, removedIds, orderChanged };
}

export function reconcileChatRoomCharacters(state, availableCharacterIds) {
  const availableValues = Array.isArray(availableCharacterIds)
    ? availableCharacterIds
    : availableCharacterIds instanceof Set ? [...availableCharacterIds] : [];
  const available = new Set(availableValues.map(String));
  const previous = uniqueParticipants(state?.participants);
  const removedIds = previous.filter((item) => !available.has(item.characterId)).map((item) => item.characterId);
  if (!removedIds.length) return { removedIds: [], insufficientParticipants: state.status === 'active' && previous.length < 2 };

  const next = previous.filter((item) => available.has(item.characterId));
  const nextIds = new Set(next.map((item) => item.characterId));
  state.participants = next;
  state.queue = (Array.isArray(state.queue) ? state.queue : []).filter((id) => nextIds.has(String(id)));
  state.priorityTurns = (Array.isArray(state.priorityTurns) ? state.priorityTurns : []).filter((turn) => nextIds.has(String(turn?.speakerId ?? '')));
  state.spokenThisRound = (Array.isArray(state.spokenThisRound) ? state.spokenThisRound : []).filter((id) => nextIds.has(String(id)));
  state.lastSpeakerId = nextIds.has(String(state.lastSpeakerId ?? '')) ? String(state.lastSpeakerId) : null;
  state.unresolvedQuestions = (Array.isArray(state.unresolvedQuestions) ? state.unresolvedQuestions : []).filter((item) => {
    const fromId = item?.fromId ? String(item.fromId) : null;
    return nextIds.has(String(item?.targetId ?? '')) && (!fromId || fromId === 'human' || nextIds.has(fromId));
  });
  prunePriorityTurns(state);

  if (!state.characterMemories || typeof state.characterMemories !== 'object' || Array.isArray(state.characterMemories)) state.characterMemories = {};
  Object.keys(state.characterMemories).forEach((characterId) => {
    if (!nextIds.has(characterId)) delete state.characterMemories[characterId];
  });

  if (!state.opening?.consumed && !nextIds.has(String(state.opening?.speakerId ?? ''))) {
    state.opening = { speakerId: state.queue[0] ?? next[0]?.characterId ?? null, seed: null, consumed: false };
  }
  touchState(state);
  return { removedIds, insufficientParticipants: state.status === 'active' && next.length < 2 };
}

export function pendingQuestionsFor(state, speakerId) {
  return state.unresolvedQuestions.filter((item) => item.targetId === String(speakerId));
}

export function setChatTopic(state, topic) {
  const next = String(topic ?? '').trim();
  if (next === state.topic) return false;
  state.topic = next;
  addSystemMessage(state, next ? `お題が「${next}」に変わりました。` : 'お題の指定を解除しました。');
  return true;
}
