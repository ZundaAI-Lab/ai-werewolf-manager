/**
 * 責務: モデルIDから利用可能なプロンプトキャッシュ機能だけを判定する。
 * 変更ルール: API要求本文を生成せず、未確認モデルへ非対応パラメータを送らない。OpenAI明示ブレークポイントはGPT-5.6以降だけを許可する。
 */

'use strict';

function openAiModelVersion(model) {
  const match = String(model ?? '').toLowerCase().match(/^gpt-(\d+)(?:\.(\d+))?/u);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2] ?? 0) };
}

function supportsOpenAiExplicitPromptCache(model) {
  const version = openAiModelVersion(model);
  if (!version) return false;
  return version.major > 5 || (version.major === 5 && version.minor >= 6);
}

module.exports = { openAiModelVersion, supportsOpenAiExplicitPromptCache };
