/**
 * 責務: Rendererから受け取るプロンプトEnvelopeをMain境界で厳密に正規化し、共通ゲーム・タスク不変・本人固定・タスク可変・動的区画の順序とProvider非依存構造化出力Schemaの安全性を保証する。
 * 変更ルール: ゲーム意味解析やProvider固有のrequest bodyを扱わない。キャッシュ共有順はcommonGameContext→taskInvariantContext→stablePlayerContextで固定し、taskVariableContextとdynamicTaskPromptは非キャッシュ区画としてその後ろに置く。キャッシュ対象かどうかとProviderのsystem/user配置は別責務とし、Envelope区画自体へsystem権限を付与しない。Providerが単一user入力を必要とする場合はflattenPromptEnvelopeで正本順を維持する。可変情報をキャッシュ対象へ昇格させず、廃止済みEnvelope項目へフォールバックしない。未知項目、過大区画、空の動的タスク、不正または過大なJSON Schemaを拒否する。
 */

'use strict';

const MAX_SEGMENT_LENGTH = 2_000_000;
const MAX_ENVELOPE_TEXT_LENGTH = 4_000_000;
const ENVELOPE_KEYS = Object.freeze([
  'schemaVersion', 'commonSystemInstruction', 'commonGameContext',
  'taskInvariantContext', 'stablePlayerContext', 'taskVariableContext', 'dynamicTaskPrompt',
  'structuredOutput', 'cacheIdentity',
]);
const CACHE_IDENTITY_KEYS = Object.freeze([
  'promptSpecVersion', 'promptFamily', 'gameId', 'commonGameFingerprint',
]);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new TypeError(`${label}はオブジェクトで指定してください。`);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new RangeError(`${label}に未知の項目があります: ${unknown.join(', ')}`);
}

function boundedText(value, label, { allowEmpty = true } = {}) {
  const text = String(value ?? '');
  if (!allowEmpty && !text.trim()) throw new RangeError(`${label}が空です。`);
  if (text.length > MAX_SEGMENT_LENGTH) throw new RangeError(`${label}が長すぎます。`);
  return text;
}

function normalizeJsonSchema(schema, label = 'promptEnvelope.structuredOutput.schema', depth = 0) {
  if (depth > 8) throw new RangeError(`${label}のネストが深すぎます。`);
  assertExactKeys(schema, ['type', 'properties', 'required', 'additionalProperties', 'enum', 'items'], label);
  const type = boundedText(schema.type, `${label}.type`, { allowEmpty: false });
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)) {
    throw new RangeError(`${label}.typeが未対応です。`);
  }
  const normalized = { type };
  if (Object.hasOwn(schema, 'enum')) {
    if (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 256) {
      throw new RangeError(`${label}.enumは1～256件の配列で指定してください。`);
    }
    normalized.enum = schema.enum.map((value, index) => {
      if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) {
        throw new TypeError(`${label}.enum[${index}]の型が未対応です。`);
      }
      return typeof value === 'string'
        ? boundedText(value, `${label}.enum[${index}]`, { allowEmpty: false })
        : value;
    });
  }
  if (type === 'object') {
    const properties = schema.properties ?? {};
    if (!plainObject(properties)) throw new TypeError(`${label}.propertiesはオブジェクトで指定してください。`);
    const entries = Object.entries(properties);
    if (entries.length > 64) throw new RangeError(`${label}.propertiesが多すぎます。`);
    normalized.properties = Object.fromEntries(entries.map(([key, child]) => [
      boundedText(key, `${label}.properties key`, { allowEmpty: false }),
      normalizeJsonSchema(child, `${label}.properties.${key}`, depth + 1),
    ]));
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.length > entries.length) throw new RangeError(`${label}.requiredが不正です。`);
    normalized.required = [...new Set(required.map((key, index) => boundedText(key, `${label}.required[${index}]`, { allowEmpty: false })))];
    if (normalized.required.some((key) => !Object.hasOwn(normalized.properties, key))) {
      throw new RangeError(`${label}.requiredにproperties未定義のキーがあります。`);
    }
    normalized.additionalProperties = schema.additionalProperties === true;
  }
  if (type === 'array') normalized.items = normalizeJsonSchema(schema.items, `${label}.items`, depth + 1);
  return normalized;
}

function normalizeStructuredOutput(value) {
  if (value === null || value === undefined) return null;
  assertExactKeys(value, ['name', 'schema'], 'promptEnvelope.structuredOutput');
  return {
    name: boundedText(value.name, 'promptEnvelope.structuredOutput.name', { allowEmpty: false }),
    schema: normalizeJsonSchema(value.schema),
  };
}

function normalizePromptEnvelope(raw) {
  assertExactKeys(raw, ENVELOPE_KEYS, 'promptEnvelope');
  if (Number(raw.schemaVersion) !== 5) throw new RangeError('promptEnvelope.schemaVersionは5で指定してください。');
  assertExactKeys(raw.cacheIdentity, CACHE_IDENTITY_KEYS, 'promptEnvelope.cacheIdentity');
  const normalized = {
    schemaVersion: 5,
    commonSystemInstruction: boundedText(raw.commonSystemInstruction, 'promptEnvelope.commonSystemInstruction'),
    commonGameContext: boundedText(raw.commonGameContext, 'promptEnvelope.commonGameContext'),
    taskInvariantContext: boundedText(raw.taskInvariantContext, 'promptEnvelope.taskInvariantContext'),
    stablePlayerContext: boundedText(raw.stablePlayerContext, 'promptEnvelope.stablePlayerContext'),
    taskVariableContext: boundedText(raw.taskVariableContext, 'promptEnvelope.taskVariableContext'),
    dynamicTaskPrompt: boundedText(raw.dynamicTaskPrompt, 'promptEnvelope.dynamicTaskPrompt', { allowEmpty: false }),
    structuredOutput: normalizeStructuredOutput(raw.structuredOutput),
    cacheIdentity: {
      promptSpecVersion: Number(raw.cacheIdentity.promptSpecVersion ?? 0),
      promptFamily: boundedText(raw.cacheIdentity.promptFamily, 'promptEnvelope.cacheIdentity.promptFamily', { allowEmpty: false }),
      gameId: boundedText(raw.cacheIdentity.gameId, 'promptEnvelope.cacheIdentity.gameId'),
      commonGameFingerprint: boundedText(raw.cacheIdentity.commonGameFingerprint, 'promptEnvelope.cacheIdentity.commonGameFingerprint', { allowEmpty: false }),
    },
  };
  const totalTextLength = normalized.commonSystemInstruction.length
    + normalized.commonGameContext.length
    + normalized.taskInvariantContext.length
    + normalized.stablePlayerContext.length
    + normalized.taskVariableContext.length
    + normalized.dynamicTaskPrompt.length
    + JSON.stringify(normalized.structuredOutput ?? '').length;
  if (totalTextLength > MAX_ENVELOPE_TEXT_LENGTH) {
    throw new RangeError('promptEnvelopeの総文字数が上限を超えています。');
  }
  return normalized;
}

function flattenPromptEnvelope(envelope) {
  return [
    envelope.commonGameContext,
    envelope.taskInvariantContext,
    envelope.stablePlayerContext,
    envelope.taskVariableContext,
    envelope.dynamicTaskPrompt,
  ].map((text) => String(text ?? '').trim())
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function cacheableEnvelopeBlocks(envelope) {
  return [
    { id: 'common-game', text: envelope.commonGameContext },
    { id: 'task-invariant', text: envelope.taskInvariantContext },
    { id: 'stable-player', text: envelope.stablePlayerContext },
  ].filter((block) => String(block.text ?? '').trim());
}

function cacheableEnvelopeText(envelope) {
  return cacheableEnvelopeBlocks(envelope)
    .map((block) => block.text)
    .join('\n\n---\n\n');
}

function taskVariableEnvelopeText(envelope) {
  return String(envelope.taskVariableContext ?? '').trim();
}

function dynamicTaskEnvelopeText(envelope) {
  return String(envelope.dynamicTaskPrompt ?? '').trim();
}

function dynamicEnvelopeText(envelope) {
  return [taskVariableEnvelopeText(envelope), dynamicTaskEnvelopeText(envelope)]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

module.exports = {
  MAX_ENVELOPE_TEXT_LENGTH,
  MAX_SEGMENT_LENGTH,
  cacheableEnvelopeBlocks,
  cacheableEnvelopeText,
  dynamicEnvelopeText,
  dynamicTaskEnvelopeText,
  flattenPromptEnvelope,
  normalizePromptEnvelope,
  taskVariableEnvelopeText,
};
