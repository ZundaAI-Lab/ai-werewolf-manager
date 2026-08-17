/**
 * 責務: ゲームルールの正式な入力仕様、欠落補完、未知項目除去、値検証、準備画面からの変更適用を一元管理する。
 * 正式仕様: 保存JSONのgame.rulesは版番号では分岐せず、既知項目の欠落を現在のDEFAULT_RULESで補完して取り込む。未知項目は取り込まず、不正な型・列挙値・数値範囲は既存値として拒否する。
 * 変更ルール: ルール項目を追加・削除・意味変更する場合はDEFAULT_RULESとRULE_VALUE_SPECSを同時更新する。状態全体の参照整合性、DOM操作、保存処理を持ち込まない。
 */

import { DEFAULT_RULES, VOTE_TIE_RESOLUTIONS } from '../../config/constants.js';
import { deepClone } from '../../shared/utils.js';

const RULE_VALUE_SPECS = Object.freeze({
  speechCountPerDay: Object.freeze({ type: 'integer', min: 1, max: 10 }),
  'discussion.mode': Object.freeze({ type: 'enum', values: Object.freeze(['ordered', 'designated', 'free']) }),
  'discussion.answerPriorityEnabled': Object.freeze({ type: 'boolean' }),
  'roleAssignment.shuffleOnStart': Object.freeze({ type: 'boolean' }),
  'roleAssignment.roleMissingEnabled': Object.freeze({ type: 'boolean' }),
  'firstNight.wolfCommunicationEnabled': Object.freeze({ type: 'boolean' }),
  'firstNight.wolfAttackEnabled': Object.freeze({ type: 'boolean' }),
  'firstNight.seerMode': Object.freeze({ type: 'enum', values: Object.freeze(['choose', 'random-non-wolf', 'disabled']) }),
  'firstNight.guardEnabled': Object.freeze({ type: 'boolean' }),
  'vote.selfVoteAllowed': Object.freeze({ type: 'boolean' }),
  'vote.abstentionAllowed': Object.freeze({ type: 'boolean' }),
  'vote.visibilityDuringInput': Object.freeze({ type: 'enum', values: Object.freeze(['secret', 'public']) }),
  'vote.publicationAfterFinalize': Object.freeze({ type: 'enum', values: Object.freeze(['tally-only', 'all-ballots', 'execution-target-only']) }),
  'vote.runoffLimit': Object.freeze({ type: 'integer', min: 0, max: 5 }),
  'vote.tieResolution': Object.freeze({ type: 'enum', values: VOTE_TIE_RESOLUTIONS }),
  'vote.revealExecutedRole': Object.freeze({ type: 'boolean' }),
  'seer.selfTargetAllowed': Object.freeze({ type: 'boolean' }),
  'seer.repeatedTargetAllowed': Object.freeze({ type: 'boolean' }),
  'guard.selfGuardAllowed': Object.freeze({ type: 'boolean' }),
  'guard.consecutiveGuardAllowed': Object.freeze({ type: 'boolean' }),
  'testament.enabled': Object.freeze({ type: 'boolean' }),
  'graveyardCommunication.enabled': Object.freeze({ type: 'boolean' }),
  'graveyardCommunication.availability': Object.freeze({ type: 'enum', values: Object.freeze(['night-only']) }),
  'graveyardCommunication.includeConversationInAiPrompt': Object.freeze({ type: 'boolean' }),
  'graveyardCommunication.retainPastConversation': Object.freeze({ type: 'boolean' }),
  'graveyardCommunication.speechCountPerNight': Object.freeze({ type: 'integer', min: 1, max: 10 }),
  'masonCommunication.enabled': Object.freeze({ type: 'boolean' }),
  'masonCommunication.availability': Object.freeze({ type: 'enum', values: Object.freeze(['night-only']) }),
  'masonCommunication.includeConversationInAiPrompt': Object.freeze({ type: 'boolean' }),
  'masonCommunication.retainPastConversation': Object.freeze({ type: 'boolean' }),
  'masonCommunication.speechCountPerNight': Object.freeze({ type: 'integer', min: 1, max: 10 }),
  'wolfCommunication.enabled': Object.freeze({ type: 'boolean' }),
  'wolfCommunication.participantMode': Object.freeze({ type: 'enum', values: Object.freeze(['wolves-only', 'wolves-and-madman']) }),
  'wolfCommunication.availability': Object.freeze({ type: 'enum', values: Object.freeze(['night-only']) }),
  'wolfCommunication.includeConversationInAiPrompt': Object.freeze({ type: 'boolean' }),
  'wolfCommunication.retainPastConversation': Object.freeze({ type: 'boolean' }),
  'wolfCommunication.speechCountPerNight': Object.freeze({ type: 'integer', min: 1, max: 10 }),
  'nightResolution.deliverPrivateResultToDeadPlayer': Object.freeze({ type: 'boolean' }),
  'callNames.enabled': Object.freeze({ type: 'boolean' }),
  'ai.maxPublicSpeechLength': Object.freeze({ type: 'integer', min: 1 }),
  'ai.maxWolfMessageLength': Object.freeze({ type: 'integer', min: 1 }),
  'ai.maxMasonMessageLength': Object.freeze({ type: 'integer', min: 1 }),
  'ai.maxGraveyardMessageLength': Object.freeze({ type: 'integer', min: 1 }),
  'ai.maxHeartVoiceLength': Object.freeze({ type: 'integer', min: 1 }),
  'ai.maxInternalMemoLength': Object.freeze({ type: 'integer', min: 1 }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function joinPath(parent, key) {
  return parent ? `${parent}.${key}` : key;
}

function leafPaths(value, parent = '') {
  if (!isPlainObject(value)) return [parent];
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, joinPath(parent, key)));
}

function validateSpecCoverage() {
  const defaultPaths = leafPaths(DEFAULT_RULES).sort();
  const specPaths = Object.keys(RULE_VALUE_SPECS).sort();
  if (defaultPaths.length !== specPaths.length || defaultPaths.some((path, index) => path !== specPaths[index])) {
    throw new Error('DEFAULT_RULESとゲームルール値仕様が一致していません。');
  }
}

function valueError(spec, value, itemLabel) {
  if (spec.type === 'boolean') {
    return typeof value === 'boolean' ? '' : `${itemLabel}は真偽値で指定してください。`;
  }
  if (spec.type === 'enum') {
    return typeof value === 'string' && spec.values.includes(value)
      ? ''
      : `${itemLabel}は許可された選択値ではありません。`;
  }
  if (spec.type === 'integer') {
    if (!Number.isInteger(value)) return `${itemLabel}は整数で指定してください。`;
    if (spec.min !== undefined && value < spec.min) return `${itemLabel}は${spec.min}以上で指定してください。`;
    if (spec.max !== undefined && value > spec.max) return `${itemLabel}は${spec.max}以下で指定してください。`;
  }
  return '';
}

function validateRuleTree(actual, expected, path, label, errors, { allowMissing, ignoreUnknown }) {
  const itemLabel = path ? `${label}.${path}` : label;
  if (actual === undefined) {
    if (!allowMissing) errors.push(`${itemLabel}がありません。`);
    return;
  }

  if (!isPlainObject(expected)) {
    const spec = RULE_VALUE_SPECS[path];
    const error = valueError(spec, actual, itemLabel);
    if (error) errors.push(error);
    return;
  }

  if (!isPlainObject(actual)) {
    errors.push(`${itemLabel}はオブジェクトで指定してください。`);
    return;
  }

  if (!ignoreUnknown) {
    Object.keys(actual).forEach((key) => {
      if (!Object.hasOwn(expected, key)) errors.push(`${joinPath(itemLabel, key)}は定義されていない項目です。`);
    });
  }

  Object.entries(expected).forEach(([key, child]) => {
    validateRuleTree(actual[key], child, joinPath(path, key), label, errors, { allowMissing, ignoreUnknown });
  });
}

function projectKnownRules(actual, expected) {
  if (!isPlainObject(expected)) return actual === undefined ? deepClone(expected) : deepClone(actual);
  const source = isPlainObject(actual) ? actual : {};
  return Object.fromEntries(Object.entries(expected).map(([key, child]) => [key, projectKnownRules(source[key], child)]));
}

function assignAtPath(value, path, nextValue) {
  const keys = path.split('.');
  let current = value;
  keys.slice(0, -1).forEach((key) => { current = current[key]; });
  current[keys.at(-1)] = nextValue;
}

function coerceRuleInput(path, rawValue) {
  const spec = RULE_VALUE_SPECS[path];
  if (!spec) throw new Error(`変更対象のゲームルールが不正です: ${path}`);
  if (spec.type === 'boolean') {
    if (typeof rawValue === 'boolean') return rawValue;
    if (rawValue === 'true') return true;
    if (rawValue === 'false') return false;
    throw new Error(`${path}は真偽値で指定してください。`);
  }
  if (spec.type === 'integer') {
    const text = String(rawValue ?? '').trim();
    if (!/^-?\d+$/u.test(text)) throw new Error(`${path}は整数で指定してください。`);
    return Number(text);
  }
  return String(rawValue ?? '');
}

validateSpecCoverage();

export function validateGameRules(rules, {
  allowMissing = false,
  ignoreUnknown = false,
  label = 'game.rules',
} = {}) {
  const errors = [];
  validateRuleTree(rules, DEFAULT_RULES, '', label, errors, { allowMissing, ignoreUnknown });
  return errors;
}

export function normalizeImportedGameRules(rules, { label = 'game.rules' } = {}) {
  const errors = validateGameRules(rules, { allowMissing: true, ignoreUnknown: true, label });
  if (errors.length) throw new Error(errors.join('\n'));
  return projectKnownRules(rules, DEFAULT_RULES);
}

export function assertCompleteGameRules(rules, label = 'game.rules') {
  const errors = validateGameRules(rules, { label });
  if (errors.length) throw new Error(errors.join('\n'));
  return rules;
}

export function applyGameRuleChange(rules, path, rawValue) {
  const next = projectKnownRules(rules, DEFAULT_RULES);
  if (path === 'wolfCommunication.mode') {
    const mode = String(rawValue ?? '');
    if (!['none', 'wolves-only', 'wolves-and-madman'].includes(mode)) {
      throw new Error('wolfCommunication.modeは許可された選択値ではありません。');
    }
    next.wolfCommunication.enabled = mode !== 'none';
    if (mode !== 'none') next.wolfCommunication.participantMode = mode;
  } else {
    const value = coerceRuleInput(path, rawValue);
    assignAtPath(next, path, value);
  }
  assertCompleteGameRules(next);
  return next;
}

