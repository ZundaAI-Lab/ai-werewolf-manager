/**
 * 責務: 公開会話と確定公開イベントを、LLM判断に必要な全情報を保った短い履歴データへ投影する。
 * 変更ルール: publicHistoryPolicyが選択したイベントと保存済みinteractionだけを使用し、本文の要約・切断・関係推定を行わない。連続する同一本文は参照番号・Day・発言者をまとめ、投票は集計・結論・各票を短縮表現へ変換するが、公開済み情報と時系列を欠落させない。
 */

import {
  playerName,
  formatPromptEventText,
} from './promptFormatters.js';

function speechRecord(context, event, publicSpeechById) {
  const interaction = event.payload?.structured?.interaction ?? {};
  const questionTargets = [...new Set((interaction.questionTargetIds ?? [])
    .map((id) => playerName(context, id, ''))
    .filter(Boolean))];
  const answerEventSequences = [...new Set((interaction.answersEventIds ?? [])
    .map((eventId) => publicSpeechById.get(eventId))
    .filter((source) => (source?.payload?.structured?.interaction?.questionTargetIds ?? []).includes(event.actorId))
    .map((source) => source.sequence)
    .filter(Number.isInteger)
    .map((sequence) => Number(sequence)))];
  const annotations = [
    questionTargets.length ? `質問:${questionTargets.join('、')}` : '',
    answerEventSequences.length ? `回答:${answerEventSequences.map((sequence) => `#${sequence}`).join('、')}` : '',
  ].filter(Boolean).join('/');
  const speaker = playerName(context, event.actorId);
  const rawText = String(event?.payload?.text ?? '');
  const redundantSelfIntroduction = new RegExp(`^${speaker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:です|だ)[。！!]\\s*`, 'u');
  const text = rawText.replace(redundantSelfIntroduction, '');
  return {
    ref: `#${event.sequence}/D${event.day}/${speaker}`,
    content: `${text}${annotations ? ` [${annotations}]` : ''}`,
  };
}

function groupIdenticalSpeeches(records) {
  const groups = [];
  records.forEach((record) => {
    const previous = groups.at(-1);
    if (previous?.content === record.content) previous.refs.push(record.ref);
    else groups.push({ refs: [record.ref], content: record.content });
  });
  return groups.map((group) => `${group.refs.join(',')}: ${group.content}`);
}

function compactVoteResultLine(context, event) {
  const payload = event.payload ?? {};
  const tally = (payload.tally ?? [])
    .map((item) => `${playerName(context, item.targetId)}:${item.count}`)
    .join(',');
  const ballots = (payload.ballots ?? [])
    .map((item) => `${playerName(context, item.voterId)}→${item.targetId === 'abstain' ? '棄権' : playerName(context, item.targetId)}`)
    .join(',');
  const result = payload.result ?? {};
  let outcome = '';
  if (result.type === 'execution') {
    const target = playerName(context, result.targetId);
    outcome = result.resolution === 'random-tie-break' ? `抽選処刑候補:${target}` : `処刑候補:${target}`;
  } else if (result.type === 'runoff') {
    outcome = `決選:${(result.tiedCandidateIds ?? []).map((id) => playerName(context, id)).join(',')}`;
  } else {
    outcome = '処刑なし';
  }
  const fields = [tally ? `集計=${tally}` : '', outcome ? `結果=${outcome}` : '', ballots ? `票=${ballots}` : ''].filter(Boolean);
  return `#${event.sequence}/D${event.day} 投票 ${fields.join(';')}`;
}

function compactPublicEventLine(context, event) {
  return `#${event.sequence}/D${event.day} ${formatPromptEventText(context, event)}`;
}

export function publicHistoryData(context, timeline, { excludeSpeechEventId = null } = {}) {
  const history = {};
  const publicSpeechById = new Map();
  (context.board.publicTimeline?.speeches ?? []).forEach((event) => {
    const logicalIds = event.correctionLineageIds?.length
      ? event.correctionLineageIds
      : [event.id, event.payload?.correctsEventId].filter(Boolean);
    logicalIds.forEach((eventId) => publicSpeechById.set(eventId, event));
  });
  const speeches = groupIdenticalSpeeches(timeline.speeches
    .filter((event) => event.id !== excludeSpeechEventId)
    .map((event) => speechRecord(context, event, publicSpeechById)));
  const voteResults = timeline.voteResults.map((event) => compactVoteResultLine(context, event));
  const executions = timeline.executions.map((event) => compactPublicEventLine(context, event));
  const dawns = timeline.dawns.map((event) => compactPublicEventLine(context, event));
  const otherPublicFacts = [
    ...timeline.corrections,
    ...timeline.gameResults,
    ...timeline.other,
  ].map((event) => compactPublicEventLine(context, event));
  if (speeches.length) history.speeches = speeches;
  if (voteResults.length) history.voteResults = voteResults;
  if (executions.length) history.executions = executions;
  if (dawns.length) history.dawns = dawns;
  if (otherPublicFacts.length) history.otherPublicFacts = otherPublicFacts;
  return history;
}

export function selfPublicContinuityData(context, event) {
  if (!event) return null;
  return `#${event.sequence}/D${event.day}/${playerName(context, event.actorId)}: ${String(event?.payload?.text ?? '')}`;
}
