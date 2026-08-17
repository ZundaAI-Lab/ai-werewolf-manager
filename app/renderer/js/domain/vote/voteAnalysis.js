/**
 * 責務: 公開済み投票結果と本人に見える投票履歴から、決選投票で新たに増えた公開情報と候補別の公開主張変化を純粋計算する。
 * 変更ルール: 実配役、他者の秘密投票、非公開判断状態、人数勝敗分岐を参照しない。人数勝敗分岐はvotePopulationAnalysis.jsを正本とし、文章生成や状態更新を行わない。
 */

function publicEvents(context) {
  const timeline = context.board.publicTimeline ?? {};
  return [
    ...(timeline.speeches ?? []),
    ...(timeline.voteResults ?? []),
    ...(timeline.executions ?? []),
    ...(timeline.dawns ?? []),
    ...(timeline.corrections ?? []),
    ...(timeline.gameResults ?? []),
    ...(timeline.other ?? []),
  ].sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
}

export function buildRunoffAnalysis(context) {
  const vote = context.game.vote;
  if (vote?.type !== 'runoff' || !vote.parentSessionId || !vote.triggerVoteResultEventId) return null;
  const trigger = (context.board.publicTimeline?.voteResults ?? [])
    .find((event) => event.id === vote.triggerVoteResultEventId) ?? null;
  if (!trigger) return null;
  const payload = trigger.payload ?? {};
  const previousTally = [...(payload.tally ?? [])];
  const previousBallots = [...(payload.ballots ?? [])];
  const previousBallotsVisible = previousBallots.length > 0;
  const ownPreviousVote = [...(context.ownHistory.votes ?? [])]
    .reverse()
    .find((event) => event.payload?.voteSessionId === vote.parentSessionId)?.payload?.targetId ?? null;
  const newPublicEvidenceEvents = publicEvents(context)
    .filter((event) => Number(event.sequence ?? 0) > Number(trigger.sequence ?? 0))
    .filter((event) => !['vote-finalized', 'vote-cast'].includes(event.type));
  const activeClaims = context.board.claims ?? [];
  const candidateBranches = (vote.candidateIds ?? []).map((candidateId) => {
    const claim = activeClaims.find((item) => item.actorId === candidateId && item.status === 'active') ?? null;
    const sameRoleClaimCountBefore = claim ? activeClaims.filter((item) => item.roleId === claim.roleId && item.status === 'active').length : 0;
    return {
      candidateId,
      previousVoteCount: previousTally.find((item) => item.targetId === candidateId)?.count ?? 0,
      previousSupporterIds: previousBallots.filter((item) => item.targetId === candidateId).map((item) => item.voterId),
      ownPreviousVoteWasForCandidate: ownPreviousVote === candidateId,
      activeClaimRoleId: claim?.roleId ?? null,
      sameRoleClaimCountBefore,
      sameRoleClaimCountAfterExecution: claim ? Math.max(0, sameRoleClaimCountBefore - 1) : 0,
      publicAbilityClaimCount: (context.board.publicAbilityClaims ?? []).filter((item) => item.actorId === candidateId).length,
    };
  });
  return {
    active: true,
    parentSessionId: vote.parentSessionId,
    triggerVoteResultEventId: vote.triggerVoteResultEventId,
    previousRound: Number(payload.round ?? Math.max(1, Number(vote.round ?? 2) - 1)),
    previousCandidates: [...(payload.result?.tiedCandidateIds ?? vote.candidateIds ?? [])],
    previousTally,
    previousBallotsVisible,
    previousBallots,
    ownPreviousVoteId: ownPreviousVote,
    newPublicEvidenceEvents,
    hasNewPublicEvidence: newPublicEvidenceEvents.length > 0,
    candidateBranches,
  };
}
