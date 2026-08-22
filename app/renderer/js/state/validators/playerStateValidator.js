/**
 * 責務: プレイヤー、役職固有状態、状態異常、内部記憶、判断・陣営戦略、キャラクター、呼称スナップショットを検査する。
 * 変更ルール: 本人状態と参照整合だけを検査し、公開イベントや進行状態の意味検査を混在させない。
 */

import {
  PHASES,
  REASONING_PROFILE_OPTION_LABELS,
  ROLE_IDS,
} from '../../config/constants.js';
import { isPublicSpeechLengthOption } from '../../domain/policies/publicSpeechLengthPolicy.js';
import {
  getFactionStrategyProfile,
  getPlayerTeam,
  isBadChild,
} from '../../domain/roles/roleAttributes.js';
import {
  getFactionStrategyFields,
  validateFactionStrategyState,
} from '../../domain/game/factionStrategyState.js';
import { CALL_NAME_SNAPSHOT_SCHEMA_VERSION } from '../../characters/catalog/characterCatalog.js';
import { CHARACTER_CARD_BY_ID } from '../../characters/cards/characterCards.js';
import {
  validateCallName,
  validatePlayerAlias,
  validatePlayerDisplayName,
} from '../../domain/policies/playerIdentityPolicy.js';

import {
  DECISION_ASSESSMENT_LEVEL_SET,
  validateStoredEntityId,
  validateDecisionMetadata,
} from './validatorShared.js';

export function validatePlayerState(context) {
  const { raw, label, errors, playerIds, playerIdSet, checkId, checkIds } = context;
  const characterCardIds = [];
  const normalizedPlayerNames = [];
  raw.players.forEach((player, index) => {
    const name = player.name || `players[${index}]`;
    const displayValidation = validatePlayerDisplayName(player.name);
    displayValidation.errors.forEach((message) => errors.push(`${label}: players[${index}]: ${message}`));
    const normalizedName = String(player.name ?? '').trim();
    if (normalizedName) normalizedPlayerNames.push(normalizedName);
    if (!Array.isArray(player.aliases)) {
      errors.push(`${label}: ${name}の別名が配列ではありません。`);
    } else {
      player.aliases.forEach((alias, aliasIndex) => {
        const aliasValidation = validatePlayerAlias(alias);
        aliasValidation.errors.forEach((message) => errors.push(`${label}: ${name}の別名[${aliasIndex}]: ${message}`));
      });
      if (new Set(player.aliases.map((alias) => String(alias).trim())).size !== player.aliases.length) {
        errors.push(`${label}: ${name}の別名が重複しています。`);
      }
    }
    if (!player.id) errors.push(`${label}: ${name}にIDがありません。`);
    if (!ROLE_IDS.includes(player.roleId)) errors.push(`${label}: ${name}の役職IDが不正です。`);
    if (player.roleId === 'namahage') {
      checkId(player.roleState?.lastTargetId, `${name}の直前訪問対象`);
      if (player.roleState?.lastTargetId === player.id) errors.push(`${label}: ${name}の直前訪問対象が自分自身です。`);
    } else if (player.roleId === 'snowWoman') {
      checkId(player.roleState?.lastTargetId, `${name}の直前凍結対象`);
      if (player.roleState?.lastTargetId === player.id) errors.push(`${label}: ${name}の直前凍結対象が自分自身です。`);
    } else if (player.roleId === 'zashikiWarashi') {
      const roleState = player.roleState;
      checkId(roleState?.ownerId, `${name}の家主`);
      if (roleState?.ownerId === player.id) errors.push(`${label}: ${name}が自分自身を家主にしています。`);
      if (roleState?.ownerId) {
        const owner = raw.players.find((item) => item.id === roleState.ownerId);
        if (roleState.ownerRoleId !== owner?.roleId) errors.push(`${label}: ${name}の記録した家主役職が実役職と一致しません。`);
        if (roleState.resolvedTeam !== getPlayerTeam(raw, owner)) errors.push(`${label}: ${name}の確定陣営が家主の陣営と一致しません。`);
      } else if (roleState?.ownerRoleId !== null || roleState?.resolvedTeam !== null) {
        errors.push(`${label}: ${name}の家主未決定状態に役職または陣営が残っています。`);
      }
    } else if (player.roleState !== null) {
      errors.push(`${label}: ${name}の役職に不要な役職固有状態があります。`);
    }
    let fearEffectCount = 0;
    (player.statusEffects ?? []).forEach((effect, effectIndex) => {
      if (!['frozen', 'fear'].includes(effect.type)) {
        errors.push(`${label}: ${name}の状態異常[${effectIndex}]種別が不正です。`);
        return;
      }
      if (!Number.isInteger(Number(effect.day)) || Number(effect.day) < 1) errors.push(`${label}: ${name}の状態異常Dayが不正です。`);
      checkId(effect.sourcePlayerId, `${name}の状態異常付与元`);
      const source = raw.players.find((item) => item.id === effect.sourcePlayerId);
      if (effect.type === 'frozen' && source && source.roleId !== 'snowWoman') {
        errors.push(`${label}: ${name}の凍結元が雪女ではありません。`);
      }
      if (effect.type === 'fear') {
        fearEffectCount += 1;
        if (source && source.roleId !== 'namahage') errors.push(`${label}: ${name}の恐怖付与元がなまはげではありません。`);
        if (!isBadChild(raw, player)) errors.push(`${label}: 悪い子ではない${name}に恐怖状態があります。`);
      }
    });
    if (fearEffectCount > 1) errors.push(`${label}: ${name}の恐怖状態が重複しています。`);
    if (!['ai', 'human'].includes(player.controller)) errors.push(`${label}: ${name}の操作種別が不正です。`);
    if (typeof player.alive !== 'boolean') errors.push(`${label}: ${name}の生存状態が真偽値ではありません。`);
    if (player.alive === true && player.death !== null) errors.push(`${label}: ${name}は生存中ですが死亡情報があります。`);
    if (player.alive === false) {
      if (!player.death) errors.push(`${label}: ${name}は死亡中ですが死亡情報がありません。`);
      else {
        if (!Number.isInteger(Number(player.death.day)) || Number(player.death.day) < 0) errors.push(`${label}: ${name}の死亡Dayが不正です。`);
        if (!['execution', 'dawn'].includes(player.death.phase)) errors.push(`${label}: ${name}の死亡フェーズが不正です。`);
        if (!['execution', 'wolf-attack', 'fox-divination', 'cat-revenge', 'owner-follow'].includes(player.death.cause)) errors.push(`${label}: ${name}の死因が不正です。`);
      }
    }
    if (typeof player.heartVoice !== 'string') errors.push(`${label}: ${name}の心の声が文字列ではありません。`);
    if (!Array.isArray(player.heartVoiceHistory)) errors.push(`${label}: ${name}の心の声履歴が配列ではありません。`);
    if (!player.internalMemory || typeof player.internalMemory !== 'object') {
      errors.push(`${label}: ${name}の自由内部メモがありません。`);
    } else {
      if (typeof player.internalMemory.summary !== 'string') errors.push(`${label}: ${name}の内部メモ要約が文字列ではありません。`);
      if (!Array.isArray(player.internalMemory.notes)) errors.push(`${label}: ${name}の内部メモ追記が配列ではありません。`);
      else player.internalMemory.notes.forEach((note, noteIndex) => {
        validateStoredEntityId(note?.id, `${label}: ${name}の内部メモ追記[${noteIndex}].id`, errors);
        if (!note?.id || typeof note.text !== 'string' || !String(note.text).trim()) errors.push(`${label}: ${name}の内部メモ追記[${noteIndex}]が不正です。`);
        if (note.sourceAiTurnId && !(raw.aiTurns ?? []).some((turn) => turn.id === note.sourceAiTurnId)) {
          errors.push(`${label}: ${name}の内部メモ追記[${noteIndex}]が存在しないAIターンを参照しています。`);
        }
      });
      if (player.internalMemory.lastConsolidatedAt !== null && typeof player.internalMemory.lastConsolidatedAt !== 'string') errors.push(`${label}: ${name}の内部メモ最終整理時刻が不正です。`);
      if (typeof player.internalMemory.consolidationRecommended !== 'boolean') errors.push(`${label}: ${name}の内部メモ整理推奨状態が不正です。`);
    }
    if (!Array.isArray(player.memoHistory)) {
      errors.push(`${label}: ${name}の内部メモ整理履歴が配列ではありません。`);
    } else {
      player.memoHistory.forEach((history, historyIndex) => {
        if (typeof history?.summary !== 'string' || !Array.isArray(history?.notes)) errors.push(`${label}: ${name}の内部メモ整理履歴[${historyIndex}]が不正です。`);
        (history?.notes ?? []).forEach((note, noteIndex) => {
          validateStoredEntityId(note?.id, `${label}: ${name}の内部メモ整理履歴[${historyIndex}]の追記[${noteIndex}].id`, errors);
          if (!note?.id || typeof note.text !== 'string' || !String(note.text).trim()) errors.push(`${label}: ${name}の内部メモ整理履歴[${historyIndex}]の追記[${noteIndex}]が不正です。`);
        });
        if (!['ai', 'gm'].includes(history?.source)) errors.push(`${label}: ${name}の内部メモ整理履歴[${historyIndex}]の整理元が不正です。`);
        if (history?.sourceAiTurnId && !(raw.aiTurns ?? []).some((turn) => turn.id === history.sourceAiTurnId)) errors.push(`${label}: ${name}の内部メモ整理履歴[${historyIndex}]が存在しないAIターンを参照しています。`);
      });
    }
    if (!player.memoryLedger || typeof player.memoryLedger !== 'object') {
      errors.push(`${label}: ${name}のシステム記憶台帳がありません。`);
    } else {
      ['privateFacts', 'publicCommitments', 'selectionRationales', 'pendingDiscriminators'].forEach((key) => {
        if (!Array.isArray(player.memoryLedger[key])) errors.push(`${label}: ${name}の記憶台帳${key}が配列ではありません。`);
      });
      ['privateFacts', 'publicCommitments', 'pendingDiscriminators'].forEach((key) => {
        (player.memoryLedger[key] ?? []).forEach((item, itemIndex) => {
          validateStoredEntityId(item?.id, `${label}: ${name}の記憶台帳${key}[${itemIndex}].id`, errors);
          if (!item?.id || typeof item.text !== 'string' || !String(item.text).trim()) errors.push(`${label}: ${name}の記憶台帳${key}[${itemIndex}]が不正です。`);
          if (item?.sourceEventId && !(raw.events ?? []).some((event) => event.id === item.sourceEventId)) errors.push(`${label}: ${name}の記憶台帳${key}[${itemIndex}]が存在しないイベントを参照しています。`);
        });
      });
      (player.memoryLedger.selectionRationales ?? []).forEach((item, itemIndex) => {
        validateStoredEntityId(item?.id, `${label}: ${name}の行動理由[${itemIndex}].id`, errors);
        if (!item?.id || typeof item.rationale !== 'string' || !String(item.rationale).trim()) errors.push(`${label}: ${name}の行動理由[${itemIndex}]が不正です。`);
        checkId(item?.targetId, `${name}の行動理由対象`);
        if (item?.sourceEventId && !(raw.events ?? []).some((event) => event.id === item.sourceEventId)) errors.push(`${label}: ${name}の行動理由[${itemIndex}]が存在しないイベントを参照しています。`);
        if (item?.sourceAiTurnId && !(raw.aiTurns ?? []).some((turn) => turn.id === item.sourceAiTurnId)) errors.push(`${label}: ${name}の行動理由[${itemIndex}]が存在しないAIターンを参照しています。`);
        if (typeof item?.taskType !== 'string' || !String(item.taskType).trim()) errors.push(`${label}: ${name}の行動理由[${itemIndex}]のタスク種別が不正です。`);
        if (!Number.isInteger(Number(item?.day)) || Number(item.day) < 0) errors.push(`${label}: ${name}の行動理由[${itemIndex}]のDayが不正です。`);
        if (item?.phase !== null && item?.phase !== undefined && (typeof item.phase !== 'string' || !String(item.phase).trim())) errors.push(`${label}: ${name}の行動理由[${itemIndex}]のフェーズが不正です。`);
      });
      if (player.memoryLedger.updatedAt !== null && typeof player.memoryLedger.updatedAt !== 'string') errors.push(`${label}: ${name}の記憶台帳更新時刻が不正です。`);
    }
    checkIds(player.decisionState?.suspicionCandidateIds, `${name}の疑い候補`);
    checkIds(player.decisionState?.executionCandidateIds, `${name}の処刑価値候補`);
    checkId(player.decisionState?.intendedVoteId, `${name}の投票予定`, { allowAbstain: true });
    (player.decisionState?.keyPublicEvidenceEventIds ?? []).forEach((eventId) => {
      if (!(raw.events ?? []).some((event) => event.id === eventId && event.status === 'published' && event.audience?.type === 'public')) {
        errors.push(`${label}: ${name}の判断根拠が参照不能な公開イベントを指しています: ${eventId}`);
      }
    });
    if (!DECISION_ASSESSMENT_LEVEL_SET.has(player.decisionState?.assessmentLevel ?? 'unresolved')) errors.push(`${label}: ${name}の判断段階が不正です。`);
    ['leaveAliveBenefit', 'misexecutionCost', 'selectionDifference', 'uncertainty', 'nextDiscriminatingInformation'].forEach((key) => {
      if (typeof (player.decisionState?.[key] ?? '') !== 'string') errors.push(`${label}: ${name}の判断状態${key}が文字列ではありません。`);
    });
    if (player.decisionState?.sourceDay !== null && (
      !Number.isInteger(player.decisionState?.sourceDay)
      || Number(player.decisionState.sourceDay) < 0
    )) {
      errors.push(`${label}: ${name}の判断状態sourceDayが不正です。`);
    }
    validateDecisionMetadata(player.decisionState, `${label}: ${name}の判断状態`, errors, { allowUninitialized: true });
    const strategyProfile = getFactionStrategyProfile(raw, player);
    if (strategyProfile) {
      const strategy = player.factionStrategyState;
      if (!strategy || typeof strategy !== 'object' || Array.isArray(strategy)) {
        errors.push(`${label}: ${name}の本人限定陣営戦略状態がありません。`);
      } else {
        if (strategy.profile !== strategyProfile) errors.push(`${label}: ${name}の陣営戦略プロフィールが現在の属性と一致しません。`);
        const strategyFields = getFactionStrategyFields(strategyProfile);
        strategyFields.forEach((key) => {
          if (typeof strategy[key] !== 'string') errors.push(`${label}: ${name}の陣営戦略${key}が文字列ではありません。`);
        });
        if (strategy.updatedAt === null) {
          if (strategyFields.some((key) => String(strategy[key] ?? '').trim())) {
            errors.push(`${label}: ${name}の未更新陣営戦略状態に内容が残っています。`);
          }
          if (strategy.sourceAiTurnId !== null) errors.push(`${label}: ${name}の未更新陣営戦略状態にAIターン参照があります。`);
        } else {
          if (typeof strategy.updatedAt !== 'string') errors.push(`${label}: ${name}の陣営戦略更新時刻が不正です。`);
          validateFactionStrategyState(strategy, strategyProfile, { allowPartial: true, requiredFields: [], requireSubstantive: false }).forEach((message) => errors.push(`${label}: ${name}: ${message}`));
          if (!strategy.sourceAiTurnId || !(raw.aiTurns ?? []).some((turn) => turn.id === strategy.sourceAiTurnId)) {
            errors.push(`${label}: ${name}の陣営戦略が存在しないAIターンを参照しています。`);
          }
        }
      }
    } else if (player.factionStrategyState !== null) {
      errors.push(`${label}: ${name}の陣営戦略対象外属性に陣営戦略状態が残っています。`);
    }
    const characterTextKeys = [
      'profile',
      'firstPerson',
      'genericSecondPerson',
      'speakingStyle',
      'defaultEndings',
      'avoidedExpressions',
      'speechExamples',
      'discussionBehavior',
    ];
    characterTextKeys.forEach((key) => {
      if (typeof player.character?.[key] !== 'string') {
        errors.push(`${label}: ${name}のキャラクター設定${key}が文字列ではありません。`);
      }
    });
    if (!isPublicSpeechLengthOption(player.character?.speechLength)) errors.push(`${label}: ${name}の発言量区分が不正です。`);
    if (player.character?.conversationSeeds !== undefined) {
      if (!Array.isArray(player.character.conversationSeeds)) {
        errors.push(`${label}: ${name}の会話のきっかけが配列ではありません。`);
      } else {
        const seedIds = [];
        player.character.conversationSeeds.forEach((seed, seedIndex) => {
          const seedLabel = `${label}: ${name}の会話のきっかけ[${seedIndex}]`;
          const id = String(seed?.id ?? '').trim();
          if (!seed || typeof seed !== 'object' || Array.isArray(seed) || !id || !String(seed.subject ?? '').trim() || !String(seed.tone ?? '').trim()) {
            errors.push(`${seedLabel}が不正です。`);
          }
          if (id) seedIds.push(id);
        });
        if (new Set(seedIds).size !== seedIds.length) errors.push(`${label}: ${name}の会話のきっかけIDが重複しています。`);
      }
    }
    const reasoningProfile = player.character?.reasoningProfile;
    if (!reasoningProfile || typeof reasoningProfile !== 'object' || Array.isArray(reasoningProfile)) {
      errors.push(`${label}: ${name}の推理傾向がありません。`);
    } else {
      Object.entries(REASONING_PROFILE_OPTION_LABELS).forEach(([key, options]) => {
        if (!Object.hasOwn(options, reasoningProfile[key])) errors.push(`${label}: ${name}の推理傾向${key}が不正です。`);
      });
    }
    if (player.characterCardId) {
      characterCardIds.push(player.characterCardId);
      if (!CHARACTER_CARD_BY_ID.has(player.characterCardId)) errors.push(`${label}: ${name}のキャラクターカードIDが不正です。`);
    }
    if (!player.callNameOverrides || typeof player.callNameOverrides !== 'object' || Array.isArray(player.callNameOverrides)) {
      errors.push(`${label}: ${name}の相手別呼称上書きが不正です。`);
    } else {
      Object.entries(player.callNameOverrides).forEach(([targetPlayerId, entry]) => {
        if (!playerIdSet.has(targetPlayerId) || targetPlayerId === player.id) {
          errors.push(`${label}: ${name}の相手別呼称上書き対象が不正です: ${targetPlayerId}`);
        }
        if (typeof entry !== 'string' || !entry.trim()) {
          errors.push(`${label}: ${name}の相手別呼称上書き${targetPlayerId}が不正です。`);
        } else {
          validateCallName(entry).errors.forEach((message) => {
            errors.push(`${label}: ${name}の相手別呼称上書き${targetPlayerId}: ${message}`);
          });
        }
      });
    }
  });
  if (new Set(normalizedPlayerNames).size !== normalizedPlayerNames.length) errors.push(`${label}: プレイヤー名が重複しています。`);
  if (new Set(characterCardIds).size !== characterCardIds.length) errors.push(`${label}: キャラクターカードが重複しています。`);
  const callNamesEnabled = raw.game.rules?.callNames?.enabled !== false;
  const callNameSnapshot = raw.game.callNameSnapshot;
  if (callNamesEnabled && raw.game.status !== 'setup' && !callNameSnapshot) {
    errors.push(`${label}: 開始済みゲームに相手別呼称スナップショットがありません。`);
  }
  if (callNameSnapshot !== null && callNameSnapshot !== undefined) {
    if (!callNameSnapshot || typeof callNameSnapshot !== 'object' || Array.isArray(callNameSnapshot)) {
      errors.push(`${label}: 相手別呼称スナップショットが不正です。`);
    } else {
      if (callNameSnapshot.schemaVersion !== CALL_NAME_SNAPSHOT_SCHEMA_VERSION) errors.push(`${label}: 相手別呼称スナップショットのスキーマが不正です。`);
      if (typeof callNameSnapshot.enabled !== 'boolean') errors.push(`${label}: 相手別呼称スナップショットの有効状態が不正です。`);
      if (!callNameSnapshot.bySpeakerId || typeof callNameSnapshot.bySpeakerId !== 'object' || Array.isArray(callNameSnapshot.bySpeakerId)) {
        errors.push(`${label}: 相手別呼称スナップショットの話者辞書が不正です。`);
      } else {
        playerIds.forEach((speakerId) => {
          const map = callNameSnapshot.bySpeakerId[speakerId];
          if (!map || typeof map !== 'object' || Array.isArray(map)) {
            errors.push(`${label}: ${speakerId}の相手別呼称辞書がありません。`);
            return;
          }
          if (Object.hasOwn(map, speakerId)) errors.push(`${label}: 相手別呼称に自己参照があります: ${speakerId}`);
          playerIds.filter((targetId) => targetId !== speakerId).forEach((targetId) => {
            const entry = map[targetId];
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
              errors.push(`${label}: ${speakerId}から${targetId}への呼称がありません。`);
              return;
            }
            if (!String(entry.preferred ?? '').trim()) errors.push(`${label}: ${speakerId}から${targetId}への優先呼称が空です。`);
            else validateCallName(entry.preferred).errors.forEach((message) => errors.push(`${label}: ${speakerId}から${targetId}への優先呼称: ${message}`));
            if (Object.hasOwn(entry, 'roleId') || Object.hasOwn(entry, 'team') || Object.hasOwn(entry, 'alive')) {
              errors.push(`${label}: 相手別呼称にゲーム秘密情報が混入しています。`);
            }
          });
          Object.keys(map).forEach((targetId) => {
            if (!playerIdSet.has(targetId)) errors.push(`${label}: 相手別呼称が存在しない対象を参照しています: ${targetId}`);
          });
        });
        Object.keys(callNameSnapshot.bySpeakerId).forEach((speakerId) => {
          if (!playerIdSet.has(speakerId)) errors.push(`${label}: 相手別呼称が存在しない話者を参照しています: ${speakerId}`);
        });
      }
    }
  }
  if (!PHASES.includes(raw.game.phase)) errors.push(`${label}: 現在フェーズが不正です。`);
}
