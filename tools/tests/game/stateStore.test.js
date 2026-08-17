/**
 * 責務: StateStoreがcommit外の直接変更を許さず、現在の準備設定を引き継ぐ再開始、履歴・通知を経由する更新規則、AI監査本文を重複させない履歴圧縮をAPI境界で保証することを検証する。
 * 変更ルール: ゲーム規則や永続化は検証せず、公開された状態参照、設定引継ぎ対象、更新API、Undo／Redo／復元時の監査情報再結合だけを扱う。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createRestartedGameState, StateStore } from '../../../app/renderer/js/state/stateStore.js';
import { addEvent, startGame } from '../../../app/renderer/js/domain/game/gameCommands.js';
import { markBriefingShown, acknowledgeRole } from '../../../app/renderer/js/domain/briefing/briefingCommands.js';
import {
  recommendRestorePointForProgressionEvent,
  restoreGameFromPoint,
  summarizeRestoreImpact,
} from '../../../app/renderer/js/domain/correction/restoreCorrectionService.js';
import { buildPublicSnapshot } from '../../../app/renderer/js/public/publicSnapshot.js';
import { exitCorrectionMode } from '../../../app/renderer/js/domain/correction/correctionCommands.js';
import {
  requestMandatoryRestorePoint,
  RESTORE_POINT_LABELS,
  RESTORE_POINT_TYPES,
} from '../../../app/renderer/js/domain/correction/restorePointPolicy.js';

test('getStateで取得した状態は再帰的に凍結され直接変更できない', () => {
  const store = new StateStore(createInitialState(6));
  const state = store.getState();
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.game), true);
  assert.equal(Object.isFrozen(state.players[0]), true);
  try {
    state.game.title = 'commitを通さない変更';
  } catch (error) {
    assert.equal(error instanceof TypeError, true);
  }
  assert.equal(store.getState().game.title, 'AI人狼ゲーム');
  assert.equal(store.getState().revision, 0);
});


test('subscriber例外はcommit結果と後続subscriber通知を失敗させない', () => {
  const store = new StateStore(createInitialState(6));
  const observedRevisions = [];
  const reportedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { reportedErrors.push(args); };
  try {
    store.subscribe(() => { throw new Error('subscriber exploded'); });
    store.subscribe((state) => { observedRevisions.push(state.revision); });

    const committed = store.commit('subscriber分離確認', (draft) => {
      draft.game.title = 'subscriber例外後も確定';
    });

    assert.equal(committed.game.title, 'subscriber例外後も確定');
    assert.equal(store.getState().revision, 1);
    assert.equal(store.getState().undoStack.length, 1);
    assert.deepEqual(observedRevisions, [1]);
    assert.equal(reportedErrors.length, 1);
    assert.equal(reportedErrors[0][0], '[StateStore] subscriber failed');
    assert.match(String(reportedErrors[0][1]?.message), /subscriber exploded/u);
  } finally {
    console.error = originalConsoleError;
  }
});

test('設定引継ぎ再開始はキャラクター・配役・ルールを保持して進行状態だけを初期化する', () => {
  const source = createInitialState(6);
  const originalGameId = source.game.id;
  const originalPlayerIds = source.players.map((player) => player.id);
  source.game.title = '同じ設定で再戦';
  source.game.preset = 'custom-replay';
  source.game.rules.speechCountPerDay = 5;
  source.game.rules.vote.selfVoteAllowed = true;
  source.game.status = 'ended';
  source.game.day = 4;
  source.game.phase = 'ended';
  source.game.eventSequence = 72;
  source.game.stateRevision = 31;
  source.game.winner = 'wolf';
  source.game.winnerReason = 'テスト完走';
  source.game.callNameSnapshot = { sentinel: true };
  source.revision = 31;
  source.publicRevision = 19;
  source.lastActionLabel = 'ゲーム終了';

  const player = source.players[0];
  player.name = 'ずんだもん';
  player.aliases = ['ずんだ'];
  player.characterCardId = 'zundamon';
  player.callNameOverrides = { [source.players[1].id]: 'めたん' };
  player.controller = 'human';
  player.roleId = 'seer';
  player.character.profile = 'ずんだの妖精';
  player.character.firstPerson = 'ボク';
  player.privateInfo = '現在のキャラクター設定';
  player.alive = false;
  player.death = { day: 3, phase: 'execution', cause: 'execution', announced: true };
  player.heartVoice = '進行中だけの心の声';
  player.heartVoiceUpdatedAt = '2026-08-02T00:00:00.000Z';
  player.aiContextStatus = 'ready';

  source.playerKnowledge = { sentinel: true };
  source.briefing = { sentinel: true };
  source.discussion = { sentinel: true };
  source.voteSession = { sentinel: true };
  source.wolfConversations = [{ sentinel: true }];
  source.masonConversations = [{ sentinel: true }];
  source.graveyardConversations = [{ sentinel: true }];
  source.night = { sentinel: true };
  source.executionResolution = { sentinel: true };
  source.mediumResults = [{ sentinel: true }];
  source.claims = [{ sentinel: true }];
  source.publicAbilityClaims = [{ sentinel: true }];
  source.events = [{ sentinel: true }];
  source.aiTurns = [{ sentinel: true }];
  source.result = { sentinel: true };
  source.undoStack = [{ sentinel: true }];
  source.redoStack = [{ sentinel: true }];
  source.restorePoints = [{ sentinel: true }];

  const restarted = createRestartedGameState(source);
  assert.notEqual(restarted.game.id, originalGameId);
  assert.deepEqual(restarted.players.map((item) => item.id), originalPlayerIds);
  assert.equal(restarted.game.title, '同じ設定で再戦');
  assert.equal(restarted.game.preset, 'custom-replay');
  assert.equal(restarted.game.rules.speechCountPerDay, 5);
  assert.equal(restarted.game.rules.vote.selfVoteAllowed, true);
  assert.equal(restarted.game.status, 'setup');
  assert.equal(restarted.game.day, 0);
  assert.equal(restarted.game.phase, 'setup');
  assert.equal(restarted.game.eventSequence, 0);
  assert.equal(restarted.game.winner, null);
  assert.equal(restarted.game.winnerReason, '');
  assert.equal(restarted.game.callNameSnapshot, null);
  assert.equal(restarted.revision, 0);
  assert.equal(restarted.publicRevision, 0);
  assert.equal(restarted.lastActionLabel, '初期状態');

  const restartedPlayer = restarted.players[0];
  assert.equal(restartedPlayer.name, 'ずんだもん');
  assert.deepEqual(restartedPlayer.aliases, ['ずんだ']);
  assert.equal(restartedPlayer.characterCardId, 'zundamon');
  assert.deepEqual(restartedPlayer.callNameOverrides, { [source.players[1].id]: 'めたん' });
  assert.equal(restartedPlayer.controller, 'human');
  assert.equal(restartedPlayer.roleId, 'seer');
  assert.equal(restartedPlayer.character.profile, 'ずんだの妖精');
  assert.equal(restartedPlayer.character.firstPerson, 'ボク');
  assert.equal(restartedPlayer.privateInfo, '現在のキャラクター設定');
  assert.equal(restartedPlayer.alive, true);
  assert.equal(restartedPlayer.death, null);
  assert.equal(restartedPlayer.heartVoice, '');
  assert.equal(restartedPlayer.heartVoiceUpdatedAt, null);
  assert.deepEqual(restartedPlayer.heartVoiceHistory, []);
  assert.equal(restartedPlayer.aiContextStatus, 'not-ready');
  assert.deepEqual(restartedPlayer.internalMemory.notes, []);
  assert.deepEqual(restartedPlayer.memoHistory, []);

  assert.deepEqual(restarted.playerKnowledge, {});
  assert.equal(restarted.briefing, null);
  assert.equal(restarted.discussion, null);
  assert.equal(restarted.voteSession, null);
  assert.deepEqual(restarted.wolfConversations, []);
  assert.deepEqual(restarted.masonConversations, []);
  assert.deepEqual(restarted.graveyardConversations, []);
  assert.equal(restarted.night, null);
  assert.equal(restarted.executionResolution, null);
  assert.deepEqual(restarted.mediumResults, []);
  assert.deepEqual(restarted.claims, []);
  assert.deepEqual(restarted.publicAbilityClaims, []);
  assert.deepEqual(restarted.events, []);
  assert.deepEqual(restarted.aiTurns, []);
  assert.equal(restarted.result, null);
  assert.deepEqual(restarted.undoStack, []);
  assert.deepEqual(restarted.redoStack, []);
  assert.deepEqual(restarted.restorePoints, []);
});


function createAiTurn({ id, playerId, promptText, rawResponse }) {
  return {
    id,
    day: 0,
    phase: 'setup',
    stateRevision: 0,
    promptContextFingerprint: `fingerprint-${id}`,
    promptMode: 'runtime',
    publicSequenceAtGeneration: 0,
    publicSequenceAtRegistration: 0,
    promptText,
    rawResponse,
    parsedPublicSpeech: '',
    parsedSpeechInteraction: null,
    resolvedSpeechInteraction: null,
    parsedWolfConversationMessage: '',
    parsedMasonConversationMessage: '',
    parsedGraveyardConversationMessage: '',
    parsedSharedStrategyUpdate: null,
    parsedHeartVoice: '',
    parsedInternalMemoUpdate: null,
    parsedConsolidatedMemo: '',
    parsedActionAnswer: '',
    parsedActionRationale: '',
    parsedCoOperation: null,
    parsedAbilityClaims: null,
    resolvedAbilityClaims: [],
    parsedDecisionUpdate: null,
    resolvedDecisionUpdate: null,
    parsedFactionStrategyUpdate: null,
    resolvedFactionStrategyUpdate: null,
    parsedAttackAssessment: null,
    resolvedAttackAssessment: null,
    estimatedWerewolfIds: [],
    predictedAttackTargetIds: [],
    resolvedInternalReasoningDirective: null,
    warnings: [],
    override: null,
    committedEntityIds: [],
    runtimeBuildId: 'test-build',
    promptSpecVersion: 'test-prompt-spec',
    taskType: 'speech',
    playerId,
    timestamp: '2026-08-02T00:00:00.000Z',
    generationRun: {
      schemaVersion: 1,
      executionMode: 'manual',
      depth: 1,
      ownerProfileId: '',
      taskCategory: 'speech',
      normalCallCount: 1,
      totalCallCount: 0,
      finalStageId: 'direct',
      stages: [{
        stageId: 'direct',
        executorProfileId: '',
        status: 'accepted',
        attemptCount: 0,
        targetTextFields: [],
        skipReason: null,
        rawResponse,
        fallbackUsed: false,
        issues: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      }],
    },
  };
}

test('Undo履歴と復元ポイントはAI監査本文を重複保存せず復元時に現行監査記録から再結合する', () => {
  const initial = createInitialState(6);
  const playerId = initial.players[0].id;
  const firstTurn = createAiTurn({ id: 'turn-first', playerId, promptText: 'PROMPT-FIRST', rawResponse: 'RAW-FIRST' });
  initial.aiTurns = [firstTurn];
  const store = new StateStore(initial);
  const point = store.createRestorePoint('AI回答前');

  const secondTurn = createAiTurn({ id: 'turn-second', playerId, promptText: 'PROMPT-SECOND', rawResponse: 'RAW-SECOND' });
  store.commit('AI回答追加', (draft) => {
    draft.aiTurns.push(secondTurn);
    draft.game.title = 'AI回答追加後';
  });

  const stateAfterCommit = store.getState();
  assert.equal(stateAfterCommit.undoStack[0].state.aiTurns[0].promptText, '');
  assert.equal(stateAfterCommit.undoStack[0].state.aiTurns[0].rawResponse, '');
  assert.equal(stateAfterCommit.undoStack[0].state.aiTurns[0].generationRun.stages[0].rawResponse, '');
  assert.equal(stateAfterCommit.restorePoints[0].state.aiTurns[0].rawResponse, '');

  assert.equal(store.undo(), true);
  assert.equal(store.getState().aiTurns.length, 1);
  assert.equal(store.getState().aiTurns[0].promptText, 'PROMPT-FIRST');
  assert.equal(store.getState().aiTurns[0].rawResponse, 'RAW-FIRST');
  assert.equal(store.getState().aiTurns[0].generationRun.stages[0].rawResponse, 'RAW-FIRST');

  assert.equal(store.redo(), true);
  assert.equal(store.getState().aiTurns.length, 2);
  assert.equal(store.getState().aiTurns[1].promptText, 'PROMPT-SECOND');
  assert.equal(store.getState().aiTurns[1].rawResponse, 'RAW-SECOND');
  assert.equal(store.getState().aiTurns[1].generationRun.stages[0].rawResponse, 'RAW-SECOND');

  store.commit('復元後に無効化される公開イベント追加', (draft) => {
    addEvent(draft, {
      type: 'system',
      audience: { type: 'public', targetIds: [] },
      status: 'published',
      payload: { text: '復元後は無効になる公開イベント' },
    });
  }, { publicBarrier: true });
  const restoreResponse = restoreGameFromPoint(store, { pointId: point.id, reason: '入力内容の訂正' });
  assert.equal(restoreResponse.ok, true, restoreResponse.message);
  assert.equal(store.getState().aiTurns.length, 1);
  assert.equal(store.getState().aiTurns[0].promptText, 'PROMPT-FIRST');
  assert.equal(store.getState().aiTurns[0].rawResponse, 'RAW-FIRST');
  assert.equal(store.getState().game.correctionMode.enabled, true);
  assert.ok(store.getState().restorePoints.some((entry) => entry.label.startsWith('訂正開始時の現在状態')));
  assert.equal(restoreResponse.restoreContext.supersededEvents.length, 1);
  const auditEvent = store.getState().events.find((event) => event.type === 'correction-audit');
  const publicCorrection = store.getState().events.find((event) => event.type === 'correction');
  assert.ok(auditEvent);
  assert.equal(auditEvent.audience.type, 'gm');
  assert.equal(auditEvent.payload.supersededEvents[0].payload.text, '復元後は無効になる公開イベント');
  assert.ok(publicCorrection);
  assert.equal(publicCorrection.audience.type, 'public');
  assert.equal(Object.hasOwn(publicCorrection.payload, 'supersededEvents'), false, '無効化イベントの機密内容を公開訂正通知へ含めない');
  assert.equal(buildPublicSnapshot(store.getState()).events.some((event) => event.type === 'correction-audit'), false, 'GM限定の訂正監査を公開スナップショットへ出さない');

  const progressionStore = new StateStore(createInitialState(4));
  progressionStore.createRestorePoint('臨時確認地点');
  const dawnPoint = progressionStore.createRestorePoint('夜明け公開前');
  assert.equal(dawnPoint.label, '夜明け公開前', '固定復元ポイントを追加した場合も作成した地点自身を返す');
  let dawnEventId = null;
  progressionStore.commit('夜明け公開', (draft) => {
    dawnEventId = addEvent(draft, {
      type: 'dawn',
      audience: { type: 'public', targetIds: [] },
      status: 'published',
      payload: { text: '夜明け結果' },
    }).id;
  }, { publicBarrier: true });
  const recommendation = recommendRestorePointForProgressionEvent(progressionStore.getState(), dawnEventId);
  assert.equal(recommendation?.point.id, dawnPoint.id, '公開済み夜明けから対応する公開前復元地点を選ぶ');
  assert.equal(summarizeRestoreImpact(progressionStore.getState(), dawnPoint.id)?.supersededEventCount, 1, '復元で現在状態から外れるイベント数を事前表示できる');

  const setupCorrectionStore = new StateStore(createInitialState(4));
  const setupPoint = setupCorrectionStore.createRestorePoint('配役確定前');
  setupCorrectionStore.commit('誤った準備公開', (draft) => {
    addEvent(draft, { type: 'system', audience: { type: 'public', targetIds: [] }, status: 'published', payload: { text: '訂正対象' } });
  }, { publicBarrier: true });
  assert.equal(restoreGameFromPoint(setupCorrectionStore, { pointId: setupPoint.id, reason: '配役設定の訂正' }).ok, true);
  setupCorrectionStore.commit('訂正完了', (draft) => { assert.equal(exitCorrectionMode(draft).ok, true); });
  let setupStartResponse = null;
  setupCorrectionStore.commit('訂正後の配役確定', (draft) => { setupStartResponse = startGame(draft); });
  assert.equal(setupStartResponse.ok, true);
  assert.ok(setupCorrectionStore.getState().events.some((event) => event.type === 'correction-audit'), '配役確定前へ戻して再開始してもGM訂正監査を保持する');
  assert.ok(setupCorrectionStore.getState().events.some((event) => event.type === 'correction'), '配役確定前へ戻して再開始しても公開訂正通知を保持する');

  const checkpointStore = new StateStore(createInitialState(6));
  const mandatoryRestorePointTypes = Object.values(RESTORE_POINT_TYPES);
  checkpointStore.commit('必須復元ポイント作成', (draft) => {
    mandatoryRestorePointTypes.forEach((type) => {
      requestMandatoryRestorePoint(draft, type);
      requestMandatoryRestorePoint(draft, type);
    });
  }, { recordUndo: false });
  const checkpointLabels = checkpointStore.getState().restorePoints.map((entry) => entry.label);
  assert.deepEqual(checkpointLabels, mandatoryRestorePointTypes.map((type) => RESTORE_POINT_LABELS[type]));
  assert.equal(new Set(checkpointLabels).size, mandatoryRestorePointTypes.length, '同一更新内の重複要求は一件へまとめる');


  const lifecycleStore = new StateStore(createInitialState(4));
  let response = null;
  lifecycleStore.commit('配役確定', (draft) => { response = startGame(draft); });
  assert.equal(response.ok, true);
  assert.deepEqual(lifecycleStore.getState().restorePoints.map((entry) => entry.label), ['配役確定前']);
  const rolePoint = lifecycleStore.getState().restorePoints.find((entry) => entry.label === '配役確定前');
  assert.equal(rolePoint.state.game.phase, 'setup');

  lifecycleStore.getState().players.forEach((player) => {
    lifecycleStore.commit(`${player.name}役職表示`, (draft) => { response = markBriefingShown(draft, player.id); });
    assert.equal(response.ok, true);
    lifecycleStore.commit(`${player.name}役職確認`, (draft) => { response = acknowledgeRole(draft, player.id); });
    assert.equal(response.ok, true);
  });
  const gameStartPoints = lifecycleStore.getState().restorePoints.filter((entry) => entry.label === 'ゲーム開始前');
  assert.equal(gameStartPoints.length, 1, '最後の役職確認から実ゲームへ移る直前だけゲーム開始前を保存する');
  assert.equal(gameStartPoints[0].state.game.phase, 'briefing');
  assert.equal(gameStartPoints[0].state.briefing.eligiblePlayerIds.every((id) => ['acknowledged', 'gm-forced'].includes(gameStartPoints[0].state.briefing.noticeStatusByPlayerId[id])), true, '全員の役職確認が済んだ実ゲーム開始直前を保存する');
  assert.equal(gameStartPoints[0].state.briefing.completed, false, '実ゲーム開始処理自体はまだ適用されていない');
  assert.notEqual(gameStartPoints[0].state.revision, rolePoint.state.revision, '配役確定前とゲーム開始前は別の進行状態を保存する');

  for (let index = 0; index < 20; index += 1) lifecycleStore.createRestorePoint(`臨時復元ポイント${index + 1}`);
  assert.equal(lifecycleStore.getState().restorePoints.length, 16);
  assert.ok(lifecycleStore.getState().restorePoints.some((entry) => entry.label === '配役確定前'), '長期戦でも配役確定前を保持する');
  assert.ok(lifecycleStore.getState().restorePoints.some((entry) => entry.label === 'ゲーム開始前'), '長期戦でもゲーム開始前を保持する');
});
