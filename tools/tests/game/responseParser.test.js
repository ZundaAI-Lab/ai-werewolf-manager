/**
 * 責務: ゲーム進行に必要なAI応答JSONの必須契約、昼議論の心の声境界、不正JSON拒否、主要な対象・状態境界の検証を確認する。
 * 変更ルール: 過去形式や個別不具合の再現テストを追加せず、全タスク共通の回答検証必須境界、プロンプト掲載される検証任意項目の欠落受理、代表的な構造・異常系だけを検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAiResponse } from '../../../app/renderer/js/prompts/response/responseParser.js';
import { validateAiResponse } from '../../../app/renderer/js/prompts/response/responseValidator.js';
import {
  parseCompleteTopLevelFields,
  parseJsonObjectStrict,
} from '../../../app/renderer/js/prompts/response/repair/jsonObjectRecovery.js';
import {
  buildResponseContractExample,
  getRequiredResponseTopLevelKeys,
} from '../../../app/renderer/js/prompts/response/responseContract.js';
import { renderActiveResponseContract } from '../../../app/renderer/js/prompts/response/activeResponseContract.js';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
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
    if (payload.actionRationale) assert.equal(result.value.actionRationale, payload.actionRationale, mode);
    else assert.equal(result.value.actionRationale, '', mode);
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

test('投票理由はactionRationaleだけを受け付け、判断状態の理由にも同じ値を使用する', () => {
  const state = createInitialState(6);
  const actor = state.players[0];
  const target = state.players[1];
  const actionRationale = `${target.name}は公開発言の矛盾が他候補より大きく、今日の処刑価値が高いと判断したためです。`;
  const payload = {
    actionAnswer: target.name,
    actionRationale,
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
  assert.equal(validation.resolvedDecisionUpdate.decisionReason, actionRationale);
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


