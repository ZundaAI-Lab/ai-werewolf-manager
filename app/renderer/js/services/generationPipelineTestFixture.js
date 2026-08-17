/**
 * 責務: ゲーム未開始時の生成工程テスト専用に、実ゲームから独立した仮ゲーム状態と本番AIタスク成果物を生成し、その状態だけを使って候補回答を検証する。
 * 変更ルール: 実行中ゲーム、保存状態、DOM、AI設定を変更しない。仮プロンプトもprepareAiTask()とevaluateAiTaskCandidate()の本番経路を使用し、手書きの簡易契約へ置き換えない。
 */

import { acknowledgeRole, markBriefingShown } from '../domain/briefing/briefingCommands.js';
import { startGame } from '../domain/game/gameCommands.js';
import { createInitialState } from '../state/stateStore.js';
import { evaluateAiTaskCandidate, prepareAiTask } from './aiTaskService.js';

const TEST_PLAYER_NAMES = Object.freeze([
  'テスト参加者A',
  'テスト参加者B',
  'テスト参加者C',
  'テスト参加者D',
  'テスト参加者E',
  'テスト参加者F',
]);

const TEST_ROLE_IDS = Object.freeze([
  'villager',
  'villager',
  'seer',
  'guard',
  'madman',
  'wolf',
]);

function requireSuccess(result, operation) {
  if (result?.ok) return;
  throw new Error(`${operation}に失敗しました: ${result?.message ?? '原因不明'}`);
}

function createTestState() {
  const state = createInitialState(TEST_PLAYER_NAMES.length);
  state.game.title = '生成工程テスト用の仮ゲーム';
  state.game.rules.firstNight = {
    ...state.game.rules.firstNight,
    wolfCommunicationEnabled: false,
    wolfAttackEnabled: false,
    seerMode: 'disabled',
    guardEnabled: false,
  };
  state.players.forEach((player, index) => {
    player.name = TEST_PLAYER_NAMES[index];
    player.aliases = [];
    player.characterCardId = null;
    player.callNameOverrides = {};
    player.controller = 'ai';
    player.roleId = TEST_ROLE_IDS[index];
    player.character = {
      ...player.character,
      profile: index === 0 ? '生成工程テスト用の穏やかな参加者。公開情報だけを整理して話す。' : player.character.profile,
      firstPerson: index === 0 ? '私' : player.character.firstPerson,
      genericSecondPerson: index === 0 ? 'みなさん' : player.character.genericSecondPerson,
      speakingStyle: index === 0 ? '簡潔で丁寧な口調。確定情報と推測を分けて話す。' : player.character.speakingStyle,
      defaultEndings: index === 0 ? 'です、ます' : player.character.defaultEndings,
      speechLength: index === 0 ? '標準' : player.character.speechLength,
    };
  });

  requireSuccess(startGame(state), '仮ゲーム開始');
  state.players.forEach((player) => {
    requireSuccess(markBriefingShown(state, player.id), `${player.name}の仮役職通知表示`);
    requireSuccess(acknowledgeRole(state, player.id), `${player.name}の仮役職通知完了`);
  });
  if (state.game.phase !== 'discussion') {
    throw new Error(`仮ゲームが昼議論へ到達しませんでした: ${state.game.phase}`);
  }
  return state;
}

export function createGenerationPipelineTestTask() {
  const state = createTestState();
  const playerId = state.discussion?.queue?.[0] ?? state.players[0]?.id;
  const player = state.players.find((item) => item.id === playerId);
  if (!player) throw new Error('仮ゲームの発言者を決定できませんでした。');

  const taskType = 'speech';
  const slotId = '';
  const taskArtifact = prepareAiTask(state, {
    playerId,
    taskType,
    slotId,
    publicHistoryTransmissionMode: 'full',
    forceFullPublicHistory: true,
  });

  return {
    source: 'fixture',
    request: { playerId, taskType, slotId },
    taskArtifact,
    playerName: player.name,
    gameId: state.game.id,
    promptLabel: '仮ゲーム・Day 1公開発言',
    evaluateCandidate(rawResponse) {
      return evaluateAiTaskCandidate(state, taskArtifact, rawResponse);
    },
  };
}
