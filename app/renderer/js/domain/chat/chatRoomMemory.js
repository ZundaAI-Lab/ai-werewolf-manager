/**
 * 責務: チャットルームのキャラクター個別内部メモを、Prompt・保存状態の双方で共通利用できる安全な短文配列へ正規化する。
 * 変更ルール: 共有記憶や会話履歴の要約を生成しない。メモはキャラクター本人だけへ再投入する前提とし、件数・1項目長・総文字数の上限だけを決定的に適用する。
 */

export const CHAT_MEMORY_MAX_ENTRIES = 24;
export const CHAT_MEMORY_MAX_ENTRY_CHARS = 200;
export const CHAT_MEMORY_MAX_TOTAL_CHARS = 3200;

function cleanEntry(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, CHAT_MEMORY_MAX_ENTRY_CHARS);
}

export function normalizeChatCharacterMemory(values) {
  const result = [];
  const seen = new Set();
  let totalChars = 0;
  for (const value of Array.isArray(values) ? values : []) {
    const entry = cleanEntry(value);
    if (!entry || seen.has(entry)) continue;
    if (result.length >= CHAT_MEMORY_MAX_ENTRIES) break;
    if (totalChars + entry.length > CHAT_MEMORY_MAX_TOTAL_CHARS) break;
    seen.add(entry);
    result.push(entry);
    totalChars += entry.length;
  }
  return result;
}
