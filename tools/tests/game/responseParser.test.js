/**
 * 責務: ゲーム進行に必要なAI応答JSONの必須契約、昼議論の心の声境界、不正JSON拒否、主要な対象・状態境界の検証を確認する。
 * 変更ルール: 個別不具合の再現テストを追加せず、全タスク共通の回答検証必須境界、プロンプト掲載される検証任意項目の欠落受理、外部AI応答の構文安全・資源上限、代表的な構造・異常系だけを検証する。AI応答の外部キー変更時はresponseContract.jsと解析結果の整合を同じ契約境界として確認する。heartVoiceの長さ契約は文字数上限だけを検証し、文数制約を再導入しない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAiResponse } from '../../../app/renderer/js/prompts/response/responseParser.js';
import { validateAiResponse } from '../../../app/renderer/js/prompts/response/responseValidator.js';
import {
  extractJsonObjectText,
  parseCompleteTopLevelFields,
  parseJsonObjectStrict,
  parseJsonObjectWithEnvelopeRecovery,
} from '../../../app/renderer/js/prompts/response/repair/jsonObjectRecovery.js';
import {
  buildResponseContractExample,
  getRequiredResponseTopLevelKeys,
} from '../../../app/renderer/js/prompts/response/responseContract.js';
import { renderActiveResponseContract } from '../../../app/renderer/js/prompts/response/activeResponseContract.js';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { createEvent } from '../../../app/renderer/js/domain/events/eventStore.js';
import { validateFactionStrategyPatch } from '../../../app/renderer/js/domain/game/factionStrategyState.js';
import {
  attackResponse,
  freezeActionResponse,
  nightActionResponse,
  speechResponse,
} from './responseFixtures.js';



test('JSON回復はnull prototype辞書を生成し特殊キーによるプロトタイプ変更を拒否する', () => {
  const parsed = parseJsonObjectStrict('{"publicSpeech":"本文","scores":[0,-1.25,2e3]}', []);
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.deepEqual(parsed.scores, [0, -1.25, 2000]);

  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(
      () => parseJsonObjectStrict(`{"publicSpeech":"本文","${key}":{"injected":"YES"}}`, []),
      (error) => error?.code === 'INVALID_JSON' && error.message.includes(`${key}はオブジェクトキーに使用できません`),
      key,
    );
  }

  const operations = [];
  const partial = parseCompleteTopLevelFields(
    '{"publicSpeech":"途中まで完結","heartVoice":"内心",',
    ['publicSpeech', 'heartVoice'],
    operations,
  );
  assert.equal(Object.getPrototypeOf(partial), null);
  assert.deepEqual({ ...partial }, { publicSpeech: '途中まで完結', heartVoice: '内心' });
  assert.equal(operations.some((entry) => entry.code === 'PARTIAL_JSON_FIELDS_RECOVERED'), true);

  const nestedPartial = parseCompleteTopLevelFields(
    '{"decisionPatch":{"grounding":{"evidenceRefs":[1]}},',
    ['decisionPatch'],
    [],
  );
  assert.equal(Object.getPrototypeOf(nestedPartial.decisionPatch), null);
  assert.equal(Object.getPrototypeOf(nestedPartial.decisionPatch.grounding), null);
  assert.equal(
    parseCompleteTopLevelFields('{"decisionPatch":{"__proto__":{"injected":true}},', ['decisionPatch'], []),
    null,
  );

  const envelope = parseJsonObjectWithEnvelopeRecovery('説明\n```json\n{"chatMessage":"本文","interaction":{}}\n```');
  assert.equal(Object.getPrototypeOf(envelope), null);
  assert.equal(Object.getPrototypeOf(envelope.interaction), null);
  assert.equal(parseJsonObjectWithEnvelopeRecovery('{"interaction":{"prototype":{}}}'), null);
});

test('JSON回復は未閉鎖の外側があっても完結した内部オブジェクトを回収し過剰入力を有界時間で処理する', { timeout: 1000 }, () => {
  const operations = [];
  assert.equal(
    extractJsonObjectText('{"broken": {"publicSpeech":"回収対象"}', operations),
    '{"publicSpeech":"回収対象"}',
  );
  assert.equal(operations.some((entry) => entry.code === 'SURROUNDING_TEXT_REMOVED'), true);

  const malformed = '{'.repeat(64_000);
  assert.equal(extractJsonObjectText(malformed, []), malformed);
});

test('AI応答JSONは過剰ネストを分類可能な構文エラーとして拒否する', () => {
  const nestedValue = `${'['.repeat(70)}0${']'.repeat(70)}`;
  assert.throws(
    () => parseJsonObjectStrict(`{"value":${nestedValue}}`, []),
    (error) => error?.code === 'JSON_TOO_DEEP',
  );
  const parsed = parseAiResponse(`{"publicSpeech":"本文","heartVoice":${nestedValue}}`, 'speech');
  assert.equal(parsed.diagnostics.issues[0]?.code, 'JSON_TOO_DEEP');
  assert.match(parsed.diagnostics.errors[0] ?? '', /ネストが上限/u);
});

test('各タスクはゲーム進行に必要な最小キーだけで解析でき、投票の説明項目欠落をエラーにしない', () => {
  assert.deepEqual(getRequiredResponseTopLevelKeys('vote'), ['actionAnswer']);
  const cases = [
    ['vote', { actionAnswer: '四国めたん' }],
    ['night-action', { actionAnswer: '四国めたん' }],
    ['attack-action', { actionAnswer: '四国めたん' }],
    ['freeze-action', { actionAnswer: '四国めたん' }],
    ['wolf', { wolfMessage: '潜伏を続けます。' }],
    ['mason', { masonMessage: '公開方針を合わせます。' }],
  ];

  cases.forEach(([mode, payload]) => {
    const result = parseAiResponse(JSON.stringify(payload), mode);
    assert.deepEqual(result.diagnostics.errors, [], mode);
    assert.equal(result.value.heartVoice, '', mode);
    if (payload.rationale) assert.equal(result.value.selectionRationale, payload.rationale, mode);
    else assert.equal(result.value.selectionRationale, '', mode);
  });
});


test('生存人狼仲間がいない場合partnerDispositionはAI差分として受け付けず内部正規化だけに任せる', () => {
  const result = validateFactionStrategyPatch(null, {
    mode: 'patch',
    changes: { partnerDisposition: 'not-applicable' },
  }, 'wolf', {
    partnerDispositionPolicy: {
      hasAlivePartner: false,
      allowedValues: ['not-applicable'],
      requiredValue: 'not-applicable',
    },
    updatePolicy: { requiredFields: [], missingRequiredFields: [] },
  });
  assert.equal(result.errors.some((error) => error.includes('partnerDisposition')), true);
  assert.equal(result.resolvedUpdate, null);
});

test('投票理由はrationaleだけを受け付け、判断状態の理由にも同じ値を使用する', () => {
  const state = createInitialState(6);
  const actor = state.players[0];
  const target = state.players[1];
  const rationale = `${target.name}は公開発言の矛盾が他候補より大きく、今日の処刑価値が高いと判断したためです。`;
  const payload = {
    actionAnswer: target.name,
    rationale,
    decisionPatch: {
      executionCandidates: [target.name],
      assessmentLevel: 'moderate',
      misexecutionCost: '村側なら処刑余裕を失う。',
      selectionDifference: '他候補より公開発言の矛盾が大きい。',
    },
  };
  const parsed = parseAiResponse(JSON.stringify(payload), 'vote');
  assert.deepEqual(parsed.diagnostics.errors, []);
  const validation = validateAiResponse(state, {
    parsed,
    playerId: actor.id,
    taskType: 'vote',
    candidateIds: state.players.slice(1).map((player) => player.id),
  });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(validation.resolvedDecisionUpdate.decisionReason, rationale);
});


test('必須項目欠落・未知キー・重複キー・JSON外文章を拒否する', () => {
  const missing = parseAiResponse(JSON.stringify({ heartVoice: '本心です。' }), 'speech');
  assert.equal(missing.diagnostics.errors.some((error) => error.includes('response.publicSpeechがありません')), true);

  const unknownPayload = JSON.parse(speechResponse('比較します。'));
  unknownPayload.unknownField = true;
  const unknown = parseAiResponse(JSON.stringify(unknownPayload), 'speech');
  assert.equal(unknown.diagnostics.errors.some((error) => error.includes('unknownField')), true);

  const duplicate = parseAiResponse('{"publicSpeech":"A","publicSpeech":"B"}', 'public-only');
  assert.equal(duplicate.diagnostics.errors.some((error) => error.includes('重複')), true);

  const trailing = parseAiResponse('{"publicSpeech":"A"}\n説明', 'public-only');
  assert.equal(trailing.diagnostics.errors.some((error) => error.includes('不要な文章')), true);

  const invalid = parseAiResponse('公開発言だけを返します。', 'public-only');
  assert.equal(invalid.diagnostics.errors.some((error) => error.includes('JSONとして解析できません')), true);
  assert.equal(invalid.diagnostics.issues[0].code, 'INVALID_JSON');

  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const forbiddenKey = parseAiResponse(`{"publicSpeech":"本文","${key}":{"injected":true}}`, 'public-only');
    assert.equal(
      forbiddenKey.diagnostics.errors.some((error) => error.includes(`${key}はオブジェクトキーに使用できません`)),
      true,
      key,
    );
    assert.equal(forbiddenKey.diagnostics.issues[0].code, 'INVALID_JSON', key);
  }

  const declareNone = parseAiResponse(JSON.stringify({
    publicSpeech: 'COします。',
    coOperation: { action: 'declare', roleId: 'none' },
  }), 'speech');
  assert.equal(
    declareNone.diagnostics.errors.some((error) => error.includes('roleIdにnoneは使用できません')),
    true,
  );
});


test('現行AI応答JSONキーを内部保存表現へ変換する', () => {
  const speech = parseAiResponse(JSON.stringify({
    publicSpeech: '判断と質問回答を更新します。',
    speechInteraction: { answerToRefs: [11] },
    abilityClaims: [{ intent: 'truthful', sourceRef: 21 }],
    decisionPatch: {
      suspects: ['四国めたん'],
      correctedSpeechRefs: [31],
      evidenceRefs: [32],
    },
    factionStrategy: {
      mode: 'patch',
      changes: { publicWorld: '公開情報だけで成立する世界を更新する。' },
    },
  }), 'speech');
  assert.deepEqual(speech.diagnostics.errors, []);
  assert.deepEqual(speech.value.speechInteraction.answerToRefs, [11]);
  assert.equal(speech.value.abilityClaims.claims[0].sourceRef, 21);
  assert.deepEqual(speech.value.decisionUpdate.changes.suspicionCandidateNames, ['四国めたん']);
  assert.deepEqual(speech.value.decisionUpdate.grounding.correctedSpeechRefs, [31]);
  assert.deepEqual(speech.value.decisionUpdate.grounding.evidenceRefs, [32]);
  assert.equal(speech.value.factionStrategyPatch.changes.publicWorld, '公開情報だけで成立する世界を更新する。');

  const wolf = parseAiResponse(JSON.stringify({
    wolfMessage: '共有方針を更新します。',
    sharedStrategy: {
      mode: 'patch',
      changes: { claimPlan: '潜伏を続ける。' },
    },
  }), 'wolf');
  assert.deepEqual(wolf.diagnostics.errors, []);
  assert.equal(wolf.value.sharedStrategyPatch.changes.claimPlan, '潜伏を続ける。');

  const vote = parseAiResponse(JSON.stringify({
    actionAnswer: '四国めたん',
    rationale: '公開情報から最も処刑価値が高いためです。',
  }), 'vote');
  assert.deepEqual(vote.diagnostics.errors, []);
  assert.equal(vote.value.selectionRationale, '公開情報から最も処刑価値が高いためです。');

  const memo = parseAiResponse(JSON.stringify({ fullMemo: '現在も必要な内部メモ全文です。' }), 'memo');
  assert.deepEqual(memo.diagnostics.errors, []);
  assert.equal(memo.value.fullMemo, '現在も必要な内部メモ全文です。');

  const attack = parseAiResponse(JSON.stringify({
    actionAnswer: '四国めたん',
    attackAssessment: {
      hunterAliveChance: 'medium',
      otherTarget: 'ずんだもん',
      otherGuardRisk: 'low',
    },
  }), 'attack-action');
  assert.deepEqual(attack.diagnostics.errors, []);
  assert.equal(attack.value.attackAssessment.hunterAliveChance, 'medium');
  assert.equal(attack.value.attackAssessment.otherTargetName, 'ずんだもん');
  assert.equal(attack.value.attackAssessment.otherTargetGuardRisk, 'low');
});



test('通常発言はpublicSpeechを必須として検証する', () => {
  const state = createInitialState(6);
  const playerId = state.players[0].id;

  const valid = validateAiResponse(state, {
    parsed: parseAiResponse(JSON.stringify({ publicSpeech: '新しい論点を述べます。' }), 'speech'),
    playerId,
    taskType: 'speech',
  });
  assert.equal(valid.ok, true, valid.errors.join('\n'));

  const empty = validateAiResponse(state, {
    parsed: parseAiResponse(JSON.stringify({ publicSpeech: '' }), 'speech'),
    playerId,
    taskType: 'speech',
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.errors.some((error) => error.includes('publicSpeech')), true);
});

test('heartVoiceは文数を制約せず文字数上限だけを警告する', () => {
  const state = createInitialState(6);
  const playerId = state.players[0].id;

  const multiSentence = validateAiResponse(state, {
    parsed: parseAiResponse(JSON.stringify({ publicSpeech: '公開本文です。', heartVoice: '一文目。二文目。三文目。' }), 'speech'),
    playerId,
    taskType: 'speech',
  });
  assert.equal(multiSentence.ok, true, multiSentence.errors.join('\n'));
  assert.equal(multiSentence.warnings.some((warning) => warning.includes('1～2文')), false);

  const tooLong = validateAiResponse(state, {
    parsed: parseAiResponse(JSON.stringify({ publicSpeech: '公開本文です。', heartVoice: 'あ'.repeat(121) }), 'speech'),
    playerId,
    taskType: 'speech',
  });
  assert.equal(tooLong.warnings.some((warning) => warning.includes('文字数上限120文字')), true);
});

test('対象外プレイヤーと生成後に更新された状態を登録前に拒否する', () => {
  const state = createInitialState(6);
  const playerId = state.players[0].id;
  const candidateIds = state.players.slice(1).map((player) => player.id);

  const invalidTarget = validateAiResponse(state, {
    parsed: parseAiResponse(JSON.stringify({ actionAnswer: '存在しないプレイヤー' }), 'vote'),
    playerId,
    taskType: 'vote',
    candidateIds,
  });
  assert.equal(invalidTarget.ok, false);
  assert.equal(invalidTarget.errors.some((error) => error.includes('行動回答の対象を一意に特定できません')), true);
  assert.equal(invalidTarget.issues[0].code, 'INVALID_ACTION_TARGET');
  assert.deepEqual(invalidTarget.issues[0].expectedValues, state.players.slice(1).map((player) => player.name));

  const stalePrompt = validateAiResponse(state, {
    parsed: parseAiResponse(JSON.stringify({ publicSpeech: '公開本文' }), 'speech'),
    playerId,
    taskType: 'speech',
    candidateIds: [],
    promptFingerprint: '生成時の状態',
    currentFingerprint: '更新後の状態',
  });
  assert.equal(stalePrompt.ok, false);
  assert.equal(stalePrompt.errors.some((error) => error.includes('プロンプト生成後に、本人から見えるゲーム状態が更新されています')), true);
  assert.equal(stalePrompt.issues.some((issue) => issue.code === 'STALE_PROMPT' && issue.category === 'state'), true);
});




test('truthful能力公開は本人P#正本から対象・Day・結果を解決しAIに事実値を再入力させない', () => {
  const state = createInitialState(6);
  const actor = state.players.find((player) => player.roleId === 'seer');
  const target = state.players.find((player) => player.id !== actor.id);
  state.game.day = 1;
  state.game.phase = 'discussion';
  const resultEvent = createEvent(state, {
    type: 'private-result',
    actorId: actor.id,
    targetIds: [target.id],
    audience: { type: 'player', targetIds: [actor.id] },
    payload: {
      actionType: 'inspect',
      targetId: target.id,
      result: 'not-wolf',
      availableFromDay: 1,
      nightDay: 0,
    },
  });

  const parsed = parseAiResponse(JSON.stringify({
    publicSpeech: '正式な能力結果を公開します。',
    coOperation: { action: 'declare', roleId: 'seer' },
    abilityClaims: [{ intent: 'truthful', sourceRef: resultEvent.sequence }],
  }), 'speech');
  assert.deepEqual(parsed.diagnostics.errors, []);
  assert.equal(Object.hasOwn(parsed.value.abilityClaims.claims[0], 'result'), false);
  assert.equal(Object.hasOwn(parsed.value.abilityClaims.claims[0], 'targetName'), false);

  const validation = validateAiResponse(state, {
    parsed,
    playerId: actor.id,
    taskType: 'speech',
  });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(validation.resolvedAbilityClaims[0].claimedRoleId, 'seer');
  assert.equal(validation.resolvedAbilityClaims[0].targetId, target.id);
  assert.equal(validation.resolvedAbilityClaims[0].result, 'not-wolf');
  assert.equal(validation.resolvedAbilityClaims[0].observedDay, 1);
  assert.equal(validation.normalizedParsedAbilityClaims.claims[0].result, 'not-wolf');
  assert.equal(validation.normalizedParsedAbilityClaims.claims[0].targetName, target.name);
});


test('truthful霊能公開は非人狼の正本をwolfへ反転できず、deceptionだけ自由結果を許可する', () => {
  const state = createInitialState(6);
  const actor = state.players.find((player) => player.roleId === 'seer');
  actor.roleId = 'medium';
  const target = state.players.find((player) => player.id !== actor.id);
  state.game.day = 1;
  state.game.phase = 'execution';
  createEvent(state, {
    type: 'execution',
    actorId: null,
    targetIds: [target.id],
    audience: { type: 'public', targetIds: [] },
    payload: { targetId: target.id, deadPlayerIds: [target.id] },
    status: 'published',
  });
  state.game.day = 2;
  state.game.phase = 'discussion';
  const resultEvent = createEvent(state, {
    type: 'private-result',
    actorId: actor.id,
    targetIds: [target.id],
    audience: { type: 'player', targetIds: [actor.id] },
    payload: {
      actionType: 'medium',
      targetId: target.id,
      result: 'not-wolf',
      availableFromDay: 2,
    },
  });

  const truthful = parseAiResponse(JSON.stringify({
    publicSpeech: '霊能結果を公開します。',
    coOperation: { action: 'declare', roleId: 'medium' },
    abilityClaims: [{ intent: 'truthful', sourceRef: resultEvent.sequence }],
  }), 'speech');
  const truthfulValidation = validateAiResponse(state, {
    parsed: truthful,
    playerId: actor.id,
    taskType: 'speech',
  });
  assert.equal(truthfulValidation.ok, true, truthfulValidation.errors.join('\n'));
  assert.equal(truthfulValidation.resolvedAbilityClaims[0].result, 'not-wolf');

  const injected = parseAiResponse(JSON.stringify({
    publicSpeech: '霊能結果を公開します。',
    coOperation: { action: 'declare', roleId: 'medium' },
    abilityClaims: [{
      intent: 'truthful',
      sourceRef: resultEvent.sequence,
      result: 'wolf',
    }],
  }), 'speech');
  assert.equal(injected.diagnostics.errors.some((error) => error.includes('abilityClaims[0].resultは未定義')), true);

  const deceptionState = createInitialState(6);
  const wolf = deceptionState.players.find((player) => player.roleId === 'wolf');
  const deceptionTarget = deceptionState.players.find((player) => player.id !== wolf.id);
  deceptionState.game.day = 1;
  deceptionState.game.phase = 'discussion';
  const deception = parseAiResponse(JSON.stringify({
    publicSpeech: '占い結果として主張します。',
    coOperation: { action: 'declare', roleId: 'seer' },
    abilityClaims: [{
      intent: 'deception',
      roleId: 'seer',
      resultDay: 1,
      target: deceptionTarget.name,
      result: 'wolf',
      selectionBasis: 'no-public-information',
      evidenceRefs: [],
    }],
  }), 'speech');
  const deceptionValidation = validateAiResponse(deceptionState, {
    parsed: deception,
    playerId: wolf.id,
    taskType: 'speech',
  });
  assert.equal(deceptionValidation.ok, true, deceptionValidation.errors.join('\n'));
  assert.equal(deceptionValidation.resolvedAbilityClaims[0].result, 'wolf');
});
