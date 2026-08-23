/**
 * 責務: 公開会話と確定公開イベントを、LLM判断に必要な全情報を保った短い履歴データへ投影する。
 * 変更ルール: publicHistoryPolicyが選択したイベントと保存済みinteractionだけを使用し、本文の要約・切断・関係推定を行わない。公開履歴はイベント種別ごとに再配置せずsequence順の単一timelineとして表示する。連続する同一本文の公開発言だけは参照番号・Day・発言者をまとめ、投票は集計・結論・各票を短縮表現へ変換するが、公開済み情報と時系列を欠落させない。
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
  const answerToRefs = [...new Set((interaction.answersEventIds ?? [])
    .map((eventId) => publicSpeechById.get(eventId))
    .filter((source) => (source?.payload?.structured?.interaction?.questionTargetIds ?? []).includes(event.actorId))
    .map((source) => source.sequence)
    .filter(Number.isInteger)
    .map((sequence) => Number(sequence)))];
  const annotations = [
    questionTargets.length ? `質問:${questionTargets.join('、')}` : '',
    answerToRefs.length ? `回答:${answerToRefs.map((sequence) => `#${sequence}`).join('、')}` : '',
  ].filter(Boolean).join('/');
  const speaker = playerName(context, event.actorId);
  const rawText = String(event?.payload?.text ?? '');
  const redundantSelfIntroduction = new RegExp(`^${speaker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:です|だ)[。！!]\\s*`, 'u');
  const text = rawText.replace(redundantSelfIntroduction, '');
  return {
    kind: 'speech',
    sequence: Number(event.sequence),
    ref: `#${event.sequence}/D${event.day}/${speaker}`,
    content: `${text}${annotations ? ` [${annotations}]` : ''}`,
  };
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

function pushEvents(rows, events, formatter, kind) {
  (events ?? []).forEach((event) => rows.push({
    kind,
    sequence: Number(event.sequence),
    content: formatter(event),
  }));
}

function mergeConsecutiveIdenticalSpeeches(records) {
  const rows = [];
  records.forEach((record) => {
    const previous = rows.at(-1);
    if (record.kind === 'speech' && previous?.kind === 'speech' && previous.content === record.content) {
      previous.refs.push(record.ref);
      return;
    }
    if (record.kind === 'speech') {
      rows.push({ ...record, refs: [record.ref] });
      return;
    }
    rows.push(record);
  });
  return rows.map((record) => (
    record.kind === 'speech'
      ? `${record.refs.join(',')}: ${record.content}`
      : record.content
  ));
}

export function publicHistoryData(context, timeline, { excludeSpeechEventId = null } = {}) {
  const publicSpeechById = new Map();
  (context.board.publicTimeline?.speeches ?? []).forEach((event) => {
    const logicalIds = event.correctionLineageIds?.length
      ? event.correctionLineageIds
      : [event.id, event.payload?.correctsEventId].filter(Boolean);
    logicalIds.forEach((eventId) => publicSpeechById.set(eventId, event));
  });

  const rows = (timeline.speeches ?? [])
    .filter((event) => event.id !== excludeSpeechEventId)
    .map((event) => speechRecord(context, event, publicSpeechById));
  pushEvents(rows, timeline.voteResults, (event) => compactVoteResultLine(context, event), 'vote');
  pushEvents(rows, timeline.executions, (event) => compactPublicEventLine(context, event), 'execution');
  pushEvents(rows, timeline.dawns, (event) => compactPublicEventLine(context, event), 'dawn');
  pushEvents(rows, timeline.corrections, (event) => compactPublicEventLine(context, event), 'correction');
  pushEvents(rows, timeline.gameResults, (event) => compactPublicEventLine(context, event), 'game-result');
  pushEvents(rows, timeline.other, (event) => compactPublicEventLine(context, event), 'other');

  rows.sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0));
  const merged = mergeConsecutiveIdenticalSpeeches(rows);
  return merged.length ? { timeline: merged } : {};
}

export function selfPublicContinuityData(context, event) {
  if (!event) return null;
  return `#${event.sequence}/D${event.day}/${playerName(context, event.actorId)}: ${String(event?.payload?.text ?? '')}`;
}
