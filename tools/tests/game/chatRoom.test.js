/**
 * 責務: 人狼Stateから独立したチャットルームの参加者・内部メモ・通常巡回・質問専用回答・手動指定・Prompt/応答境界を検証する。
 * 変更ルール: UI形状、schema番号そのもの、会話きっかけ候補数や選択確率などの調整値は固定しない。履歴・内部メモ・質問・巡回・外部カタログ整合という利用者データと進行契約だけを確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  addAiMessage,
  addHumanMessage,
  beginChatRoom,
  consumeNextTurn,
  createChatRoomState,
  ensureNextTurn,
  forceNextSpeaker,
  getCharacterMemory,
  pendingQuestionsFor,
  reconcileChatRoomCharacters,
  replaceChatRoomParticipants,
  setCharacterMemory,
  setChatTopic,
} from '../../../app/renderer/js/domain/chat/chatRoomState.js';
import {
  buildChatRoomPromptEnvelope,
  parseChatRoomResponse,
} from '../../../app/renderer/js/prompts/chat/chatRoomPrompt.js';

const require = createRequire(import.meta.url);
const demoAi = require('../../../app/shared/demoAi.js');
const { flattenPromptEnvelope } = require('../../../app/main/llm/promptEnvelopeValidator.js');

const participants = Object.freeze([
  { characterId: 'char-a', profileId: 'profile-a' },
  { characterId: 'char-b', profileId: 'profile-b' },
  { characterId: 'char-c', profileId: 'profile-c' },
]);

function room({ mode = 'fixed', openingSeed = null, topic = '' } = {}) {
  const state = createChatRoomState({ participants });
  state.speakerMode = mode;
  state.topic = topic;
  return beginChatRoom(state, { openingSeed });
}

function card(id, name, extraCharacter = {}) {
  return {
    id,
    name,
    callNames: {},
    character: {
      profile: `${name}のプロフィール`,
      firstPerson: '私',
      genericSecondPerson: 'あなた',
      speakingStyle: '自然',
      defaultEndings: '',
      avoidedExpressions: '',
      speechLength: 'medium',
      speechExamples: '',
      ...extraCharacter,
    },
  };
}

const cards = Object.freeze([
  card('char-a', 'A', { discussionBehavior: 'NEVER_LEAK_DISCUSSION', reasoningProfile: { aggressiveness: 'NEVER_LEAK_REASONING' } }),
  card('char-b', 'B'),
  card('char-c', 'C'),
]);

function consumeTurnSpeaker(state) {
  return consumeNextTurn(state)?.speakerId ?? null;
}

function nextTurnSpeaker(state) {
  return ensureNextTurn(state)?.speakerId ?? null;
}

test('チャットルーム新規状態の自動会話一区切りは10発言を既定値とする', () => {
  const state = createChatRoomState({ participants });
  assert.equal(state.autoBatchSize, 10);
});
test('デモAIはチャットルーム専用応答を返しJSON例へ依存しない', () => {
  const state = room();
  setCharacterMemory(state, 'char-a', ['既存の内部メモ']);
  const envelope = buildChatRoomPromptEnvelope({
    state,
    speakerCard: cards[0],
    participantCards: cards,
    pendingQuestions: [],
    turn: { kind: 'round', speakerId: 'char-a' },
  });
  const parsed = parseChatRoomResponse(demoAi.generate({
    prompt: flattenPromptEnvelope(envelope),
    taskType: 'chat-room',
    playerName: 'A',
  }), {
    participantIds: ['char-a', 'char-b', 'char-c'],
    speakerId: 'char-a',
    fallbackMemory: getCharacterMemory(state, 'char-a'),
  });
  assert.equal(parsed.chatMessage, 'こんにちは。デモAIです。チャットルームの動作確認用に参加しています。');
  assert.deepEqual(parsed.memory, ['既存の内部メモ']);
});

test('デモAIはチャットルーム質問専用回答の元質問IDを引き継ぐ', () => {
  const state = room();
  const question = addHumanMessage(state, { text: 'Aに質問', targetId: 'char-a', targetName: 'A' });
  const turn = ensureNextTurn(state);
  const pending = pendingQuestionsFor(state, 'char-a').filter((item) => item.messageId === question.id);
  const envelope = buildChatRoomPromptEnvelope({ state, speakerCard: cards[0], participantCards: cards, pendingQuestions: pending, turn });
  const parsed = parseChatRoomResponse(demoAi.generate({
    prompt: flattenPromptEnvelope(envelope),
    taskType: 'chat-room',
    playerName: 'A',
  }), {
    participantIds: ['char-a', 'char-b', 'char-c'],
    speakerId: 'char-a',
    pendingMessageIds: [question.id],
    requiredAnswerMessageId: question.id,
  });
  assert.deepEqual(parsed.answersMessageIds, [question.id]);
});

test('プレイヤー名はチャット状態へ保持され人間発言とAI向け履歴へ反映される', () => {
  const state = room();
  state.playerName = 'ずんだあい';
  const message = addHumanMessage(state, { text: 'こんにちは' });
  assert.equal(message.speakerName, 'ずんだあい');
  const envelope = buildChatRoomPromptEnvelope({ state, speakerCard: cards[0], participantCards: cards, pendingQuestions: [] });
  assert.match(envelope.dynamicTaskPrompt, /ずんだあい: こんにちは/u);
});


test('内部メモはキャラクターごとに独立し発言者本人のPromptへだけ渡す', () => {
  const state = room();
  setCharacterMemory(state, 'char-a', ['プレイヤーは辛い物が苦手だと話した']);
  setCharacterMemory(state, 'char-b', ['プレイヤーは猫が好きだと話した']);
  const aEnvelope = buildChatRoomPromptEnvelope({ state, speakerCard: cards[0], participantCards: cards, pendingQuestions: [] });
  const bEnvelope = buildChatRoomPromptEnvelope({ state, speakerCard: cards[1], participantCards: cards, pendingQuestions: [] });
  assert.match(aEnvelope.dynamicTaskPrompt, /プレイヤーは辛い物が苦手/u);
  assert.doesNotMatch(aEnvelope.dynamicTaskPrompt, /プレイヤーは猫が好き/u);
  assert.match(bEnvelope.dynamicTaskPrompt, /プレイヤーは猫が好き/u);
  assert.doesNotMatch(bEnvelope.dynamicTaskPrompt, /プレイヤーは辛い物が苦手/u);
});

test('内部メモは追記ではなくAIが返した完成版で丸ごと置換する', () => {
  const state = room();
  setCharacterMemory(state, 'char-a', ['北海道出身だと聞いた', '温泉に興味がある']);
  setCharacterMemory(state, 'char-a', ['北海道出身という話は冗談だった', '温泉に興味がある']);
  assert.deepEqual(getCharacterMemory(state, 'char-a'), ['北海道出身という話は冗談だった', '温泉に興味がある']);
  assert.equal(getCharacterMemory(state, 'char-a').includes('北海道出身だと聞いた'), false);
});

test('内部メモは48発言より古い会話がPromptから外れても別枠で維持できる', () => {
  const state = room();
  setCharacterMemory(state, 'char-a', ['序盤でプレイヤーは北海道出身だと話した']);
  for (let index = 0; index < 60; index += 1) addHumanMessage(state, { text: `会話${index}` });
  const envelope = buildChatRoomPromptEnvelope({ state, speakerCard: cards[0], participantCards: cards, pendingQuestions: [] });
  assert.match(envelope.dynamicTaskPrompt, /序盤でプレイヤーは北海道出身だと話した/u);
  assert.doesNotMatch(envelope.dynamicTaskPrompt, /会話0(?:\n|$)/u);
  assert.match(envelope.dynamicTaskPrompt, /会話59/u);
});

test('チャット開始時は前セッションの内部メモを持ち越さない', () => {
  const state = createChatRoomState({ participants });
  setCharacterMemory(state, 'char-a', ['前セッションの記憶']);
  beginChatRoom(state);
  assert.deepEqual(state.characterMemories, {});
});

test('会話中の参加者変更はログ・お題・プレイヤー名と継続参加者の内部メモを保持し発言順だけ再構成する', () => {
  const state = room();
  state.topic = '夢の話';
  state.playerName = 'ずんだあい';
  setCharacterMemory(state, 'char-a', ['プレイヤーは猫が好き']);
  setCharacterMemory(state, 'char-c', ['退出前の個別メモ']);
  assert.equal(consumeTurnSpeaker(state), 'char-a');
  addAiMessage(state, { speakerId: 'char-a', speakerName: 'A', text: '最初の発言' });
  addHumanMessage(state, { text: 'Cに質問', targetId: 'char-c', targetName: 'C' });
  const messageSnapshot = state.messages.map((message) => ({ id: message.id, text: message.text }));

  const change = replaceChatRoomParticipants(state, [
    { characterId: 'char-a', profileId: 'profile-a-next' },
    { characterId: 'char-b', profileId: 'profile-b' },
    { characterId: 'char-d', profileId: 'profile-d' },
  ]);

  assert.deepEqual(change.addedIds, ['char-d']);
  assert.deepEqual(change.removedIds, ['char-c']);
  assert.deepEqual(state.messages.map((message) => ({ id: message.id, text: message.text })), messageSnapshot);
  assert.equal(state.topic, '夢の話');
  assert.equal(state.playerName, 'ずんだあい');
  assert.deepEqual(getCharacterMemory(state, 'char-a'), ['プレイヤーは猫が好き']);
  assert.deepEqual(getCharacterMemory(state, 'char-c'), []);
  assert.deepEqual(state.participants.map((item) => item.characterId), ['char-a', 'char-b', 'char-d']);
  assert.equal(state.participants[0].profileId, 'profile-a-next');
  assert.deepEqual(new Set(state.queue), new Set(['char-a', 'char-b', 'char-d']));
  assert.equal(state.queue.includes('char-c'), false);
  assert.equal(state.unresolvedQuestions.some((item) => item.targetId === 'char-c'), false);
});
test('固定巡回は1巡内で全参加者を一度ずつ発言させる', () => {
  const state = room();
  const spoken = [consumeTurnSpeaker(state), consumeTurnSpeaker(state), consumeTurnSpeaker(state)];
  assert.deepEqual(spoken, ['char-a', 'char-b', 'char-c']);
  assert.equal(new Set(spoken).size, participants.length);
  assert.equal(nextTurnSpeaker(state), 'char-a');
  assert.equal(state.round, 2);
});

test('ランダム巡回も1巡内では参加者を重複させない', () => {
  const state = room({ mode: 'random' });
  const spoken = participants.map(() => consumeTurnSpeaker(state));
  assert.equal(spoken.length, participants.length);
  assert.equal(new Set(spoken).size, participants.length);
  assert.deepEqual([...spoken].sort(), participants.map((item) => item.characterId).sort());
});

test('AI質問は質問1件ごとの回答ターンを追加し対象の通常巡回枠を消費しない', () => {
  const state = room();
  const first = consumeTurnSpeaker(state);
  assert.equal(first, 'char-a');
  const question = addAiMessage(state, { speakerId: first, speakerName: 'A', text: 'Cはどう？', questionTargetIds: ['char-c'] });
  assert.deepEqual(state.queue, ['char-b', 'char-c']);
  assert.deepEqual(ensureNextTurn(state), { kind: 'answer', speakerId: 'char-c', questionMessageId: question.id });
  assert.deepEqual(consumeNextTurn(state), { kind: 'answer', speakerId: 'char-c', questionMessageId: question.id });
  assert.deepEqual(state.queue, ['char-b', 'char-c']);
  assert.equal(state.spokenThisRound.includes('char-c'), false);
  assert.equal(consumeTurnSpeaker(state), 'char-b');
  assert.equal(consumeTurnSpeaker(state), 'char-c');
  assert.equal(state.spokenThisRound.filter((id) => id === 'char-c').length, 1);
});

test('同一キャラクターへの複数質問は同一巡内でも質問ごとに別回答ターンを保持する', () => {
  const state = room();
  assert.equal(consumeTurnSpeaker(state), 'char-a');
  const first = addAiMessage(state, { speakerId: 'char-a', speakerName: 'A', text: 'Cは夏と冬どっち？', questionTargetIds: ['char-c'] });
  const second = addAiMessage(state, { speakerId: 'char-b', speakerName: 'B', text: 'Cは海も好き？', questionTargetIds: ['char-c'] });
  assert.deepEqual(state.priorityTurns, [
    { kind: 'answer', speakerId: 'char-c', questionMessageId: first.id },
    { kind: 'answer', speakerId: 'char-c', questionMessageId: second.id },
  ]);
  assert.equal(consumeNextTurn(state).speakerId, 'char-c');
  assert.equal(consumeNextTurn(state).speakerId, 'char-c');
  assert.deepEqual(state.queue, ['char-b', 'char-c']);
});

test('質問優先OFFではAI質問を未解決として保持するが専用回答ターンは追加しない', () => {
  const state = room();
  state.questionPriority = false;
  assert.equal(consumeTurnSpeaker(state), 'char-a');
  addAiMessage(state, { speakerId: 'char-a', speakerName: 'A', text: 'Cはどう？', questionTargetIds: ['char-c'] });
  assert.equal(pendingQuestionsFor(state, 'char-c').length, 1);
  assert.deepEqual(state.priorityTurns, []);
  assert.equal(nextTurnSpeaker(state), 'char-b');
});

test('プレイヤーの特定キャラ指定は質問優先OFFでも専用回答ターンを追加し通常巡回枠を残す', () => {
  const state = room();
  state.questionPriority = false;
  assert.equal(consumeTurnSpeaker(state), 'char-a');
  const question = addHumanMessage(state, { text: 'Aにもう一度聞きたい', targetId: 'char-a', targetName: 'A' });
  assert.deepEqual(ensureNextTurn(state), { kind: 'answer', speakerId: 'char-a', questionMessageId: question.id });
  assert.equal(pendingQuestionsFor(state, 'char-a').length, 1);
  consumeNextTurn(state);
  assert.deepEqual(state.queue, ['char-b', 'char-c']);
});

test('プレイヤー全体発言はAI巡回キューと優先ターンを変更しない', () => {
  const state = room();
  const queueBefore = [...state.queue];
  const priorityBefore = [...state.priorityTurns];
  addHumanMessage(state, { text: 'みんなはどう思う？' });
  assert.deepEqual(state.queue, queueBefore);
  assert.deepEqual(state.priorityTurns, priorityBefore);
  assert.equal(state.messages.at(-1).kind, 'human');
});

test('明示的な次話者指定は通常巡回枠を手動優先ターンへ移し回答ターンより先にできる', () => {
  const state = room();
  const question = addHumanMessage(state, { text: 'Bに質問', targetId: 'char-b', targetName: 'B' });
  assert.equal(forceNextSpeaker(state, 'char-c'), true);
  assert.deepEqual(ensureNextTurn(state), { kind: 'manual', speakerId: 'char-c', questionMessageId: null });
  assert.equal(state.queue.includes('char-c'), false);
  consumeNextTurn(state);
  assert.deepEqual(ensureNextTurn(state), { kind: 'answer', speakerId: 'char-b', questionMessageId: question.id });
});

test('初回conversationSeedは最初の話者だけへ提示し初回発言後は再提示しない', () => {
  const state = room({ openingSeed: { subject: '夏休み', tone: '楽しそう' } });
  const firstId = state.opening.speakerId;
  const firstCard = cards.find((item) => item.id === firstId);
  const before = buildChatRoomPromptEnvelope({ state, speakerCard: firstCard, participantCards: cards, pendingQuestions: [] });
  assert.match(before.dynamicTaskPrompt, /夏休み/u);
  assert.match(before.dynamicTaskPrompt, /楽しそう/u);
  addAiMessage(state, { speakerId: firstId, speakerName: firstCard.name, text: '夏休み何しようかな。' });
  const after = buildChatRoomPromptEnvelope({ state, speakerCard: firstCard, participantCards: cards, pendingQuestions: [] });
  assert.doesNotMatch(after.dynamicTaskPrompt, /会話のきっかけとして「夏休み」/u);
});
test('お題変更は会話履歴へシステム発言として残し通常キューを変更しない', () => {
  const state = room();
  const before = [...state.queue];
  assert.equal(setChatTopic(state, '好きな食べ物'), true);
  assert.equal(state.topic, '好きな食べ物');
  assert.deepEqual(state.queue, before);
  assert.match(state.messages.at(-1).text, /好きな食べ物/u);
});

test('チャット応答解析は不正質問先・自己質問・未解決でない回答参照を除去する', () => {
  const parsed = parseChatRoomResponse(JSON.stringify({
    chatMessage: 'Bに聞いてみる。',
    memory: ['  プレイヤーは猫が好き  ', 'プレイヤーは猫が好き', '', 'Bとは映画の好みが違う'],
    interaction: {
      questionTargetIds: ['char-b', 'char-a', 'unknown', 'char-b'],
      answersMessageIds: ['msg-1', 'msg-unknown', 'msg-1'],
    },
  }), { participantIds: ['char-a', 'char-b', 'char-c'], speakerId: 'char-a', pendingMessageIds: ['msg-1'] });
  assert.deepEqual(parsed, {
    chatMessage: 'Bに聞いてみる。',
    memory: ['プレイヤーは猫が好き', 'Bとは映画の好みが違う'],
    questionTargetIds: ['char-b'],
    answersMessageIds: ['msg-1'],
  });
});


test('質問専用回答の解析は指定された元質問IDをanswersMessageIdsへ必須とする', () => {
  assert.throws(() => parseChatRoomResponse(JSON.stringify({
    chatMessage: '冬が好き。',
    memory: [],
    interaction: { questionTargetIds: [], answersMessageIds: [] },
  }), {
    participantIds: ['char-a', 'char-b'],
    speakerId: 'char-b',
    pendingMessageIds: ['msg-question'],
    requiredAnswerMessageId: 'msg-question',
  }), /質問専用回答ターン/u);
  const parsed = parseChatRoomResponse(JSON.stringify({
    chatMessage: '冬が好き。',
    memory: [],
    interaction: { questionTargetIds: [], answersMessageIds: ['msg-question'] },
  }), {
    participantIds: ['char-a', 'char-b'],
    speakerId: 'char-b',
    pendingMessageIds: ['msg-question'],
    requiredAnswerMessageId: 'msg-question',
  });
  assert.deepEqual(parsed.answersMessageIds, ['msg-question']);
});

test('Prompt-onlyモデルがmemoryを欠落した場合は既存メモを消さず保持する', () => {
  const parsed = parseChatRoomResponse(JSON.stringify({
    chatMessage: '続けよう。',
    interaction: { questionTargetIds: [], answersMessageIds: [] },
  }), {
    participantIds: ['char-a', 'char-b'],
    speakerId: 'char-a',
    fallbackMemory: ['維持すべき既存メモ'],
  });
  assert.deepEqual(parsed.memory, ['維持すべき既存メモ']);
});

test('回答済み質問は対象者の未解決一覧から解消される', () => {
  const state = room();
  const question = addHumanMessage(state, { text: 'Bはどう？', targetId: 'char-b', targetName: 'B' });
  assert.equal(pendingQuestionsFor(state, 'char-b').length, 1);
  addAiMessage(state, { speakerId: 'char-b', speakerName: 'B', text: '私はこう思う。', answersMessageIds: [question.id] });
  assert.deepEqual(pendingQuestionsFor(state, 'char-b'), []);
});
test('外部カタログから消えた参加者は履歴を保持したまま参照を一括除去し1人でもactiveセッションを維持する', () => {
  const state = room();
  setCharacterMemory(state, 'char-c', ['Cだけの内部メモ']);
  addHumanMessage(state, { text: 'Cへ質問', targetId: 'char-c', targetName: 'C' });
  addAiMessage(state, { speakerId: 'char-b', speakerName: 'B', text: 'Cにも聞きたい', questionTargetIds: ['char-c'] });
  const messages = state.messages.map((message) => ({ id: message.id, text: message.text }));

  const result = reconcileChatRoomCharacters(state, new Set(['char-a']));

  assert.deepEqual(result.removedIds.sort(), ['char-b', 'char-c']);
  assert.equal(result.insufficientParticipants, true);
  assert.equal(state.status, 'active');
  assert.deepEqual(state.participants.map((item) => item.characterId), ['char-a']);
  assert.deepEqual(state.messages.map((message) => ({ id: message.id, text: message.text })), messages);
  assert.equal(state.queue.every((id) => id === 'char-a'), true);
  assert.deepEqual(state.unresolvedQuestions, []);
  assert.deepEqual(getCharacterMemory(state, 'char-c'), []);
  assert.equal(nextTurnSpeaker(state), 'char-a');
});

test('未解決質問は質問者名を保持してPromptへ提示し保存件数を上限へ丸める', () => {
  const state = room();
  state.playerName = 'ずんだあい';
  const first = addHumanMessage(state, { text: 'Bはどう思う？', targetId: 'char-b', targetName: 'B' });
  for (let index = 0; index < 60; index += 1) addHumanMessage(state, { text: `別の会話${index}` });
  const pending = pendingQuestionsFor(state, 'char-b');
  assert.equal(pending[0].messageId, first.id);
  assert.equal(pending[0].fromName, 'ずんだあい');
  const envelope = buildChatRoomPromptEnvelope({ state, speakerCard: cards[1], participantCards: cards, pendingQuestions: pending });
  assert.match(envelope.dynamicTaskPrompt, /ずんだあいから: Bはどう思う？/u);

  for (let index = 0; index < 520; index += 1) {
    addHumanMessage(state, { text: `Bへの質問${index}`, targetId: 'char-b', targetName: 'B' });
  }
  assert.equal(state.unresolvedQuestions.length, 512);
  assert.equal(state.unresolvedQuestions.at(-1).text, 'Bへの質問519');
});
