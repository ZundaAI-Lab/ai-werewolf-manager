/**
 * 責務: 役職CO・能力結果主張の派生状態とAIターンの解析・採用・監査情報を検査する。
 * 変更ルール: 公開イベントから再構築した値との意味一致と参照整合だけを検査し、オブジェクトのキー挿入順だけの差を不一致扱いしない。配列順は保持し、代替ターンへ通常生成本文の同一性を要求しない。
 */

import {
  MAX_FREEZE_ACTION_RATIONALE_LENGTH,
  MAX_NIGHT_ACTION_RATIONALE_LENGTH,
  MAX_RESULT_IMPRESSION_LENGTH,
  ROLE_IDS,
} from '../../config/constants.js';
import { isPersonalNightActionTask } from '../../config/personalNightActionTasks.js';
import {
  rebuildPlayerDecisionStates,
  rebuildPublicAbilityClaims,
  rebuildRoleClaims,
  validatePublicStructuredHistory,
} from '../../domain/events/publicDerivation.js';
import {
  PUBLIC_ABILITY_RESULTS,
  validatePublicAbilityClaim,
} from '../../domain/policies/publicAbilityClaimPolicy.js';
import { getFactionStrategyProfile } from '../../domain/roles/roleAttributes.js';
import { getFactionStrategyFields } from '../../domain/game/factionStrategyState.js';
import { stableStringify } from '../../shared/utils.js';

import {
  PUBLIC_ABILITY_ROLE_ID_SET,
  ABILITY_SELECTION_BASE_SET,
  CLAIM_STATUSES,
  ABILITY_STATUSES,
  WOLF_PARTNER_DISPOSITION_SET,
  validateDecisionMetadata,
  clone,
  isPlainObject,
  validateWolfSharedStrategyPatch,
} from './validatorShared.js';

export function validateDerivedAndAiState(context) {
  const { raw, label, errors, playerIds, playerIdSet, checkId, checkIds, events, eventIdSet, checkEventIds } = context;
  const activeClaimsByActor = new Map();
  (raw.claims ?? []).forEach((claim) => {
    checkId(claim.actorId, '役職CO話者');
    if (!ROLE_IDS.includes(claim.roleId)) errors.push(`${label}: 役職COの役職IDが不正です。`);
    if (!CLAIM_STATUSES.has(claim.status)) errors.push(`${label}: 役職CO状態が不正です。`);
    const source = events.find((event) => event.id === claim.sourceEventId);
    if (!source) errors.push(`${label}: 役職COの発言イベント参照先がありません。`);
    else if (claim.status === 'active' && source.status !== 'published') errors.push(`${label}: 無効な公開発言由来のCOがactiveです。`);
    if (claim.status === 'active') {
      if (activeClaimsByActor.has(claim.actorId)) errors.push(`${label}: 一人に複数の有効COがあります。`);
      activeClaimsByActor.set(claim.actorId, claim);
    }
  });

  const activeRoleAfterEvent = new Map();
  const replayedRoleByActor = new Map();
  events
    .filter((event) => event.type === 'public-speech' && event.audience?.type === 'public')
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0))
    .forEach((event) => {
      if (event.status === 'voided') return;
      const operation = event.payload?.structured?.coOperation ?? { action: 'none', roleId: 'none' };
      if (operation.action === 'declare' || operation.action === 'change') replayedRoleByActor.set(event.actorId, operation.roleId);
      else if (operation.action === 'withdraw') replayedRoleByActor.delete(event.actorId);
      activeRoleAfterEvent.set(event.id, replayedRoleByActor.get(event.actorId) ?? null);
    });

  (raw.publicAbilityClaims ?? []).forEach((claim) => {
    checkId(claim.actorId, '能力結果主張者');
    checkId(claim.targetId, '能力結果対象');
    if (!PUBLIC_ABILITY_ROLE_ID_SET.has(claim.claimedRoleId)) errors.push(`${label}: 能力結果主張の役職IDが不正です。`);
    if (!ABILITY_STATUSES.has(claim.status)) errors.push(`${label}: 能力結果主張の状態が不正です。`);
    const source = events.find((event) => event.id === claim.sourceEventId);
    if (!source) errors.push(`${label}: 能力結果主張の発言イベント参照先がありません。`);
    else if (claim.status === 'active' && source.status !== 'published') errors.push(`${label}: 無効な公開発言由来の能力結果がactiveです。`);
    if (!Number.isInteger(Number(claim.observedDay)) || Number(claim.observedDay) < 1 || Number(claim.observedDay) > Number(claim.announcedDay)) errors.push(`${label}: 能力結果主張の日付が不正です。`);
    if (!PUBLIC_ABILITY_RESULTS.includes(claim.result)) errors.push(`${label}: 能力結果主張のresultが不正です。`);
    if (!ABILITY_SELECTION_BASE_SET.has(claim.selectionBasis)) errors.push(`${label}: 能力結果主張のselectionBasisが不正です。`);
    checkEventIds(claim.evidenceEventIds, '能力結果主張の公開根拠イベント');
    if (typeof claim.selectionReasonAtTime !== 'string') errors.push(`${label}: 能力結果主張のselectionReasonAtTimeが文字列ではありません。`);
    if (!Number.isInteger(Number(claim.sourceClaimIndex)) || Number(claim.sourceClaimIndex) < 0) errors.push(`${label}: 能力結果主張のsourceClaimIndexが不正です。`);
    if (claim.status === 'active') {
      const roleAtSource = activeRoleAfterEvent.get(claim.sourceEventId) ?? null;
      validatePublicAbilityClaim(raw, {
        actorId: claim.actorId,
        claim,
        activeRoleId: roleAtSource,
        announcedDay: claim.announcedDay,
        excludeSourceEventId: claim.sourceEventId,
      }).forEach((message) => errors.push(`${label}: ${message}`));
    }
  });
  const abilityDayKeys = new Set();
  (raw.publicAbilityClaims ?? []).filter((claim) => claim.status === 'active').forEach((claim) => {
    const key = `${claim.actorId}:${claim.claimedRoleId}:${claim.observedDay}`;
    if (abilityDayKeys.has(key)) errors.push(`${label}: 同一人物・同一役職・同一Dayの能力結果主張が複数あります。`);
    abilityDayKeys.add(key);
  });

  validatePublicStructuredHistory(raw).forEach((message) => errors.push(`${label}: 公開構造化履歴: ${message}`));

  // 公開発言から再構築した派生状態と保存値が一致することを確認する。
  try {
    const derived = clone(raw);
    rebuildRoleClaims(derived);
    rebuildPublicAbilityClaims(derived);
    rebuildPlayerDecisionStates(derived);
    if (JSON.stringify(derived.claims) !== JSON.stringify(raw.claims ?? [])) errors.push(`${label}: claimsが有効な公開発言から再構築した内容と一致しません。`);
    if (JSON.stringify(derived.publicAbilityClaims) !== JSON.stringify(raw.publicAbilityClaims ?? [])) errors.push(`${label}: publicAbilityClaimsが有効な公開発言から再構築した内容と一致しません。`);
    raw.players.forEach((player, index) => {
      if (stableStringify(derived.players[index]?.decisionState) !== stableStringify(player.decisionState)) errors.push(`${label}: ${player.name}の判断状態がイベント履歴から再構築した内容と一致しません。`);
    });
  } catch (error) {
    errors.push(`${label}: 公開派生状態を再構築できませんでした: ${error.message}`);
  }

  (raw.aiTurns ?? []).forEach((turn) => {
    checkId(turn.playerId, 'AIターン対象');
    validateWolfSharedStrategyPatch(
      turn.parsedSharedStrategyUpdate,
      `${label}: AIターン${turn.id ?? '不明'}の解析済み共有作戦更新`,
      errors,
    );
    if (turn.parsedDecisionUpdate) {
      if (!['keep', 'patch'].includes(String(turn.parsedDecisionUpdate.mode ?? ''))) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み判断更新modeが不正です。`);
      if (!turn.parsedDecisionUpdate.changes || typeof turn.parsedDecisionUpdate.changes !== 'object' || Array.isArray(turn.parsedDecisionUpdate.changes)) {
        errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み判断更新changesが不正です。`);
      } else {
        if (Object.hasOwn(turn.parsedDecisionUpdate.changes, 'suspicionCandidateNames') && !Array.isArray(turn.parsedDecisionUpdate.changes.suspicionCandidateNames)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み疑い候補名が配列ではありません。`);
        if (Object.hasOwn(turn.parsedDecisionUpdate.changes, 'executionCandidateNames') && !Array.isArray(turn.parsedDecisionUpdate.changes.executionCandidateNames)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み処刑価値候補名が配列ではありません。`);
      }
      const grounding = turn.parsedDecisionUpdate.grounding;
      if (grounding !== null && grounding !== undefined) {
        const groundingKeys = new Set(['correctedSpeechSequences', 'evidenceEventSequences']);
        const invalidGroundingObject = !isPlainObject(grounding);
        const invalidGroundingKey = !invalidGroundingObject
          && Object.keys(grounding).some((key) => !groundingKeys.has(key));
        const invalidGroundingRefs = !invalidGroundingObject
          && [...groundingKeys].some((key) => (
            Object.hasOwn(grounding, key)
            && (!Array.isArray(grounding[key]) || grounding[key].some((sequence) => !Number.isInteger(sequence) || sequence < 1))
          ));
        if (invalidGroundingObject || invalidGroundingKey || invalidGroundingRefs) {
          errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み判断根拠が不正です。`);
        }
      }
    }
    checkIds(turn.resolvedDecisionUpdate?.suspicionCandidateIds, 'AIターンの解決済み疑い候補');
    checkIds(turn.resolvedDecisionUpdate?.executionCandidateIds, 'AIターンの解決済み処刑価値候補');
    checkId(turn.resolvedDecisionUpdate?.intendedVoteId, 'AIターンの解決済み投票予定', { allowAbstain: true });
    (turn.resolvedDecisionUpdate?.keyPublicEvidenceEventIds ?? []).forEach((eventId) => {
      if (!(raw.events ?? []).some((event) => event.id === eventId && event.status === 'published' && event.audience?.type === 'public')) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解決済み判断根拠イベントが不正です。`);
    });
    if (turn.resolvedDecisionUpdate) validateDecisionMetadata(turn.resolvedDecisionUpdate, `${label}: AIターン${turn.id ?? '不明'}の解決済み判断更新`, errors);
    const turnPlayer = raw.players.find((player) => player.id === turn.playerId);
    const turnStrategyProfile = getFactionStrategyProfile(raw, turnPlayer);
    if (turn.parsedFactionStrategyUpdate) {
      const parsedStrategyMode = String(turn.parsedFactionStrategyUpdate.mode ?? '');
      const parsedStrategyChanges = turn.parsedFactionStrategyUpdate.changes;
      if (!['keep', 'patch'].includes(parsedStrategyMode)) {
        errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み陣営戦略modeが不正です。`);
      }
      if (!parsedStrategyChanges || typeof parsedStrategyChanges !== 'object' || Array.isArray(parsedStrategyChanges)) {
        errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み陣営戦略changesが不正です。`);
      } else {
        if (parsedStrategyMode === 'keep' && Object.keys(parsedStrategyChanges).length) {
          errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み陣営戦略keepに変更項目があります。`);
        }
        if (parsedStrategyMode === 'patch' && !Object.keys(parsedStrategyChanges).length) {
          errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み陣営戦略patchに変更項目がありません。`);
        }
        Object.entries(parsedStrategyChanges).forEach(([key, value]) => {
          if (!getFactionStrategyFields(turnStrategyProfile).includes(key) || typeof value !== 'string') errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み陣営戦略${key}が不正です。`);
        });
      }
    }
    if (turn.resolvedFactionStrategyUpdate) {
      if (turn.resolvedFactionStrategyUpdate.profile !== turnStrategyProfile) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解決済み陣営戦略プロフィールが対象プレイヤーと一致しません。`);
      getFactionStrategyFields(turnStrategyProfile).forEach((key) => {
        if (key === 'partnerDisposition') {
          const disposition = String(turn.resolvedFactionStrategyUpdate[key] ?? '');
          if (disposition && !WOLF_PARTNER_DISPOSITION_SET.has(disposition)) {
            errors.push(`${label}: AIターン${turn.id ?? '不明'}の解決済み陣営戦略${key}が不正です。`);
          }
        } else if (typeof (turn.resolvedFactionStrategyUpdate[key] ?? '') !== 'string') {
          errors.push(`${label}: AIターン${turn.id ?? '不明'}の解決済み陣営戦略${key}が文字列ではありません。`);
        }
      });
    }
    if ((turn.parsedFactionStrategyUpdate || turn.resolvedFactionStrategyUpdate) && !turnStrategyProfile) {
      errors.push(`${label}: AIターン${turn.id ?? '不明'}の村人陣営応答に陣営戦略が含まれています。`);
    }
    if (turn.parsedAttackAssessment) {
      ['hunterSurvivalLikelihood', 'hunterSurvivalReason', 'selectedTargetGuardRisk', 'selectedTargetValue', 'selectedTargetFailureCost', 'alternativeTargetName', 'alternativeTargetGuardRisk', 'alternativeTargetValue', 'selectionDifference'].forEach((key) => {
        if (typeof (turn.parsedAttackAssessment?.[key] ?? '') !== 'string') errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み襲撃判断${key}が文字列ではありません。`);
      });
      if (turn.parsedAttackAssessment.hunterSurvivalLikelihood
        && !['low', 'medium', 'high'].includes(turn.parsedAttackAssessment.hunterSurvivalLikelihood)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み狩人生存可能性が不正です。`);
      if (turn.parsedAttackAssessment.selectedTargetGuardRisk
        && !['low', 'medium', 'high'].includes(turn.parsedAttackAssessment.selectedTargetGuardRisk)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み選択対象護衛リスクが不正です。`);
      if (turn.parsedAttackAssessment.alternativeTargetGuardRisk
        && !['low', 'medium', 'high'].includes(turn.parsedAttackAssessment.alternativeTargetGuardRisk)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み別候補護衛リスクが不正です。`);
    }
    if (turn.resolvedAttackAssessment) {
      checkId(turn.resolvedAttackAssessment.alternativeTargetId, 'AIターンの襲撃別候補');
      ['hunterSurvivalLikelihood', 'hunterSurvivalReason', 'selectedTargetGuardRisk', 'selectedTargetValue', 'selectedTargetFailureCost', 'alternativeTargetGuardRisk', 'alternativeTargetValue', 'selectionDifference'].forEach((key) => {
        if (typeof (turn.resolvedAttackAssessment?.[key] ?? '') !== 'string') errors.push(`${label}: AIターン${turn.id ?? '不明'}の解決済み襲撃判断${key}が文字列ではありません。`);
      });
      if (turn.resolvedAttackAssessment.hunterSurvivalLikelihood
        && !['low', 'medium', 'high'].includes(turn.resolvedAttackAssessment.hunterSurvivalLikelihood)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解決済み狩人生存可能性が不正です。`);
      if (turn.resolvedAttackAssessment.selectedTargetGuardRisk
        && !['low', 'medium', 'high'].includes(turn.resolvedAttackAssessment.selectedTargetGuardRisk)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解決済み選択対象護衛リスクが不正です。`);
      if (turn.resolvedAttackAssessment.alternativeTargetGuardRisk
        && !['low', 'medium', 'high'].includes(turn.resolvedAttackAssessment.alternativeTargetGuardRisk)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解決済み別候補護衛リスクが不正です。`);
    }
    if (!Array.isArray(turn.estimatedWerewolfIds)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の推定人狼IDが配列ではありません。`);
    if (!Array.isArray(turn.predictedAttackTargetIds)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の予想襲撃先IDが配列ではありません。`);
    if (turn.taskType === 'freeze') {
      [...(turn.estimatedWerewolfIds ?? []), ...(turn.predictedAttackTargetIds ?? [])].forEach((id) => checkId(id, 'AIターンの雪女戦術候補'));
      if (new Set(turn.estimatedWerewolfIds ?? []).size !== (turn.estimatedWerewolfIds?.length ?? 0)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の推定人狼IDが重複しています。`);
      if (new Set(turn.predictedAttackTargetIds ?? []).size !== (turn.predictedAttackTargetIds?.length ?? 0)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の予想襲撃先IDが重複しています。`);
    } else if ((turn.estimatedWerewolfIds?.length ?? 0) || (turn.predictedAttackTargetIds?.length ?? 0)) {
      errors.push(`${label}: AIターン${turn.id ?? '不明'}の凍結以外の応答に雪女戦術候補が含まれています。`);
    }
    if (turn.parsedAbilityClaims) {
      if (!Array.isArray(turn.parsedAbilityClaims.claims)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み能力履歴が配列ではありません。`);
      (turn.parsedAbilityClaims.claims ?? []).forEach((claim, index) => {
        if (typeof claim.targetName !== 'string') errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み能力履歴${index + 1}対象名が文字列ではありません。`);
        if (!PUBLIC_ABILITY_RESULTS.includes(claim.result)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み能力履歴${index + 1}結果が不正です。`);
        if (claim.roleId !== 'medium' && !ABILITY_SELECTION_BASE_SET.has(claim.selectionBasis)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解析済み能力履歴${index + 1}selectionBasisが不正です。`);
      });
    }
    if (!Array.isArray(turn.resolvedAbilityClaims)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解決済み能力履歴が配列ではありません。`);
    (turn.resolvedAbilityClaims ?? []).forEach((claim, index) => {
      checkId(claim.targetId, `AIターンの解決済み能力履歴${index + 1}対象`);
      checkEventIds(claim.evidenceEventIds, `AIターンの解決済み能力履歴${index + 1}根拠イベント`);
      if (!PUBLIC_ABILITY_RESULTS.includes(claim.result)) errors.push(`${label}: AIターン${turn.id ?? '不明'}の解決済み能力履歴${index + 1}結果が不正です。`);
    });
    if (isPersonalNightActionTask(turn.taskType) || turn.taskType === 'wolf-attack') {
      const rationale = String(turn.parsedActionRationale ?? '').trim();
      const rationaleLimit = turn.taskType === 'freeze'
        ? MAX_FREEZE_ACTION_RATIONALE_LENGTH
        : MAX_NIGHT_ACTION_RATIONALE_LENGTH;
      if (rationale && rationale.length > rationaleLimit) errors.push(`${label}: AIターン${turn.id ?? '不明'}の夜行動選択理由が長すぎます。`);
    }
    if (turn.parsedInternalMemoUpdate) {
      if (turn.parsedInternalMemoUpdate.mode !== 'add') errors.push(`${label}: AIターン${turn.id ?? '不明'}の内部メモ更新modeが不正です。`);
      if (typeof turn.parsedInternalMemoUpdate.text !== 'string') errors.push(`${label}: AIターン${turn.id ?? '不明'}の内部メモ更新textが不正です。`);
    }
    if (turn.taskType === 'memo-consolidate' && !String(turn.parsedConsolidatedMemo ?? '').trim()) {
      errors.push(`${label}: AIターン${turn.id ?? '不明'}の整理後内部メモがありません。`);
    }
    if (turn.taskType === 'memo-consolidate-fallback' && String(turn.parsedConsolidatedMemo ?? '').trim()) {
      errors.push(`${label}: AIターン${turn.id ?? '不明'}の内部メモ整理スキップに整理本文を設定できません。`);
    }
    if (turn.taskType === 'result-impression') {
      const text = String(turn.parsedPublicSpeech ?? '').trim();
      if (!text) errors.push(`${label}: AIターン${turn.id ?? '不明'}に勝敗後感想の公開発言がありません。`);
      if (text.length > MAX_RESULT_IMPRESSION_LENGTH) errors.push(`${label}: AIターン${turn.id ?? '不明'}の勝敗後感想が長すぎます。`);
    }
    if (!String(turn.runtimeBuildId ?? '').trim()) errors.push(`${label}: AIターン${turn.id ?? '不明'}にビルドIDがありません。`);
    if (!Number.isInteger(turn.promptSpecVersion) || turn.promptSpecVersion < 1) errors.push(`${label}: AIターン${turn.id ?? '不明'}のプロンプト仕様番号が不正です。`);
  });
}
