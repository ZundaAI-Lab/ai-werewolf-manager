/**
 * 責務: OpenAI Responses APIの構造化Envelope要求、対応モデルだけの明示キャッシュ、共通応答変換を実装する。
 * 変更ルール: OpenAI以外の分岐を追加せず、GPT-5.6未満へ明示ブレークポイントを送らない。最新タスクは必ずキャッシュ境界後へ置く。
 */

'use strict';

const {
  normalizeEndpoint,
  normalizeMaxOutputTokens,
  normalizeModel,
  systemInstructionForRequest,
} = require('../providerProfilePolicy.js');
const { resolveStructuredOutputMode } = require('../modelStructuredOutputPolicy.js');
const { toOpenAiStrictSchema } = require('../providerStructuredOutputSchema.js');
const { requestJson } = require('../providerHttpClient.js');
const { outputTextFromResponsesApi, usageFromBody } = require('../providerResponseParser.js');
const {
  cacheableEnvelopeBlocks,
  dynamicEnvelopeText,
} = require('../promptEnvelopeValidator.js');
const { envelopeDiagnostics, openAiCachePolicy } = require('../providerCachePolicy.js');

function openAiInputBlocks(envelope, policy) {
  const cacheable = cacheableEnvelopeBlocks(envelope);
  const breakpoints = new Set(policy.breakpointIndexes ?? []);
  const blocks = cacheable.map((block, index) => ({
    type: 'input_text',
    text: block.text,
    ...(policy.explicit && breakpoints.has(index)
      ? { prompt_cache_breakpoint: { mode: 'explicit' } }
      : {}),
  }));
  const dynamicText = dynamicEnvelopeText(envelope);
  if (dynamicText) blocks.push({ type: 'input_text', text: dynamicText });
  return { cacheable, dynamicText, blocks };
}

async function generateOpenAi(profile, promptEnvelope, apiKey, signal, requestPurpose = 'normal') {
  const systemInstruction = systemInstructionForRequest(requestPurpose, promptEnvelope.commonSystemInstruction);
  const cacheable = cacheableEnvelopeBlocks(promptEnvelope);
  const cachePolicy = openAiCachePolicy(profile, promptEnvelope, cacheable);
  const { dynamicText, blocks } = openAiInputBlocks(promptEnvelope, cachePolicy);
  const requestBody = {
    model: normalizeModel(profile),
    instructions: systemInstruction,
    input: [{ type: 'message', role: 'user', content: blocks }],
    store: false,
    max_output_tokens: normalizeMaxOutputTokens(profile),
  };
  const structuredOutputMode = resolveStructuredOutputMode(profile, promptEnvelope, requestPurpose);
  if (structuredOutputMode === 'json-schema') {
    requestBody.text = {
      format: {
        type: 'json_schema',
        name: promptEnvelope.structuredOutput.name,
        strict: true,
        schema: toOpenAiStrictSchema(promptEnvelope.structuredOutput.schema),
      },
    };
  } else if (structuredOutputMode === 'json-object') {
    requestBody.text = { format: { type: 'json_object' } };
  }
  if (cachePolicy.enabled) requestBody.prompt_cache_key = cachePolicy.cacheKey;
  if (cachePolicy.explicit) {
    requestBody.prompt_cache_options = { mode: 'explicit', ttl: cachePolicy.ttl };
  }
  const body = await requestJson({
    provider: 'openai',
    url: normalizeEndpoint(profile),
    headers: { authorization: `Bearer ${apiKey}` },
    signal,
    body: requestBody,
  });
  return {
    text: outputTextFromResponsesApi(body),
    usage: usageFromBody('openai', body),
    requestId: body.id ?? null,
    providerDiagnostics: {
      cache: { ...cachePolicy, cacheKey: cachePolicy.cacheKey ? '[HASHED]' : '' },
      envelope: envelopeDiagnostics(profile, promptEnvelope, cacheable, dynamicText),
      structuredOutputMode,
    },
  };
}

module.exports = { generateOpenAi, openAiInputBlocks };
