/**
 * 責務: AIの公開ゲーム事実と本人専用・秘密会話・GM監査情報の保存および可視範囲を検証する。
 * 変更ルール: 「公開しない」と「保存しない」、「共有停止」と「生成停止」を混同しない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { recordAiSpeech, recordHumanSpeech } from '../../../app/renderer/js/domain/discussion/discussionCommands.js';
import { createEvent } from '../../../app/renderer/js/domain/events/eventStore.js';
import { rebuildPlayerMemoryLedger } from '../../../app/renderer/js/domain/memory/memoryLedger.js';
import { buildPromptContext } from '../../../app/renderer/js/prompts/promptBuilder.js';
import { buildPlayerVisibleContext } from '../../../app/renderer/js/prompts/context/promptContext.js';
import { buildPublicSnapshot } from '../../../app/renderer/js/public/publicSnapshot.js';
import { buildStandalonePublicHtml } from '../../../app/renderer/js/public/publicHtmlExport.js';
import { correctPublicSpeech, enterCorrectionMode, publishGameResult, recordAiPriorityAnswer } from '../../../app/renderer/js/domain/game/gameRuntime.js';
import { renderPublicSnapshot } from '../../../app/renderer/js/ui/views/public/publicView.js';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';

function fixture() {
  const state = createInitialState(6);
  state.game.phase = 'discussion';
  state.game.day = 1;
  state.players.forEach((player, index) => {
    player.roleId = index < 2 ? 'wolf' : 'villager';
  });
  const ids = state.players.map((player) => player.id);
  state.discussion = {
    day: 1, mode: 'ordered', modeControl: null, round: 1, roundKind: 'normal', roundStartedAtSequence: 0,
    roundEligiblePlayerIds: [...ids], queue: [...ids], currentIndex: 0, designatedPlayerId: null,
    spokenInCurrentRound: [], deferredPlayerIds: [],
    deferredCountByPlayer: Object.fromEntries(ids.map((id) => [id, 0])), allDeferred: false,
    remainingByPlayer: Object.fromEntries(ids.map((id) => [id, 3])),
    reconsideration: { pending: false, active: false, items: [], reasons: [], sourceEventIds: [], affectedPlayerIds: [], updatedAt: null, handledRound: null },
    completed: false,
  };
  state.playerKnowledge[state.players[0].id] = {
    knownWolfIds: [state.players[0].id, state.players[1].id], knownMadmanIds: [], knownMasonIds: [],
    roleNotifiedAt: null, knowledgeRevision: 0,
  };
  state.playerKnowledge[state.players[1].id] = {
    knownWolfIds: [state.players[0].id, state.players[1].id], knownMadmanIds: [], knownMasonIds: [],
    roleNotifiedAt: null, knowledgeRevision: 0,
  };
  return state;
}

function decisionUpdate(targetId) {
  return {
    suspicionCandidateIds: [targetId], executionCandidateIds: [targetId], intendedVoteId: targetId,
    assessmentLevel: 'slight', leaveAliveBenefit: '追加情報を得られる', misexecutionCost: '誤処刑の損失',
    selectionDifference: '公開説明の差', uncertainty: '回答待ち', nextDiscriminatingInformation: '次の公開回答',
    decisionReason: '公開された説明を比較するため',
  };
}

test('AI私有情報を生成・保存しつつ公開イベントへ格納しない', () => {
  const state = fixture();
  const actor = state.players[0];
  const target = state.players[2];
  actor.factionStrategyState = {
    profile: 'wolf', publicWorld: '', dayWinPath: '', partnerDisposition: '', collapsePlan: '', failureRisk: '',
    updatedAt: null, sourceAiTurnId: null,
  };
  const factionStrategyUpdate = {
    publicWorld: '公開情報だけで対象比較が成立する',
    dayWinPath: '必要票を一票動かして生存する',
    partnerDisposition: 'independent',
    collapsePlan: '仲間が崩れたら本人だけの公開説明へ縮小する',
    failureRisk: '票移動に失敗して処刑候補へ固定される',
  };
  const response = recordAiSpeech(state, {
    playerId: actor.id,
    content: '公開情報を比較します。',
    heartVoice: 'これは本人だけの心の声です。',
    internalMemoUpdate: { mode: 'add', text: '本人だけの内部継続メモ' },
    coOperation: { action: 'none', roleId: 'none' },
    decisionUpdate: decisionUpdate(target.id),
    factionStrategyUpdate,
  });
  assert.equal(response.ok, true, response.message);
  const event = state.events.find((item) => item.id === response.eventId);
  const turn = state.aiTurns.find((item) => item.id === response.aiTurnId);
  assert.equal(turn.parsedHeartVoice, 'これは本人だけの心の声です。');
  assert.equal(actor.internalMemory.notes.at(-1).text, '本人だけの内部継続メモ');
  assert.deepEqual(actor.decisionState.suspicionCandidateIds, [target.id]);
  assert.equal(actor.factionStrategyState.dayWinPath, factionStrategyUpdate.dayWinPath);
  assert.deepEqual(Object.keys(event.payload.structured).sort(), ['abilityClaims', 'coOperation', 'interaction']);
  for (const secret of ['心の声', '内部継続メモ', 'dayWinPath', 'decisionUpdate', 'sourceAiTurnId']) {
    assert.equal(JSON.stringify(event).includes(secret), false, `公開イベントへ${secret}が混入しています。`);
  }
});



test('プロンプト盤面は未訂正発言へ自己IDだけの訂正系列を付けず、実際の訂正系列だけを保持する', () => {
  const state = fixture();
  const actor = state.players[0];
  const ordinary = createEvent(state, {
    type: 'public-speech',
    actorId: actor.id,
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload: { text: '未訂正の通常発言です。' },
  });
  const original = createEvent(state, {
    type: 'public-speech',
    actorId: actor.id,
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload: { text: '訂正前の発言です。' },
  });
  const replacement = createEvent(state, {
    type: 'public-speech',
    actorId: actor.id,
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload: { text: '訂正後の発言です。', correctsEventId: original.id },
  });
  original.status = 'voided';

  const context = buildPlayerVisibleContext(state, state.players[1].id, { taskType: 'speech' });
  const speeches = context.board.publicTimeline.speeches;
  const ordinaryContext = speeches.find((event) => event.id === ordinary.id);
  const replacementContext = speeches.find((event) => event.id === replacement.id);

  assert.equal(Object.hasOwn(ordinaryContext, 'correctionLineageIds'), false);
  assert.deepEqual(replacementContext.correctionLineageIds, [original.id, replacement.id]);
  assert.equal(replacementContext.sequence, original.sequence);
});

test('心の声はGM監査で閲覧できるが通常公開と他AIプロンプトへ出ない', () => {
  const state = fixture();
  const actor = state.players[0];
  const response = recordAiSpeech(state, {
    playerId: actor.id, content: '公開本文', heartVoice: '監査専用の心の声',
    internalMemoUpdate: { mode: 'add', text: '監査専用メモ' },
    coOperation: { action: 'none', roleId: 'none' },
  });
  assert.equal(response.ok, true, response.message);
  const publicSnapshot = buildPublicSnapshot(state);
  const auditSnapshot = buildPublicSnapshot(state, { includeConfidential: true });
  assert.equal(JSON.stringify(publicSnapshot).includes('監査専用の心の声'), false);
  assert.equal(auditSnapshot.events.find((event) => event.id === response.eventId).confidential.heartVoice, '監査専用の心の声');
  const otherPrompt = buildPromptContext(state, state.players[1].id, { taskType: 'speech' });
  assert.equal(otherPrompt.text.includes('監査専用の心の声'), false);
  assert.equal(otherPrompt.text.includes('監査専用メモ'), false);
});


test('公開HTMLは選択済みスナップショットだけを固定化し非表示版へ機密情報や切替機能を持ち込まない', () => {
  const state = fixture();
  const actor = state.players[0];
  const secretHeartVoice = 'HTML内部にも残してはいけない監査専用の心の声';
  const response = recordAiSpeech(state, {
    playerId: actor.id,
    content: 'HTMLへ掲載する公開本文',
    heartVoice: secretHeartVoice,
    coOperation: { action: 'none', roleId: 'none' },
  });
  assert.equal(response.ok, true, response.message);

  const publicHtml = buildStandalonePublicHtml({
    title: '公開表示',
    snapshot: buildPublicSnapshot(state, { includeConfidential: false }),
  });
  assert.equal(publicHtml.includes('HTMLへ掲載する公開本文'), true);
  assert.equal(publicHtml.includes(secretHeartVoice), false);
  assert.equal(publicHtml.includes('confidential-toggle'), false);
  assert.equal(publicHtml.includes('<script'), false);
  assert.match(
    publicHtml,
    /Content-Security-Policy[\s\S]*default-src 'none';[\s\S]*style-src 'unsafe-inline';[\s\S]*script-src 'none';[\s\S]*object-src 'none'/u,
  );

  const confidentialHtml = buildStandalonePublicHtml({
    title: '公開表示',
    snapshot: buildPublicSnapshot(state, { includeConfidential: true }),
  });
  assert.equal(confidentialHtml.includes(secretHeartVoice), true);
  assert.equal(confidentialHtml.includes('confidential-toggle'), false);
  assert.equal(confidentialHtml.includes('<script'), false);
});



test('人狼共有会話を公開しても内部共有戦略は公開イベントと公開スナップショットへ含めない', () => {
  const state = fixture();
  const wolves = state.players.slice(0, 2);
  const strategySecret = '公開データへ含めてはいけない内部共有戦略';
  const publicMessage = '結果公開後に見せる人狼共有会話';
  state.wolfConversations = [{
    id: 'wolf-result-boundary',
    day: 1,
    purpose: 'attack-planning',
    status: 'closed',
    participantIds: wolves.map((player) => player.id),
    messages: [{
      id: 'wolf-result-message',
      sessionId: 'wolf-result-boundary',
      speakerId: wolves[0].id,
      content: publicMessage,
      sequence: 1,
      timestamp: '',
      source: 'human',
      type: 'wolf-conversation',
      aiTurnId: null,
    }],
    summary: '',
    createdAt: '',
    closedAt: '',
    speechCountPerParticipant: 1,
    remainingByParticipant: Object.fromEntries(wolves.map((player) => [player.id, 0])),
    sharedStrategy: {
      claimPlan: strategySecret,
      blackReceivedPlan: '',
      partnerExecutionPlan: '',
      collapsePlan: '',
      discussionPlan: '',
      attackPlan: '',
      updatedAt: null,
      updatedByPlayerId: wolves[0].id,
    },
  }];
  state.game.phase = 'result';
  state.result = {
    winner: 'wolf',
    reason: '境界テスト',
    status: 'confirmed',
    revealAllRoles: false,
    revealWolfConversation: true,
    revealMasonConversation: false,
    revealInternalMemos: false,
    publishedAt: null,
  };

  const published = publishGameResult(state);
  assert.equal(published.ok, true, published.message);
  const event = state.events.find((item) => item.id === published.eventId);
  assert.equal(JSON.stringify(event.payload).includes(publicMessage), true);
  assert.equal(JSON.stringify(event.payload).includes(strategySecret), false);
  assert.equal(Object.hasOwn(event.payload.wolfConversations[0], 'sharedStrategy'), false);

  const snapshot = buildPublicSnapshot(state);
  assert.equal(JSON.stringify(snapshot.result).includes(publicMessage), true);
  assert.equal(JSON.stringify(snapshot.result).includes(strategySecret), false);
  assert.equal(Object.hasOwn(snapshot.result.wolfConversations[0], 'sharedStrategy'), false);
});

test('正規の人狼共有情報は参加者だけが閲覧し非参加者へ渡さない', () => {
  const state = fixture();
  const wolves = state.players.slice(0, 2);
  const outsider = state.players[2];
  const session = {
    id: 'wolf-session-boundary', day: 1, purpose: 'attack-planning', status: 'open',
    participantIds: wolves.map((player) => player.id),
    messages: [{ id: 'm1', sessionId: 'wolf-session-boundary', speakerId: wolves[0].id, content: '人狼だけの共有戦略', sequence: 1, timestamp: '', source: 'human', type: 'wolf-conversation', aiTurnId: null }],
    summary: '', createdAt: '', closedAt: null, speechCountPerParticipant: 1,
    remainingByParticipant: Object.fromEntries(wolves.map((player) => [player.id, 0])),
    sharedStrategy: { claimPlan: '潜伏', blackReceivedPlan: '比較', partnerExecutionPlan: '必要票で判断', collapsePlan: '縮小', discussionPlan: '役割分担', attackPlan: '候補比較', updatedAt: null, updatedByPlayerId: wolves[0].id },
  };
  state.wolfConversations = [session];
  state.night = { wolfConversationId: session.id, plan: { wolfConversationRequired: true, wolfConversationPurpose: 'attack-planning', wolfAttackRequired: true } };
  const memberContext = buildPlayerVisibleContext(state, wolves[1].id, { taskType: 'wolf-conversation' });
  const outsiderContext = buildPlayerVisibleContext(state, outsider.id, { taskType: 'speech' });
  assert.equal(JSON.stringify(memberContext).includes('人狼だけの共有戦略'), true);
  assert.equal(JSON.stringify(outsiderContext).includes('人狼だけの共有戦略'), false);
});


test('生成工程の中間回答はAIターン監査だけに保存し公開イベントと他AIプロンプトへ渡さない', () => {
  const state = fixture();
  const actor = state.players[0];
  const intermediateSecret = '構造草案だけに存在する監査専用中間回答';
  const response = recordAiSpeech(state, {
    playerId: actor.id,
    content: '最終登録された公開本文です。',
    coOperation: { action: 'none', roleId: 'none' },
    promptText: '元の本番プロンプト',
    rawResponse: '{"publicSpeech":"最終登録された公開本文です。"}',
    generationRun: {
      schemaVersion: 1, executionMode: 'automatic', depth: 2, ownerProfileId: 'owner-profile',
      taskCategory: 'speech', normalCallCount: 2, totalCallCount: 2, finalStageId: 'proofread',
      stages: [
        {
          stageId: 'direct', executorProfileId: 'owner-profile', status: 'accepted', attemptCount: 1,
          targetTextFields: [], skipReason: null, rawResponse: `{"publicSpeech":"${intermediateSecret}"}`,
          fallbackUsed: false, issues: [],
          usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15 },
        },
        {
          stageId: 'proofread', executorProfileId: 'proofread-profile', status: 'applied', attemptCount: 1,
          targetTextFields: ['publicSpeech'], skipReason: null,
          rawResponse: '{"textPatch":{"publicSpeech":"最終登録された公開本文です。"}}',
          fallbackUsed: false, issues: [],
          usage: { inputTokens: 8, outputTokens: 4, cachedInputTokens: 0, totalTokens: 12 },
        },
      ],
    },
  });
  assert.equal(response.ok, true, response.message);
  const turn = state.aiTurns.find((item) => item.id === response.aiTurnId);
  const event = state.events.find((item) => item.id === response.eventId);
  assert.equal(JSON.stringify(turn.generationRun).includes(intermediateSecret), true);
  assert.equal(JSON.stringify(event).includes(intermediateSecret), false);
  assert.equal(JSON.stringify(buildPublicSnapshot(state)).includes(intermediateSecret), false);
  const otherPrompt = buildPromptContext(state, state.players[2].id, { taskType: 'speech' });
  assert.equal(otherPrompt.text.includes(intermediateSecret), false);
});
