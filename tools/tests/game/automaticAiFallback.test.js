/**
 * 責務: AI必須項目を取得できない場合でも、回収済みの任意項目を保持し、発言フォールバック・行動ランダム代替・優先回答スキップ・感想スキップで状態を進められることを検証する。
 * 変更ルール: API通信や画面DOMへ依存せず、正式ドメインコマンドと保存状態検証を通して公開／私有境界と進行継続だけを固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameCallNameSnapshot } from '../../../app/renderer/js/characters/callNames/callNameResolver.js';
import { manualFinish, startGame } from '../../../app/renderer/js/domain/game/gameCommands.js';
import {
  recordAiSpeechPass,
  recordHumanSpeech,
  skipAiPriorityAnswer,
} from '../../../app/renderer/js/domain/discussion/discussionCommands.js';
import {
  confirmGameResult,
  publishGameResult,
  skipResultImpression,
} from '../../../app/renderer/js/domain/result/resultCommands.js';
import { skipAiMemoConsolidation } from '../../../app/renderer/js/domain/memory/memoryCommands.js';
import { acknowledgeRole, markBriefingShown } from '../../../app/renderer/js/domain/briefing/briefingCommands.js';
import { recordRandomNightAction } from '../../../app/renderer/js/domain/night/nightCommands.js';
import { getNightActionCandidates } from '../../../app/renderer/js/domain/game/standardRules.js';
import { createInitialState } from '../../../app/renderer/js/state/stateStore.js';
import { validateImportedState } from '../../../app/renderer/js/state/stateValidator.js';
import { synchronizePlayerKnowledgeForTest } from './testStateHelpers.js';

function discussionFixture({ remaining = null } = {}) {
  const state = createInitialState(4);
  state.game.phase = 'discussion';
  state.game.day = 1;
  const ids = state.players.map((player) => player.id);
  state.discussion = {
    day: 1,
    mode: 'ordered',
    modeControl: null,
    round: 1,
    roundKind: 'normal',
    roundStartedAtSequence: 0,
    roundEligiblePlayerIds: [...ids],
    queue: [...ids],
    currentIndex: 0,
    designatedPlayerId: null,
    spokenInCurrentRound: [],
    deferredPlayerIds: [],
    deferredCountByPlayer: Object.fromEntries(ids.map((id) => [id, 0])),
    allDeferred: false,
    remainingByPlayer: remaining ?? Object.fromEntries(ids.map((id) => [id, 2])),
    reconsideration: {
      pending: false,
      active: false,
      items: [],
      reasons: [],
      sourceEventIds: [],
      affectedPlayerIds: [],
      updatedAt: null,
      handledRound: null,
    },
    completed: false,
  };
  synchronizePlayerKnowledgeForTest(state);
  return { state, ids };
}

function assertValidState(state) {
  const validation = validateImportedState(state);
  assert.equal(validation.ok, true, validation.errors?.join('\n'));
}

test('公開発言必須本文の失敗はパスで進め、心の声と内部メモを保持する', () => {
  const { state, ids } = discussionFixture();
  const response = recordAiSpeechPass(state, {
    playerId: ids[0],
    heartVoice: '公開本文は壊れたが、この内心は回収できた。',
    internalMemoUpdate: { mode: 'add', text: '回収済みの内部メモを保持する。' },
    rawResponse: '{"heartVoice":"公開本文は壊れたが、この内心は回収できた。","memoAdd":"回収済みの内部メモを保持する。"}',
    promptText: '発言プロンプト',
    promptFingerprint: 'fallback-speech',
    promptMode: 'runtime',
    publicSequenceAtGeneration: 0,
    warnings: ['自動代替'],
  });

  assert.equal(response.ok, true, response.message);
  const event = state.events.find((item) => item.id === response.eventId);
  const turn = state.aiTurns.find((item) => item.id === response.aiTurnId);
  assert.equal(event.payload.pass, true);
  assert.equal(event.payload.text, '発言なし');
  assert.equal(turn.taskType, 'speech-fallback');
  assert.equal(turn.parsedHeartVoice, '公開本文は壊れたが、この内心は回収できた。');
  assert.equal(turn.parsedInternalMemoUpdate.text, '回収済みの内部メモを保持する。');
  assert.match(state.players[0].heartVoice, /この内心は回収できた/u);
  assertValidState(state);
});

test('AI失敗時のランダム夜行動は注入した乱数で決定的に対象を選べる', () => {
  const state = createInitialState(4);
  const roles = ['wolf', 'seer', 'villager', 'villager'];
  state.players.forEach((player, index) => {
    player.roleId = roles[index];
    player.controller = 'ai';
  });
  state.game.rules.firstNight.wolfCommunicationEnabled = false;
  state.game.rules.firstNight.wolfAttackEnabled = false;
  state.game.rules.firstNight.seerMode = 'choose';
  assert.equal(startGame(state).ok, true);
  state.players.forEach((player) => {
    assert.equal(markBriefingShown(state, player.id).ok, true);
    assert.equal(acknowledgeRole(state, player.id).ok, true);
  });
  assert.equal(state.game.phase, 'night');
  const slot = state.night.slots.find((item) => item.type === 'inspect' && item.status === 'pending');
  assert.ok(slot);
  const candidates = getNightActionCandidates(state, slot.type, slot.actorId);
  assert.ok(candidates.length >= 2);

  const response = recordRandomNightAction(state, slot.id, '決定的ランダム夜行動テスト', { random: () => 0.999999 });
  assert.equal(response.ok, true, response.message);
  assert.equal(slot.targetId, candidates.at(-1).id);
  assert.equal(slot.override.selectedBy, 'random');
  assertValidState(state);
});

