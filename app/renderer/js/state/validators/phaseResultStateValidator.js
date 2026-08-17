/**
 * 責務: 現在フェーズに必要な進行状態と保存勝者・公開結果・全員感想の終端整合を検査する。
 * 変更ルール: 勝敗はstandardRulesの再計算結果を正本とし、状態遷移やイベント追加を行わない。
 */

import { detectWinner } from '../../domain/game/standardRules.js';


export function validatePhaseAndResultState(context) {
  const { raw, label, errors, events, resultImpressions } = context;
  const phaseRequirements = {
    briefing: () => raw.briefing,
    discussion: () => raw.discussion,
    vote: () => raw.voteSession,
    runoff: () => raw.voteSession,
    execution: () => raw.voteSession?.result?.type === 'execution',
    night: () => raw.night,
    dawn: () => raw.night?.resolution,
    result: () => raw.result,
    ended: () => raw.result?.status === 'published',
  };
  const requirement = phaseRequirements[raw.game.phase];
  if (requirement && !requirement()) errors.push(`${label}: 現在フェーズ${raw.game.phase}に必要な進行状態がありません。`);

  if (['result', 'ended'].includes(raw.game.phase) || raw.game.winner || raw.result) {
    if (raw.game.winner !== raw.result?.winner) errors.push(`${label}: game.winnerとresult.winnerが一致しません。`);
    const detected = detectWinner(raw);
    if (detected && detected.winner !== raw.game.winner) errors.push(`${label}: 生存者から再計算した勝者と保存された勝者が一致しません。`);
    if (!detected && raw.game.phase === 'ended' && raw.result?.winner !== 'draw') errors.push(`${label}: 勝敗条件未成立のままゲームが終了しています。`);
    if (raw.game.phase === 'ended' && !events.some((event) => event.status === 'published' && event.type === 'game-result')) errors.push(`${label}: 終了状態ですが公開ゲーム結果イベントがありません。`);
    if (raw.game.phase === 'ended' && resultImpressions.length !== raw.players.length) errors.push(`${label}: 全員の勝敗後感想が揃う前にゲームが終了しています。`);
    if (raw.game.phase === 'result' && raw.result?.status === 'published' && resultImpressions.length >= raw.players.length) errors.push(`${label}: 全員の勝敗後感想が揃っていますが終了フェーズへ進んでいません。`);
  }
}
