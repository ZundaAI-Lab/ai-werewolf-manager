/**
 * 責務: 公開履歴のfull・compact・deltaが同じ正常回答境界を使用し、既定差分・無圧縮・過去選別・差分送信・参考視点anchor保持・夜の当日最終巡保持契約を維持することを検証する。
 * 変更ルール: Day境界や文字数切断を圧縮条件にせず、保存済み構造情報・判断根拠・参加者ごとの直近発言と今回の参考視点が参照する公開イベントだけを重要履歴として扱う。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerationStageSource } from '../../../app/renderer/js/prompts/context/generationStageSource.js';
import {
  buildSelectedPublicHistoryEvents,
  normalizePublicHistoryTransmissionMode,
  resolvePublicHistoryMode,
  selectLatestOwnSpeechBeforeDelta,
  selectPublicHistoryTimeline,
} from '../../../app/renderer/js/prompts/policies/publicHistoryPolicy.js';

function speech({ id, actorId, sequence, day = 2, round = null, text = '', structured = null, correctionLineageIds = [] }) {
  return {
    id,
    type: 'public-speech',
    actorId,
    day,
    sequence,
    ...(correctionLineageIds.length ? { correctionLineageIds } : {}),
    payload: {
      text,
      ...(Number.isFinite(round) ? { round } : {}),
      ...(structured ? { structured } : {}),
    },
  };
}

function contextAndDecision() {
  const longOld = `旧発言:${'長'.repeat(260)}`;
  const longRecent = `新規発言:${'新'.repeat(260)}`;
  const events = [
    speech({ id: 'old-ordinary', actorId: 'p1', sequence: 1, day: 1, text: longOld }),
    speech({ id: 'co', actorId: 'p2', sequence: 2, day: 1, text: '占い師CO', structured: { coOperation: { action: 'declare', roleId: 'seer' }, interaction: { questionTargetIds: [], answersEventIds: [] }, abilityClaims: [] } }),
    speech({ id: 'question', actorId: 'p3', sequence: 3, round: 1, text: 'p1への質問', structured: { coOperation: { action: 'none', roleId: 'none' }, interaction: { questionTargetIds: ['p1'], answersEventIds: [] }, abilityClaims: [] } }),
    speech({ id: 'answer', actorId: 'p1', sequence: 4, round: 1, text: '質問への回答', structured: { coOperation: { action: 'none', roleId: 'none' }, interaction: { questionTargetIds: [], answersEventIds: ['question'] }, abilityClaims: [] } }),
    speech({ id: 'evidence-replacement', actorId: 'p4', sequence: 5, round: 1, text: '現在判断が参照する訂正後発言', correctionLineageIds: ['evidence-original', 'evidence-replacement'] }),
    speech({ id: 'latest-p1', actorId: 'p1', sequence: 6, round: 1, text: 'p1の境界以前の直近発言' }),
    speech({ id: 'recent-a', actorId: 'p2', sequence: 7, round: 2, text: longRecent }),
    speech({ id: 'recent-b', actorId: 'p2', sequence: 8, round: 2, text: '同じ参加者の追加発言も省略しない' }),
  ];
  const vote = { id: 'vote', type: 'vote-finalized', sequence: 9, day: 2, payload: {} };
  return {
    context: {
      game: { day: 2 },
      player: { decisionState: { keyPublicEvidenceEventIds: ['evidence-original'] } },
      board: {
        publicTimeline: {
          speeches: events,
          voteResults: [vote],
          executions: [],
          dawns: [],
          corrections: [],
          gameResults: [],
          other: [],
        },
      },
    },
    decision: {
      decisionDelta: {
        sourceSequence: 6,
        newPublicEvents: [events[6], events[7], vote],
      },
    },
    events,
    longOld,
    longRecent,
  };
}

const DAY_SITUATION = Object.freeze({ isBriefing: false, isMemo: false, isResultImpression: false, isNightTask: false });
const NIGHT_SITUATION = Object.freeze({ ...DAY_SITUATION, isNightTask: true });

test('fullは正常回答境界やDayに関係なく公開履歴を全件・全文で維持する', () => {
  const { context, decision, longOld } = contextAndDecision();
  const timeline = selectPublicHistoryTimeline(context, decision, 'full');
  assert.deepEqual(timeline.speeches.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(timeline.speeches[0].payload.text, longOld);
  assert.equal(timeline.speeches[0].payload.text.length > 160, true);
});

test('compactは同じDayの途中にある正常回答境界以前だけを選別し、境界後を全件・全文で維持する', () => {
  const { context, decision, longRecent } = contextAndDecision();
  const timeline = selectPublicHistoryTimeline(context, decision, 'compact');
  assert.deepEqual(timeline.speeches.map((event) => event.sequence), [2, 3, 4, 5, 6, 7, 8]);
  assert.equal(timeline.speeches.some((event) => event.id === 'old-ordinary'), false);
  assert.equal(timeline.speeches.find((event) => event.id === 'recent-a').payload.text, longRecent);
  assert.deepEqual(timeline.voteResults.map((event) => event.sequence), [9]);
  assert.deepEqual(
    buildSelectedPublicHistoryEvents(context, decision, 'compact').map((event) => event.sequence),
    [2, 3, 4, 5, 6, 7, 8, 9],
    '生成工程も本番プロンプトと同じ履歴選択を使用する',
  );
});

test('deltaは既存どおり正常回答境界後のnewPublicEventsだけを分類する', () => {
  const { context, decision } = contextAndDecision();
  const timeline = selectPublicHistoryTimeline(context, decision, 'delta');
  assert.deepEqual(timeline.speeches.map((event) => event.sequence), [7, 8]);
  assert.deepEqual(timeline.voteResults.map((event) => event.sequence), [9]);
});


test('deltaは参考視点が参照する境界以前の公開発言と投票だけを追加同梱する', () => {
  const priorReferencedSpeech = speech({ id: 'prior-ref', actorId: 'p1', sequence: 1, day: 1, text: '参照対象の前日発言' });
  const priorUnreferencedSpeech = speech({ id: 'prior-other', actorId: 'p2', sequence: 2, day: 1, text: '参照されない前日発言' });
  const priorVote = {
    id: 'prior-vote',
    type: 'vote-finalized',
    sequence: 3,
    day: 1,
    payload: { ballots: [{ voterId: 'p3', targetId: 'p2' }] },
  };
  const recentSpeech = speech({ id: 'recent', actorId: 'p2', sequence: 4, day: 2, text: '境界後の当日発言' });
  const recentVote = { id: 'recent-vote', type: 'vote-finalized', sequence: 5, day: 2, payload: {} };
  const context = {
    game: { day: 2 },
    player: { id: 'p4', decisionState: { keyPublicEvidenceEventIds: [] } },
    board: {
      publicTimeline: {
        speeches: [priorReferencedSpeech, priorUnreferencedSpeech, recentSpeech],
        voteResults: [priorVote, recentVote],
        executions: [], dawns: [], corrections: [], gameResults: [], other: [],
      },
    },
  };
  const decision = { decisionDelta: { sourceSequence: 3, newPublicEvents: [recentSpeech, recentVote] } };
  const options = { preserveEventSequences: [1, 3] };
  const timeline = selectPublicHistoryTimeline(context, decision, 'delta', options);
  assert.deepEqual(timeline.speeches.map((event) => event.sequence), [1, 4]);
  assert.deepEqual(timeline.voteResults.map((event) => event.sequence), [3, 5]);
  assert.equal(timeline.speeches.some((event) => event.sequence === 2), false, '参照されていない過去イベントはdeltaへ広げない');
  assert.deepEqual(
    buildSelectedPublicHistoryEvents(context, decision, 'delta', options).map((event) => event.sequence),
    [1, 3, 4, 5],
    '生成工程も同じanchor保持規則を使用する',
  );
});

test('deltaの多段生成stageSourceも参考視点anchorを公開履歴へ引き継ぐ', () => {
  const priorSpeech = speech({ id: 'prior-stage', actorId: 'p1', sequence: 1, day: 1, text: '前日の比較材料' });
  const priorVote = { id: 'prior-stage-vote', type: 'vote-finalized', sequence: 2, day: 1, payload: { ballots: [] } };
  const recentSpeech = speech({ id: 'recent-stage', actorId: 'p2', sequence: 3, day: 2, text: '当日の新規材料' });
  const context = {
    game: {
      id: 'stage-anchor', day: 2, phase: 'discussion',
      rules: { discussion: { answerPriorityEnabled: true }, ai: {} },
      roleComposition: {},
      discussion: { round: 1 },
    },
    task: { type: 'speech' },
    player: {
      id: 'p4', name: '本人', roleId: 'villager', team: 'village', strategyProfile: null,
      character: { speechLength: '標準' }, decisionState: { keyPublicEvidenceEventIds: [] }, knowledge: {},
    },
    board: {
      alive: [
        { id: 'p1', name: '甲' }, { id: 'p2', name: '乙' }, { id: 'p4', name: '本人' },
      ],
      dead: [], claims: [], publicAbilityClaims: [], claimTimingFacts: [], pendingMediumClaimRequirements: [],
      publicTimeline: {
        speeches: [priorSpeech, recentSpeech], voteResults: [priorVote],
        executions: [], dawns: [], corrections: [], gameResults: [], other: [],
      },
    },
    private: { abilityResults: [], personalNotifications: [] },
    ownHistory: {},
    callNames: { rows: [] },
  };
  const decision = { decisionDelta: { sourceSequence: 2, newPublicEvents: [recentSpeech] } };
  const directive = {
    modeId: 'check-consistency', lens: 'consistency', focusPlayerIds: ['p1'], focusPlayerNames: ['甲'],
    anchorEventSequences: [1, 2], publicSequenceAtGeneration: 3, identity: {}, factionOverlay: null,
  };
  const responseContract = {
    mode: 'speech', allowedTopLevelKeys: [], requiredTopLevelKeys: [], optionalTopLevelKeys: [],
    fieldDescriptions: {}, completeExample: {}, conditionalExamples: {},
  };
  const source = buildGenerationStageSource({
    context, decision, taskType: 'speech', playerId: 'p4', slotId: '', validTargetIds: [],
    publicHistoryMode: 'delta', responseContract, internalReasoningDirective: directive,
  });
  assert.deepEqual(source.histories.recentPublicTimeline.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(source.internalReasoningDirective.anchorEventSequences, [1, 2]);
  const projection = source.histories.publicHistoryProjection.timeline.join('\n');
  assert.match(projection, /#1\/D1\/甲/u);
  assert.match(projection, /#2\/D1 投票/u);
  assert.ok(projection.indexOf('#1/') < projection.indexOf('#2/'));
  assert.ok(projection.indexOf('#2/') < projection.indexOf('#3/'));
});

test('compactは構造保持だけでは残らない過去発言も参考視点anchorなら保持する', () => {
  const { context, decision } = contextAndDecision();
  const timeline = selectPublicHistoryTimeline(context, decision, 'compact', {
    preserveEventSequences: [1],
  });
  assert.deepEqual(timeline.speeches.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
});


test('deltaで本人の直近境界前発言がanchor保持済みならさらに古い本人発言を補完しない', () => {
  const { context, decision } = contextAndDecision();
  context.player.id = 'p1';
  const selected = selectPublicHistoryTimeline(context, decision, 'delta', { preserveEventSequences: [6] });
  assert.equal(selectLatestOwnSpeechBeforeDelta(context, decision, 'delta', selected), null);
});

test('deltaは既定値で、境界なしと再同期時だけfullへ戻り、夜タスクは当日最終巡を維持する', () => {
  assert.equal(normalizePublicHistoryTransmissionMode(undefined), 'delta');
  assert.equal(resolvePublicHistoryMode(DAY_SITUATION, { hasHistoryCursor: false }), 'full');
  assert.equal(resolvePublicHistoryMode(DAY_SITUATION, { hasHistoryCursor: true }), 'delta');
  assert.equal(resolvePublicHistoryMode(DAY_SITUATION, { hasHistoryCursor: true, forceFull: true }), 'full');
  assert.equal(resolvePublicHistoryMode(NIGHT_SITUATION, { hasHistoryCursor: true }), 'night-delta');
  assert.equal(resolvePublicHistoryMode(DAY_SITUATION, { transmissionMode: 'compact', hasHistoryCursor: true }), 'compact');
  assert.equal(resolvePublicHistoryMode(NIGHT_SITUATION, { transmissionMode: 'compact', hasHistoryCursor: true }), 'night');

  const { context, decision } = contextAndDecision();
  const night = selectPublicHistoryTimeline(context, decision, 'night');
  assert.deepEqual(night.speeches.map((event) => event.sequence), [7, 8]);
  assert.deepEqual(night.voteResults.map((event) => event.sequence), [9]);
  const nightDelta = selectPublicHistoryTimeline(context, decision, 'night-delta');
  assert.deepEqual(nightDelta.speeches.map((event) => event.sequence), [7, 8]);
  assert.deepEqual(nightDelta.voteResults.map((event) => event.sequence), [9]);
});
