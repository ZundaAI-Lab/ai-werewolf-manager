/**
 * 責務: ルート形状、スキーマ、ゲームルール、保存ID、参加人数、開始前プレイヤー別配役スナップショット、公開用役職構成を検査し、後続Validatorが共有する参照検査コンテキストを生成する。
 * 変更ルール: 入力補完や修正を行わず、致命的なルート欠落時だけ後続検査を停止する。
 */

import { MAX_PLAYER_COUNT, MIN_PLAYER_COUNT, ROLE_IDS, SCHEMA_VERSION } from '../../config/constants.js';
import { validateStateShape } from '../stateSchema.js';
import { validateGameRules } from '../../domain/game/gameRulePolicy.js';
import { validateRoleComposition } from '../../domain/roles/roleComposition.js';

import {
  validateStoredEntityId,
  validateStoredEntityIds,
} from './validatorShared.js';

export function createStateValidationContext(raw, label = 'ルート') {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: [`${label}: JSON状態がオブジェクトではありません。`], stop: true };
  if (raw.schemaVersion !== SCHEMA_VERSION) errors.push(`${label}: スキーマバージョン${SCHEMA_VERSION}のデータではありません。`);
  if (raw.runtime?.schemaVersion !== SCHEMA_VERSION) errors.push(`${label}: runtime.schemaVersionが${SCHEMA_VERSION}ではありません。`);
  if (!String(raw.runtime?.buildId ?? '').trim()) errors.push(`${label}: runtime.buildIdがありません。`);
  if (!raw.game || typeof raw.game !== 'object') errors.push(`${label}: gameがありません。`);
  if (!Array.isArray(raw.players)) errors.push(`${label}: playersが配列ではありません。`);
  if (errors.length) return { errors, stop: true };
  errors.push(...validateStateShape(raw, label));

  errors.push(...validateGameRules(raw.game.rules, { label: `${label}: game.rules` }));
  const voteRules = raw.game.rules?.vote ?? {};

  validateStoredEntityId(raw.game.id, `${label}: game.id`, errors);
  validateStoredEntityIds(raw.players, `${label}: players`, errors);

  const playerIds = raw.players.map((player) => player.id);
  const playerIdSet = new Set(playerIds);
  if (playerIdSet.size !== playerIds.length) errors.push(`${label}: プレイヤーIDが重複しています。`);
  if (raw.players.length < MIN_PLAYER_COUNT || raw.players.length > MAX_PLAYER_COUNT) {
    errors.push(`${label}: 参加人数は${MIN_PLAYER_COUNT}～${MAX_PLAYER_COUNT}人である必要があります。`);
  }

  if (raw.game.setupRoleAssignments !== null) {
    const assignments = raw.game.setupRoleAssignments;
    if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
      errors.push(`${label}: game.setupRoleAssignmentsがオブジェクトではありません。`);
    } else {
      const assignmentIds = Object.keys(assignments);
      playerIds.forEach((playerId) => {
        if (!Object.hasOwn(assignments, playerId)) errors.push(`${label}: game.setupRoleAssignmentsに${playerId}の開始前役職がありません。`);
      });
      assignmentIds.forEach((playerId) => {
        if (!playerIdSet.has(playerId)) errors.push(`${label}: game.setupRoleAssignmentsが存在しないプレイヤーを参照しています: ${playerId}`);
        if (!ROLE_IDS.includes(assignments[playerId])) errors.push(`${label}: game.setupRoleAssignments.${playerId}の役職IDが不正です。`);
      });
    }
  }
  if (raw.game.publicRoleComposition !== null) {
    errors.push(...validateRoleComposition(raw.game.publicRoleComposition, {
      playerCount: raw.players.length,
      label: `${label}: game.publicRoleComposition`,
    }));
  }
  const checkId = (id, referenceLabel, { allowAbstain = false } = {}) => {
    if (id === null || id === undefined || id === '') return;
    if (allowAbstain && id === 'abstain') return;
    if (!playerIdSet.has(id)) errors.push(`${label}: ${referenceLabel}が存在しないプレイヤーを参照しています: ${id}`);
  };
  const checkIds = (ids, referenceLabel, options) => {
    if (!Array.isArray(ids)) return;
    ids.forEach((id) => checkId(id, referenceLabel, options));
  };

  return { raw, label, errors, voteRules, playerIds, playerIdSet, checkId, checkIds, stop: false };
}
