/**
 * 責務: タスク・本人役職の機械応答契約と現在の有効対象から、Provider非依存の構造化出力Schemaを生成する。
 * 変更ルール: Provider固有のrequest bodyを生成せず、ゲーム状態を更新しない。許可キーと回答検証必須キーはresponseContract.js、役職適合判定はfactionStrategyState.jsを正本とし、Schema.requiredには欠落時にゲーム進行を止める回答検証必須項目だけを入れる。AI向けプロンプトで原則出力するrationale / decisionPatch等を、プロンプト掲載を理由にSchema.requiredへ追加してはならない。投票候補のenumは現在タスクの正式表示名だけから構成する。構造化出力非対応時はプロンプト契約へ委譲できるようnullを返す。
 */

import { DECISION_ASSESSMENT_LEVELS } from '../../domain/game/decisionState.js';
import { resolveWolfPartnerDispositionPolicy } from '../../domain/game/wolfPartnerDispositionPolicy.js';
import { getPlayer } from '../../domain/game/standardRules.js';
import {
  getDecisionPatchKeys,
  getFactionStrategyResponseFields,
  getRequiredResponseTopLevelKeys,
  getResponseModeForTask,
  getRoleCompatibleResponseTopLevelKeys,
} from './responseContract.js';

const VOTE_DECISION_PROPERTY_SCHEMAS = Object.freeze({
  suspects: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
  executionCandidates: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
  assessmentLevel: Object.freeze({ type: 'string', enum: Object.freeze([...DECISION_ASSESSMENT_LEVELS]) }),
  leaveAliveBenefit: Object.freeze({ type: 'string' }),
  misexecutionCost: Object.freeze({ type: 'string' }),
  selectionDifference: Object.freeze({ type: 'string' }),
  uncertainty: Object.freeze({ type: 'string' }),
  nextDiscriminatingInformation: Object.freeze({ type: 'string' }),
  correctedSpeechRefs: Object.freeze({ type: 'array', items: Object.freeze({ type: 'integer' }) }),
  evidenceRefs: Object.freeze({ type: 'array', items: Object.freeze({ type: 'integer' }) }),
});

function voteDecisionPatchSchema() {
  return {
    type: 'object',
    properties: Object.fromEntries(getDecisionPatchKeys('vote')
      .map((key) => [key, VOTE_DECISION_PROPERTY_SCHEMAS[key]])),
    required: [],
    additionalProperties: false,
  };
}

const TOP_LEVEL_PROPERTY_SCHEMAS = Object.freeze({
  actionAnswer: Object.freeze({ type: 'string' }),
  rationale: Object.freeze({ type: 'string' }),
  decisionPatch: Object.freeze(voteDecisionPatchSchema()),
  memoAdd: Object.freeze({ type: 'string' }),
});


function factionStrategySchema(roleId, partnerDispositionPolicy = null) {
  const fields = getFactionStrategyResponseFields(roleId, partnerDispositionPolicy);
  if (!fields.length) return null;
  return {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['keep', 'patch'] },
      changes: {
        type: 'object',
        properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])),
        required: [],
        additionalProperties: false,
      },
    },
    required: ['mode', 'changes'],
    additionalProperties: false,
  };
}

function voteTargetNames(state, validTargetIds) {
  const names = [...new Set((validTargetIds ?? [])
    .map((targetId) => getPlayer(state, targetId)?.name)
    .map((name) => String(name ?? '').trim())
    .filter(Boolean))];
  if (state?.game?.rules?.vote?.abstentionAllowed) names.push('棄権');
  return [...new Set(names)];
}

export function buildStructuredOutputContract(state, {
  taskType = '',
  playerId = '',
  validTargetIds = [],
} = {}) {
  if (taskType !== 'vote') return null;
  const mode = getResponseModeForTask(taskType);
  const targetNames = voteTargetNames(state, validTargetIds);
  const player = getPlayer(state, playerId);
  const roleId = player?.roleId ?? '';
  const partnerDispositionPolicy = resolveWolfPartnerDispositionPolicy({
    actorId: playerId,
    knownWolfIds: state?.playerKnowledge?.[playerId]?.knownWolfIds ?? [],
    alivePlayerIds: (state?.players ?? []).filter((item) => item.alive).map((item) => item.id),
  });
  if (!targetNames.length) return null;
  const properties = {};
  for (const key of getRoleCompatibleResponseTopLevelKeys(mode, roleId)) {
    const base = key === 'factionStrategy'
      ? factionStrategySchema(roleId, partnerDispositionPolicy)
      : TOP_LEVEL_PROPERTY_SCHEMAS[key];
    if (!base) continue;
    properties[key] = key === 'actionAnswer'
      ? { ...base, enum: targetNames }
      : { ...base };
  }
  return Object.freeze({
    name: 'vote_response',
    schema: Object.freeze({
      type: 'object',
      properties: Object.freeze(properties),
      required: Object.freeze(getRequiredResponseTopLevelKeys(mode)),
      additionalProperties: false,
    }),
  });
}
