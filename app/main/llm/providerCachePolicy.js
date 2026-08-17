/**
 * 責務: Provider非依存のEnvelopeから安定したキャッシュ識別子、対応可否、ブレークポイント、TTLを決定する。
 * 変更ルール: RendererへAPI固有項目を要求せず、未知モデルへ明示キャッシュ指定を送らない。キャッシュ対象はcommonGameContext→taskInvariantContext→stablePlayerContextだけとし、役職・局面・出力契約などのtaskVariableContextと最終確認を含むdynamicTaskPromptをキャッシュ都合で前方へ移さない。タスク種別・要求ID・ターン番号をキャッシュキーへ含めない。
 */

'use strict';

const { createHash } = require('node:crypto');
const { estimateTextTokens } = require('./promptBudget.js');
const { normalizeModel } = require('./providerProfilePolicy.js');
const { supportsOpenAiExplicitPromptCache } = require('./modelCacheCapabilityPolicy.js');

function hashText(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function cacheMode(profile) {
  return profile?.promptCacheMode === 'off' ? 'off' : 'auto';
}

function buildPromptCacheKey(profile, envelope) {
  const identity = envelope.cacheIdentity;
  const source = [
    'ai-werewolf',
    identity.promptSpecVersion,
    identity.gameId || 'no-game',
    identity.commonGameFingerprint || 'no-common-game',
    String(profile?.id ?? 'no-profile'),
    normalizeModel(profile),
    identity.promptFamily,
  ].join(':');
  return `aiwm:${hashText(source).slice(0, 48)}`;
}

function selectBreakpointIndexes(blocks, maxBreakpoints = 4) {
  if (!blocks.length || maxBreakpoints <= 0) return [];
  const candidates = [0];
  if (blocks.length > 1) candidates.push(1);
  if (blocks.length > 2) candidates.push(blocks.length - 2);
  candidates.push(blocks.length - 1);
  return [...new Set(candidates)]
    .filter((index) => index >= 0 && index < blocks.length)
    .slice(-maxBreakpoints)
    .sort((left, right) => left - right);
}

function openAiCachePolicy(profile, envelope, blocks) {
  if (cacheMode(profile) === 'off') return { enabled: false, explicit: false, cacheKey: '' };
  const cacheableTokens = estimateTextTokens(blocks.map((block) => block.text).join('\n'));
  if (cacheableTokens < 1024) return { enabled: false, explicit: false, cacheKey: '', cacheableTokens };
  const model = normalizeModel(profile);
  const explicit = supportsOpenAiExplicitPromptCache(model);
  return {
    enabled: true,
    explicit,
    cacheKey: buildPromptCacheKey(profile, envelope),
    cacheableTokens,
    breakpointIndexes: explicit ? selectBreakpointIndexes(blocks, 4) : [],
    ttl: explicit ? '30m' : null,
  };
}

function anthropicCacheTtl(profile) {
  const value = String(profile?.anthropicCacheTtl ?? 'auto');
  if (value === '1h') return '1h';
  return '5m';
}

function anthropicCachePolicy(profile, envelope, blocks) {
  if (cacheMode(profile) === 'off' || !blocks.length) return { enabled: false, cacheKey: '', breakpointIndexes: [] };
  const cacheableTokens = estimateTextTokens(blocks.map((block) => block.text).join('\n'));
  if (cacheableTokens < 1024) return { enabled: false, cacheKey: '', breakpointIndexes: [], cacheableTokens };
  return {
    enabled: true,
    cacheKey: buildPromptCacheKey(profile, envelope),
    cacheableTokens,
    breakpointIndexes: selectBreakpointIndexes(blocks, 4),
    ttl: anthropicCacheTtl(profile),
  };
}

function envelopeDiagnostics(profile, envelope, blocks, dynamicText) {
  return {
    commonGameContextHash: hashText(envelope.commonGameContext),
    taskInvariantContextHash: hashText(envelope.taskInvariantContext),
    stablePlayerContextHash: hashText(envelope.stablePlayerContext),
    taskVariableContextHash: hashText(envelope.taskVariableContext),
    cacheablePrefixHash: hashText(blocks.map((block) => block.text).join('\n\n---\n\n')),
    dynamicPromptHash: hashText(dynamicText),
    cacheKeyHash: hashText(buildPromptCacheKey(profile, envelope)),
  };
}

module.exports = {
  anthropicCachePolicy,
  anthropicCacheTtl,
  buildPromptCacheKey,
  cacheMode,
  envelopeDiagnostics,
  openAiCachePolicy,
  selectBreakpointIndexes,
};
