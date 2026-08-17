/**
 * 責務: Main信頼境界でプロンプトEnvelopeの区画別上限と総量上限が同時に適用されることを検証する。
 * 変更ルール: Provider固有request bodyは扱わず、Envelope正規化の拒否条件だけを固定する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_ENVELOPE_TEXT_LENGTH,
  flattenPromptEnvelope,
  normalizePromptEnvelope,
} = require('../../../app/main/llm/promptEnvelopeValidator.js');

function envelope(overrides = {}) {
  return {
    schemaVersion: 5,
    commonSystemInstruction: 'SYSTEM',
    commonGameContext: 'COMMON',
    taskInvariantContext: 'TASK_INVARIANT',
    stablePlayerContext: 'PLAYER',
    taskVariableContext: 'TASK_VARIABLE',
    dynamicTaskPrompt: 'DYNAMIC_TASK',
    structuredOutput: null,
    cacheIdentity: {
      promptSpecVersion: 1,
      promptFamily: 'game-candidate',
      gameId: 'game-a',
      commonGameFingerprint: 'common-game-a',
    },
    ...overrides,
  };
}

test('区画単体が上限内でもEnvelope総文字数が上限を超えれば拒否する', () => {
  const chunk = 'a'.repeat(1_500_000);
  assert.throws(
    () => normalizePromptEnvelope(envelope({
      commonSystemInstruction: chunk,
      commonGameContext: chunk,
      taskInvariantContext: chunk,
      taskVariableContext: chunk,
      dynamicTaskPrompt: chunk,
    })),
    /総文字数が上限/u,
  );
  assert.equal(MAX_ENVELOPE_TEXT_LENGTH, 4_000_000);
});

test('通常サイズのEnvelopeは正規化する', () => {
  const normalized = normalizePromptEnvelope(envelope());
  assert.equal(normalized.dynamicTaskPrompt, 'DYNAMIC_TASK');
});


test('Envelopeは共通ゲーム、タスク不変、本人固定、タスク可変、現在タスクの順で平坦化する', () => {
  const text = flattenPromptEnvelope(envelope());
  assert.ok(text.indexOf('COMMON') < text.indexOf('TASK_INVARIANT'));
  assert.ok(text.indexOf('TASK_INVARIANT') < text.indexOf('PLAYER'));
  assert.ok(text.indexOf('PLAYER') < text.indexOf('TASK_VARIABLE')
  && text.indexOf('TASK_VARIABLE') < text.indexOf('DYNAMIC_TASK'));
});
