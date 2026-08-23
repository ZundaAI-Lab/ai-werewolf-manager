/**
 * 責務: 遺言と墓場会話の進行順・発言回数・死亡時点知識境界・結果公開境界を、実ゲーム状態とプロンプト可視状態の両方から検証する。
 * 変更ルール: 通常議論や既存の人狼／共有者会話の挙動を重複検証せず、遺言・墓場会話に固有の境界だけを固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, StateStore } from '../../../app/renderer/js/state/stateStore.js';
import { createEvent } from '../../../app/renderer/js/domain/events/eventStore.js';
import {
  beginVote,
  finalizeVote,
  publishExecution,
  publishVoteResult,
  recordVote,
  resolveExecution,
} from '../../../app/renderer/js/domain/vote/voteCommands.js';
import { recordHumanTestament, skipTestament } from '../../../app/renderer/js/domain/execution/testamentCommands.js';
import { FROZEN_TESTAMENT_SKIP_REASON } from '../../../app/renderer/js/domain/execution/testamentPolicy.js';
import { closeGraveyardConversation, recordGraveyardMessage } from '../../../app/renderer/js/domain/night/nightCommands.js';
import { initializeNight } from '../../../app/renderer/js/domain/night/nightRuntime.js';
import { getCurrentGmTask } from '../../../app/renderer/js/domain/game/workflow.js';
import { buildPlayerVisibleContext } from '../../../app/renderer/js/prompts/context/promptContext.js';
import { buildPromptContext } from '../../../app/renderer/js/prompts/promptBuilder.js';
import { detectGameResult, confirmGameResult, publishGameResult } from '../../../app/renderer/js/domain/result/resultRuntime.js';
import { buildPublicSnapshot } from '../../../app/renderer/js/public/publicSnapshot.js';
import { prepareImportedState } from '../../../app/renderer/js/state/stateImport.js';
import { createGameCallNameSnapshot } from '../../../app/renderer/js/characters/callNames/callNameResolver.js';
import { synchronizePlayerKnowledgeForTest } from './testStateHelpers.js';

function prepareCompletedDiscussion(state) {
  const ids = state.players.map((player) => player.id);
  state.game.status = 'running';
  state.game.day = 1;
  state.game.phase = 'discussion';
  state.discussion = {
    day: 1,
    mode: 'ordered',
    modeControl: null,
    round: 1,
    roundKind: 'normal',
    roundStartedAtSequence: 0,
    roundEligiblePlayerIds: [...ids],
    queue: [...ids],
    currentIndex: ids.length,
    remainingByPlayer: Object.fromEntries(ids.map((id) => [id, 0])),
    spokenInCurrentRound: [...ids],
    deferredPlayerIds: [],
    deferredCountByPlayer: Object.fromEntries(ids.map((id) => [id, 0])),
    allDeferred: false,
    designatedPlayerId: null,
    completed: true,
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
  };
}

function preparePendingTestamentStore() {
  const state = createInitialState(6);
  state.game.rules.testament.enabled = true;
  prepareCompletedDiscussion(state);
  const target = state.players.find((player) => player.roleId === 'villager') ?? state.players[0];
  const store = new StateStore(state);
  let response = null;
  store.commit('投票開始', (draft) => { response = beginVote(draft); });
  assert.equal(response.ok, true, response.message);
  const voterIds = [...store.getState().voteSession.eligibleVoterIds];
  voterIds.forEach((voterId) => {
    const current = store.getState();
    const fallbackId = current.voteSession.candidateIds.find((id) => id !== voterId && id !== target.id);
    const targetId = voterId === target.id ? fallbackId : target.id;
    store.commit('投票登録', (draft) => { response = recordVote(draft, { voterId, targetId }); });
    assert.equal(response.ok, true, response.message);
  });
  store.commit('投票確定', (draft) => { response = finalizeVote(draft, () => 0); });
  assert.equal(response.ok, true, response.message);
  store.commit('投票結果公開', (draft) => { response = publishVoteResult(draft); }, { publicBarrier: true });
  assert.equal(response.ok, true, response.message);
  store.commit('処刑内容解決', (draft) => { response = resolveExecution(draft, () => 0); });
  assert.equal(response.ok, true, response.message);
  return { store, targetId: target.id };
}

function markDead(player, { day = 1, phase = 'execution' } = {}) {
  player.alive = false;
  player.death = { day, phase, cause: phase === 'execution' ? 'execution' : 'night', announced: true };
}

function publicSpeech(state, actorId, text) {
  return createEvent(state, {
    type: 'public-speech',
    actorId,
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload: {
      text,
      pass: false,
      speechKind: 'normal',
      sourceQuestionEventId: null,
      round: 1,
      roundKind: 'normal',
      opportunityContext: null,
      structured: {
        coOperation: { action: 'none', roleId: 'none' },
        interaction: { questionTargetIds: [], answersEventIds: [] },
        abilityClaims: [],
      },
    },
  });
}

function publicExecutionDeath(state, player, text) {
  const event = createEvent(state, {
    type: 'execution',
    targetIds: [player.id],
    audience: { type: 'public', targetIds: [] },
    status: 'published',
    payload: {
      text,
      targetId: player.id,
      collateralPlayerIds: [],
      deadPlayerIds: [player.id],
      revealedRoleId: null,
    },
  });
  markDead(player, { day: state.game.day, phase: 'execution' });
  return event;
}

test('遺言と墓場会話は既定OFFで、墓場会話の発言回数は1回から開始する', () => {
  const state = createInitialState(6);
  assert.equal(state.game.rules.testament.enabled, false);
  assert.equal(state.game.rules.graveyardCommunication.enabled, false);
  assert.equal(state.game.rules.graveyardCommunication.speechCountPerNight, 1);
});

test('遺言ONでは処刑公開前に一度だけ公開発言または辞退を必須にする', () => {
  const { store, targetId } = preparePendingTestamentStore();
  let current = store.getState();
  assert.equal(current.executionResolution.testament.status, 'pending');
  assert.equal(getCurrentGmTask(current).type, 'testament');

  let blocked = null;
  store.commit('処刑公開を試行', (draft) => { blocked = publishExecution(draft); });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /遺言/u);

  let testament = null;
  store.commit('遺言公開', (draft) => {
    testament = recordHumanTestament(draft, {
      playerId: targetId,
      content: '最後に占い師として名乗ります。',
      coOperation: { action: 'declare', roleId: 'seer' },
      abilityClaims: [],
    });
  }, { publicBarrier: true });
  assert.equal(testament.ok, true, testament.message);
  current = store.getState();
  const event = current.events.find((item) => item.id === testament.eventId);
  assert.equal(event.type, 'public-speech');
  assert.equal(event.payload.speechKind, 'testament');
  assert.deepEqual(event.payload.structured.interaction, { questionTargetIds: [], answersEventIds: [] });
  assert.equal(current.claims.find((claim) => claim.actorId === targetId)?.roleId, 'seer');
  assert.equal(current.executionResolution.testament.status, 'completed');
  assert.equal(getCurrentGmTask(current).type, 'publish-execution');

  let published = null;
  store.commit('処刑公開', (draft) => { published = publishExecution(draft); }, { publicBarrier: true });
  assert.equal(published.ok, true, published.message);
  assert.equal(store.getState().players.find((player) => player.id === targetId).alive, false);
  {
    const importable = structuredClone(store.getState());
    importable.game.callNameSnapshot = createGameCallNameSnapshot(importable.players);
    synchronizePlayerKnowledgeForTest(importable);
    assert.doesNotThrow(() => prepareImportedState(importable), '遺言完了後の公開済み処刑状態を再読込できる');
  }
});

test('遺言は辞退しても処刑進行を再開でき、二重登録できない', () => {
  const { store, targetId } = preparePendingTestamentStore();
  let skipped = null;
  store.commit('遺言辞退', (draft) => { skipped = skipTestament(draft, { playerId: targetId, reason: '遺言なし' }); });
  assert.equal(skipped.ok, true, skipped.message);
  assert.equal(store.getState().executionResolution.testament.status, 'skipped');

  let duplicate = null;
  store.commit('遺言再登録を試行', (draft) => {
    duplicate = recordHumanTestament(draft, {
      playerId: targetId,
      content: '二度目の遺言',
      coOperation: { action: 'none', roleId: 'none' },
    });
  });
  assert.equal(duplicate.ok, false);

  let published = null;
  store.commit('処刑公開', (draft) => { published = publishExecution(draft); }, { publicBarrier: true });
  assert.equal(published.ok, true, published.message);
  {
    const importable = structuredClone(store.getState());
    importable.game.callNameSnapshot = createGameCallNameSnapshot(importable.players);
    synchronizePlayerKnowledgeForTest(importable);
    assert.doesNotThrow(() => prepareImportedState(importable), '遺言辞退後の公開済み処刑状態を再読込できる');
  }
});



test('凍結中の処刑対象は遺言を自動スキップし、その夜の墓場会話には通常参加できる', () => {
  const state = createInitialState(6);
  state.game.rules.testament.enabled = true;
  state.game.rules.graveyardCommunication.enabled = true;
  state.game.rules.graveyardCommunication.speechCountPerNight = 1;
  state.game.rules.wolfCommunication.enabled = false;
  state.game.rules.masonCommunication.enabled = false;
  prepareCompletedDiscussion(state);
  const target = state.players.find((player) => player.roleId === 'villager') ?? state.players[0];
  const alreadyDead = state.players.find((player) => player.id !== target.id && player.roleId !== 'wolf') ?? state.players.find((player) => player.id !== target.id);
  markDead(alreadyDead, { day: 0, phase: 'night' });
  target.statusEffects.push({ type: 'frozen', day: 1, sourcePlayerId: state.players.find((player) => player.id !== target.id)?.id ?? null });

  const store = new StateStore(state);
  let response = null;
  store.commit('投票開始', (draft) => { response = beginVote(draft); });
  assert.equal(response.ok, true, response.message);
  const voterIds = [...store.getState().voteSession.eligibleVoterIds];
  assert.equal(voterIds.includes(target.id), false, '凍結対象は投票者にならない');
  voterIds.forEach((voterId) => {
    store.commit('投票登録', (draft) => { response = recordVote(draft, { voterId, targetId: target.id }); });
    assert.equal(response.ok, true, response.message);
  });
  store.commit('投票確定', (draft) => { response = finalizeVote(draft, () => 0); });
  assert.equal(response.ok, true, response.message);
  store.commit('投票結果公開', (draft) => { response = publishVoteResult(draft); }, { publicBarrier: true });
  assert.equal(response.ok, true, response.message);
  store.commit('処刑内容解決', (draft) => { response = resolveExecution(draft, () => 0); });
  assert.equal(response.ok, true, response.message);

  let current = store.getState();
  assert.equal(current.executionResolution.testament.status, 'skipped');
  assert.equal(current.executionResolution.testament.skippedReason, FROZEN_TESTAMENT_SKIP_REASON);
  assert.ok(current.executionResolution.testament.completedAt);
  assert.equal(getCurrentGmTask(current).type, 'publish-execution');

  let blocked = null;
  store.commit('凍結中の遺言登録を試行', (draft) => {
    blocked = recordHumanTestament(draft, {
      playerId: target.id,
      content: '凍結中でも遺言を残したい',
      coOperation: { action: 'none', roleId: 'none' },
    });
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /凍結中/u);

  store.commit('処刑公開', (draft) => { response = publishExecution(draft); }, { publicBarrier: true });
  assert.equal(response.ok, true, response.message);
  current = store.getState();
  assert.equal(current.players.find((player) => player.id === target.id).alive, false);
  assert.equal(current.game.phase, 'night');
  const session = current.graveyardConversations.find((item) => item.id === current.night.graveyardConversationId);
  assert.ok(session, '処刑直後の夜に墓場会話が開始される');
  assert.equal(session.participantIds.includes(target.id), true, '凍結されて処刑された人物も墓場参加資格を持つ');
  assert.equal(session.participantIds.includes(alreadyDead.id), true);
});

test('墓場会話は夜開始時死亡者だけで開始し、設定回数を各参加者が消費すると完了する', () => {
  const state = createInitialState(6);
  state.game.status = 'running';
  state.game.day = 1;
  state.game.phase = 'discussion';
  state.game.rules.graveyardCommunication.enabled = true;
  state.game.rules.graveyardCommunication.speechCountPerNight = 2;
  state.game.rules.wolfCommunication.enabled = false;
  state.game.rules.masonCommunication.enabled = false;
  const dead = state.players.filter((player) => player.roleId === 'villager').slice(0, 2);
  assert.equal(dead.length, 2);
  dead.forEach((player) => markDead(player));

  const store = new StateStore(state);
  store.commit('夜開始', (draft) => initializeNight(draft, 1));
  let current = store.getState();
  const sessionId = current.night.graveyardConversationId;
  assert.ok(sessionId);
  let session = current.graveyardConversations.find((item) => item.id === sessionId);
  assert.deepEqual(new Set(session.participantIds), new Set(dead.map((player) => player.id)));
  assert.equal(session.speechCountPerParticipant, 2);
  assert.deepEqual(session.remainingByParticipant, Object.fromEntries(dead.map((player) => [player.id, 2])));
  assert.equal(getCurrentGmTask(current).type, 'graveyard-conversation');

  for (const [index, player] of dead.entries()) {
    let response = null;
    store.commit('墓場発言', (draft) => {
      response = recordGraveyardMessage(draft, { speakerId: player.id, content: `${player.name}の1巡目` });
    });
    assert.equal(response.ok, true, response.message);
    assert.equal(response.conversationCompleted, false);
    if (index === 0) {
      let repeated = null;
      store.commit('墓場連続発言拒否', (draft) => {
        repeated = recordGraveyardMessage(draft, { speakerId: player.id, content: `${player.name}の連続発言` });
      });
      assert.equal(repeated.ok, false);
      assert.match(repeated.message, /連続して発言できません/u);
    }
  }
  current = store.getState();
  session = current.graveyardConversations.find((item) => item.id === sessionId);
  assert.deepEqual(session.remainingByParticipant, Object.fromEntries(dead.map((player) => [player.id, 1])));
  assert.equal(session.status, 'open');

  for (const [index, player] of dead.entries()) {
    let response = null;
    store.commit('墓場発言', (draft) => {
      response = recordGraveyardMessage(draft, { speakerId: player.id, content: `${player.name}の2巡目` });
    });
    assert.equal(response.ok, true, response.message);
    assert.equal(response.conversationCompleted, index === dead.length - 1);
  }
  current = store.getState();
  session = current.graveyardConversations.find((item) => item.id === sessionId);
  assert.equal(session.status, 'closed');
  assert.deepEqual(session.remainingByParticipant, Object.fromEntries(dead.map((player) => [player.id, 0])));
  assert.notEqual(getCurrentGmTask(current).type, 'graveyard-conversation');
});

test('その夜に新しく死亡した者は途中参加せず、次の夜から墓場会話へ参加する', () => {
  const state = createInitialState(6);
  state.game.status = 'running';
  state.game.rules.graveyardCommunication.enabled = true;
  state.game.rules.wolfCommunication.enabled = false;
  state.game.rules.masonCommunication.enabled = false;
  const [first, second, newcomer] = state.players.filter((player) => player.roleId !== 'wolf').slice(0, 3);
  markDead(first);
  markDead(second);

  initializeNight(state, 1);
  const firstSession = state.graveyardConversations.find((item) => item.id === state.night.graveyardConversationId);
  assert.deepEqual(new Set(firstSession.participantIds), new Set([first.id, second.id]));

  markDead(newcomer, { day: 1, phase: 'night' });
  assert.equal(firstSession.participantIds.includes(newcomer.id), false, '夜途中の死亡者は既存セッションへ追加しない');
  assert.equal(closeGraveyardConversation(state).ok, true);

  initializeNight(state, 2);
  const secondSession = state.graveyardConversations.find((item) => item.id === state.night.graveyardConversationId);
  assert.deepEqual(new Set(secondSession.participantIds), new Set([first.id, second.id, newcomer.id]));
});


test('墓場プロンプトは生前判断を再提示せず、新規死亡者と継続参加者で秘密共有・感想の焦点を切り替える', () => {
  const state = createInitialState(6);
  state.game.status = 'running';
  state.game.rules.graveyardCommunication.enabled = true;
  state.game.rules.graveyardCommunication.speechCountPerNight = 1;
  state.game.rules.wolfCommunication.enabled = false;
  state.game.rules.masonCommunication.enabled = false;
  const [first, second, newcomer] = state.players.filter((player) => player.roleId !== 'wolf').slice(0, 3);
  const living = state.players.find((player) => ![first.id, second.id, newcomer.id].includes(player.id));
  markDead(first);
  markDead(second);
  first.decisionState = {
    ...first.decisionState,
    suspicionCandidateIds: living ? [living.id] : [],
    executionCandidateIds: living ? [living.id] : [],
    intendedVoteId: living?.id ?? null,
    assessmentLevel: 'moderate',
    nextDiscriminatingInformation: '生前の次の確認事項',
    decisionReason: '生前の判断理由',
    updatedAt: '2026-08-22T00:00:00.000Z',
    sourceDay: 1,
  };

  initializeNight(state, 1);
  const firstPrompt = buildPromptContext(state, first.id, { taskType: 'graveyard-conversation' });
  assert.match(firstPrompt.text, /墓場会話の主目的は、死亡者同士で生前の秘密を共有し、答え合わせや感想を交わす/u);
  assert.doesNotMatch(firstPrompt.text, /memoAdd/u);
  assert.match(firstPrompt.text, /participantStatus.*new/us);
  assert.doesNotMatch(firstPrompt.text, /previous-decision-state|生前の判断理由|生前の次の確認事項/u);

  assert.equal(recordGraveyardMessage(state, { speakerId: first.id, content: '私は生前こう見ていたよ。' }).ok, true);
  assert.equal(recordGraveyardMessage(state, { speakerId: second.id, content: 'こっちは役職の秘密があるよ。' }).ok, true);
  state.game.day = 2;
  state.game.phase = 'execution';
  publicExecutionDeath(state, newcomer, '新規死亡者が処刑された');
  initializeNight(state, 2);

  const newcomerPrompt = buildPromptContext(state, newcomer.id, { taskType: 'graveyard-conversation' });
  assert.match(newcomerPrompt.text, /participantStatus.*new/us);
  assert.match(newcomerPrompt.text, /墓場側が知らなかった秘密/u);

  const returningBefore = buildPromptContext(state, first.id, { taskType: 'graveyard-conversation' });
  assert.match(returningBefore.text, /participantStatus.*returning/us);
  assert.match(returningBefore.text, /前夜までの墓場会話/u);

  assert.equal(recordGraveyardMessage(state, { speakerId: newcomer.id, content: '実は私は占い師だったよ。' }).ok, true);
  const returningAfter = buildPromptContext(state, first.id, { taskType: 'graveyard-conversation' });
  assert.match(returningAfter.text, /newcomerMessageSpeakers/u);
  assert.match(returningAfter.text, /驚き、納得、後悔/u);
});

test('墓場AIの公開知識は本人の死亡時点で凍結し、後の地上情報は新規死亡者の墓場発言からだけ共有される', () => {
  const state = createInitialState(6);
  state.game.status = 'running';
  state.game.rules.graveyardCommunication.enabled = true;
  state.game.rules.wolfCommunication.enabled = false;
  state.game.rules.masonCommunication.enabled = false;
  const [olderDead, newerDead, living] = state.players.filter((player) => player.roleId !== 'wolf').slice(0, 3);

  state.game.day = 1;
  state.game.phase = 'discussion';
  publicSpeech(state, living.id, '古参死者も知っている生前の公開情報');
  const olderDeath = publicExecutionDeath(state, olderDead, '古参死者が処刑された');
  publicSpeech(state, living.id, '古参死者の死亡後、新規死者だけが見た地上情報');
  const newerDeath = publicExecutionDeath(state, newerDead, '新規死者が処刑された');
  publicSpeech(state, living.id, '二人とも死亡した後の地上情報');

  initializeNight(state, 2);
  const olderContext = buildPlayerVisibleContext(state, olderDead.id, { taskType: 'graveyard-conversation' });
  const newerContext = buildPlayerVisibleContext(state, newerDead.id, { taskType: 'graveyard-conversation' });
  const olderPublicText = olderContext.board.publicTimeline.speeches.map((event) => event.payload.text).join('\n');
  const newerPublicText = newerContext.board.publicTimeline.speeches.map((event) => event.payload.text).join('\n');
  assert.equal(olderContext.graveyardCommunication.knowledgeCutoffSequence, olderDeath.sequence);
  assert.equal(newerContext.graveyardCommunication.knowledgeCutoffSequence, newerDeath.sequence);
  assert.match(olderPublicText, /生前の公開情報/u);
  assert.doesNotMatch(olderPublicText, /新規死者だけが見た/u);
  assert.match(newerPublicText, /新規死者だけが見た/u);
  assert.doesNotMatch(newerPublicText, /二人とも死亡した後/u);

  const secretReport = '墓場報告：地上では占いCOが増えた';
  const report = recordGraveyardMessage(state, { speakerId: newerDead.id, content: secretReport });
  assert.equal(report.ok, true, report.message);
  const olderAfterReport = buildPlayerVisibleContext(state, olderDead.id, { taskType: 'graveyard-conversation' });
  assert.equal(olderAfterReport.graveyardCommunication.current.messages.some((message) => message.content === secretReport), true);
  const livingContext = buildPlayerVisibleContext(state, living.id, { taskType: 'speech' });
  assert.equal(JSON.stringify(livingContext).includes(secretReport), false, '墓場発言は生存者へ漏らさない');
});

test('新規死亡者は次夜から過去の墓場ログを読める', () => {
  const state = createInitialState(6);
  state.game.status = 'running';
  state.game.rules.graveyardCommunication.enabled = true;
  state.game.rules.wolfCommunication.enabled = false;
  state.game.rules.masonCommunication.enabled = false;
  const [first, second, newcomer] = state.players.filter((player) => player.roleId !== 'wolf').slice(0, 3);
  markDead(first);
  markDead(second);
  initializeNight(state, 1);
  const historicalMessage = '前夜から続いている墓場推理';
  assert.equal(recordGraveyardMessage(state, { speakerId: first.id, content: historicalMessage }).ok, true);
  assert.equal(recordGraveyardMessage(state, { speakerId: second.id, content: '前夜の応答' }).ok, true);
  const previousSessionId = state.graveyardConversations.at(-1).id;
  assert.equal(state.graveyardConversations.at(-1).status, 'closed');

  state.game.day = 2;
  state.game.phase = 'execution';
  publicExecutionDeath(state, newcomer, '新規死亡者が処刑された');
  initializeNight(state, 2);
  const context = buildPlayerVisibleContext(state, newcomer.id, { taskType: 'graveyard-conversation' });
  const past = context.graveyardCommunication.past.find((session) => session.id === previousSessionId);
  assert.ok(past);
  assert.equal(past.messages.some((message) => message.content === historicalMessage), true);
});

test('墓場会話の結果公開は独立OFFで、ONにした場合も許可した会話記録だけを公開する', () => {
  const makeState = () => {
    const state = createInitialState(6);
    state.graveyardConversations = [{
      id: 'grave-result-test',
      day: 2,
      status: 'closed',
      participantIds: [state.players[0].id, state.players[1].id],
      messages: [{
        id: 'grave-result-message',
        sessionId: 'grave-result-test',
        speakerId: state.players[0].id,
        type: 'message',
        content: '結果公開を許可した墓場会話',
        sequence: 1,
        source: 'human',
        aiTurnId: null,
        timestamp: '',
      }],
      speechCountPerParticipant: 1,
      remainingByParticipant: { [state.players[0].id]: 0, [state.players[1].id]: 0 },
      summary: '公開射影へ含めない内部要約',
      createdAt: '',
      closedAt: '',
    }];
    detectGameResult(state, { winner: 'draw', reason: '墓場公開境界テスト' });
    return state;
  };

  const hidden = makeState();
  assert.equal(confirmGameResult(hidden, {}).ok, true);
  assert.equal(hidden.result.revealGraveyardConversation, false);
  const hiddenPublish = publishGameResult(hidden);
  assert.equal(hiddenPublish.ok, true, hiddenPublish.message);
  assert.deepEqual(hidden.events.find((event) => event.id === hiddenPublish.eventId).payload.graveyardConversations, []);
  assert.deepEqual(buildPublicSnapshot(hidden).result.graveyardConversations, []);

  const shown = makeState();
  assert.equal(confirmGameResult(shown, { revealGraveyardConversation: true }).ok, true);
  const shownPublish = publishGameResult(shown);
  assert.equal(shownPublish.ok, true, shownPublish.message);
  const eventSession = shown.events.find((event) => event.id === shownPublish.eventId).payload.graveyardConversations[0];
  assert.deepEqual(Object.keys(eventSession).sort(), ['day', 'id', 'messages', 'participantIds']);
  assert.equal(eventSession.messages[0].content, '結果公開を許可した墓場会話');
  assert.equal(JSON.stringify(eventSession).includes('内部要約'), false);
  const snapshotSession = buildPublicSnapshot(shown).result.graveyardConversations[0];
  assert.deepEqual(Object.keys(snapshotSession).sort(), ['day', 'id', 'messages', 'participantIds']);
});
