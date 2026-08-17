/**
 * 責務: 昼議論の公開発言機会、公開時点の先行構造化情報、明示提出された質問・回答関連を純粋計算する。
 * 変更ルール: 公開発言本文を解析せず、人物名・質問・回答・疑い・CO・能力結果を推定しない。質問・回答関連は呼出元が明示した構造だけを正本とし、状態更新や文章生成を行わない。通常発言と無料の回答発言を混同せず、3巡目CO後の追加発言判定に使う残り回数は発言開始時点で固定する。
 */

function bySequence(left, right) {
  return Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function hasStructuredPublication(event) {
  const structured = event?.payload?.structured ?? {};
  const coAction = String(structured.coOperation?.action ?? 'none');
  return ['declare', 'change', 'withdraw'].includes(coAction)
    || (structured.abilityClaims ?? []).length > 0;
}

export function createSpeechOpportunitySnapshot(state, playerId) {
  const discussion = state?.discussion ?? null;
  const day = Number(state?.game?.day ?? 0);
  const previousSpeeches = (state?.events ?? []).filter((event) => (
    event.status === 'published'
    && event.type === 'public-speech'
    && event.actorId === playerId
    && event.payload?.speechKind === 'normal'
    && Number(event.day) === day
  ));
  const priorDeferralCount = Number(discussion?.deferredCountByPlayer?.[playerId] ?? 0);
  const queuePosition = discussion?.mode === 'ordered'
    ? (discussion.queue ?? []).indexOf(playerId)
    : -1;

  return {
    mode: discussion?.mode ?? null,
    round: Number(discussion?.round ?? 0) || null,
    queuePosition: queuePosition >= 0 ? queuePosition + 1 : null,
    priorSpeechCountToday: previousSpeeches.length,
    priorDeferralCountToday: priorDeferralCount,
    hadPriorRecordedOpportunity: previousSpeeches.length > 0 || priorDeferralCount > 0,
    remainingByPlayerAtSpeechStart: Object.fromEntries(
      Object.entries(discussion?.remainingByPlayer ?? {}).map(([id, count]) => [id, count === null ? null : Number(count)]),
    ),
  };
}

export function buildPublicClaimTimingFacts({
  speeches = [],
  claims = [],
  publicAbilityClaims = [],
} = {}) {
  const activeSourceIds = new Set(unique([
    ...claims.map((claim) => claim.sourceEventId),
    ...publicAbilityClaims.map((claim) => claim.sourceEventId),
  ]));
  const orderedSpeeches = [...speeches].sort(bySequence);

  return orderedSpeeches
    .filter((event) => activeSourceIds.has(event.id) || hasStructuredPublication(event))
    .map((event) => {
      const priorStructuredEvents = orderedSpeeches.filter((previous) => (
        Number(previous.day) === Number(event.day)
        && Number(previous.sequence) < Number(event.sequence)
        && hasStructuredPublication(previous)
      ));
      return {
        actorId: event.actorId,
        sourceEventId: event.id,
        sequence: event.sequence,
        day: event.day,
        opportunityContext: {
          ...(event.payload?.opportunityContext ?? {}),
        },
        priorStructuredEventIds: priorStructuredEvents.map((previous) => previous.id),
        priorStructuredEventSequences: priorStructuredEvents.map((previous) => previous.sequence),
      };
    });
}

export function deriveSpeechInteraction(state, {
  actorId,
  interaction = null,
} = {}) {
  const playerIds = new Set((state?.players ?? []).map((player) => player.id));
  const publishedSpeechEventIds = new Set((state?.events ?? [])
    .filter((event) => event.type === 'public-speech' && event.status === 'published')
    .map((event) => event.id));
  return {
    questionTargetIds: unique(interaction?.questionTargetIds ?? [])
      .filter((id) => id !== actorId && playerIds.has(id)),
    answersEventIds: unique(interaction?.answersEventIds ?? [])
      .filter((id) => publishedSpeechEventIds.has(id)),
  };
}

export function validateSpeechInteractionForCommit(state, {
  actorId,
  interaction = null,
} = {}) {
  const empty = { questionTargetIds: [], answersEventIds: [] };
  if (interaction === null || interaction === undefined) return { ok: true, interaction: empty, errors: [] };
  if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) {
    return { ok: false, interaction: empty, errors: ['質問・回答関連はオブジェクトで指定してください。'] };
  }
  const keys = Object.keys(interaction).sort();
  const errors = [];
  if (keys.join(',') !== 'answersEventIds,questionTargetIds') {
    errors.push('質問・回答関連にはquestionTargetIdsとanswersEventIdsだけを指定してください。');
  }
  const questionTargetIds = interaction.questionTargetIds;
  const answersEventIds = interaction.answersEventIds;
  if (!Array.isArray(questionTargetIds)) errors.push('questionTargetIdsは配列で指定してください。');
  if (!Array.isArray(answersEventIds)) errors.push('answersEventIdsは配列で指定してください。');
  if (errors.length) return { ok: false, interaction: empty, errors };

  const playerById = new Map((state?.players ?? []).map((player) => [player.id, player]));
  if (new Set(questionTargetIds).size !== questionTargetIds.length) errors.push('questionTargetIdsに同じ対象を重複指定できません。');
  questionTargetIds.forEach((targetId) => {
    const target = playerById.get(targetId);
    if (!target) errors.push(`questionTargetIdsが存在しないプレイヤーを参照しています: ${targetId}`);
    else if (targetId === actorId) errors.push('questionTargetIdsへ本人を指定できません。');
    else if (!target.alive) errors.push(`questionTargetIdsの${target.name}は現在生存していません。`);
  });

  const eventById = new Map((state?.events ?? []).map((event) => [event.id, event]));
  if (new Set(answersEventIds).size !== answersEventIds.length) errors.push('answersEventIdsに同じ発言を重複指定できません。');
  answersEventIds.forEach((eventId) => {
    const event = eventById.get(eventId);
    if (!event || event.type !== 'public-speech' || event.status !== 'published') {
      errors.push(`answersEventIdsが現在参照できる公開発言を参照していません: ${eventId}`);
      return;
    }
    if (event.actorId === actorId) {
      errors.push(`answersEventIdsの#${event.sequence}は本人自身の発言です。`);
      return;
    }
    if (!(event.payload?.structured?.interaction?.questionTargetIds ?? []).includes(actorId)) {
      errors.push(`answersEventIdsの#${event.sequence}は本人への明示質問ではありません。`);
    }
  });

  return {
    ok: errors.length === 0,
    interaction: errors.length ? empty : {
      questionTargetIds: [...questionTargetIds],
      answersEventIds: [...answersEventIds],
    },
    errors,
  };
}
