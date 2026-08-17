/**
 * 責務: API要求ログへ保存する値から認証情報らしい文字列を除去し、元のログオブジェクトを変更せず安全な複製を返す。
 * 変更ルール: 使用量集計・ログ保存先・通信エラー分類を変更しない。秘密情報の検出規則は過剰な一般文字列削除を避け、認証ヘッダー、APIキー項目、既知のキー接頭辞だけを対象にする。
 */

'use strict';

const SECRET_FIELD_PATTERN = /^(?:authorization|x-api-key|api[-_]?key|access[-_]?token|auth[-_]?token)$/iu;

function redactSecretText(value) {
  return String(value ?? '')
    .replace(/(\bAuthorization\s*:\s*)(?:Bearer\s+)?[^\s,;"']+/giu, '$1[REDACTED]')
    .replace(/(\bx-api-key\s*:\s*)[^\s,;"']+/giu, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, '[REDACTED]');
}

function sanitizeRequestLogEntry(value, key = '') {
  if (SECRET_FIELD_PATTERN.test(String(key))) return '[REDACTED]';
  if (typeof value === 'string') return redactSecretText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeRequestLogEntry(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeRequestLogEntry(entryValue, entryKey)]),
  );
}

module.exports = {
  redactSecretText,
  sanitizeRequestLogEntry,
};
