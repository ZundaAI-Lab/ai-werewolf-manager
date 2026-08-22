/**
 * 責務: 副作用の小さい汎用処理と、出力ファイル名部品のOS非依存な正規化を提供する。
 * 変更ルール: ゲーム固有の規則やDOM画面構成を持ち込まない。
 */

export function createId(prefix = 'id') {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

export function deepClone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export function deepMerge(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? deepClone(override) : deepClone(base);
  if (!base || typeof base !== 'object') return override === undefined ? base : override;
  const result = { ...base };
  if (!override || typeof override !== 'object') return result;
  Object.entries(override).forEach(([key, value]) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) return;
    result[key] = Object.hasOwn(base, key) ? deepMerge(base[key], value) : deepClone(value);
  });
  return result;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date);
}

export function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function selected(value, expected) {
  return value === expected ? ' selected' : '';
}

export function checked(value) {
  return value ? ' checked' : '';
}

export function normalizeName(value) {
  return String(value ?? '')
    .trim()
    .replace(/[「」『』【】（）()\s]/g, '')
    .replace(/(さん|くん|君|ちゃん|様|殿)$/u, '');
}

export function sanitizeFilenamePart(value, { fallback = 'file', whitespaceReplacement = ' ', maxLength = 120 } = {}) {
  const invalidCharacters = /[\\/:*?"<>|\u0000-\u001f]/gu;
  const safeWhitespace = String(whitespaceReplacement ?? ' ').replace(invalidCharacters, '_') || ' ';
  const normalize = (input) => String(input ?? '')
    .trim()
    .replace(invalidCharacters, '_')
    .replace(/\s+/gu, safeWhitespace)
    .replace(/[. ]+$/gu, '');
  const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : 120;
  const normalized = normalize(value).slice(0, limit).replace(/[. ]+$/gu, '');
  const normalizedFallback = normalize(fallback).slice(0, limit).replace(/[. ]+$/gu, '');
  return normalized || normalizedFallback || 'file';
}

export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename, value) {
  downloadText(filename, JSON.stringify(value, null, 2), 'application/json;charset=utf-8');
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('ファイルを読み込めませんでした。'));
    reader.readAsText(file, 'utf-8');
  });
}

export async function copyText(text) {
  if (typeof window.__AI_WEREWOLF_CLIPBOARD_WRITE__ === 'function') {
    await window.__AI_WEREWOLF_CLIPBOARD_WRITE__(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.className = 'clipboard-copy-fallback';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export function stableStringify(value) {
  const visit = (item) => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.keys(item)
        .filter((key) => item[key] !== undefined)
        .sort()
        .map((key) => [key, visit(item[key])]),
    );
  };
  return JSON.stringify(visit(value));
}

export function hashText(value) {
  let hash = 2166136261;
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function unique(values) {
  return [...new Set(values)];
}
