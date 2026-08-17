/**
 * 責務: 処刑対象が死亡処理の直前に一度だけ残す公開遺言を登録・辞退する。
 * 変更ルール: 遺言は通常議論の発言回数・質問・回答・再議論へ接続しない。凍結中の処刑対象には遺言を許可せず、公開CO・能力結果だけ既存の公開主張規則を再利用し、処刑以外の死亡へ適用しない。
 */

import { getPlayer } from '../game/standardRules.js';
import { createEvent } from '../events/eventStore.js';
import { rebuildPublicDerivedState } from '../events/publicDerivation.js';
import { resolvePublicClaimCommit } from '../claims/publicClaimCommitPolicy.js';
import { createSpeechOpportunitySnapshot } from '../discussion/discussionOpportunity.js';
import { assertAiPublicSpeechUnmodified } from '../policies/publicAbilityClaimNarrative.js';
import { applyInternalMemoryUpdate } from '../memory/memoryLedger.js';
import { nowIso } from '../../shared/utils.js';
import { getTestamentAvailability } from './testamentPolicy.js';
import {
  commandGuard,
  recordAiTurn,
  result,
  setHeartVoice,
} from '../game/gameRuntimeShared.js';

function pendingResolution(state, playerId) {
  const resolution = state.executionResolution;
  if (!resolution || resolution.status !== 'resolved') return { error: '先に処刑内容を解決してください。' };
  if (resolution.targetId !== playerId) return { error: '現在の処刑対象ではありません。' };
  const availability = getTestamentAvailability(state, playerId);
  if (availability.status === 'skipped') return { error: '凍結中のため遺言は残せません。' };
  if (resolution.testament?.status !== 'pending') return { error: '遺言はすでに完了しています。' };
  const player = getPlayer(state, playerId);
  if (!player?.alive) return { error: '処刑対象が不正です。' };
  return { resolution, player };
}

function recordTestamentCore(state, {
  sourceType,
  playerId,
  content,
  coOperation = null,
  abilityClaims = [],
  parsedAbilityClaims = null,
  heartVoice = '',
  internalMemoUpdate = null,
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  warnings = [],
} = {}) {
  const guard = commandGuard(state, { phases: ['execution'] });
  if (guard) return guard;
  const pending = pendingResolution(state, playerId);
  if (pending.error) return result(false, pending.error);
  const submittedText = String(content ?? '');
  if (!submittedText.trim()) return result(false, '遺言を入力するか、遺言なしを選択してください。');
  if (sourceType === 'ai') assertAiPublicSpeechUnmodified(submittedText, submittedText);

  const publicClaims = resolvePublicClaimCommit(state, { playerId, coOperation, abilityClaims });
  if (!publicClaims.ok) return result(false, publicClaims.errors.join('\n'));
  const interaction = { questionTargetIds: [], answersEventIds: [] };
  const opportunityContext = createSpeechOpportunitySnapshot(state, playerId);
  const event = createEvent(state, {
    type: 'public-speech',
    actorId: playerId,
    audience: { type: 'public', targetIds: [] },
    payload: {
      text: submittedText,
      pass: false,
      speechKind: 'testament',
      sourceQuestionEventId: null,
      round: state.discussion?.round ?? null,
      roundKind: state.discussion?.roundKind ?? 'normal',
      opportunityContext,
      structured: {
        coOperation: publicClaims.operation,
        interaction,
        abilityClaims: publicClaims.abilityClaims.map((claim) => ({ ...claim, evidenceEventIds: [...claim.evidenceEventIds] })),
      },
    },
    status: 'published',
  });

  let turn = null;
  if (sourceType === 'ai') {
    setHeartVoice(state, playerId, heartVoice);
    turn = recordAiTurn(state, {
      taskType: 'testament',
      playerId,
      promptText,
      promptFingerprint,
      promptMode,
      publicSequenceAtGeneration,
      rawResponse,
      generationRun,
      parsedPublicSpeech: submittedText,
      parsedSpeechInteraction: null,
      resolvedSpeechInteraction: interaction,
      parsedHeartVoice: heartVoice,
      parsedInternalMemoUpdate: internalMemoUpdate,
      parsedCoOperation: publicClaims.operation,
      parsedAbilityClaims: parsedAbilityClaims ?? null,
      resolvedAbilityClaims: publicClaims.abilityClaims,
      warnings,
      committedEntityIds: [
        event.id,
        ['declare', 'change'].includes(publicClaims.operation.action) ? `claim:${event.id}` : null,
        ...publicClaims.abilityClaims.map((claim, index) => `ability-claim:${event.id}:${index}`),
      ].filter(Boolean),
    });
    applyInternalMemoryUpdate(state, playerId, internalMemoUpdate, turn.id);
  }

  pending.resolution.testament = {
    status: 'completed',
    eventId: event.id,
    skippedReason: '',
    completedAt: nowIso(),
  };
  rebuildPublicDerivedState(state);
  return result(true, `${pending.player.name}の遺言を公開しました。`, { eventId: event.id, aiTurnId: turn?.id ?? null });
}

export function recordHumanTestament(state, input = {}) {
  return recordTestamentCore(state, { ...input, sourceType: 'human' });
}

export function recordAiTestament(state, input = {}) {
  return recordTestamentCore(state, { ...input, sourceType: 'ai' });
}

export function skipTestament(state, {
  playerId,
  reason = '遺言なし',
  heartVoice = '',
  internalMemoUpdate = null,
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  warnings = [],
} = {}) {
  const guard = commandGuard(state, { phases: ['execution'] });
  if (guard) return guard;
  const pending = pendingResolution(state, playerId);
  if (pending.error) return result(false, pending.error);
  const normalizedReason = String(reason ?? '').trim() || '遺言なし';
  let turn = null;
  if (rawResponse) {
    setHeartVoice(state, playerId, heartVoice);
    turn = recordAiTurn(state, {
      taskType: 'testament-fallback',
      playerId,
      promptText,
      promptFingerprint,
      promptMode,
      publicSequenceAtGeneration,
      rawResponse,
      generationRun,
      parsedPublicSpeech: '',
      parsedHeartVoice: heartVoice,
      parsedInternalMemoUpdate: internalMemoUpdate,
      warnings,
      committedEntityIds: [],
    });
    applyInternalMemoryUpdate(state, playerId, internalMemoUpdate, turn.id);
  }
  pending.resolution.testament = {
    status: 'skipped',
    eventId: null,
    skippedReason: normalizedReason,
    completedAt: nowIso(),
  };
  return result(true, `${pending.player.name}は遺言を残しませんでした。`, { aiTurnId: turn?.id ?? null });
}
