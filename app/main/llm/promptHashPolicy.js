/**
 * 責務: 正規化済みPrompt Envelopeの監査ハッシュを決定的に生成する。
 * 変更ルール: Envelopeの意味区画を欠落させず全体を対象とし、成功・失敗ログで同じ正本を使用する。未正規化入力の救済やProvider送信形式への変換は行わない。
 */

'use strict';

const { createHash } = require('node:crypto');

function promptHashForNormalizedEnvelope(promptEnvelope) {
  if (!promptEnvelope || typeof promptEnvelope !== 'object' || Array.isArray(promptEnvelope)) {
    throw new TypeError('正規化済みPrompt Envelopeが必要です。');
  }
  return createHash('sha256').update(JSON.stringify(promptEnvelope)).digest('hex');
}

module.exports = { promptHashForNormalizedEnvelope };
