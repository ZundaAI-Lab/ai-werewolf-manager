/**
 * 責務: API詳細ログのpromptHashが正規化済みPrompt Envelope全体を同一基準で識別することを検証する。
 * 変更ルール: Provider応答内容やログ保存先を固定せず、system指示・構造化出力を含むEnvelope識別契約だけを守る。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePromptEnvelope } = require('../../../app/main/llm/promptEnvelopeValidator.js');
const { promptHashForNormalizedEnvelope } = require('../../../app/main/llm/promptHashPolicy.js');

function envelope(overrides = {}) {
  return {
    schemaVersion: 5,
    commonSystemInstruction: 'SYSTEM',
    commonGameContext: 'COMMON',
    taskInvariantContext: 'TASK',
    taskVariableContext: 'VARIABLE',
    stablePlayerContext: 'PLAYER',
    dynamicTaskPrompt: 'DYNAMIC',
    structuredOutput: {
      name: 'response',
      schema: {
        type: 'object',
        properties: { publicSpeech: { type: 'string' } },
        required: ['publicSpeech'],
        additionalProperties: false,
      },
    },
    cacheIdentity: {
      promptSpecVersion: 1,
      promptFamily: 'speech',
      gameId: 'game-a',
      commonGameFingerprint: 'common-a',
    },
    ...overrides,
  };
}

function hash(raw) {
  return promptHashForNormalizedEnvelope(normalizePromptEnvelope(raw));
}

test('promptHashは正規化済みEnvelope全体を識別しsystem指示・Schema・動的タスク差を区別する', () => {
  const original = envelope();
  assert.equal(hash(original), hash(structuredClone(original)));
  assert.notEqual(hash(original), hash(envelope({ commonSystemInstruction: 'SYSTEM-CHANGED' })));
  assert.notEqual(hash(original), hash(envelope({
    structuredOutput: {
      name: 'response',
      schema: {
        type: 'object',
        properties: { publicSpeech: { type: 'string' }, pass: { type: 'boolean' } },
        required: ['publicSpeech'],
        additionalProperties: false,
      },
    },
  })));
  assert.notEqual(hash(original), hash(envelope({ dynamicTaskPrompt: 'DYNAMIC-CHANGED' })));
});
