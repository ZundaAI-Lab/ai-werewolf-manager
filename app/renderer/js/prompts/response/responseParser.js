/**
 * 責務: AI応答の単一JSONオブジェクトを、公開発言・CO操作・能力結果主張・判断差分・判断根拠参照・陣営戦略差分・秘密会話・襲撃判断・雪女の推定候補・夜行動理由・心の声・内部メモへ厳密に構文分解する。
 * 変更ルール: 公開発言の自然文からCOや判断状態を推測しない。応答キーと判断参照キーはresponseContract.js、assessmentLevelの列挙値はdecisionState.jsを正本とし、判断変更原因を生成せず、ゲーム状態との整合性判定や状態更新を行わない。ゲーム進行に不要な理由・比較・戦略・内面・監査項目は未入力・空値・子キー欠落を省略扱いとし、実値が出力されたキーだけを厳密に構文検証する。任意項目の欠落診断を追加しない。診断は表示用errorsと再試行判断用issuesへ同時に集約し、未知キーは自動補正しない。外部AI応答のJSONネストは固定上限で拒否し、未知キーの補正候補探索も許容距離から外れる長さ差を事前除外してRenderer占有を許可しない。外部応答キーはresponseContract.jsを正本とし、外部キーから内部保存表現への変換は本モジュールで明示する。推理モード固有のdecisionPatch項目は解析済みターン内の思考整理情報として受理し、永続判断状態へ保存するかどうかはresponseValidator.js側の状態責務へ委譲する。
 */

import { DECISION_ASSESSMENT_LEVELS } from '../../domain/game/decisionState.js';
import { getDecisionChangeKeys, getDecisionPatchKeys, getRequiredResponseTopLevelKeys, getResponseTopLevelKeys } from './responseContract.js';

const ABILITY_SELECTION_BASES = new Set(['no-public-information', 'public-evidence', 'rule-forced']);
const ASSESSMENT_LEVELS = new Set(DECISION_ASSESSMENT_LEVELS);
const CO_ACTIONS = new Set(['declare', 'change', 'withdraw']);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_JSON_NESTING_DEPTH = 64;
const MAX_KEY_SUGGESTION_DISTANCE = 2;
const FACTION_STRATEGY_KEYS = new Set([
  'publicWorld', 'dayWinPath', 'partnerDisposition', 'collapsePlan', 'linkageRisk',
  'fallbackRoute', 'pressureGoal', 'failureRisk', 'nextDayPlan',
]);

const TURN_LOCAL_DECISION_TEXT_KEYS = Object.freeze([
  'unresolvedPoint', 'responseImpact',
  'changePoint', 'changeTrigger', 'changeNaturalness',
  'conflictPoint', 'compatibleExplanation',
  'commitmentAlignment', 'reversalExplanation',
  'interactionAsymmetry', 'consensusIndependence', 'counterHypothesis',
  'comparisonAxis', 'candidateDifference',
]);

const TURN_LOCAL_DECISION_LIST_KEYS = Object.freeze([
  'supportingSignals', 'counterSignals', 'remainingHypotheses',
]);

function parseStrictJson(text) {
  let index = 0;
  let depth = 0;
  const duplicateErrors = [];

  function fail(message) {
    throw new SyntaxError(`${message}（位置${index + 1}）`);
  }

  function enterNesting() {
    depth += 1;
    if (depth <= MAX_JSON_NESTING_DEPTH) return;
    depth -= 1;
    const error = new RangeError(`JSONのネストが上限（${MAX_JSON_NESTING_DEPTH}段）を超えています。`);
    error.code = 'JSON_TOO_DEEP';
    throw error;
  }

  function leaveNesting() {
    depth -= 1;
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
    const rest = text.slice(index);
    const match = rest.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) fail('数値を解析できません');
    index += match[0].length;
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
    enterNesting();
    try {
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
    } finally {
      leaveNesting();
    }
  }

  function parseObject(path) {
    enterNesting();
    try {
      index += 1;
      const result = {};
      const seen = new Set();
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
        if (seen.has(key)) duplicateErrors.push(`${keyPath}が重複しています。`);
        seen.add(key);
        skipWhitespace();
        if (text[index] !== ':') fail('オブジェクトのキーと値の区切りがありません');
        index += 1;
        result[key] = parseValue(keyPath);
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return result;
        }
        if (text[index] !== ',') fail('オブジェクト項目の区切りがありません');
        index += 1;
      }
      fail('オブジェクトが閉じられていません');
    } finally {
      leaveNesting();
    }
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
  return { value, duplicateErrors };
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
  const submitted = String(rawKey ?? '');
  const candidates = [...allowedKeys]
    // 距離上限を超える長さ差は補正候補になり得ないため、外部入力で距離行列を作る前に除外する。
    .filter((key) => Math.abs(key.length - submitted.length) <= MAX_KEY_SUGGESTION_DISTANCE)
    .map((key) => ({ key, distance: damerauLevenshteinDistance(submitted, key) }))
    .sort((left, right) => left.distance - right.distance || left.key.localeCompare(right.key));
  if (!candidates.length || candidates[0].distance > MAX_KEY_SUGGESTION_DISTANCE) return null;
  if (candidates[1]?.distance === candidates[0].distance) return null;
  return candidates[0].key;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label, errors) {
  if (isPlainObject(value)) return value;
  errors.push(`${label}はJSONオブジェクトで指定してください。`);
  return null;
}

function validateExactKeys(value, label, allowedKeys, requiredKeys, errors) {
  const object = requireObject(value, label, errors);
  if (!object) return null;
  const allowed = new Set(allowedKeys);
  Object.keys(object).forEach((key) => {
    if (allowed.has(key)) return;
    const suggestion = closestKey(key, allowed);
    errors.push(suggestion
      ? `${label}.${key}は未定義です。${suggestion}の誤記ではありませんか。`
      : `${label}.${key}は未定義です。`);
  });
  requiredKeys.forEach((key) => {
    if (!Object.hasOwn(object, key)) errors.push(`${label}.${key}がありません。`);
  });
  return object;
}

function parseString(value, label, errors, { allowNull = false, allowEmpty = false, preserveWhitespace = false } = {}) {
  if (allowNull && value === null) return '';
  if (typeof value !== 'string') {
    errors.push(`${label}は${allowNull ? '文字列またはnull' : '文字列'}で指定してください。`);
    return '';
  }
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) errors.push(`${label}が空です。`);
  return preserveWhitespace ? value : trimmed;
}

function parseStringArray(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label}は文字列配列で指定してください。`);
    return [];
  }
  const result = value.map((item, index) => parseString(item, `${label}[${index}]`, errors));
  if (new Set(result).size !== result.length) errors.push(`${label}に同じ値が重複しています。`);
  return result;
}

function parseEnum(value, label, allowed, errors, { preserveCase = false } = {}) {
  const submitted = parseString(value, label, errors);
  const normalized = preserveCase ? submitted : submitted.toLowerCase();
  if (normalized && !allowed.has(normalized)) errors.push(`${label}は ${[...allowed].join(' / ')} のいずれかで指定してください。`);
  return normalized;
}

function hasUsableOptionalValue(object, key) {
  if (!Object.hasOwn(object, key) || object[key] === null || object[key] === undefined) return false;
  return typeof object[key] !== 'string' || Boolean(object[key].trim());
}

function parseOptionalStringField(object, key, label, errors, options = {}) {
  if (!hasUsableOptionalValue(object, key)) return '';
  return parseString(object[key], label, errors, { ...options, allowEmpty: true, allowNull: true });
}

function parseOptionalEnumField(object, key, label, allowed, errors) {
  if (!hasUsableOptionalValue(object, key)) return '';
  return parseEnum(object[key], label, allowed, errors);
}


function parseSpeechInteraction(value, errors) {
  const object = validateExactKeys(
    value,
    'speechInteraction',
    ['questionTargets', 'answerToRefs'],
    [],
    errors,
  );
  if (!object) return null;
  return {
    questionTargetNames: hasUsableOptionalValue(object, 'questionTargets')
      ? parseStringArray(object.questionTargets, 'speechInteraction.questionTargets', errors)
      : [],
    answerToRefs: hasUsableOptionalValue(object, 'answerToRefs')
      ? parsePositiveIntegerRefs(object.answerToRefs, 'speechInteraction.answerToRefs', errors)
      : [],
  };
}

function parseCoOperation(value, errors) {
  const preliminary = validateExactKeys(value, 'coOperation', ['action', 'roleId'], [], errors);
  if (!preliminary || !hasUsableOptionalValue(preliminary, 'action')) return null;
  const action = parseEnum(preliminary.action, 'coOperation.action', CO_ACTIONS, errors);
  const requiresRole = ['declare', 'change'].includes(action);
  if (requiresRole && !hasUsableOptionalValue(preliminary, 'roleId')) {
    errors.push(`coOperation.actionが${action}の場合、roleIdを指定してください。`);
    return null;
  }
  if (action === 'withdraw' && hasUsableOptionalValue(preliminary, 'roleId')) {
    errors.push('coOperation.actionがwithdrawの場合、roleIdは出力しないでください。');
  }
  const roleId = requiresRole
    ? parseString(preliminary.roleId, 'coOperation.roleId', errors)
    : 'none';
  if (requiresRole && roleId === 'none') errors.push('coOperation.actionがdeclareまたはchangeの場合、roleIdにnoneは使用できません。');
  return { action, roleId };
}

function parseAbilityClaims(value, errors) {
  if (!Array.isArray(value)) {
    errors.push('abilityClaimsは配列で指定してください。');
    return null;
  }
  const claims = value.map((claim, index) => {
    const label = `abilityClaims[${index}]`;
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
      errors.push(`${label}はオブジェクトで指定してください。`);
      return null;
    }
    const intent = hasUsableOptionalValue(claim, 'intent')
      ? parseEnum(claim.intent, `${label}.intent`, new Set(['truthful', 'deception']), errors)
      : '';
    if (!intent) {
      errors.push(`${label}.intentはtruthfulまたはdeceptionで指定してください。`);
      return null;
    }

    const optionalSelectionKeys = ['selectionBasis', 'evidenceRefs', 'selectionReasonAtTime'];
    if (intent === 'truthful') {
      const item = validateExactKeys(
        claim,
        label,
        ['intent', 'sourceRef', ...optionalSelectionKeys],
        ['intent', 'sourceRef'],
        errors,
      );
      if (!item) return null;
      const sourceRef = Number.isInteger(item.sourceRef) && item.sourceRef >= 1
        ? item.sourceRef
        : null;
      if (sourceRef === null) errors.push(`${label}.sourceRefは本人へ表示されたP#番号の正整数で指定してください。`);
      let evidenceRefs = [];
      if (hasUsableOptionalValue(item, 'evidenceRefs')) {
        if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.some((ref) => !Number.isInteger(ref) || ref < 1)) {
          errors.push(`${label}.evidenceRefsは公開イベント番号の正整数配列で指定してください。`);
        }
        evidenceRefs = Array.isArray(item.evidenceRefs)
          ? item.evidenceRefs.filter((ref) => Number.isInteger(ref) && ref > 0)
          : [];
        if (new Set(evidenceRefs).size !== evidenceRefs.length) errors.push(`${label}.evidenceRefsに同じ参照が重複しています。`);
      }
      const selectionBasis = hasUsableOptionalValue(item, 'selectionBasis')
        ? parseEnum(item.selectionBasis, `${label}.selectionBasis`, ABILITY_SELECTION_BASES, errors)
        : evidenceRefs.length
          ? 'public-evidence'
          : 'no-public-information';
      const selectionReasonAtTime = parseOptionalStringField(item, 'selectionReasonAtTime', `${label}.selectionReasonAtTime`, errors);
      return { intent, sourceRef, selectionBasis, evidenceRefs, selectionReasonAtTime };
    }

    const commonKeys = ['intent', 'roleId', 'actionDay', 'actionPhase', 'availableDay', 'availablePhase', 'target', 'result'];
    const item = validateExactKeys(claim, label, [...commonKeys, ...optionalSelectionKeys], commonKeys, errors);
    if (!item) return null;
    const roleId = parseString(item.roleId, `${label}.roleId`, errors);
    const actionDay = Number.isInteger(item.actionDay) && item.actionDay >= 0 ? item.actionDay : null;
    if (actionDay === null) errors.push(`${label}.actionDayは0以上の整数で指定してください。`);
    const actionPhase = parseString(item.actionPhase, `${label}.actionPhase`, errors);
    const availableDay = Number.isInteger(item.availableDay) && item.availableDay >= 1 ? item.availableDay : null;
    if (availableDay === null) errors.push(`${label}.availableDayは1以上の整数で指定してください。`);
    const availablePhase = parseString(item.availablePhase, `${label}.availablePhase`, errors);
    const targetName = parseString(item.target, `${label}.target`, errors);
    const result = parseString(item.result, `${label}.result`, errors);
    if (roleId === 'medium') {
      return { intent, roleId, actionDay, actionPhase, availableDay, availablePhase, targetName, result, selectionBasis: '', evidenceRefs: [], selectionReasonAtTime: '' };
    }
    let evidenceRefs = [];
    if (hasUsableOptionalValue(item, 'evidenceRefs')) {
      if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.some((ref) => !Number.isInteger(ref) || ref < 1)) {
        errors.push(`${label}.evidenceRefsは公開イベント番号の正整数配列で指定してください。`);
      }
      evidenceRefs = Array.isArray(item.evidenceRefs)
        ? item.evidenceRefs.filter((ref) => Number.isInteger(ref) && ref > 0)
        : [];
      if (new Set(evidenceRefs).size !== evidenceRefs.length) errors.push(`${label}.evidenceRefsに同じ参照が重複しています。`);
    }
    const selectionBasis = hasUsableOptionalValue(item, 'selectionBasis')
      ? parseEnum(item.selectionBasis, `${label}.selectionBasis`, ABILITY_SELECTION_BASES, errors)
      : evidenceRefs.length
        ? 'public-evidence'
        : 'no-public-information';
    const selectionReasonAtTime = parseOptionalStringField(item, 'selectionReasonAtTime', `${label}.selectionReasonAtTime`, errors);
    return { intent, roleId, actionDay, actionPhase, availableDay, availablePhase, targetName, result, selectionBasis, evidenceRefs, selectionReasonAtTime };
  }).filter(Boolean);
  if (!claims.length) return null;
  return { action: 'publish', count: claims.length, claims };
}

function parsePositiveIntegerRefs(value, label, errors) {
  if (!Array.isArray(value) || value.some((ref) => !Number.isInteger(ref) || ref < 1)) {
    errors.push(`${label}は公開イベント番号の正整数配列で指定してください。`);
    return [];
  }
  const result = [...value];
  if (new Set(result).size !== result.length) errors.push(`${label}に同じ参照が重複しています。`);
  return result;
}

function parseDecisionPatch(value, errors, { responseMode = 'speech' } = {}) {
  const allowedChangeKeys = getDecisionChangeKeys(responseMode);
  const object = validateExactKeys(
    value,
    'decisionPatch',
    getDecisionPatchKeys(responseMode),
    [],
    errors,
  );
  if (!object) return null;
  const changes = {};
  const text = (key) => parseString(object[key], `decisionPatch.${key}`, errors, { allowNull: true, allowEmpty: true });
  if (Object.hasOwn(object, 'suspects') && object.suspects !== null) {
    changes.suspicionCandidateNames = parseStringArray(object.suspects, 'decisionPatch.suspects', errors);
  }
  if (Object.hasOwn(object, 'executionCandidates') && object.executionCandidates !== null) {
    changes.executionCandidateNames = parseStringArray(object.executionCandidates, 'decisionPatch.executionCandidates', errors);
  }
  if (allowedChangeKeys.includes('intendedVote') && Object.hasOwn(object, 'intendedVote')) {
    if (object.intendedVote === null) changes.intendedVoteName = null;
    else changes.intendedVoteName = parseString(object.intendedVote, 'decisionPatch.intendedVote', errors, { allowEmpty: false });
  }
  if (Object.hasOwn(object, 'assessmentLevel') && object.assessmentLevel !== null) {
    changes.assessmentLevel = parseEnum(object.assessmentLevel, 'decisionPatch.assessmentLevel', ASSESSMENT_LEVELS, errors) || 'unresolved';
  }
  if (allowedChangeKeys.includes('leaveAliveBenefit') && hasUsableOptionalValue(object, 'leaveAliveBenefit')) changes.leaveAliveBenefit = text('leaveAliveBenefit');
  if (allowedChangeKeys.includes('misexecutionCost') && hasUsableOptionalValue(object, 'misexecutionCost')) changes.misexecutionCost = text('misexecutionCost');
  if (allowedChangeKeys.includes('selectionDifference') && hasUsableOptionalValue(object, 'selectionDifference')) changes.selectionDifference = text('selectionDifference');
  if (hasUsableOptionalValue(object, 'uncertainty')) changes.uncertainty = text('uncertainty');
  if (allowedChangeKeys.includes('nextDiscriminatingInformation') && hasUsableOptionalValue(object, 'nextDiscriminatingInformation')) {
    changes.nextDiscriminatingInformation = text('nextDiscriminatingInformation');
  }
  TURN_LOCAL_DECISION_TEXT_KEYS.forEach((key) => {
    if (allowedChangeKeys.includes(key) && hasUsableOptionalValue(object, key)) changes[key] = text(key);
  });
  TURN_LOCAL_DECISION_LIST_KEYS.forEach((key) => {
    if (allowedChangeKeys.includes(key) && hasUsableOptionalValue(object, key)) {
      changes[key] = parseStringArray(object[key], `decisionPatch.${key}`, errors);
    }
  });
  if (!Object.keys(changes).length) return null;
  const correctedSpeechRefs = hasUsableOptionalValue(object, 'correctedSpeechRefs')
    ? parsePositiveIntegerRefs(object.correctedSpeechRefs, 'decisionPatch.correctedSpeechRefs', errors)
    : [];
  const evidenceRefs = hasUsableOptionalValue(object, 'evidenceRefs')
    ? parsePositiveIntegerRefs(object.evidenceRefs, 'decisionPatch.evidenceRefs', errors)
    : [];
  return {
    mode: 'patch',
    changes,
    decisionReason: responseMode === 'vote'
      ? ''
      : parseOptionalStringField(object, 'reason', 'decisionPatch.reason', errors),
    grounding: correctedSpeechRefs.length || evidenceRefs.length
      ? { correctedSpeechRefs, evidenceRefs }
      : null,
  };
}

function parseFactionStrategyPatch(value, errors) {
  const object = validateExactKeys(value, 'factionStrategy', ['mode', 'changes'], [], errors);
  if (!object) return null;
  const changes = hasUsableOptionalValue(object, 'changes')
    ? requireObject(object.changes, 'factionStrategy.changes', errors) ?? {}
    : {};
  Object.keys(changes).forEach((key) => {
    if (!FACTION_STRATEGY_KEYS.has(key)) {
      const suggestion = closestKey(key, FACTION_STRATEGY_KEYS);
      errors.push(suggestion
        ? `factionStrategy.changes.${key}は未定義です。${suggestion}の誤記ではありませんか。`
        : `factionStrategy.changes.${key}は未定義です。`);
    }
  });
  const normalizedChanges = Object.fromEntries(
    Object.entries(changes)
      .filter(([key, item]) => FACTION_STRATEGY_KEYS.has(key) && item !== null && !(typeof item === 'string' && !item.trim()))
      .map(([key, item]) => [key, parseString(item, `factionStrategy.changes.${key}`, errors)]),
  );
  const mode = hasUsableOptionalValue(object, 'mode')
    ? parseEnum(object.mode, 'factionStrategy.mode', new Set(['keep', 'patch']), errors)
    : Object.keys(normalizedChanges).length
      ? 'patch'
      : '';
  if (!mode || (mode === 'patch' && !Object.keys(normalizedChanges).length)) return null;
  return { mode, changes: normalizedChanges };
}

function parseSharedStrategyPatch(value, errors) {
  const strategyKeys = new Set(['claimPlan', 'blackReceivedPlan', 'partnerExecutionPlan', 'collapsePlan', 'discussionPlan', 'attackPlan']);
  const object = validateExactKeys(value, 'sharedStrategy', ['mode', 'changes'], [], errors);
  if (!object) return null;
  const changesObject = hasUsableOptionalValue(object, 'changes')
    ? requireObject(object.changes, 'sharedStrategy.changes', errors) ?? {}
    : {};
  Object.keys(changesObject).forEach((key) => {
    if (!strategyKeys.has(key)) errors.push(`sharedStrategy.changes.${key}は未定義です。`);
  });
  const changes = Object.fromEntries(Object.entries(changesObject)
    .filter(([key, item]) => strategyKeys.has(key) && item !== null && !(typeof item === 'string' && !item.trim()))
    .map(([key, item]) => [key, parseString(item, `sharedStrategy.changes.${key}`, errors)]));
  const mode = hasUsableOptionalValue(object, 'mode')
    ? parseEnum(object.mode, 'sharedStrategy.mode', new Set(['keep', 'patch']), errors)
    : Object.keys(changes).length
      ? 'patch'
      : '';
  if (!mode || (mode === 'patch' && !Object.keys(changes).length)) return null;
  if (mode === 'keep' && Object.keys(changes).length) errors.push('sharedStrategy.modeがkeepの場合、changesは空オブジェクトにしてください。');
  return { mode, changes };
}

function parseAttackAssessment(value, errors) {
  const assessmentKeys = ['hunterAliveChance', 'guardRisk', 'otherTarget', 'otherGuardRisk'];
  const object = validateExactKeys(value, 'attackAssessment', assessmentKeys, [], errors);
  if (!object || !assessmentKeys.some((key) => hasUsableOptionalValue(object, key))) return null;
  const risk = new Set(['low', 'medium', 'high']);
  return {
    hunterAliveChance: parseOptionalEnumField(object, 'hunterAliveChance', 'attackAssessment.hunterAliveChance', risk, errors),
    hunterSurvivalReason: '',
    selectedTargetGuardRisk: parseOptionalEnumField(object, 'guardRisk', 'attackAssessment.guardRisk', risk, errors),
    selectedTargetValue: '',
    selectedTargetFailureCost: '',
    otherTargetName: parseOptionalStringField(object, 'otherTarget', 'attackAssessment.otherTarget', errors),
    otherTargetGuardRisk: parseOptionalEnumField(object, 'otherGuardRisk', 'attackAssessment.otherGuardRisk', risk, errors),
    otherTargetValue: '',
    selectionDifference: '',
  };
}

function parseEstimate(value, errors) {
  const object = validateExactKeys(value, 'estimate', ['wolfCandidateIds', 'predictedAttackTargetIds'], [], errors);
  if (!object) return null;
  return {
    estimatedWerewolfIds: hasUsableOptionalValue(object, 'wolfCandidateIds')
      ? parseStringArray(object.wolfCandidateIds, 'estimate.wolfCandidateIds', errors)
      : [],
    predictedAttackTargetIds: hasUsableOptionalValue(object, 'predictedAttackTargetIds')
      ? parseStringArray(object.predictedAttackTargetIds, 'estimate.predictedAttackTargetIds', errors)
      : [],
  };
}

function parseMemoAdd(value, errors) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  const text = parseString(value, 'memoAdd', errors);
  return text ? { mode: 'add', text } : null;
}

function emptyParsedValue() {
  return {
    publicSpeech: '',
    speechInteraction: null,
    coOperation: null,
    abilityClaims: null,
    decisionUpdate: null,
    factionStrategyPatch: null,
    wolfMessage: '',
    masonMessage: '',
    graveyardMessage: '',
    sharedStrategyPatch: null,
    attackAssessment: null,
    estimatedWerewolfIds: [],
    predictedAttackTargetIds: [],
    selectionRationale: '',
    heartVoice: '',
    internalMemoUpdate: null,
    fullMemo: '',
    actionAnswer: '',
    nextSpeakerPreference: '',
    discussionPreference: '',
    openingPreference: '',
  };
}

function parseIssueFromMessage(message) {
  const text = String(message ?? '');
  const path = text.match(/^([A-Za-z][A-Za-z0-9_.\[\]]*)/u)?.[1] ?? '';
  if (text === 'AI応答が空です。') {
    return { code: 'EMPTY_RESPONSE', category: 'syntax', path: '', message: text };
  }
  if (text.startsWith('AI応答をJSONとして解析できません。')) {
    return { code: 'INVALID_JSON', category: 'syntax', path: '', message: text };
  }
  if (/重複/u.test(text)) {
    return { code: 'DUPLICATE_KEY', category: 'schema', path, message: text };
  }
  if (/は未定義です/u.test(text)) {
    return { code: 'UNKNOWN_KEY', category: 'schema', path, message: text };
  }
  if (/必須です|ありません/u.test(text)) {
    return { code: 'MISSING_REQUIRED_KEY', category: 'schema', path, message: text };
  }
  if (/配列|文字列|整数|真偽値|オブジェクト|指定してください/u.test(text)) {
    return { code: 'INVALID_VALUE_TYPE', category: 'schema', path, message: text };
  }
  return { code: 'RESPONSE_SCHEMA_ERROR', category: 'schema', path, message: text };
}

function createParseResult(value, errors = [], warnings = []) {
  const uniqueErrors = [...new Set(errors)];
  const unknownProperties = uniqueErrors
    .map((message) => message.match(/^(.+?)は未定義です/u)?.[1] ?? null)
    .filter(Boolean);
  return {
    value,
    diagnostics: {
      errors: uniqueErrors,
      warnings: [...new Set(warnings)],
      unknownProperties: [...new Set(unknownProperties)],
      issues: uniqueErrors.map(parseIssueFromMessage),
    },
  };
}

export function parseAiResponse(rawResponse, mode) {
  const raw = String(rawResponse ?? '').trim();
  const value = emptyParsedValue();
  if (!raw) return createParseResult(value, ['AI応答が空です。']);
  let payload;
  let duplicateErrors = [];
  try {
    const parsedJson = parseStrictJson(raw);
    payload = parsedJson.value;
    duplicateErrors = parsedJson.duplicateErrors;
  } catch (error) {
    const result = createParseResult(value, [`AI応答をJSONとして解析できません。${error.message}`]);
    if (error?.code === 'JSON_TOO_DEEP' && result.diagnostics.issues[0]) {
      result.diagnostics.issues[0].code = 'JSON_TOO_DEEP';
    }
    return result;
  }
  const errors = [...duplicateErrors];
  const allowedTop = getResponseTopLevelKeys(mode);
  const requiredTop = getRequiredResponseTopLevelKeys(mode);
  const object = validateExactKeys(payload, 'response', allowedTop, requiredTop, errors);
  if (!object) return createParseResult(value, errors);

  if (Object.hasOwn(object, 'publicSpeech')) value.publicSpeech = parseString(object.publicSpeech, 'publicSpeech', errors, { preserveWhitespace: true });
  if (hasUsableOptionalValue(object, 'speechInteraction')) value.speechInteraction = parseSpeechInteraction(object.speechInteraction, errors);
  if (hasUsableOptionalValue(object, 'coOperation')) value.coOperation = parseCoOperation(object.coOperation, errors);
  if (hasUsableOptionalValue(object, 'abilityClaims')) value.abilityClaims = parseAbilityClaims(object.abilityClaims, errors);
  if (hasUsableOptionalValue(object, 'decisionPatch')) value.decisionUpdate = parseDecisionPatch(object.decisionPatch, errors, { responseMode: mode });
  if (hasUsableOptionalValue(object, 'factionStrategy')) value.factionStrategyPatch = parseFactionStrategyPatch(object.factionStrategy, errors);
  if (Object.hasOwn(object, 'wolfMessage')) value.wolfMessage = parseString(object.wolfMessage, 'wolfMessage', errors);
  if (Object.hasOwn(object, 'masonMessage')) value.masonMessage = parseString(object.masonMessage, 'masonMessage', errors);
  if (Object.hasOwn(object, 'graveyardMessage')) value.graveyardMessage = parseString(object.graveyardMessage, 'graveyardMessage', errors);
  if (hasUsableOptionalValue(object, 'sharedStrategy')) value.sharedStrategyPatch = parseSharedStrategyPatch(object.sharedStrategy, errors);
  if (hasUsableOptionalValue(object, 'attackAssessment')) value.attackAssessment = parseAttackAssessment(object.attackAssessment, errors);
  if (hasUsableOptionalValue(object, 'estimate')) {
    const estimate = parseEstimate(object.estimate, errors);
    value.estimatedWerewolfIds = estimate?.estimatedWerewolfIds ?? [];
    value.predictedAttackTargetIds = estimate?.predictedAttackTargetIds ?? [];
  }
  if (hasUsableOptionalValue(object, 'rationale')) value.selectionRationale = parseString(object.rationale, 'rationale', errors, { allowEmpty: true, allowNull: true });
  if (hasUsableOptionalValue(object, 'heartVoice')) value.heartVoice = parseString(object.heartVoice, 'heartVoice', errors, { allowEmpty: true, allowNull: true });
  if (hasUsableOptionalValue(object, 'memoAdd')) value.internalMemoUpdate = parseMemoAdd(object.memoAdd, errors);
  if (Object.hasOwn(object, 'fullMemo')) value.fullMemo = parseString(object.fullMemo, 'fullMemo', errors);
  if (Object.hasOwn(object, 'actionAnswer')) value.actionAnswer = parseString(object.actionAnswer, 'actionAnswer', errors);
  if (Object.hasOwn(object, 'nextSpeakerPreference')) value.nextSpeakerPreference = parseString(object.nextSpeakerPreference, 'nextSpeakerPreference', errors, { allowEmpty: true });
  if (Object.hasOwn(object, 'discussionPreference')) value.discussionPreference = parseString(object.discussionPreference, 'discussionPreference', errors).trim().toUpperCase();
  if (Object.hasOwn(object, 'openingPreference')) value.openingPreference = parseEnum(object.openingPreference, 'openingPreference', new Set(['early', 'normal', 'wait_co']), errors).toUpperCase();

  return createParseResult(value, errors);
}
