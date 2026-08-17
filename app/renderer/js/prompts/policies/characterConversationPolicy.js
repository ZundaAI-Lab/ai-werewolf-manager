/**
 * 責務: ゲーム最初の公開発言でCO・能力結果を公開しない場合に使える、プロフィール固有の会話種を一つ選ぶ。
 * 変更ルール:
 * - 発言本文、疑い先、投票先、CO、役職行動を生成・決定しない。
 * - 公開情報と本人のキャラクター設定だけを使用し、秘密情報を参照しない。公開発言本文は参照・解析しない。
 * - 同じ入力から同じ結果を返し、Math.randomを使用しない。
 * - 会話開始局面の判定はopeningSpeechPolicy.jsへ集約し、既存公開発言がある序盤反応へは介入しない。
 */

import { hashText } from '../../shared/utils.js';
import { isOpeningSpeechSituation } from './openingSpeechPolicy.js';
const RECENT_OWN_SPEECH_LIMIT = 8;

function currentDaySpeeches(context) {
  const day = Number(context.game.day);
  return (context.board.publicTimeline?.speeches ?? [])
    .filter((event) => Number(event.day) === day);
}

function validConversationSeeds(character) {
  return (character?.conversationSeeds ?? [])
    .filter((item) => (
      String(item?.id ?? '').trim()
      && String(item?.subject ?? '').trim()
      && String(item?.tone ?? '').trim()
    ))
    .map((item) => ({
      id: String(item.id),
      subject: String(item.subject),
      tone: String(item.tone),
    }));
}

function recentlyReservedSeedIds(context, seeds) {
  const ownSpeeches = (context.board.publicTimeline?.speeches ?? [])
    .filter((event) => event.actorId === context.player.id);
  const recentStart = Math.max(0, ownSpeeches.length - RECENT_OWN_SPEECH_LIMIT);
  const rotationOffset = Number.parseInt(hashText(`${context.game.id}|${context.player.id}`), 16) % seeds.length;

  return new Set(ownSpeeches
    .slice(recentStart)
    .map((_, index) => seeds[(rotationOffset + recentStart + index) % seeds.length]?.id ?? null)
    .filter(Boolean));
}

function stableIndex(context, length) {
  if (length <= 1) return 0;
  const key = [
    context.game.id,
    context.game.day,
    context.game.discussion?.round ?? 0,
    context.player.id,
  ].join('|');
  return Number.parseInt(hashText(key), 16) % length;
}

export function isOpeningCharacterConversationSituation(context) {
  if (!isOpeningSpeechSituation(context)) return false;
  return !currentDaySpeeches(context).some((event) => event.actorId === context.player.id);
}

export function resolveCharacterConversationSeed(context) {
  if (!isOpeningCharacterConversationSituation(context)) return null;

  const seeds = validConversationSeeds(context.player.character);
  if (seeds.length) {
    const usedIds = recentlyReservedSeedIds(context, seeds);
    const unusedSeeds = seeds.filter((seed) => !usedIds.has(seed.id));
    if (!unusedSeeds.length) return null;
    const selected = unusedSeeds[stableIndex(context, unusedSeeds.length)];
    return {
      source: 'curated-seed',
      seed: {
        id: selected.id,
        subject: selected.subject,
        tone: selected.tone,
      },
    };
  }

  const profile = String(context.player.character?.profile ?? '').trim();
  if (profile.length < 12) return null;

  return {
    source: 'profile-fallback',
    profile,
  };
}
