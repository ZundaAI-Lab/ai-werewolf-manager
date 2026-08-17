/**
 * 責務: Day 1第1巡・公開CO前の初動局面を、先行CO判断、最初の会話開始、既存発言への序盤反応へ分離して判定する。
 * 変更ルール:
 * - 発言本文、質問、CO、疑い先、投票先を生成しない。
 * - 現在のactive COだけでなく、公開後に撤回されたCOも「公開済み」として扱う。
 * - 先行CO判断と会話形式を混同せず、COがないことを潜伏理由にしない。
 * - 導入意図は公開情報と本人のキャラクター設定だけから決定的に選び、Math.randomを使用しない。推理方針・評価基準・判断変更条件の自己紹介を導入意図にしない。
 */

import { hashText } from '../../shared/utils.js';

export const OPENING_CONVERSATION_MODES = Object.freeze({
  NORMAL: 'normal',
  FIRST_SPEAKER: 'first-speaker',
  EARLY_REACTION: 'early-reaction',
});

const OPENING_INTENTS = Object.freeze([
  Object.freeze({
    id: 'atmosphere',
    instruction: '現在の場の空気や、議論が始まることへの短い感想から自然に始める。',
  }),
  Object.freeze({
    id: 'personal-stance',
    instruction: '自分らしい短い感情や場への反応を一つ述べる。推理方針は説明しない。',
  }),
  Object.freeze({
    id: 'observation-focus',
    instruction: '現在見えている場の様子や自分の気持ちを一つ述べる。今後見る情報や評価基準は表明しない。',
  }),
  Object.freeze({
    id: 'discussion-proposal',
    instruction: '特定人物へ回答を強要せず、キャラクターらしい短い声掛けで全員の参加を促す。議論手順は提案しない。',
  }),
  Object.freeze({
    id: 'light-character-line',
    instruction: '人物設定に合う短い感想、比喩、冗談のいずれかから始め、推理結論を無理に追加しない。',
  }),
  Object.freeze({
    id: 'cautious-expectation',
    instruction: 'これから公開されるCOや発言について、楽しみまたは慎重な期待を短く示す。評価変更条件として表現しない。',
  }),
]);

function hasPublishedCoOperation(context) {
  if ((context.board.claims ?? []).length > 0) return true;

  return (context.board.publicTimeline?.speeches ?? []).some((event) => {
    const action = event.payload?.structured?.coOperation?.action;
    return action === 'declare' || action === 'change';
  });
}

function currentDaySpeeches(context) {
  const day = Number(context.game.day);
  return (context.board.publicTimeline?.speeches ?? [])
    .filter((event) => Number(event.day) === day);
}

function hasCharacterConversationMaterial(context) {
  const character = context.player?.character ?? {};
  const seeds = Array.isArray(character.conversationSeeds) ? character.conversationSeeds : [];
  return seeds.some((seed) => String(seed?.subject ?? '').trim())
    || String(character.profile ?? '').trim().length >= 12;
}

function eligibleOpeningIntents(context) {
  return OPENING_INTENTS.filter((intent) => (
    intent.id !== 'light-character-line' || hasCharacterConversationMaterial(context)
  ));
}

function stableIntentIndex(context, length) {
  if (length <= 1) return 0;
  const key = [
    context.game.id,
    context.player.id,
    context.player.character?.reasoningProfile?.questionStyle ?? '',
    context.player.character?.speechLength ?? '',
    'opening-intent-v1',
  ].join('|');
  return Number.parseInt(hashText(key), 16) % length;
}

export function isInitialClaimDecisionSituation(context) {
  return context.task.type === 'speech'
    && Number(context.game.day) === 1
    && Number(context.game.discussion?.round) === 1
    && !hasPublishedCoOperation(context);
}

export function resolveOpeningConversationMode(context) {
  if (!isInitialClaimDecisionSituation(context)) return OPENING_CONVERSATION_MODES.NORMAL;
  return currentDaySpeeches(context).length === 0
    ? OPENING_CONVERSATION_MODES.FIRST_SPEAKER
    : OPENING_CONVERSATION_MODES.EARLY_REACTION;
}

export function isOpeningSpeechSituation(context) {
  return resolveOpeningConversationMode(context) === OPENING_CONVERSATION_MODES.FIRST_SPEAKER;
}

export function resolveOpeningIntent(context) {
  if (!isOpeningSpeechSituation(context)) return null;
  const intents = eligibleOpeningIntents(context);
  if (!intents.length) return null;
  const selected = intents[stableIntentIndex(context, intents.length)];
  return { ...selected };
}
