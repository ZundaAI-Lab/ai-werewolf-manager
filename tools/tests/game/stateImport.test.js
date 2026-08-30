/**
 * 責務: 現行ゲームJSONのschema境界、正式リリース済みゲームJSONの一方向移行、現在仕様の構造・参照検証、イベント履歴を一次情報とする派生状態再構築を検証する。
 * 変更ルール: v1.0.3以降の正式保存ゲームをfixtureとして保持し、AI履歴・投票・内部判断・Undo/Redo/復元ポイントを失う変更を禁止する。現行schema受入、未来/無版schema拒否、現在必要な構造の厳格検証、決定的な派生状態再構築も継続する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, SCHEMA_VERSION } from '../../../app/renderer/js/config/constants.js';
import { createInitialState, StateStore } from '../../../app/renderer/js/state/stateStore.js';
import { recordAiSpeech } from '../../../app/renderer/js/domain/discussion/discussionCommands.js';
import { createEvent } from '../../../app/renderer/js/domain/events/eventStore.js';
import { beginVote, finalizeVote, publishExecution, publishVoteResult, recordVote, resolveExecution } from '../../../app/renderer/js/domain/vote/voteCommands.js';
import { prepareImportedState } from '../../../app/renderer/js/state/stateImport.js';
import { validateImportedState } from '../../../app/renderer/js/state/stateValidator.js';
import { createGameCallNameSnapshot } from '../../../app/renderer/js/characters/callNames/callNameResolver.js';
import { applyGameRuleChange } from '../../../app/renderer/js/domain/game/gameRulePolicy.js';
import { synchronizePlayerKnowledgeForTest } from './testStateHelpers.js';

function createHistoryEntry(id, state) {
  return {
    id,
    label: `履歴 ${id}`,
    createdAt: '2026-08-16T00:00:00.000Z',
    state,
  };
}

test('現行製品schemaのゲームJSONを履歴込みで読み込み入力を破壊しない', () => {
  const raw = runningDiscussionStateForGenerationAudit();
  raw.undoStack.push(createHistoryEntry('preserved-undo', runningDiscussionStateForGenerationAudit()));
  raw.redoStack.push(createHistoryEntry('preserved-redo', runningDiscussionStateForGenerationAudit()));
  raw.restorePoints.push(createHistoryEntry('preserved-restore', runningDiscussionStateForGenerationAudit()));
  const before = structuredClone(raw);

  const prepared = prepareImportedState(raw);
  const store = new StateStore(createInitialState(6));
  store.replace('JSONインポート', prepared, { preserveProvidedHistory: true });
  const loaded = store.getState();

  assert.equal(prepared.schemaVersion, SCHEMA_VERSION);
  assert.equal(prepared.runtime.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(loaded.undoStack.map((entry) => entry.id), ['preserved-undo']);
  assert.deepEqual(loaded.redoStack.map((entry) => entry.id), ['preserved-redo']);
  assert.deepEqual(loaded.restorePoints.map((entry) => entry.id), ['preserved-restore']);
  assert.deepEqual(raw, before, '入力データを破壊しない');
});

test('未来schemaのゲームJSONは推測して読まず最新版を要求する', () => {
  const raw = runningDiscussionStateForGenerationAudit();
  raw.schemaVersion = SCHEMA_VERSION + 1;
  assert.throws(() => prepareImportedState(raw), /現在のアプリより新しいschemaVersion/u);
});

test('schemaVersionがないゲームJSONは製品データとして受理しない', () => {
  const raw = runningDiscussionStateForGenerationAudit();
  delete raw.schemaVersion;
  assert.throws(() => prepareImportedState(raw), /有効なschemaVersionがありません/u);
});

test('ゲーム事実のaliveは真偽値以外を補正せず拒否する', () => {
  const raw = runningDiscussionStateForGenerationAudit();
  raw.players[0].alive = 'false';
  assert.throws(() => prepareImportedState(raw), /生存状態が真偽値ではありません/u);
});



test('公開用役職構成は既知役職・正の整数人数・参加人数合計だけを保存値として受理する', () => {
  const valid = createInitialState(6);
  valid.game.publicRoleComposition = { wolf: 1, seer: 1, villager: 3, guard: 1 };
  assert.doesNotThrow(() => prepareImportedState(valid));

  const cases = [
    ['未知役職', { wolf: 1, alien: 5 }, /未対応の役職ID/u],
    ['負数', { wolf: 1, villager: 6, seer: -1 }, /正の整数/u],
    ['文字列人数', { wolf: 1, villager: '5' }, /正の整数/u],
    ['合計不一致', { wolf: 1, villager: 4 }, /合計人数が参加人数と一致/u],
    ['空構成', {}, /空です/u],
  ];

  cases.forEach(([label, composition, pattern]) => {
    const raw = createInitialState(6);
    raw.game.publicRoleComposition = composition;
    assert.throws(() => prepareImportedState(raw), pattern, label);
  });
});


test('開始前プレイヤー別配役スナップショットは全参加者の既知役職だけを受理する', () => {
  const raw = createInitialState(4);
  raw.game.setupRoleAssignments = Object.fromEntries(raw.players.map((player) => [player.id, player.roleId]));
  assert.doesNotThrow(() => prepareImportedState(raw));

  const missing = structuredClone(raw);
  delete missing.game.setupRoleAssignments[missing.players[0].id];
  assert.throws(() => prepareImportedState(missing), /開始前役職がありません/u);

  const unknownRole = structuredClone(raw);
  unknownRole.game.setupRoleAssignments[unknownRole.players[0].id] = 'not-a-role';
  assert.throws(() => prepareImportedState(unknownRole), /役職IDが不正/u);
});

test('ゲームルールに存在する不正な型・列挙値・数値範囲は補正せず拒否する', () => {
  const cases = [
    ['speechCountPerDay', (rules) => { rules.speechCountPerDay = -999; }, /speechCountPerDayは1以上/u],
    ['discussion.mode', (rules) => { rules.discussion.mode = 'broken-mode'; }, /discussion\.modeは許可された選択値/u],
    ['firstNight.wolfAttackEnabled', (rules) => { rules.firstNight.wolfAttackEnabled = 'yes'; }, /wolfAttackEnabledは真偽値/u],
    ['vote.abstentionAllowed', (rules) => { rules.vote.abstentionAllowed = 'true'; }, /abstentionAllowedは真偽値/u],
    ['ai.maxPublicSpeechLength', (rules) => { rules.ai.maxPublicSpeechLength = 0; }, /maxPublicSpeechLengthは1以上/u],
    ['vote object', (rules) => { rules.vote = []; }, /game\.rules\.voteはオブジェクト/u],
  ];

  cases.forEach(([label, mutate, pattern]) => {
    const raw = createInitialState(6);
    mutate(raw.game.rules);
    assert.throws(() => prepareImportedState(raw), pattern, label);
  });
});


test('準備画面用ルール変更もインポートと同じ値仕様で検証する', () => {
  const rules = structuredClone(DEFAULT_RULES);
  assert.equal(applyGameRuleChange(rules, 'speechCountPerDay', '10').speechCountPerDay, 10);
  assert.equal(applyGameRuleChange(rules, 'wolfCommunication.mode', 'none').wolfCommunication.enabled, false);
  assert.throws(() => applyGameRuleChange(rules, 'speechCountPerDay', '0'), /speechCountPerDayは1以上/u);
  assert.throws(() => applyGameRuleChange(rules, 'discussion.mode', 'broken-mode'), /discussion\.modeは許可された選択値/u);
});

function staleDecisionState(state, playerIndex = 0) {
  const player = state.players[playerIndex];
  const target = state.players[(playerIndex + 1) % state.players.length];
  player.decisionState = {
    suspicionCandidateIds: [target.id],
    executionCandidateIds: [target.id],
    intendedVoteId: target.id,
    assessmentLevel: 'moderate',
    keyPublicEvidenceEventIds: [],
    revisionCause: 'new-public-evidence',
    leaveAliveBenefit: '低い',
    misexecutionCost: '不明',
    selectionDifference: '暫定候補との差',
    uncertainty: '履歴には存在しない',
    nextDiscriminatingInformation: '次の公開発言',
    decisionReason: '保存時点では対象を疑っていたため。',
    hasDecisionChanged: true,
    changedFields: ['suspicionCandidateIds', 'executionCandidateIds', 'intendedVoteId', 'assessmentLevel'],
    updatedAt: '2026-07-18T00:00:00.000Z',
    sourceAiTurnId: null,
    sourceEventId: null,
    sourceDay: Number(state.game.day),
  };
}


function runningDiscussionStateForGenerationAudit() {
  const state = createInitialState(6);
  state.game.status = 'running';
  state.game.day = 1;
  state.game.phase = 'discussion';
  state.game.callNameSnapshot = createGameCallNameSnapshot(state.players);
  synchronizePlayerKnowledgeForTest(state);
  const ids = state.players.map((player) => player.id);
  state.discussion = {
    day: 1, mode: 'ordered', modeControl: null, round: 1, roundKind: 'normal', roundStartedAtSequence: 0,
    roundEligiblePlayerIds: [...ids], queue: [...ids], currentIndex: 0,
    designatedPlayerId: null, spokenInCurrentRound: [], deferredPlayerIds: [],
    deferredCountByPlayer: Object.fromEntries(ids.map((id) => [id, 0])), allDeferred: false,
    remainingByPlayer: Object.fromEntries(ids.map((id) => [id, 1])),
    reconsideration: { pending: false, active: false, items: [], reasons: [], sourceEventIds: [], affectedPlayerIds: [], updatedAt: null, handledRound: null },
    completed: false,
  };
  return state;
}

test('読込はdecisionState確定後にmemoryLedgerを再構築し同じJSONから決定的な派生状態を得る', () => {
  const raw = runningDiscussionStateForGenerationAudit();
  staleDecisionState(raw);
  raw.players[0].memoryLedger.publicCommitments = [{
    id: 'stale-commitment',
    type: 'decision',
    text: '履歴に存在しない古い疑い先',
    sourceEventId: null,
    active: true,
  }];
  raw.players[0].memoryLedger.pendingDiscriminators = [{
    id: 'stale-discriminator',
    text: '履歴に存在しない確認事項',
    sourceEventId: null,
    active: true,
  }];

  const first = prepareImportedState(structuredClone(raw));
  const second = prepareImportedState(structuredClone(raw));
  assert.deepEqual(first, second, '同一JSONの派生状態は読込時刻に依存しない');
  assert.deepEqual(first.players[0].decisionState.suspicionCandidateIds, []);
  assert.equal(first.players[0].decisionState.intendedVoteId, null);
  assert.equal(first.players[0].memoryLedger.publicCommitments.some((item) => item.id === 'stale-commitment'), false);
  assert.equal(first.players[0].memoryLedger.pendingDiscriminators.some((item) => item.id === 'stale-discriminator'), false);
});


function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}


function legacyGenerationRunV1() {
  return {
    schemaVersion: 1,
    executionMode: 'automatic',
    depth: 4,
    ownerProfileId: 'legacy-owner-profile',
    taskCategory: 'speech',
    normalCallCount: 3,
    totalCallCount: 3,
    finalStageId: 'proofread',
    stages: [
      {
        stageId: 'draft', executorProfileId: 'legacy-draft-profile', status: 'accepted', attemptCount: 1,
        targetTextFields: [], skipReason: null, rawResponse: '{"publicSpeech":"下書き"}', fallbackUsed: false,
        issues: [], usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 15 },
      },
      {
        stageId: 'render', executorProfileId: 'legacy-render-profile', status: 'applied', attemptCount: 1,
        targetTextFields: ['publicSpeech'], skipReason: null, rawResponse: '{"publicSpeech":"発言化"}', fallbackUsed: false,
        issues: [], usage: { inputTokens: 8, outputTokens: 4, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 12 },
      },
      {
        stageId: 'proofread', executorProfileId: 'legacy-proofread-profile', status: 'applied', attemptCount: 1,
        targetTextFields: ['publicSpeech'], skipReason: null, rawResponse: '{"publicSpeech":"校正済み"}', fallbackUsed: false,
        issues: [], usage: { inputTokens: 6, outputTokens: 3, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 9 },
      },
    ],
  };
}

function generationRunWithSkippedStages() {
  return {
    schemaVersion: 2,
    executionMode: 'automatic',
    depth: 4,
    ownerProfileId: 'missing-owner-profile',
    taskCategory: 'speech',
    normalCallCount: 3,
    totalCallCount: 3,
    finalStageId: 'finalize',
    stages: [
      {
        stageId: 'analyze', executorProfileId: 'missing-draft-profile', status: 'accepted', attemptCount: 1,
        targetTextFields: [], skipReason: null, rawResponse: '監査対象の客観分析',
        fallbackUsed: false, issues: [], rejectedAttempts: [], usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 120 },
      },
      {
        stageId: 'critique', executorProfileId: 'missing-proofread-profile', status: 'fallback', attemptCount: 0,
        targetTextFields: [], skipReason: null, rawResponse: '',
        fallbackUsed: true, issues: [{ code: 'STAGE_API_ERROR', message: '監査用の検証失敗' }], rejectedAttempts: [], usage: zeroUsage(),
      },
      {
        stageId: 'finalize', executorProfileId: 'missing-render-profile', status: 'accepted', attemptCount: 2,
        targetTextFields: [], skipReason: null, rawResponse: '{"publicSpeech":"監査対象"}',
        fallbackUsed: false, issues: [], rejectedAttempts: [{
          attempt: 1, phase: 'normal', issueCodes: ['JSON_UNTERMINATED_STRING'],
          issues: [{ code: 'JSON_UNTERMINATED_STRING', category: 'syntax', path: '' }],
        }], usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 120 },
      },
    ],
  };
}


test('v1.0.3ゲームJSONをgenerationRunと履歴を保持して現行schemaへ移行できる', () => {
  const raw = runningDiscussionStateForGenerationAudit();
  const currentRun = generationRunWithSkippedStages();
  const response = recordAiSpeech(raw, {
    playerId: raw.players[0].id,
    content: '旧版ゲーム移行確認用の発言です。',
    coOperation: { action: 'none', roleId: 'none' },
    promptText: 'v1.0.3 prompt',
    rawResponse: '{"publicSpeech":"旧版ゲーム移行確認用の発言です。"}',
    generationRun: currentRun,
  });
  assert.equal(response.ok, true, response.message);
  raw.aiTurns.at(-1).generationRun = legacyGenerationRunV1();
  raw.schemaVersion = 1;
  raw.runtime.schemaVersion = 1;
  raw.appVersion = '1.0.3';
  raw.runtime.appVersion = '1.0.3';
  const historyState = structuredClone(raw);
  historyState.undoStack = [];
  historyState.redoStack = [];
  historyState.restorePoints = [];
  raw.undoStack = [createHistoryEntry('legacy-undo', historyState)];

  const prepared = prepareImportedState(structuredClone(raw));
  const checked = validateImportedState(prepared);
  assert.equal(checked.ok, true, checked.errors.join('\n'));
  assert.equal(prepared.schemaVersion, SCHEMA_VERSION);
  assert.equal(prepared.aiTurns.at(-1).generationRun.schemaVersion, 2);
  assert.deepEqual(prepared.aiTurns.at(-1).generationRun.stages.map((stage) => stage.stageId), ['decide', 'render', 'render']);
  assert.equal(prepared.aiTurns.at(-1).generationRun.finalStageId, 'render');
  assert.deepEqual(prepared.aiTurns.at(-1).generationRun.stages.map((stage) => stage.rejectedAttempts), [[], [], []]);
  assert.equal(prepared.aiTurns.at(-1).generationRun.stages[2].rawResponse, '{"publicSpeech":"校正済み"}');
  assert.equal(prepared.undoStack.length, 1);
  assert.equal(prepared.undoStack[0].state.aiTurns.at(-1).generationRun.schemaVersion, 2);
});

test('公開済みv1.0.4のroot schema 1 + generationRun schema 2ゲームJSONもそのまま救済する', () => {
  const raw = runningDiscussionStateForGenerationAudit();
  const generationRun = generationRunWithSkippedStages();
  const response = recordAiSpeech(raw, {
    playerId: raw.players[0].id,
    content: 'v1.0.4保存互換確認です。',
    coOperation: { action: 'none', roleId: 'none' },
    promptText: 'v1.0.4 prompt',
    rawResponse: '{"publicSpeech":"v1.0.4保存互換確認です。"}',
    generationRun,
  });
  assert.equal(response.ok, true, response.message);
  raw.schemaVersion = 1;
  raw.runtime.schemaVersion = 1;
  const prepared = prepareImportedState(structuredClone(raw));
  assert.equal(prepared.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(prepared.aiTurns.at(-1).generationRun, generationRun);
});

test('generationRunをexact shapeのまま保存・再読込し現在存在しない工程担当IDも許可する', () => {
  const raw = runningDiscussionStateForGenerationAudit();
  const generationRun = generationRunWithSkippedStages();
  const response = recordAiSpeech(raw, {
    playerId: raw.players[0].id,
    content: '生成工程監査を保存します。',
    coOperation: { action: 'none', roleId: 'none' },
    promptText: '元の本番プロンプト',
    rawResponse: '{"publicSpeech":"生成工程監査を保存します。"}',
    generationRun,
  });
  assert.equal(response.ok, true, response.message);
  assert.deepEqual(raw.aiTurns.at(-1).generationRun, generationRun);

  const prepared = prepareImportedState(structuredClone(raw));
  const checked = validateImportedState(prepared);
  assert.equal(checked.ok, true, checked.errors.join('\n'));
  assert.deepEqual(prepared.aiTurns.at(-1).generationRun, generationRun);
});


test('客観分析を取得できない場合のcritique省略状態を保存・再読込できる', () => {
  const raw = runningDiscussionStateForGenerationAudit();
  const generationRun = generationRunWithSkippedStages();
  generationRun.stages[1] = {
    stageId: 'critique', executorProfileId: 'missing-proofread-profile', status: 'skipped', attemptCount: 0,
    targetTextFields: [], skipReason: 'ANALYSIS_UNAVAILABLE', rawResponse: '',
    fallbackUsed: false, issues: [{ code: 'ANALYSIS_UNAVAILABLE', message: '客観分析を取得できなかったため、批判的検証を省略しました。' }], rejectedAttempts: [], usage: zeroUsage(),
  };
  const response = recordAiSpeech(raw, {
    playerId: raw.players[0].id,
    content: '客観分析なしでも最終回答を保存します。',
    coOperation: { action: 'none', roleId: 'none' },
    promptText: '元の本番プロンプト',
    rawResponse: '{"publicSpeech":"客観分析なしでも最終回答を保存します。"}',
    generationRun,
  });
  assert.equal(response.ok, true, response.message);

  const prepared = prepareImportedState(structuredClone(raw));
  const checked = validateImportedState(prepared);
  assert.equal(checked.ok, true, checked.errors.join('\n'));
  assert.deepEqual(prepared.aiTurns.at(-1).generationRun, generationRun);
});


test('decisionState再構築比較はオブジェクトのキー順だけの差を不一致扱いしない', () => {
  const raw = createInitialState(6);
  const original = raw.players[0].decisionState;
  raw.players[0].decisionState = Object.fromEntries(Object.entries(original).reverse());

  const checked = validateImportedState(raw);
  assert.equal(checked.ok, true, checked.errors.join('\n'));
});

test('decisionState再構築比較はキー順を無視しても値の差は拒否する', () => {
  const raw = createInitialState(6);
  const original = raw.players[0].decisionState;
  raw.players[0].decisionState = Object.fromEntries(Object.entries(original).reverse());
  raw.players[0].decisionState.uncertainty = 'イベント履歴には存在しない差分';

  const checked = validateImportedState(raw);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join('\n'), /判断状態がイベント履歴から再構築した内容と一致しません/u);
});


test('取込境界はDOM属性や動的キーへ使用できないエンティティIDを拒否する', () => {
  const maliciousPlayer = createInitialState(6);
  maliciousPlayer.players[0].id = 'x" autofocus onfocus="globalThis.pwned=1';
  const playerChecked = validateImportedState(maliciousPlayer);
  assert.equal(playerChecked.ok, false);
  assert.match(playerChecked.errors.join('\n'), /players\[0\]\.idは半角英数字/u);

  const maliciousGame = createInitialState(6);
  maliciousGame.game.id = '__proto__';
  const gameChecked = validateImportedState(maliciousGame);
  assert.equal(gameChecked.ok, false);
  assert.match(gameChecked.errors.join('\n'), /game\.idは半角英数字/u);
});



test('存在しないObject prototype名をキャラクターカードIDとして受理しない', () => {
  ['toString', 'hasOwnProperty', 'constructor', '__proto__'].forEach((characterCardId) => {
    const raw = createInitialState(6);
    raw.players[0].characterCardId = characterCardId;
    const checked = validateImportedState(raw);
    assert.equal(checked.ok, false, `${characterCardId}を拒否する`);
    assert.match(checked.errors.join('\n'), /キャラクターカードIDが不正です/u);
  });
});
