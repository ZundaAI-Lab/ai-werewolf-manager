/**
 * 責務: Anthropic Messages APIの構造化Envelope要求、短期／長期プロンプトキャッシュ、共通応答変換を実装する。
 * 変更ルール: Anthropic以外の分岐を追加せず、全自動向け既定は5分とする。タスク別契約を含む動的末尾へcache_controlを付けない。
 */

'use strict';

const {
  normalizeEndpoint,
  normalizeMaxOutputTokens,
  normalizeModel,
  systemInstructionForRequest,
} = require('../providerProfilePolicy.js');
const { resolveStructuredOutputMode } = require('../modelStructuredOutputPolicy.js');
const { requestJson } = require('../providerHttpClient.js');
const { outputTextFromAnthropic, usageFromBody } = require('../providerResponseParser.js');
const { cacheableEnvelopeBlocks, dynamicEnvelopeText } = require('../promptEnvelopeValidator.js');
const { anthropicCachePolicy, envelopeDiagnostics } = require('../providerCachePolicy.js');

function anthropicRequestSections(profile, envelope, requestPurpose) {
  const systemInstruction = systemInstructionForRequest(requestPurpose, envelope.commonSystemInstruction);
  const cacheable = cacheableEnvelopeBlocks(envelope);
  const policy = anthropicCachePolicy(profile, envelope, cacheable);
  const breakpointIndexes = new Set(policy.breakpointIndexes ?? []);
  const system = [];
  if (systemInstruction) system.push({ type: 'text', text: systemInstruction });

  const userBlocks = [];
  cacheable.forEach((block, index) => {
    const content = { type: 'text', text: block.text };
    if (policy.enabled && breakpointIndexes.has(index)) {
      content.cache_control = { type: 'ephemeral', ttl: policy.ttl };
    }
    userBlocks.push(content);
  });
  const dynamicText = dynamicEnvelopeText(envelope);
  if (dynamicText) userBlocks.push({ type: 'text', text: dynamicText });
  return { system, userBlocks, cacheable, dynamicText, policy };
}

async function generateAnthropic(profile, promptEnvelope, apiKey, signal, requestPurpose = 'normal') {
  const sections = anthropicRequestSections(profile, promptEnvelope, requestPurpose);
  const structuredOutputMode = resolveStructuredOutputMode(profile, promptEnvelope);
  const requestBody = {
    model: normalizeModel(profile),
    system: sections.system,
    max_tokens: normalizeMaxOutputTokens(profile),
    messages: [{ role: 'user', content: sections.userBlocks }],
  };
  if (structuredOutputMode === 'json-schema') {
    requestBody.output_config = {
      format: {
        type: 'json_schema',
        schema: promptEnvelope.structuredOutput.schema,
      },
    };
  }
  const body = await requestJson({
    provider: 'anthropic',
    url: normalizeEndpoint(profile),
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal,
    body: requestBody,
  });
  return {
    text: outputTextFromAnthropic(body),
    usage: usageFromBody('anthropic', body),
    requestId: body.id ?? null,
    providerDiagnostics: {
      cache: { ...sections.policy, cacheKey: sections.policy.cacheKey ? '[HASHED]' : '' },
      envelope: envelopeDiagnostics(profile, promptEnvelope, sections.cacheable, sections.dynamicText),
      structuredOutputMode,
    },
  };
}

module.exports = { anthropicRequestSections, generateAnthropic };
