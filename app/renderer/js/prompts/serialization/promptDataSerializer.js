/**
 * 責務: プロンプトへ挿入するゲーム内データを、命令文と混同されない構造化データ区画へ直列化する。
 * 変更ルール: ゲーム内容を改変・要約せず、可視性判定や指示文生成を行わない。既定はランタイム向け圧縮JSONとし、整形表示は明示指定時だけ許可する。区画名は固定の英小文字識別子だけを許可する。データ値にgame-data開始・終了表記が含まれても実区画として現れないようJSON内ではUnicodeエスケープし、復号時の値は維持する。
 */

const DATA_BLOCK_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;
const DATA_BLOCK_OPEN_PATTERN = /^\[game-data:([a-z][a-z0-9-]*)\]$/gmu;
const DATA_BLOCK_CLOSE_PATTERN = /^\[\/game-data\]$/gmu;
const DATA_BLOCK_CLOSE = '[/game-data]';

function escapeJsonForPrompt(json) {
  return json
    .replace(/\[\/game-data\]/gu, '\\u005b/game-data\\u005d')
    .replace(/\[game-data:/gu, '\\u005bgame-data:')
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

export function stringifyPromptData(value, { pretty = false } = {}) {
  return escapeJsonForPrompt(JSON.stringify(value, null, pretty ? 2 : 0));
}

export function renderPromptDataBlock(name, value, options = {}) {
  if (!DATA_BLOCK_NAME_PATTERN.test(name)) {
    throw new RangeError(`不正なプロンプトデータ区画名です: ${name}`);
  }
  return [
    `[game-data:${name}]`,
    stringifyPromptData(value, options),
    DATA_BLOCK_CLOSE,
  ].join('\n');
}

export function inspectPromptDataBlocks(promptText, allowedNames = null) {
  const text = String(promptText ?? '');
  const errors = [];
  const blocks = [];
  const opens = [...text.matchAll(DATA_BLOCK_OPEN_PATTERN)];
  const closes = [...text.matchAll(DATA_BLOCK_CLOSE_PATTERN)];
  if (opens.length !== closes.length) {
    errors.push('ゲームデータ区画の開始数と終了数が一致しません。');
  }

  let cursor = 0;
  opens.forEach((match) => {
    const name = match[1];
    const start = match.index ?? 0;
    if (start < cursor) return;
    const bodyStart = start + match[0].length;
    const closeMatch = closes.find((candidate) => (candidate.index ?? -1) >= bodyStart);
    if (!closeMatch) return;
    const closeIndex = closeMatch.index ?? -1;
    const json = text.slice(bodyStart, closeIndex).trim();
    if (allowedNames && !allowedNames.has(name)) {
      errors.push(`許可されていないゲームデータ区画です: ${name}`);
    }
    try {
      blocks.push({ name, value: JSON.parse(json), json });
    } catch {
      errors.push(`ゲームデータ区画${name}をJSONとして解析できません。`);
    }
    cursor = closeIndex + DATA_BLOCK_CLOSE.length;
  });

  return { ok: errors.length === 0, errors, blocks };
}
