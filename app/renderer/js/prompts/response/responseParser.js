/**
 * 責務: AI応答の単一JSONオブジェクトを、公開発言・CO操作・能力結果主張・判断差分・判断根拠参照・陣営戦略差分・秘密会話・襲撃判断・雪女の推定候補・夜行動理由・心の声・内部メモへ厳密に構文分解する。
 * 変更ルール: 公開発言の自然文からCOや判断状態を推測しない。応答キーと判断参照キーはresponseContract.js、assessmentLevelの列挙値はdecisionState.jsを正本とし、判断変更原因を生成せず、ゲーム状態との整合性判定や状態更新を行わない。ゲーム進行に不要な理由・比較・戦略・内面・監査項目は未入力・空値・子キー欠落を省略扱いとし、実値が出力されたキーだけを厳密に構文検証する。任意項目の欠落診断を追加しない。診断は表示用errorsと再試行判断用issuesへ同時に集約し、未知キーは自動補正しない。
 */

import { DECISION_ASSESSMENT_LEVELS } from '../../domain/game/decisionState.js';
import { getDecisionChangeKeys, getDecisionPatchKeys, getRequiredResponseTopLevelKeys, getResponseTopLevelKeys } from './responseContract.js';

const ABILITY_SELECTION_BASES = new Set(['no-public-information', 'public-evidence', 'rule-forced']);
const ASSESSMENT_LEVELS = new Set(DECISION_ASSESSMENT_LEVELS);
const CO_ACTIONS = new Set(['declare', 'change', 'withdraw']);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FACTION_STRATEGY_KEYS = new Set([
  'publicWorld', 'dayWinPath', 'partnerDisposition', 'collapsePlan', 'linkageRisk',
  'fallbackRoute', 'pressureGoal', 'failureRisk', 'nextDayPlan',
]);

function parseStrictJson(text) {
  let index = 0;
  const duplicateErrors = [];

  function fail(message) {
    throw new SyntaxError(`${message}（位置${index + 1}）`);
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
  const candidates = [...allowedKeys]
    .map((key) => ({ key, distance: damerauLevenshteinDistance(rawKey, key) }))
    .sort((left, right) => left.distance - right.distance || left.key.localeCompare(right.key));
  if (!candidates.length || candidates[0].distance > 2) return null;
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
    ['questionTargets', 'answerEventSequences'],
    [],
    errors,
  );
  if (!object) return null;
  return {
    questionTargetNames: hasUsableOptionalValue(object, 'questionTargets')
      ? parseStringArray(object.questionTargets, 'speechInteraction.questionTargets', errors)
      : [],
    answerEventSequences: hasUsableOptionalValue(object, 'answerEventSequences')
      ? parsePositiveIntegerRefs(object.answerEventSequences, 'speechInteraction.answerEventSequences', errors)
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
    const commonKeys = ['roleId', 'resultDay', 'target', 'result'];
    const optionalSelectionKeys = ['selectionBasis', 'evidenceEventSequences', 'selectionReasonAtTime'];
    const item = validateExactKeys(claim, label, [...commonKeys, ...optionalSelectionKeys], [], errors);
    if (!item) return null;
    const hasAllCommonKeys = commonKeys.every((key) => hasUsableOptionalValue(item, key));
    const roleId = hasUsableOptionalValue(item, 'roleId') ? parseString(item.roleId, `${label}.roleId`, errors) : '';
    let resultDay = null;
    if (Object.hasOwn(item, 'resultDay') && item.resultDay !== null) {
      resultDay = Number.isInteger(item.resultDay) && item.resultDay >= 1 ? item.resultDay : null;
      if (resultDay === null) errors.push(`${label}.resultDayは1以上の整数で指定してください。`);
    }
    const targetName = hasUsableOptionalValue(item, 'target') ? parseString(item.target, `${label}.target`, errors) : '';
    const result = hasUsableOptionalValue(item, 'result') ? parseString(item.result, `${label}.result`, errors) : '';
    if (!hasAllCommonKeys) return null;
    if (roleId === 'medium') {
      return { roleId, resultDay, targetName, result, selectionBasis: '', evidenceRefs: [], selectionReasonAtTime: '' };
    }
    let evidenceRefs = [];
    if (hasUsableOptionalValue(item, 'evidenceEventSequences')) {
      if (!Array.isArray(item.evidenceEventSequences) || item.evidenceEventSequences.some((ref) => !Number.isInteger(ref) || ref < 1)) {
        errors.push(`${label}.evidenceEventSequencesは公開イベント番号の正整数配列で指定してください。`);
      }
      evidenceRefs = Array.isArray(item.evidenceEventSequences)
        ? item.evidenceEventSequences.filter((ref) => Number.isInteger(ref) && ref > 0)
        : [];
      if (new Set(evidenceRefs).size !== evidenceRefs.length) errors.push(`${label}.evidenceEventSequencesに同じ参照が重複しています。`);
    }
    const selectionBasis = hasUsableOptionalValue(item, 'selectionBasis')
      ? parseEnum(item.selectionBasis, `${label}.selectionBasis`, ABILITY_SELECTION_BASES, errors)
      : evidenceRefs.length
        ? 'public-evidence'
        : 'no-public-information';
    const selectionReasonAtTime = parseOptionalStringField(item, 'selectionReasonAtTime', `${label}.selectionReasonAtTime`, errors);
    return { roleId, resultDay, targetName, result, selectionBasis, evidenceRefs, selectionReasonAtTime };
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
  if (Object.hasOwn(object, 'suspicionCandidates') && object.suspicionCandidates !== null) {
    changes.suspicionCandidateNames = parseStringArray(object.suspicionCandidates, 'decisionPatch.suspicionCandidates', errors);
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
  if (!Object.keys(changes).length) return null;
  const correctedSpeechSequences = hasUsableOptionalValue(object, 'correctedSpeechSequences')
    ? parsePositiveIntegerRefs(object.correctedSpeechSequences, 'decisionPatch.correctedSpeechSequences', errors)
    : [];
  const evidenceEventSequences = hasUsableOptionalValue(object, 'evidenceEventSequences')
    ? parsePositiveIntegerRefs(object.evidenceEventSequences, 'decisionPatch.evidenceEventSequences', errors)
    : [];
  return {
    mode: 'patch',
    changes,
    decisionReason: responseMode === 'vote'
      ? ''
      : parseOptionalStringField(object, 'reason', 'decisionPatch.reason', errors),
    grounding: correctedSpeechSequences.length || evidenceEventSequences.length
      ? { correctedSpeechSequences, evidenceEventSequences }
      : null,
  };
}

function parseFactionStrategyPatch(value, errors) {
  const object = validateExactKeys(value, 'factionStrategyUpdate', ['mode', 'changes'], [], errors);
  if (!object) return null;
  const changes = hasUsableOptionalValue(object, 'changes')
    ? requireObject(object.changes, 'factionStrategyUpdate.changes', errors) ?? {}
    : {};
  Object.keys(changes).forEach((key) => {
    if (!FACTION_STRATEGY_KEYS.has(key)) {
      const suggestion = closestKey(key, FACTION_STRATEGY_KEYS);
      errors.push(suggestion
        ? `factionStrategyUpdate.changes.${key}は未定義です。${suggestion}の誤記ではありませんか。`
        : `factionStrategyUpdate.changes.${key}は未定義です。`);
    }
  });
  const normalizedChanges = Object.fromEntries(
    Object.entries(changes)
      .filter(([key, item]) => FACTION_STRATEGY_KEYS.has(key) && item !== null && !(typeof item === 'string' && !item.trim()))
      .map(([key, item]) => [key, parseString(item, `factionStrategyUpdate.changes.${key}`, errors)]),
  );
  const mode = hasUsableOptionalValue(object, 'mode')
    ? parseEnum(object.mode, 'factionStrategyUpdate.mode', new Set(['keep', 'patch']), errors)
    : Object.keys(normalizedChanges).length
      ? 'patch'
      : '';
  if (!mode || (mode === 'patch' && !Object.keys(normalizedChanges).length)) return null;
  return { mode, changes: normalizedChanges };
}

function parseSharedStrategyUpdate(value, errors) {
  const strategyKeys = new Set(['claimPlan', 'blackReceivedPlan', 'partnerExecutionPlan', 'collapsePlan', 'discussionPlan', 'attackPlan']);
  const object = validateExactKeys(value, 'sharedStrategyUpdate', ['mode', 'changes'], [], errors);
  if (!object) return null;
  const changesObject = hasUsableOptionalValue(object, 'changes')
    ? requireObject(object.changes, 'sharedStrategyUpdate.changes', errors) ?? {}
    : {};
  Object.keys(changesObject).forEach((key) => {
    if (!strategyKeys.has(key)) errors.push(`sharedStrategyUpdate.changes.${key}は未定義です。`);
  });
  const changes = Object.fromEntries(Object.entries(changesObject)
    .filter(([key, item]) => strategyKeys.has(key) && item !== null && !(typeof item === 'string' && !item.trim()))
    .map(([key, item]) => [key, parseString(item, `sharedStrategyUpdate.changes.${key}`, errors)]));
  const mode = hasUsableOptionalValue(object, 'mode')
    ? parseEnum(object.mode, 'sharedStrategyUpdate.mode', new Set(['keep', 'patch']), errors)
    : Object.keys(changes).length
      ? 'patch'
      : '';
  if (!mode || (mode === 'patch' && !Object.keys(changes).length)) return null;
  if (mode === 'keep' && Object.keys(changes).length) errors.push('sharedStrategyUpdate.modeがkeepの場合、changesは空オブジェクトにしてください。');
  return { mode, changes };
}

function parseAttackAssessment(value, errors) {
  const assessmentKeys = ['hunterSurvivalLikelihood', 'guardRisk', 'alternativeTarget', 'alternativeGuardRisk'];
  const object = validateExactKeys(value, 'attackAssessment', assessmentKeys, [], errors);
  if (!object || !assessmentKeys.some((key) => hasUsableOptionalValue(object, key))) return null;
  const risk = new Set(['low', 'medium', 'high']);
  return {
    hunterSurvivalLikelihood: parseOptionalEnumField(object, 'hunterSurvivalLikelihood', 'attackAssessment.hunterSurvivalLikelihood', risk, errors),
    hunterSurvivalReason: '',
    selectedTargetGuardRisk: parseOptionalEnumField(object, 'guardRisk', 'attackAssessment.guardRisk', risk, errors),
    selectedTargetValue: '',
    selectedTargetFailureCost: '',
    alternativeTargetName: parseOptionalStringField(object, 'alternativeTarget', 'attackAssessment.alternativeTarget', errors),
    alternativeTargetGuardRisk: parseOptionalEnumField(object, 'alternativeGuardRisk', 'attackAssessment.alternativeGuardRisk', risk, errors),
    alternativeTargetValue: '',
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
    factionStrategyUpdate: null,
    wolfMessage: '',
    masonMessage: '',
    graveyardMessage: '',
    sharedStrategyUpdate: null,
    attackAssessment: null,
    estimatedWerewolfIds: [],
    predictedAttackTargetIds: [],
    actionRationale: '',
    heartVoice: '',
    internalMemoUpdate: null,
    consolidatedMemo: '',
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
    return createParseResult(value, [`AI応答をJSONとして解析できません。${error.message}`]);
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
  if (hasUsableOptionalValue(object, 'factionStrategyUpdate')) value.factionStrategyUpdate = parseFactionStrategyPatch(object.factionStrategyUpdate, errors);
  if (Object.hasOwn(object, 'wolfMessage')) value.wolfMessage = parseString(object.wolfMessage, 'wolfMessage', errors);
  if (Object.hasOwn(object, 'masonMessage')) value.masonMessage = parseString(object.masonMessage, 'masonMessage', errors);
  if (Object.hasOwn(object, 'graveyardMessage')) value.graveyardMessage = parseString(object.graveyardMessage, 'graveyardMessage', errors);
  if (hasUsableOptionalValue(object, 'sharedStrategyUpdate')) value.sharedStrategyUpdate = parseSharedStrategyUpdate(object.sharedStrategyUpdate, errors);
  if (hasUsableOptionalValue(object, 'attackAssessment')) value.attackAssessment = parseAttackAssessment(object.attackAssessment, errors);
  if (hasUsableOptionalValue(object, 'estimate')) {
    const estimate = parseEstimate(object.estimate, errors);
    value.estimatedWerewolfIds = estimate?.estimatedWerewolfIds ?? [];
    value.predictedAttackTargetIds = estimate?.predictedAttackTargetIds ?? [];
  }
  if (hasUsableOptionalValue(object, 'actionRationale')) value.actionRationale = parseString(object.actionRationale, 'actionRationale', errors, { allowEmpty: true, allowNull: true });
  if (hasUsableOptionalValue(object, 'heartVoice')) value.heartVoice = parseString(object.heartVoice, 'heartVoice', errors, { allowEmpty: true, allowNull: true });
  if (hasUsableOptionalValue(object, 'memoAdd')) value.internalMemoUpdate = parseMemoAdd(object.memoAdd, errors);
  if (Object.hasOwn(object, 'consolidatedMemo')) value.consolidatedMemo = parseString(object.consolidatedMemo, 'consolidatedMemo', errors);
  if (Object.hasOwn(object, 'actionAnswer')) value.actionAnswer = parseString(object.actionAnswer, 'actionAnswer', errors);
  if (Object.hasOwn(object, 'nextSpeakerPreference')) value.nextSpeakerPreference = parseString(object.nextSpeakerPreference, 'nextSpeakerPreference', errors, { allowEmpty: true });
  if (Object.hasOwn(object, 'discussionPreference')) value.discussionPreference = parseString(object.discussionPreference, 'discussionPreference', errors).trim().toUpperCase();
  if (Object.hasOwn(object, 'openingPreference')) value.openingPreference = parseEnum(object.openingPreference, 'openingPreference', new Set(['early', 'normal', 'wait_co']), errors).toUpperCase();

  return createParseResult(value, errors);
}
