/**
 * 責務: 現在のゲーム状態から、同一状態を基準に並列生成または一括処理しても既存ワークフロー順を壊さない連続AIタスク群を純粋導出する。
 * 変更ルール: DOM・AIプロファイル・通信先・並列数設定を参照しない。公開逐次投票、秘密会話、昼発言、家主選択など先行入力へ依存する処理は並列対象にしない。発言希望制の開始時希望と勝敗後感想は人間入力境界を越えて先行生成しない。内部メモ整理は通信中プレイヤーを呼び出し側から明示的に除外できるが、その一時状態をゲームstateへ保存しない。初期役職通知はAPI生成を伴わないため共有stateへ同時書き込みせず、連続AI分を同一自動実行ステップ群として一括処理する。実際の状態登録順は既存workflowと各domain runtimeを正本とする。
 */

import { getCurrentGmTask } from './workflow.js';
import { getDiscussionEligiblePlayerIds } from './playerStatus.js';
import { getPublishedResultImpressions } from '../result/resultImpressions.js';
import { getPendingNightSlots } from '../../state/selectors.js';

const PARALLEL_NIGHT_TASK_TYPES = new Set(['inspect', 'guard', 'visit', 'freeze']);
const COMPLETED_BRIEFING_STATUSES = new Set(['acknowledged', 'gm-forced']);

function noBatch(reason = '') {
  return Object.freeze({ kind: 'none', reason });
}

function aiPlayer(state, playerId) {
  return (state.players ?? []).find((player) => String(player?.id ?? '') === String(playerId ?? '') && player.controller === 'ai') ?? null;
}

function taskRequest(playerId, taskType, slotId = '') {
  return Object.freeze({
    playerId: String(playerId ?? ''),
    taskType: String(taskType ?? ''),
    slotId: String(slotId ?? ''),
  });
}

function commandRequest(command, label, playerId = '') {
  return Object.freeze({
    command: String(command ?? ''),
    label: String(label ?? command ?? ''),
    playerId: String(playerId ?? ''),
  });
}

function aiBatch(taskRequests, source) {
  if (taskRequests.length < 2) return noBatch('並列生成できる連続AIタスクが2件未満です。');
  return Object.freeze({
    kind: 'ai-task-batch',
    source,
    taskRequests: Object.freeze(taskRequests),
  });
}

function commandBatch(commandRequests, source) {
  if (commandRequests.length < 2) return noBatch('一括処理できる連続AIコマンドが2件未満です。');
  return Object.freeze({
    kind: 'command-batch',
    source,
    commandRequests: Object.freeze(commandRequests),
  });
}

function memoConsolidationBatch(state, ignoredPlayerIds = []) {
  const ignored = new Set((ignoredPlayerIds ?? []).map((playerId) => String(playerId ?? '')));
  const requests = (state.players ?? [])
    .filter((player) => player.controller === 'ai'
      && player.internalMemory?.consolidationRecommended === true
      && !ignored.has(String(player.id ?? '')))
    .map((player) => taskRequest(player.id, 'memo-consolidate'));
  return aiBatch(requests, 'memo-consolidation');
}

function briefingBatch(state) {
  if (state.game?.phase !== 'briefing' || !state.briefing) return noBatch();
  const requests = [];
  for (const playerId of state.briefing.eligiblePlayerIds ?? []) {
    if (COMPLETED_BRIEFING_STATUSES.has(state.briefing.noticeStatusByPlayerId?.[playerId])) continue;
    if (!aiPlayer(state, playerId)) break;
    requests.push(commandRequest('complete-ai-briefing', 'AI役職通知', playerId));
  }
  return commandBatch(requests, 'briefing');
}

function discussionOpeningPreferenceBatch(state) {
  const discussion = state.discussion;
  if (state.game?.phase !== 'discussion'
    || discussion?.mode !== 'free'
    || discussion.modeControl?.type !== 'free'
    || discussion.modeControl.stage !== 'opening-preference') return noBatch();
  const submitted = discussion.modeControl.openingPreferenceByPlayerId ?? {};
  const requests = [];
  for (const playerId of getDiscussionEligiblePlayerIds(state)) {
    if (Object.hasOwn(submitted, playerId)) continue;
    if (!aiPlayer(state, playerId)) break;
    requests.push(taskRequest(playerId, 'discussion-opening-preference'));
  }
  return aiBatch(requests, 'discussion-opening-preference');
}

function resultImpressionBatch(state) {
  if (state.game?.phase !== 'result' || state.result?.status !== 'published') return noBatch();
  const completed = new Set(getPublishedResultImpressions(state).map((event) => String(event.actorId ?? '')));
  const requests = [];
  for (const player of state.players ?? []) {
    if (completed.has(String(player.id ?? ''))) continue;
    if (player.controller !== 'ai') break;
    requests.push(taskRequest(player.id, 'result-impression'));
  }
  return aiBatch(requests, 'result-impression');
}

function secretVoteBatch(state) {
  const session = state.voteSession;
  if (!session || session.status !== 'input' || session.inputMode !== 'sequential') return noBatch();
  if (state.game?.rules?.vote?.visibilityDuringInput !== 'secret') return noBatch('逐次公開投票は先行票へ依存するため並列生成しません。');
  const startIndex = Math.max(0, Number(session.currentVoterIndex ?? 0));
  const requests = [];
  for (let index = startIndex; index < session.eligibleVoterIds.length; index += 1) {
    const voterId = session.eligibleVoterIds[index];
    if (Object.hasOwn(session.votes ?? {}, voterId)) continue;
    if (!aiPlayer(state, voterId)) break;
    requests.push(taskRequest(voterId, 'vote'));
  }
  return aiBatch(requests, 'secret-vote');
}

function wolfAttackBatch(state) {
  const attack = state.night?.wolfAttack;
  if (!attack || attack.status !== 'voting') return noBatch();
  const requests = [];
  for (const wolfId of attack.voterWolfIds ?? []) {
    if (attack.voteByWolfId?.[wolfId]) continue;
    if (!aiPlayer(state, wolfId)) break;
    requests.push(taskRequest(wolfId, 'wolf-attack'));
  }
  return aiBatch(requests, 'wolf-attack');
}

function nightActionBatch(state) {
  const requests = [];
  for (const slot of getPendingNightSlots(state)) {
    if (!PARALLEL_NIGHT_TASK_TYPES.has(slot.type)) break;
    if (!aiPlayer(state, slot.actorId)) break;
    requests.push(taskRequest(slot.actorId, slot.type, slot.id));
  }
  return aiBatch(requests, 'night-actions');
}

export function resolveAutomaticAiBatch(state, { ignoredMemoConsolidationPlayerIds = [] } = {}) {
  if (!state?.game) return noBatch('ゲーム状態を取得できません。');
  if (state.game.correctionMode?.enabled) return noBatch('訂正モード中です。');

  const memoBatch = memoConsolidationBatch(state, ignoredMemoConsolidationPlayerIds);
  if (memoBatch.kind !== 'none') return memoBatch;

  const currentTask = getCurrentGmTask(state, { ignoredMemoConsolidationPlayerIds });
  if (currentTask.type === 'briefing') return briefingBatch(state);
  if (currentTask.type === 'discussion-opening-preference') return discussionOpeningPreferenceBatch(state);
  if (currentTask.type === 'result-impression') return resultImpressionBatch(state);
  if (currentTask.type === 'vote') return secretVoteBatch(state);
  if (currentTask.type === 'wolf-attack') return wolfAttackBatch(state);
  if (PARALLEL_NIGHT_TASK_TYPES.has(currentTask.type)) return nightActionBatch(state);
  return noBatch('現在タスクは並列生成または一括処理の対象ではありません。');
}
