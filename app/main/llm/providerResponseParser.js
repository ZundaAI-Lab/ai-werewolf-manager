/**
 * 責務: 各プロバイダーの本文・使用量を共通形式へ変換し、必要時だけJSONオブジェクトを決定的に抽出する。
 * 変更ルール: HTTP送信やゲーム意味解析を行わず、応答構造の差異だけを吸収する。JSON候補が複数ある場合はMainで意味判定せず抽出を諦め、Renderer側の契約検証へ委ねる。
 */

'use strict';

const { normalizeJsonResponseMode } = require('./providerProfilePolicy.js');

function stripCodeFence(value) {
  const text = String(value ?? '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return (fenced ? fenced[1] : text).trim();
}

const MAX_JSON_EXTRACTION_DEPTH = 128;
const THINK_OPEN_PREFIX = '<think';
const THINK_CLOSE_PREFIX = '</think';

function isHtmlTagBoundary(character) {
  return character === '>' || /\s/u.test(character ?? '');
}

function findThinkTag(lowerText, prefix, fromIndex) {
  let cursor = Math.max(0, Number(fromIndex) || 0);
  for (;;) {
    const start = lowerText.indexOf(prefix, cursor);
    if (start < 0) return null;
    const boundary = lowerText[start + prefix.length];
    if (isHtmlTagBoundary(boundary)) {
      const end = lowerText.indexOf('>', start + prefix.length);
      return { start, end };
    }
    cursor = start + prefix.length;
  }
}

function stripCompletedThinkBlocks(value) {
  const text = String(value ?? '');
  const lowerText = text.toLowerCase();
  const parts = [];
  let cursor = 0;
  for (;;) {
    const open = findThinkTag(lowerText, THINK_OPEN_PREFIX, cursor);
    if (!open || open.end < 0) break;
    const close = findThinkTag(lowerText, THINK_CLOSE_PREFIX, open.end + 1);
    if (!close || close.end < 0) break;
    parts.push(text.slice(cursor, open.start));
    cursor = close.end + 1;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

function containsThinkTag(value) {
  const lowerText = String(value ?? '').toLowerCase();
  return Boolean(
    findThinkTag(lowerText, THINK_OPEN_PREFIX, 0)
    || findThinkTag(lowerText, THINK_CLOSE_PREFIX, 0)
  );
}

function isJsonObjectText(value) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function extractionTextWithoutThinking(value) {
  const text = String(value ?? '');
  if (isJsonObjectText(text)) return text;
  const withoutCompleteBlocks = stripCompletedThinkBlocks(text).trim();
  // 未閉鎖thinkingは、その内部断片を最終回答として誤採用しない。
  return containsThinkTag(withoutCompleteBlocks) ? '' : withoutCompleteBlocks;
}

function extractFirstJsonObject(value) {
  const text = String(value ?? '');
  let start = -1;
  let stack = [];
  let inString = false;
  let escaping = false;
  let singleCandidate = '';
  let candidateCount = 0;

  const resetCandidate = () => {
    start = -1;
    stack = [];
    inString = false;
    escaping = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start < 0) {
      if (character === '{') {
        start = index;
        stack = ['{'];
      }
      continue;
    }

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
    if (character === '{' || character === '[') {
      stack.push(character);
      if (stack.length > MAX_JSON_EXTRACTION_DEPTH) return '';
      continue;
    }
    if (character !== '}' && character !== ']') continue;

    const expected = character === '}' ? '{' : '[';
    if (stack.pop() !== expected) {
      resetCandidate();
      continue;
    }
    if (stack.length !== 0) continue;

    const candidate = text.slice(start, index + 1);
    if (isJsonObjectText(candidate)) {
      candidateCount += 1;
      // 複数候補の意味選択はゲーム契約を知らないMainでは行わず、Renderer側の検証・回復へ委ねる。
      if (candidateCount > 1) return '';
      singleCandidate = candidate;
    }
    resetCandidate();
  }
  return candidateCount === 1 ? singleCandidate : '';
}

function normalizeProviderText(profile, value) {
  const stripped = stripCodeFence(value);
  if (normalizeJsonResponseMode(profile) !== 'extract-object') {
    return { text: stripped, jsonObjectExtracted: false };
  }
  const extractionText = extractionTextWithoutThinking(stripped);
  const extracted = extractionText ? extractFirstJsonObject(extractionText) : '';
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
