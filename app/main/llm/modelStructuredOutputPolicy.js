/**
 * 責務: プロファイル設定、要求目的、モデル能力、ローカル接続プリセット、Prompt EnvelopeのSchema有無から実際に送信する構造化出力方式を決定する。
 * 変更ルール: ゲーム固有Schemaを生成・変更せず、HTTP request bodyも生成しない。Analyze/Critiqueは自由記述契約を最優先して必ずprompt-onlyとし、OpenAI・Anthropic・Geminiは確認済みモデルだけSchemaを自動利用する。その他のクラウド接続先を推測で昇格せず、ローカルはjson-object要求時だけ既知のSchema対応プリセットをjson-schemaへ昇格する。
 */

'use strict';

const { isLocalProvider, normalizeJsonRequestMode } = require('./providerProfilePolicy.js');

const JSON_SCHEMA_LOCAL_PRESETS = new Set(['ollama', 'lm-studio', 'llama-cpp']);
const OFFICIAL_JSON_SCHEMA_PROVIDERS = new Set(['openai', 'anthropic', 'gemini']);
const PLAIN_TEXT_REQUEST_PURPOSES = new Set(['generation-analyze', 'generation-critique']);


function supportsOpenAiStructuredOutput(model) {
  const value = String(model ?? '').trim().toLowerCase();
  if (/^gpt-4o(?:-mini)?(?:-|$)/u.test(value)) return true;
  const gpt = value.match(/^gpt-(\d+)(?:\.(\d+))?(?:-|$)/u);
  if (gpt) {
    const major = Number(gpt[1]);
    const minor = Number(gpt[2] ?? 0);
    return major > 4 || (major === 4 && minor >= 1);
  }
  return /^o[1-9](?:-|$)/u.test(value);
}

function anthropicModelVersion(model) {
  const value = String(model ?? '').trim().toLowerCase();
  if (/claude-mythos/u.test(value)) return { major: 5, minor: 0 };
  const match = value.match(/^claude-(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/u)
    ?? value.match(/^claude-(\d+)(?:[-.](\d+))?-(?:opus|sonnet|haiku)/u);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2] ?? 0) };
}

function supportsAnthropicStructuredOutput(model) {
  const version = anthropicModelVersion(model);
  if (!version) return false;
  return version.major > 4 || (version.major === 4 && version.minor >= 5);
}

function supportsGeminiStructuredOutput(model) {
  const match = String(model ?? '').trim().toLowerCase().match(/^gemini-(\d+)(?:\.(\d+))?/u);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 2 || (major === 2 && minor >= 5);
}

function supportsOfficialStructuredOutput(profile) {
  const provider = String(profile?.provider ?? '');
  if (!OFFICIAL_JSON_SCHEMA_PROVIDERS.has(provider)) return false;
  if (provider === 'openai') return supportsOpenAiStructuredOutput(profile?.model);
  if (provider === 'anthropic') return supportsAnthropicStructuredOutput(profile?.model);
  return supportsGeminiStructuredOutput(profile?.model);
}

function hasStructuredOutput(promptEnvelope) {
  return Boolean(promptEnvelope?.structuredOutput?.name && promptEnvelope?.structuredOutput?.schema);
}

function isPlainTextRequestPurpose(requestPurpose) {
  return PLAIN_TEXT_REQUEST_PURPOSES.has(String(requestPurpose ?? ''));
}

function resolveStructuredOutputMode(profile, promptEnvelope, requestPurpose = 'normal') {
  if (isPlainTextRequestPurpose(requestPurpose)) return 'prompt-only';
  const requestedMode = normalizeJsonRequestMode(profile);
  if (!hasStructuredOutput(promptEnvelope)) return requestedMode;
  if (supportsOfficialStructuredOutput(profile)) return 'json-schema';
  if (requestedMode !== 'json-object') return requestedMode;
  if (!isLocalProvider(profile)) return 'json-object';
  return JSON_SCHEMA_LOCAL_PRESETS.has(String(profile?.localServerPreset ?? ''))
    ? 'json-schema'
    : 'json-object';
}

module.exports = {
  JSON_SCHEMA_LOCAL_PRESETS,
  OFFICIAL_JSON_SCHEMA_PROVIDERS,
  PLAIN_TEXT_REQUEST_PURPOSES,
  hasStructuredOutput,
  isPlainTextRequestPurpose,
  resolveStructuredOutputMode,
  supportsAnthropicStructuredOutput,
  supportsGeminiStructuredOutput,
  supportsOfficialStructuredOutput,
  supportsOpenAiStructuredOutput,
};
