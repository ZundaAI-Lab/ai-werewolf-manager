/**
 * 責務: 各プロバイダーの本文・使用量を共通形式へ変換し、必要時だけJSONオブジェクトを決定的に抽出する。
 * 変更ルール: HTTP送信やゲーム意味解析を行わず、応答構造の差異だけを吸収する。
 */

'use strict';

const { normalizeJsonResponseMode } = require('./providerProfilePolicy.js');

function stripCodeFence(value) {
  const text = String(value ?? '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return (fenced ? fenced[1] : text).trim();
}

function extractFirstJsonObject(value) {
  const text = String(value ?? '');
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const stack = [];
    let inString = false;
    let escaping = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaping) escaping = false;
        else if (character === '\\') escaping = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === '{' || character === '[') stack.push(character);
      else if (character === '}' || character === ']') {
        const expected = character === '}' ? '{' : '[';
        if (stack.pop() !== expected) break;
        if (stack.length === 0) {
          const candidate = text.slice(start, index + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return candidate;
          } catch {
            // 次の開始波括弧を試す。
          }
          break;
        }
      }
    }
  }
  return '';
}

function normalizeProviderText(profile, value) {
  const stripped = stripCodeFence(value);
  if (normalizeJsonResponseMode(profile) !== 'extract-object') {
    return { text: stripped, jsonObjectExtracted: false };
  }
  const extracted = extractFirstJsonObject(stripped);
  return {
    text: extracted || stripped,
    jsonObjectExtracted: Boolean(extracted && extracted !== stripped),
  };
}

function outputTextFromResponsesApi(body) {
  if (typeof body?.output_text === 'string') return body.output_text;
  const texts = [];
  for (const item of body?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === 'string') texts.push(content.text);
      else if (typeof content?.output_text === 'string') texts.push(content.output_text);
    }
  }
  return texts.join('\n');
}

function outputTextFromChatCompletions(body) {
  const choice = body?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? part?.content ?? '').join('');
  return '';
}

function outputTextFromAnthropic(body) {
  return (body?.content ?? []).map((part) => part?.type === 'text' ? part.text : '').join('');
}

function outputTextFromGemini(body) {
  return (body?.candidates?.[0]?.content?.parts ?? []).map((part) => part?.text ?? '').join('');
}

function finiteTokenCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function usageFromBody(provider, body) {
  if (provider === 'anthropic') {
    const inputTokens = finiteTokenCount(body?.usage?.input_tokens);
    const outputTokens = finiteTokenCount(body?.usage?.output_tokens);
    const cachedInputTokens = finiteTokenCount(body?.usage?.cache_read_input_tokens);
    const cacheWriteTokens = finiteTokenCount(body?.usage?.cache_creation_input_tokens);
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      reasoningTokens: 0,
      totalTokens: inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens,
    };
  }
  if (provider === 'gemini') {
    return {
      inputTokens: finiteTokenCount(body?.usageMetadata?.promptTokenCount),
      outputTokens: finiteTokenCount(body?.usageMetadata?.candidatesTokenCount),
      cachedInputTokens: finiteTokenCount(body?.usageMetadata?.cachedContentTokenCount),
      cacheWriteTokens: 0,
      reasoningTokens: finiteTokenCount(body?.usageMetadata?.thoughtsTokenCount),
      totalTokens: finiteTokenCount(body?.usageMetadata?.totalTokenCount),
    };
  }
  const inputTokens = finiteTokenCount(body?.usage?.input_tokens ?? body?.usage?.prompt_tokens);
  const outputTokens = finiteTokenCount(body?.usage?.output_tokens ?? body?.usage?.completion_tokens);
  const explicitTotalTokens = body?.usage?.total_tokens;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: finiteTokenCount(body?.usage?.input_tokens_details?.cached_tokens ?? body?.usage?.prompt_tokens_details?.cached_tokens),
    cacheWriteTokens: finiteTokenCount(body?.usage?.input_tokens_details?.cache_write_tokens),
    reasoningTokens: finiteTokenCount(body?.usage?.output_tokens_details?.reasoning_tokens ?? body?.usage?.completion_tokens_details?.reasoning_tokens),
    totalTokens: explicitTotalTokens === undefined || explicitTotalTokens === null
      ? inputTokens + outputTokens
      : finiteTokenCount(explicitTotalTokens),
  };
}


module.exports = {
  extractFirstJsonObject, finiteTokenCount, normalizeProviderText, outputTextFromAnthropic,
  outputTextFromChatCompletions, outputTextFromGemini, outputTextFromResponsesApi, stripCodeFence, usageFromBody,
};
