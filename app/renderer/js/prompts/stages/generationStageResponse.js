/**
 * 責務: キャラクター発言化工程のtextPatch JSONを解析し、対象キー完全一致と元文章からの機械的な乖離上限を検証して、今回指定された文章フィールドだけを検証済み候補へ決定的にマージする。
 * 変更ルール: ゲーム上の意味、人物、役職、CO、能力結果を解釈せず、文字列類似度とJSON形状だけを扱う。非文章フィールドと今回対象外フィールドを変更しない。元文章が連続性検査対象の長さに達した場合は、置換後だけを短文化して検査を回避することを許可しない。構造不正または過大乖離時は呼び出し元へ失敗を返し、AI再生成を要求しない。
 */

function issue(code, message) {
  return { code, message };
}

function normalizeContinuityText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[「」『』【】（）()［\][\]{}〈〉《》<>＜＞“”‘’"'`´。、，,.!?！？:：;；・…―—ー~〜]/gu, '');
}

function bigramCounts(value) {
  const chars = Array.from(value);
  const counts = new Map();
  if (chars.length < 2) {
    if (chars.length === 1) counts.set(chars[0], 1);
    return counts;
  }
  for (let index = 0; index < chars.length - 1; index += 1) {
    const gram = `${chars[index]}${chars[index + 1]}`;
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

export function characterBigramDice(leftValue, rightValue) {
  const left = normalizeContinuityText(leftValue);
  const right = normalizeContinuityText(rightValue);
  if (left === right) return 1;
  if (!left || !right) return 0;
  const leftCounts = bigramCounts(left);
  const rightCounts = bigramCounts(right);
  const leftTotal = [...leftCounts.values()].reduce((sum, count) => sum + count, 0);
  const rightTotal = [...rightCounts.values()].reduce((sum, count) => sum + count, 0);
  if (!leftTotal || !rightTotal) return 0;
  let overlap = 0;
  for (const [gram, count] of leftCounts.entries()) {
    overlap += Math.min(count, rightCounts.get(gram) ?? 0);
  }
  return (2 * overlap) / (leftTotal + rightTotal);
}

export function parseTextPatchResponse(rawResponse) {
  const raw = String(rawResponse ?? '').trim();
  if (!raw) return { ok: false, textPatch: null, issues: [issue('EMPTY_TEXT_PATCH_RESPONSE', 'textPatch応答が空です。')] };
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return { ok: false, textPatch: null, issues: [issue('INVALID_TEXT_PATCH_JSON', `textPatch応答をJSONとして解析できません。${error.message}`)] };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, textPatch: null, issues: [issue('INVALID_TEXT_PATCH', 'textPatch応答のトップレベルがオブジェクトではありません。')] };
  }
  const topKeys = Object.keys(payload);
  if (topKeys.length !== 1 || topKeys[0] !== 'textPatch') {
    return { ok: false, textPatch: null, issues: [issue('INVALID_TEXT_PATCH', 'トップレベルキーはtextPatchだけにしてください。')] };
  }
  const textPatch = payload.textPatch;
  if (!textPatch || typeof textPatch !== 'object' || Array.isArray(textPatch)) {
    return { ok: false, textPatch: null, issues: [issue('INVALID_TEXT_PATCH', 'textPatchがオブジェクトではありません。')] };
  }
  const keys = Object.keys(textPatch);
  if (!keys.length) return { ok: false, textPatch: null, issues: [issue('EMPTY_TEXT_PATCH', '空のtextPatchは使用できません。')] };
  const nonStrings = keys.filter((key) => typeof textPatch[key] !== 'string');
  if (nonStrings.length) {
    return { ok: false, textPatch: null, issues: [issue('INVALID_TEXT_PATCH_VALUE', `textPatch.${nonStrings.join(', textPatch.')}は文字列で指定してください。`)] };
  }
  return { ok: true, textPatch: { ...textPatch }, issues: [] };
}

export function validateTextPatchForStage({ stageId, targetTextFields, textPatch }) {
  const expected = [...new Set(targetTextFields ?? [])].sort();
  const actual = Object.keys(textPatch ?? {}).sort();
  if (!expected.length) return { ok: false, issues: [issue('EMPTY_TARGET_TEXT_FIELDS', `${stageId}工程の対象文章フィールドがありません。`)] };
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    return {
      ok: false,
      issues: [issue('INVALID_TEXT_PATCH_KEYS', `textPatchのキーが今回の対象キー（${expected.join(', ')}）と一致しません。`)],
    };
  }
  return { ok: true, issues: [] };
}

export function validateTextPatchContinuity({ stageId, candidateObject, targetTextFields, textPatch }) {
  const issues = [];
  const minimumSimilarity = 0.18;
  for (const fieldName of targetTextFields ?? []) {
    const before = normalizeContinuityText(candidateObject?.[fieldName]);
    const after = normalizeContinuityText(textPatch?.[fieldName]);
    if (!before || before.length < 20) continue;
    if (!after || after.length < 20) {
      issues.push(issue(
        'TEXT_PATCH_SOURCE_DIVERGED',
        `${stageId}工程で${fieldName}が元文章から極端に短い内容へ置換されました。`,
      ));
      continue;
    }
    const similarity = characterBigramDice(before, after);
    if (similarity < minimumSimilarity) {
      issues.push(issue(
        'TEXT_PATCH_SOURCE_DIVERGED',
        `${stageId}工程で${fieldName}が元文章と無関係な内容へ置換されました。`,
      ));
    }
  }
  return { ok: issues.length === 0, issues };
}

export function mergeTextPatch(candidateObject, textPatch, targetTextFields) {
  const merged = structuredClone(candidateObject);
  for (const fieldName of targetTextFields) merged[fieldName] = textPatch[fieldName];
  return merged;
}
