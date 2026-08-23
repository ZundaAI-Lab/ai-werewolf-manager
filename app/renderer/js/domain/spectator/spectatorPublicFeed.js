/**
 * 責務: buildPublicSnapshot(includeConfidential:false)だけを入力として、公開画面が実際に表示する情報へ観戦AI用の公開Feedを再射影する。
 * 変更ルール: 完全なGame Stateを受け取らない。publicSnapshotに存在してもpublicViewが表示していない補助項目を追加しない。真役職・心の声・私有会話は、公開結果としてsnapshot.resultへ明示掲載された場合だけFeedへ含める。内部UUIDをPrompt用Feedへ残さず表示名へ変換する。Prompt向け文字列化は行わず、外部由来文字列を構造化Feedのまま上位の安全なserializerへ渡す。
 */

import { ROLE_DEFINITIONS, TEAM_LABELS } from '../../config/constants.js';
import { publicAbilityResultLabel } from '../policies/publicAbilityClaimPolicy.js';
import { formatAbilityClaimTiming } from '../policies/abilityClaimTimingPolicy.js';

function cleanText(value) {
  return String(value ?? '').trim();
}

function nameOf(snapshot, id) {
  return snapshot.players.find((player) => player.id === id)?.name ?? '不明';
}

function roleName(roleId) {
  return ROLE_DEFINITIONS[roleId]?.name ?? String(roleId ?? '不明');
}

function abilityRoleLabel(roleId) {
  return ({ seer: '占い', medium: '霊能', guard: '護衛' })[roleId] ?? roleName(roleId);
}

function visibleVoteText(snapshot, payload = {}) {
  const source = cleanText(payload.text);
  const summary = source.replace(/\s*投票先:\s*[\s\S]*$/u, '').trim();
  const ballots = (payload.ballots ?? []).map((ballot) => {
    const voter = nameOf(snapshot, ballot.voterId);
    const target = ballot.targetId === 'abstain' ? '棄権' : nameOf(snapshot, ballot.targetId);
    return `${voter} → ${target}`;
  });
  const tally = (payload.tally ?? []).map((item) => `${nameOf(snapshot, item.targetId)} ${item.count}票`);
  const lines = [summary || tally.join('、') || '投票結果'];
  if (ballots.length) lines.push(`投票先の内訳: ${ballots.join(' / ')}`);
  return lines.join('\n');
}

function visibleEvent(snapshot, event) {
  const payload = event.payload ?? {};
  const text = event.type === 'vote-finalized'
    ? visibleVoteText(snapshot, payload)
    : cleanText(payload.text) || String(event.type ?? '公開更新');
  const speakerName = ['public-speech', 'result-impression'].includes(event.type) && event.actorId
    ? nameOf(snapshot, event.actorId)
    : 'ゲーム進行';
  return {
    sequence: Number(event.sequence ?? 0) || 0,
    day: Number(event.day ?? 0) || 0,
    speakerName,
    type: String(event.type ?? ''),
    text,
  };
}

function visibleResult(snapshot) {
  const result = snapshot.result;
  if (!result) return null;
  return {
    winner: TEAM_LABELS[result.winner] ?? 'ゲーム終了',
    reason: cleanText(result.reason),
    roles: (result.roles ?? []).map((item) => ({ playerName: nameOf(snapshot, item.playerId), roleName: roleName(item.roleId) })),
    wolfConversations: (result.wolfConversations ?? []).map((session) => ({
      day: session.day,
      messages: (session.messages ?? []).map((message) => ({ speakerName: nameOf(snapshot, message.speakerId), text: cleanText(message.content) })),
    })),
    masonConversations: (result.masonConversations ?? []).map((session) => ({
      day: session.day,
      messages: (session.messages ?? []).map((message) => ({ speakerName: nameOf(snapshot, message.speakerId), text: cleanText(message.content) })),
    })),
    graveyardConversations: (result.graveyardConversations ?? []).map((session) => ({
      day: session.day,
      messages: (session.messages ?? []).map((message) => ({ speakerName: nameOf(snapshot, message.speakerId), text: cleanText(message.content) })),
    })),
    internalMemos: (result.internalMemos ?? []).map((item) => ({
      playerName: nameOf(snapshot, item.playerId),
      heartVoice: cleanText(item.heartVoice) || 'なし',
      memo: cleanText(item.memo) || 'なし',
    })),
  };
}

export function buildSpectatorPublicFeed(snapshot, { afterSequence = 0, includeFullHistory = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('公開スナップショットがありません。');
  const threshold = includeFullHistory ? 0 : Math.max(0, Number(afterSequence ?? 0) || 0);
  const allEvents = (snapshot.events ?? []).map((event) => visibleEvent(snapshot, event));
  const events = allEvents.filter((event) => event.sequence > threshold);
  return {
    schemaVersion: 1,
    publicRevision: Math.max(0, Number(snapshot.publicRevision ?? 0) || 0),
    latestEventSequence: allEvents.reduce((max, event) => Math.max(max, event.sequence), 0),
    game: {
      title: cleanText(snapshot.game?.title) || 'AI人狼',
      day: Number(snapshot.game?.day ?? 0) || 0,
      phaseLabel: cleanText(snapshot.game?.phaseLabel) || cleanText(snapshot.game?.phase) || '進行中',
      status: cleanText(snapshot.game?.status),
    },
    players: (snapshot.players ?? []).map((player) => ({
      name: cleanText(player.name) || '不明',
      alive: player.alive === true,
      frozen: player.frozen === true,
    })),
    claims: (snapshot.claims ?? []).map((claim) => ({
      actorName: nameOf(snapshot, claim.actorId),
      roleName: roleName(claim.roleId),
    })),
    publicAbilityClaims: (snapshot.publicAbilityClaims ?? []).map((claim) => ({
      actorName: nameOf(snapshot, claim.actorId),
      timing: formatAbilityClaimTiming(claim),
      roleLabel: abilityRoleLabel(claim.claimedRoleId),
      targetName: nameOf(snapshot, claim.targetId),
      resultLabel: publicAbilityResultLabel(claim.result, claim.claimedRoleId),
    })),
    events,
    result: visibleResult(snapshot),
  };
}

export function spectatorPublicFactSignature(feed) {
  return JSON.stringify({
    players: feed.players,
    claims: feed.claims,
    publicAbilityClaims: feed.publicAbilityClaims,
    result: feed.result,
  });
}


export function summarizeSpectatorPublicUpdate(feed, { initial = false } = {}) {
  if (initial) return `観戦開始時点の公開表示を同期しました。Day ${feed.game.day} / ${feed.game.phaseLabel} / 公開記録${feed.latestEventSequence}まで。`;
  if (feed.events.length) {
    const tail = feed.events.slice(-3).map((event) => {
      const text = event.text.replace(/\s+/gu, ' ').slice(0, 140);
      return `#${event.sequence} ${event.speakerName}: ${text}`;
    });
    const prefix = feed.events.length > tail.length ? `公開更新${feed.events.length}件（最新${tail.length}件）` : `公開更新${feed.events.length}件`;
    return `${prefix}: ${tail.join(' / ')}`;
  }
  return `公開盤面が更新されました。Day ${feed.game.day} / ${feed.game.phaseLabel}`;
}
