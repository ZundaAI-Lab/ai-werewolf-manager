/**
 * 責務: チャットルームの会話きっかけ候補を、キャラクター固有seedとシステム汎用cueから決定的・低頻度に選ぶ。
 * 変更ルール: 会話Stateの更新、AI通信、Prompt本文生成は行わない。通常会話では「きっかけなし」を主候補とし、直近利用済みcueを避けて会話の単調化だけを弱く抑制する。質問への専用回答ターンにはcueを返さない。
 */

import { hashText } from '../../shared/utils.js';

const OPENING_CHARACTER_WEIGHT = 85;
const NORMAL_CHARACTER_WEIGHT = 10;
const NORMAL_SYSTEM_WEIGHT = 5;
const RECENT_CUE_WINDOW = 6;

export const SYSTEM_CONVERSATION_CUES = Object.freeze([
  Object.freeze({ id: 'system-recent-discovery', subject: '最近ちょっと気になったことや小さな発見', tone: '軽く共有する感じ' }),
  Object.freeze({ id: 'system-food-drink', subject: '食べ物や飲み物、好き嫌い', tone: '気楽で親しみやすく' }),
  Object.freeze({ id: 'system-hobby-free-time', subject: '趣味や遊び、暇なときの過ごし方', tone: '興味を広げる感じ' }),
  Object.freeze({ id: 'system-season-weather', subject: '季節や天気、その時期ならではのこと', tone: '日常の雑談として自然に' }),
  Object.freeze({ id: 'system-travel-place', subject: '行ってみたい場所や旅行', tone: '想像を楽しむ感じ' }),
  Object.freeze({ id: 'system-old-memory', subject: '昔の思い出や子供の頃の話', tone: '懐かしさを少し交えて' }),
  Object.freeze({ id: 'system-small-mistake', subject: '最近の小さな失敗や意外だった出来事', tone: '重くせず笑える範囲で' }),
  Object.freeze({ id: 'system-routine-preference', subject: '日常のこだわりや習慣', tone: 'さりげなく個性が出る感じ' }),
  Object.freeze({ id: 'system-what-if', subject: 'もし○○だったらという軽い仮定', tone: '遊び心のある想像として' }),
  Object.freeze({ id: 'system-recommendation', subject: '最近おすすめしたいものや人に勧められたもの', tone: '押しつけず気軽に' }),
]);

function cleanCharacterCues(card) {
  const seeds = Array.isArray(card?.character?.conversationSeeds) ? card.character.conversationSeeds : [];
  return seeds.map((seed, index) => {
    const subject = String(seed?.subject ?? '').trim();
    const tone = String(seed?.tone ?? '').trim();
    if (!subject || !tone) return null;
    const sourceId = String(seed?.id ?? '').trim() || hashText(`${subject}\u0000${tone}\u0000${index}`);
    return Object.freeze({ id: `character:${card?.id ?? 'unknown'}:${sourceId}`, source: 'character', subject, tone });
  }).filter(Boolean);
}

function systemCues() {
  return SYSTEM_CONVERSATION_CUES.map((cue) => ({ ...cue, source: 'system' }));
}

function hashNumber(value) {
  return Number.parseInt(hashText(value), 16) >>> 0;
}

function chooseCandidate(candidates, state, speakerCard, purpose) {
  if (!candidates.length) return null;
  const recent = new Set((Array.isArray(state?.conversationCueHistory) ? state.conversationCueHistory : []).slice(-RECENT_CUE_WINDOW));
  const fresh = candidates.filter((cue) => !recent.has(cue.id));
  const pool = fresh.length ? fresh : candidates;
  const aiMessageCount = (Array.isArray(state?.messages) ? state.messages : []).filter((message) => message?.kind === 'ai').length;
  const entropy = `${state?.id ?? ''}|${speakerCard?.id ?? ''}|${aiMessageCount}|${purpose}|${state?.round ?? 0}`;
  return structuredClone(pool[hashNumber(entropy) % pool.length]);
}

function chooseBySource({ state, speakerCard, source, purpose }) {
  const candidates = source === 'character' ? cleanCharacterCues(speakerCard) : systemCues();
  const fallback = source === 'character' ? systemCues() : cleanCharacterCues(speakerCard);
  return chooseCandidate(candidates.length ? candidates : fallback, state, speakerCard, purpose);
}

export function selectOpeningConversationCue({ state, speakerCard } = {}) {
  if (String(state?.topic ?? '').trim()) return null;
  const roll = hashNumber(`${state?.id ?? ''}|${speakerCard?.id ?? ''}|opening-source`) % 100;
  const source = roll < OPENING_CHARACTER_WEIGHT ? 'character' : 'system';
  return chooseBySource({ state, speakerCard, source, purpose: 'opening' });
}

export function selectOptionalConversationCue({ state, speakerCard, turnKind = 'round' } = {}) {
  if (turnKind !== 'round') return null;
  const aiMessageCount = (Array.isArray(state?.messages) ? state.messages : []).filter((message) => message?.kind === 'ai').length;
  if (aiMessageCount === 0) return null;
  const roll = hashNumber(`${state?.id ?? ''}|${speakerCard?.id ?? ''}|${aiMessageCount}|normal-source|${state?.round ?? 0}`) % 100;
  if (roll < NORMAL_CHARACTER_WEIGHT) return chooseBySource({ state, speakerCard, source: 'character', purpose: 'normal-character' });
  if (roll < NORMAL_CHARACTER_WEIGHT + NORMAL_SYSTEM_WEIGHT) return chooseBySource({ state, speakerCard, source: 'system', purpose: 'normal-system' });
  return null;
}
