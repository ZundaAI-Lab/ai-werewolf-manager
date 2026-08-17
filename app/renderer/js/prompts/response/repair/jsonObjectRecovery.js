/**
 * 責務: AI応答から厳密なJSONオブジェクトまたは完結済みトップレベル項目を決定的に回収する。
 * 変更ルール: ゲーム意味や項目妥当性を判断せず、構文回復と監査操作記録だけを担当する。生成オブジェクトはnull prototype辞書とし、特殊キーによるプロトタイプ変更を許可しない。
 */


const JSON_NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isEmptyValue(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function operation(operations, code, path, message) {
  operations.push({ code, path, message });
}

function parseJsonObjectStrict(text, operations) {
  let index = 0;

  function fail(message) {
    const error = new SyntaxError(`${message}（位置${index + 1}）`);
    error.code = 'INVALID_JSON';
    throw error;
  }

  function skipWhitespace() {
    while (/\s/u.test(text[index] ?? '')) index += 1;
  }

  function parseString() {
    if (text[index] !== '"') fail('文字列の開始記号がありません');
    const start = index;
    index += 1;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          fail('文字列を解析できません');
        }
      }
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char < ' ') fail('文字列内に制御文字があります');
      index += 1;
    }
    fail('文字列が閉じられていません');
  }

  function parseNumber() {
    JSON_NUMBER_PATTERN.lastIndex = index;
    const match = JSON_NUMBER_PATTERN.exec(text);
    if (!match) fail('数値を解析できません');
    index = JSON_NUMBER_PATTERN.lastIndex;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail('有限でない数値は使用できません');
    return value;
  }

  function parseLiteral(literal, value) {
    if (!text.startsWith(literal, index)) fail(`${literal}を解析できません`);
    index += literal.length;
    return value;
  }

  function parseArray(path) {
    index += 1;
    const result = [];
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return result;
    }
    let itemIndex = 0;
    while (index < text.length) {
      result.push(parseValue(`${path}[${itemIndex}]`));
      itemIndex += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return result;
      }
      if (text[index] !== ',') fail('配列要素の区切りがありません');
      index += 1;
      skipWhitespace();
    }
    fail('配列が閉じられていません');
  }

  function parseObject(path) {
    index += 1;
    const result = Object.create(null);
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return result;
    }
    while (index < text.length) {
      skipWhitespace();
      const key = parseString();
      const keyPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_OBJECT_KEYS.has(key)) fail(`${keyPath}はオブジェクトキーに使用できません`);
      skipWhitespace();
      if (text[index] !== ':') fail('オブジェクトのキーと値の区切りがありません');
      index += 1;
      const nextValue = parseValue(keyPath);
      if (Object.hasOwn(result, key)) {
        const previousValue = result[key];
        if (deepEqual(previousValue, nextValue)) {
          operation(operations, 'DUPLICATE_KEY_REMOVED', keyPath, `${keyPath}の同一値重複を1件へ統合しました。`);
        } else if (isEmptyValue(previousValue) !== isEmptyValue(nextValue)) {
          result[key] = isEmptyValue(previousValue) ? nextValue : previousValue;
          operation(operations, 'EMPTY_DUPLICATE_KEY_REMOVED', keyPath, `${keyPath}の空値側の重複を除外しました。`);
        } else {
          const error = new SyntaxError(`${keyPath}に異なる有効値が重複しています。`);
          error.code = 'AMBIGUOUS_DUPLICATE_KEY';
          throw error;
        }
      } else {
        result[key] = nextValue;
      }
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return result;
      }
      if (text[index] !== ',') fail('オブジェクト項目の区切りがありません');
      index += 1;
    }
    fail('オブジェクトが閉じられていません');
  }

  function parseValue(path) {
    skipWhitespace();
    const char = text[index];
    if (char === '{') return parseObject(path);
    if (char === '[') return parseArray(path);
    if (char === '"') return parseString();
    if (char === '-' || /\d/u.test(char ?? '')) return parseNumber();
    if (char === 't') return parseLiteral('true', true);
    if (char === 'f') return parseLiteral('false', false);
    if (char === 'n') return parseLiteral('null', null);
    fail('JSON値を解析できません');
  }

  skipWhitespace();
  const value = parseValue('');
  skipWhitespace();
  if (index !== text.length) fail('JSONオブジェクトの後ろに不要な文章があります');
  if (!isPlainObject(value)) {
    const error = new TypeError('AI応答がJSONオブジェクトではありません。');
    error.code = 'INVALID_JSON_OBJECT';
    throw error;
  }
  return value;
}


function parseJsonObjectWithEnvelopeRecovery(raw) {
  const source = String(raw ?? '').trim();
  if (!source) return null;
  const unfenced = source.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function extractJsonObjectText(raw, operations) {
  let text = String(raw ?? '').trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fence) {
    text = fence[1].trim();
    operation(operations, 'CODE_FENCE_REMOVED', '', 'JSON全体を囲むコードフェンスを除去しました。');
  }
  try {
    parseJsonObjectStrict(text, []);
    return text;
  } catch (error) {
    if (error?.code === 'AMBIGUOUS_DUPLICATE_KEY') return text;
  }

  const candidates = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = start; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, cursor + 1);
        try {
          parseJsonObjectStrict(candidate, []);
          candidates.push(candidate);
        } catch {
          // 有効な単一JSON候補だけを収集する。
        }
        start = cursor;
        break;
      }
      if (depth < 0) break;
    }
  }
  if (candidates.length !== 1) return text;
  operation(operations, 'SURROUNDING_TEXT_REMOVED', '', '単一JSONオブジェクト前後の説明文を除去しました。');
  return candidates[0];
}


function parseCompleteTopLevelFields(raw, allowedKeys, operations) {
  let text = String(raw ?? '').trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*)$/iu);
  if (fence) text = fence[1].replace(/\s*```\s*$/u, '').trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  const allowed = new Set(allowedKeys);
  const payload = Object.create(null);
  let index = start + 1;
  let recoveredAny = false;

  const skipWhitespaceAndCommas = () => {
    while (index < text.length && /[\s,]/u.test(text[index])) index += 1;
  };
  const readStringToken = () => {
    if (text[index] !== '"') return null;
    const tokenStart = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const char = text[index];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(tokenStart, index));
        } catch {
          return null;
        }
      }
      index += 1;
    }
    return null;
  };
  const readValueText = () => {
    const valueStart = index;
    let objectDepth = 0;
    let arrayDepth = 0;
    let inString = false;
    let escaped = false;
    while (index < text.length) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        index += 1;
        continue;
      }
      if (char === '"') {
        inString = true;
        index += 1;
        continue;
      }
      if (char === '{') objectDepth += 1;
      else if (char === '[') arrayDepth += 1;
      else if (char === '}') {
        if (objectDepth === 0 && arrayDepth === 0) break;
        objectDepth -= 1;
      } else if (char === ']') {
        if (arrayDepth === 0) return null;
        arrayDepth -= 1;
      } else if (char === ',' && objectDepth === 0 && arrayDepth === 0) {
        break;
      }
      index += 1;
    }
    if (inString || objectDepth !== 0 || arrayDepth !== 0) return null;
    const valueText = text.slice(valueStart, index).trim();
    if (!valueText) return null;
    try {
      return { value: JSON.parse(valueText), valueText };
    } catch {
      return null;
    }
  };

  while (index < text.length) {
    skipWhitespaceAndCommas();
    if (text[index] === '}') break;
    const key = readStringToken();
    if (key === null) break;
    if (FORBIDDEN_OBJECT_KEYS.has(key)) return null;
    while (index < text.length && /\s/u.test(text[index])) index += 1;
    if (text[index] !== ':') break;
    index += 1;
    while (index < text.length && /\s/u.test(text[index])) index += 1;
    const parsedValue = readValueText();
    if (!parsedValue) break;
    if (allowed.has(key)) {
      if (Object.hasOwn(payload, key) && !deepEqual(payload[key], parsedValue.value)) return null;
      payload[key] = parsedValue.value;
      recoveredAny = true;
    }
    if (text[index] === ',') index += 1;
    else if (text[index] === '}') break;
  }
  if (!recoveredAny) return null;
  operation(operations, 'PARTIAL_JSON_FIELDS_RECOVERED', '', '途中終了したJSONから完結済みのトップレベル項目を回収しました。');
  return payload;
}


export { extractJsonObjectText, isPlainObject, operation, parseCompleteTopLevelFields, parseJsonObjectStrict, parseJsonObjectWithEnvelopeRecovery };
