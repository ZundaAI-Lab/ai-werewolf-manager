/**
 * 責務: speechInteractionの補助制御情報だけを、現在の公開状態から決定的に安全化する。
 * 変更ルール: publicSpeech本文は解析・変更しない。質問先・回答参照のうち現在利用不能なものだけを監査操作付きで除去し、他のAI生成結果は保持する。判断・能力主張など別責務の構造化情報は扱わない。
 */

import { canSpeakDuringDay } from '../../../domain/game/playerStatus.js';
import { isPublicQuestionAnswered, isPublicQuestionSkipped } from '../../../domain/discussion/publicQuestionResolution.js';
import { normalizeName } from '../../../shared/utils.js';
import { operation } from './jsonObjectRecovery.js';

const ALLOWED_KEYS = new Set(['questionTargets', 'answerToRefs']);

function exactPlayerByDisplayName(state, value) {
  const normalized = normalizeName(value);
  if (!normalized) return null;
  return (state?.players ?? []).find((player) => normalizeName(player.name) === normalized) ?? null;
}

function validAnswerEvent(state, actorId, sequence) {
  const event = (state?.events ?? []).find((item) => Number(item.sequence) === Number(sequence));
  if (!event || event.type !== 'public-speech' || event.status !== 'published') return false;
  if (event.actorId === actorId) return false;
  if (!(event.payload?.structured?.interaction?.questionTargetIds ?? []).includes(actorId)) return false;
  if (isPublicQuestionAnswered(state, event, actorId)) return false;
  if (isPublicQuestionSkipped(state, event, actorId)) return false;
  return true;
}

function repairQuestionTargets(state, playerId, interaction, operations) {
  if (!Object.hasOwn(interaction, 'questionTargets')) return;
  if (!Array.isArray(interaction.questionTargets)) {
    delete interaction.questionTargets;
    operation(operations, 'INVALID_SPEECH_CONTROL_DISCARDED', 'speechInteraction.questionTargets', 'questionTargetsが配列ではないため質問先制御だけを未指定扱いにしました。');
    return;
  }

  const seenIds = new Set();
  const kept = [];
  interaction.questionTargets.forEach((value, index) => {
    const target = exactPlayerByDisplayName(state, value);
    const valid = target
      && target.id !== playerId
      && canSpeakDuringDay(state, target.id)
      && !seenIds.has(target.id);
    if (!valid) {
      operation(operations, 'INVALID_SPEECH_CONTROL_DISCARDED', `speechInteraction.questionTargets[${index}]`, '現在利用できない個人質問先を除去し、publicSpeechを含む他のAI生成結果を保持しました。');
      return;
    }
    seenIds.add(target.id);
    kept.push(String(value));
  });
  interaction.questionTargets = kept;
}

function repairAnswerRefs(state, playerId, interaction, operations) {
  if (!Object.hasOwn(interaction, 'answerToRefs')) return;
  if (!Array.isArray(interaction.answerToRefs)) {
    delete interaction.answerToRefs;
    operation(operations, 'INVALID_SPEECH_CONTROL_DISCARDED', 'speechInteraction.answerToRefs', 'answerToRefsが配列ではないため回答参照制御だけを未指定扱いにしました。');
    return;
  }

  const seen = new Set();
  const kept = [];
  interaction.answerToRefs.forEach((value, index) => {
    const sequence = Number(value);
    const valid = Number.isInteger(sequence)
      && sequence > 0
      && !seen.has(sequence)
      && validAnswerEvent(state, playerId, sequence);
    if (!valid) {
      operation(operations, 'INVALID_SPEECH_CONTROL_DISCARDED', `speechInteraction.answerToRefs[${index}]`, '現在利用できない回答参照を除去し、publicSpeechを含む他のAI生成結果を保持しました。');
      return;
    }
    seen.add(sequence);
    kept.push(sequence);
  });
  interaction.answerToRefs = kept;
}

function repairSpeechInteraction(state, playerId, payload, operations) {
  if (!Object.hasOwn(payload, 'speechInteraction')) return;
  const interaction = payload.speechInteraction;
  if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) {
    delete payload.speechInteraction;
    operation(operations, 'INVALID_SPEECH_CONTROL_DISCARDED', 'speechInteraction', 'speechInteractionがオブジェクトではないため補助制御だけを未指定扱いにしました。');
    return;
  }

  Object.keys(interaction).forEach((key) => {
    if (ALLOWED_KEYS.has(key)) return;
    delete interaction[key];
    operation(operations, 'INVALID_SPEECH_CONTROL_DISCARDED', `speechInteraction.${key}`, `未定義の補助制御speechInteraction.${key}を除去しました。`);
  });

  repairQuestionTargets(state, playerId, interaction, operations);
  repairAnswerRefs(state, playerId, interaction, operations);
  if (!Object.keys(interaction).length) delete payload.speechInteraction;
}

export { repairSpeechInteraction };
