/**
 * 責務: 人狼本人が把握している生存仲間について、公開済みの発言参照・CO・能力結果主張・公開済み投票だけから直近の公開位置を構造化する。
 * 変更ルール: 公開発言本文、非公開会話、他人の内部判断、真の役職を参照しない。本人が知らない人狼を追加せず、公開発言内容を評価・補完・要約しない。
 */

import { ROLE_DEFINITIONS } from '../../config/constants.js';
import { getPublishedPublicEvents } from '../../domain/events/eventStore.js';
import { publicAbilityResultLabel } from '../../domain/policies/publicAbilityClaimPolicy.js';
import { getPlayer } from '../../domain/game/standardRules.js';
import { countsAsWolf } from '../../domain/roles/roleAttributes.js';

function bySequence(left, right) {
  return Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0);
}

function playerName(state, playerId) {
  return getPlayer(state, playerId)?.name ?? '不明';
}

function latestPublishedVote(state, playerId) {
  return getPublishedPublicEvents(state)
    .filter((event) => event.type === 'vote-cast' && event.actorId === playerId)
    .sort(bySequence)
    .at(-1) ?? null;
}

function contributionType(structured = {}, publishedVote = null) {
  const abilityClaims = structured.abilityClaims ?? [];
  if (abilityClaims.length) return 'ability-claim';
  if (structured.coOperation?.action && structured.coOperation.action !== 'none') return 'role-claim';
  if (publishedVote) return 'vote-position';
  return 'brief-alignment-or-hold';
}

function activeClaim(state, playerId) {
  const claim = state.claims.find((item) => item.actorId === playerId && item.status === 'active');
  if (!claim) return null;
  return ROLE_DEFINITIONS[claim.roleId]?.name ?? claim.roleId;
}

function activeAbilityClaims(state, playerId) {
  return state.publicAbilityClaims
    .filter((claim) => claim.actorId === playerId && claim.status !== 'voided')
    .map((claim) => ({
      role: ROLE_DEFINITIONS[claim.claimedRoleId]?.name ?? claim.claimedRoleId,
      actionDay: claim.actionDay,
      actionPhase: claim.actionPhase,
      availableDay: claim.availableDay,
      availablePhase: claim.availablePhase,
      target: playerName(state, claim.targetId),
      result: publicAbilityResultLabel(claim.result, claim.claimedRoleId),
    }));
}

export function buildWolfPartnerPublicPositionContext(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player || !countsAsWolf(state, player)) return [];

  const knownWolfIds = state.playerKnowledge[playerId]?.knownWolfIds ?? [];
  const alivePartnerIds = knownWolfIds.filter((id) => id !== playerId && getPlayer(state, id)?.alive);
  if (!alivePartnerIds.length) return [];

  const publicSpeeches = getPublishedPublicEvents(state)
    .filter((event) => event.type === 'public-speech')
    .sort(bySequence);

  return alivePartnerIds.map((partnerId) => {
    const latestSpeech = [...publicSpeeches].reverse().find((event) => event.actorId === partnerId) ?? null;
    const structured = latestSpeech?.payload?.structured ?? {};
    const publishedVote = latestPublishedVote(state, partnerId);
    return {
      name: playerName(state, partnerId),
      latestSpeechRef: latestSpeech ? `#${latestSpeech.sequence}` : null,
      suspects: [],
      executionCandidates: [],
      votePosition: publishedVote?.payload?.targetId
        ? playerName(state, publishedVote.payload.targetId)
        : null,
      decisionReason: null,
      evidenceRefs: [],
      contributionType: latestSpeech
        ? contributionType(structured, publishedVote)
        : publishedVote ? 'vote-position' : 'not-spoken',
      activeClaim: activeClaim(state, partnerId),
      activeAbilityClaims: activeAbilityClaims(state, partnerId),
    };
  });
}
