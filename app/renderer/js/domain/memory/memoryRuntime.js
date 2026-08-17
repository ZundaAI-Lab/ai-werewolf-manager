/**
 * 責務: 内部メモ整理の採用・スキップと手動勝敗確定を実行する。
 * 変更ルール: 自由内部メモとAI監査を分離し、公開状態へ内部内容を追加しない。整理スキップ時は同じ推奨タスクを即時再生成せず、次の追記で再評価する。
 */

import { getPlayer } from '../game/standardRules.js';
import { consolidateInternalMemory } from './memoryLedger.js';


import {
  result,
  commandGuard,
  recordAiTurn,
} from '../game/gameRuntimeShared.js';
import { detectGameResult } from '../result/resultRuntime.js';

export function skipAiMemoConsolidation(state, {
  playerId,
  reason,
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  warnings = [],
} = {}) {
  const guard = commandGuard(state, { allowCorrection: true });
  if (guard) return guard;
  const player = getPlayer(state, playerId);
  if (!player) return result(false, '対象プレイヤーが存在しません。');
  const normalizedReason = String(reason ?? '').trim();
  if (!normalizedReason) return result(false, '内部メモ整理をスキップする理由を入力してください。');
  const turn = recordAiTurn(state, {
    taskType: 'memo-consolidate-fallback',
    playerId,
    promptText,
    promptFingerprint,
    promptMode,
    publicSequenceAtGeneration,
    rawResponse,
    generationRun,
    parsedConsolidatedMemo: '',
    warnings: [...warnings, `内部メモ整理スキップ: ${normalizedReason}`],
    committedEntityIds: [],
  });
  player.internalMemory.consolidationRecommended = false;
  return result(true, `${player.name}の内部メモ整理をスキップし、現在のメモを維持しました。`, { aiTurnId: turn.id });
}

export function consolidatePlayerInternalMemory(state, {
  playerId,
  summary,
  rawResponse = '',
  generationRun = null,
  promptText = '',
  promptFingerprint = '',
  promptMode = 'runtime',
  publicSequenceAtGeneration = 0,
  warnings = [],
}) {
  const guard = commandGuard(state, { allowCorrection: true });
  if (guard) return guard;
  const player = getPlayer(state, playerId);
  if (!player) return result(false, '対象プレイヤーが存在しません。');
  let turn = null;
  if (rawResponse) {
    turn = recordAiTurn(state, {
      taskType: 'memo-consolidate',
      playerId,
      promptText,
      promptFingerprint,
      promptMode,
      publicSequenceAtGeneration,
      rawResponse,
      generationRun,
      parsedConsolidatedMemo: String(summary ?? '').trim(),
      warnings,
      committedEntityIds: [],
    });
  }
  const response = consolidateInternalMemory(state, playerId, summary, {
    sourceAiTurnId: turn?.id ?? null,
    source: rawResponse ? 'ai' : 'gm',
  });
  return result(response.ok, response.message, { aiTurnId: turn?.id ?? null });
}

export function manualFinish(state, team, reason) {
  const guard = commandGuard(state);
  if (guard) return guard;
  detectGameResult(state, { winner: team, reason });
  return result(true, '手動で勝敗を検出しました。');
}
