/**
 * 責務: キャラクターデータの相手別呼称をゲーム参加者へ解決し、保存用スナップショットと話者依存の言及候補を提供する。
 * 変更ルール: ゲーム判断・DOM操作を行わない。呼称は話者→対象ごとに基本呼称1件だけを扱い、ゲーム準備のplayer.callNameOverridesを最優先する。未上書き時だけキャラクターデータを参照し、曖昧な呼称は正式表示名へフォールバックする。
 */

import { CALL_NAME_SNAPSHOT_SCHEMA_VERSION } from '../catalog/characterCatalog.js';
import { getCharacterCallNameEntry } from './callNameTable.js';
import { nowIso } from '../../shared/utils.js';

const NON_IDENTIFYING_CALL_NAMES = new Set([
  'あなた', 'あなたさま', 'きみ', '君', 'お前', 'アンタ', 'あんた', 'ちゃん', 'くん', 'さん', '先輩',
  'みんな', '皆さん', 'みなさん', 'あなた達', 'あなたたち', '君たち', 'きみ達', 'きみたち', '？', '?',
]);

function normalize(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}


const JAPANESE_HONORIFICS = Object.freeze([
  'ちゃん', 'くん', 'さん', 'さま', '様', '殿', '君', '先輩', '先生', '氏',
]);

function stripJapaneseHonorific(value) {
  const source = String(value ?? '').trim();
  const suffix = [...JAPANESE_HONORIFICS]
    .sort((left, right) => right.length - left.length)
    .find((item) => source.endsWith(item));
  if (!suffix) return source;
  const stem = source.slice(0, -suffix.length).trim();
  if ([...stem].length < 2 || NON_IDENTIFYING_CALL_NAMES.has(normalize(stem))) return source;
  return stem;
}

function overrideEntry(player, targetPlayerId) {
  const raw = player?.callNameOverrides?.[targetPlayerId];
  const preferred = String(raw ?? '').trim();
  if (!preferred) return null;
  return { preferred, status: 'manual', source: 'manual-override' };
}

function baseEntry(speaker, target) {
  const manual = overrideEntry(speaker, target?.id);
  if (manual) return manual;
  if (!speaker?.characterCardId || !target?.characterCardId) return null;
  return getCharacterCallNameEntry(speaker.characterCardId, target.characterCardId);
}


function collisionNames(players, speaker) {
  const byName = new Map();
  players.filter((target) => target.id !== speaker.id).forEach((target) => {
    const entry = baseEntry(speaker, target);
    if (!entry?.preferred || entry.status === 'unknown') return;
    const key = normalize(entry.preferred);
    if (!key || NON_IDENTIFYING_CALL_NAMES.has(key)) return;
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key).add(target.id);
  });
  return new Set([...byName.entries()].filter(([, ids]) => ids.size > 1).map(([name]) => name));
}

export function createGameCallNameSnapshot(players = [], { enabled = true, createdAt = nowIso() } = {}) {
  const bySpeakerId = {};
  players.forEach((speaker) => {
    bySpeakerId[speaker.id] = {};
    const collisions = collisionNames(players, speaker);
    players.filter((target) => target.id !== speaker.id).forEach((target) => {
      const sourceEntry = enabled ? baseEntry(speaker, target) : null;
      const ambiguous = sourceEntry?.preferred && collisions.has(normalize(sourceEntry.preferred));
      const usable = sourceEntry?.preferred && sourceEntry.status !== 'unknown' && !ambiguous;
      bySpeakerId[speaker.id][target.id] = {
        preferred: usable ? sourceEntry.preferred : target.name,
        source: usable ? 'character-data' : 'display-name-fallback',
        status: usable ? sourceEntry.status ?? 'configured' : ambiguous ? 'ambiguous-fallback' : sourceEntry?.status === 'unknown' ? 'unknown-fallback' : 'fallback',
        speakerCharacterCardId: speaker.characterCardId ?? null,
        targetCharacterCardId: target.characterCardId ?? null,
      };
    });
  });
  return {
    schemaVersion: CALL_NAME_SNAPSHOT_SCHEMA_VERSION,
    createdAt,
    enabled: Boolean(enabled),
    bySpeakerId,
  };
}

export function buildPromptCallNameRows(state, speakerPlayerId) {
  if (!state?.game?.rules?.callNames?.enabled) return [];
  const speaker = state.players.find((player) => player.id === speakerPlayerId);
  if (!speaker) return [];
  const snapshot = state.game.callNameSnapshot ?? createGameCallNameSnapshot(state.players, { enabled: true });
  return state.players
    .filter((target) => target.id !== speakerPlayerId)
    .map((target) => {
      const entry = snapshot.bySpeakerId?.[speakerPlayerId]?.[target.id];
      return {
        targetPlayerId: target.id,
        targetName: target.name,
        preferred: entry?.preferred || target.name,
        status: entry?.status ?? 'fallback',
      };
    });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function containsCallName(text, name) {
  const escaped = escapeRegExp(name);
  const honorific = '(?:さん|殿|ちゃん|君|くん|様|さま|先輩|先生|氏)?';
  const pattern = new RegExp(`(?:^|[\\s「『（(、。！？!?])${escaped}${honorific}(?=$|[\\s」』）)、。！？!?はがをにへとのもでか])`, 'u');
  return pattern.test(text);
}
