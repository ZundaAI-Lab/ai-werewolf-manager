/**
 * 責務: 応答項目のキー補正、任意null除去、列挙・配列・参照の正規化に使う共通関数を提供する。
 * 変更ルール: タスク固有の修復判断を持たず、呼び出し元が渡した許可集合だけに従う。
 */

import { normalizeName } from '../../../shared/utils.js';
import {
  isPlainObject,
  operation,
} from './jsonObjectRecovery.js';

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isEmptyValue(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function normalizeIssuePath(path) {
  return String(path ?? '').replace(/^response\./u, '').replace(/^response$/u, '');
}

function parseIssuePathSegments(path) {
  const normalized = normalizeIssuePath(path);
  const segments = [];
  normalized.replace(/([A-Za-z][A-Za-z0-9_]*)|\[(\d+)\]/gu, (_match, key, index) => {
    segments.push(key ?? Number(index));
    return _match;
  });
  return segments;
}

function deletePathValue(root, segments) {
  if (!segments.length) return false;
  let parent = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if ((typeof segment === 'number' && !Array.isArray(parent)) || parent === null || typeof parent !== 'object') return false;
    parent = parent[segment];
  }
  if (parent === null || typeof parent !== 'object') return false;
  const leaf = segments.at(-1);
  if (typeof leaf === 'number') {
    if (!Array.isArray(parent) || leaf < 0 || leaf >= parent.length) return false;
    parent.splice(leaf, 1);
    return true;
  }
  if (!Object.hasOwn(parent, leaf)) return false;
  delete parent[leaf];
  return true;
}

function removeEmptyOptionalAncestors(payload, topLevelKey) {
  const value = payload[topLevelKey];
  if (Array.isArray(value) && value.length === 0) delete payload[topLevelKey];
  else if (isPlainObject(value) && Object.keys(value).length === 0) delete payload[topLevelKey];
  else if (typeof value === 'string' && !value.trim()) delete payload[topLevelKey];
}

function damerauLevenshteinDistance(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
      }
    }
  }
  return matrix[a.length][b.length];
}

function closestKey(rawKey, allowedKeys) {
  const candidates = [...allowedKeys]
    .map((key) => ({ key, distance: damerauLevenshteinDistance(rawKey, key) }))
    .sort((left, right) => left.distance - right.distance || left.key.localeCompare(right.key));
  if (!candidates.length || candidates[0].distance > 2) return null;
  if (candidates[1]?.distance === candidates[0].distance) return null;
  return candidates[0].key;
}

function repairExactKeys(object, path, allowedKeys, operations) {
  if (!isPlainObject(object)) return object;
  const allowed = new Set(allowedKeys);
  Object.keys(object).forEach((key) => {
    if (allowed.has(key)) return;
    const suggestion = closestKey(key, allowed);
    const currentPath = path ? `${path}.${key}` : key;
    if (suggestion && !Object.hasOwn(object, suggestion)) {
      object[suggestion] = object[key];
      delete object[key];
      operation(operations, 'KEY_TYPO_RENAMED', currentPath, `${currentPath}を${path ? `${path}.` : ''}${suggestion}へ修正しました。`);
      return;
    }
    delete object[key];
    operation(operations, 'UNKNOWN_KEY_REMOVED', currentPath, `${currentPath}は未定義のため除外しました。`);
  });
  return object;
}

function removeNullOptionalFields(object, requiredKeys, path, operations) {
  if (!isPlainObject(object)) return;
  const required = new Set(requiredKeys);
  Object.keys(object).forEach((key) => {
    if (object[key] !== null || required.has(key)) return;
    delete object[key];
    operation(operations, 'OPTIONAL_NULL_REMOVED', path ? `${path}.${key}` : key, `${path ? `${path}.` : ''}${key}のnullを省略扱いにしました。`);
  });
}

function normalizeEnumField(object, key, path, operations, aliases = null) {
  if (!Object.hasOwn(object, key) || typeof object[key] !== 'string') return;
  const original = object[key];
  const normalizedText = original.trim().toLowerCase();
  const normalized = aliases?.get(normalizedText) ?? normalizedText;
  if (normalized === original) return;
  object[key] = normalized;
  operation(operations, 'ENUM_NORMALIZED', `${path}.${key}`, `${path}.${key}を${normalized}へ正規化しました。`);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeStringArray(object, key, path, operations) {
  if (!Object.hasOwn(object, key)) return [];
  const original = object[key];
  if (typeof original === 'string') {
    object[key] = [original];
    operation(operations, 'SINGLE_VALUE_WRAPPED', `${path}.${key}`, `${path}.${key}の単一文字列を配列へ変換しました。`);
  }
  if (!Array.isArray(object[key])) return [];
  const normalized = object[key]
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = uniqueBy(normalized, (item) => item);
  if (!deepEqual(unique, object[key])) {
    object[key] = unique;
    operation(operations, 'ARRAY_NORMALIZED', `${path}.${key}`, `${path}.${key}の空値・重複・非文字列を除外しました。`);
  }
  return object[key];
}

function normalizePositiveIntegerRefs(object, key, path, operations) {
  if (!Object.hasOwn(object, key)) return [];
  if (typeof object[key] === 'string' && /^\d+$/u.test(object[key].trim())) {
    object[key] = [Number(object[key])];
    operation(operations, 'SINGLE_REFERENCE_WRAPPED', `${path}.${key}`, `${path}.${key}の単一参照を正整数配列へ変換しました。`);
  } else if (!Array.isArray(object[key])) {
    return [];
  }
  const normalized = object[key]
    .map((item) => (typeof item === 'string' && /^\d+$/u.test(item.trim()) ? Number(item) : item))
    .filter((item) => Number.isInteger(item) && item > 0);
  const unique = uniqueBy(normalized, Number);
  if (!deepEqual(unique, object[key])) {
    object[key] = unique;
    operation(operations, 'REFERENCE_ARRAY_NORMALIZED', `${path}.${key}`, `${path}.${key}の数値文字列変換・不正参照除外・重複削除を行いました。`);
  }
  return object[key];
}

function resolvePlayer(state, input, candidateIds = null) {
  const normalized = normalizeName(input);
  if (!normalized) return null;
  const allowed = (state.players ?? []).filter((player) => !candidateIds || candidateIds.includes(player.id));
  const exact = allowed.find((player) => normalizeName(player.name) === normalized);
  if (exact) return exact;
  const alias = allowed.find((player) => player.aliases?.some((item) => normalizeName(item) === normalized));
  if (alias) return alias;
  const partial = allowed.filter((player) => {
    const name = normalizeName(player.name);
    return name.includes(normalized) || normalized.includes(name);
  });
  return partial.length === 1 ? partial[0] : null;
}

function canonicalizePlayerNames(state, values, candidateIds, path, operations, predicate = null) {
  const resolved = [];
  values.forEach((value) => {
    const player = resolvePlayer(state, value, candidateIds);
    if (!player || (predicate && !predicate(player))) return;
    if (!resolved.some((item) => item.id === player.id)) resolved.push(player);
  });
  const names = resolved.map((player) => player.name);
  if (!deepEqual(names, values)) {
    operation(operations, 'PLAYER_REFERENCES_CANONICALIZED', path, `${path}を有効な正式表示名だけへ正規化しました。`);
  }
  return names;
}


export { canonicalizePlayerNames, deepEqual, deletePathValue, isEmptyValue, normalizeEnumField, normalizeIssuePath, normalizePositiveIntegerRefs, normalizeStringArray, parseIssuePathSegments, removeEmptyOptionalAncestors, removeNullOptionalFields, repairExactKeys, resolvePlayer, uniqueBy };
