/**
 * 責務: GM進行卓の3カラム骨格、フェーズ概要、プレイヤー相関図ダイアログへの確認導線、自動実行時の停止・再開導線を描画する。
 * 変更ルール: タスク固有フォーム・状態更新・ゲーム規則判定を持たない。
 */

import { PHASE_LABELS } from '../../../config/constants.js';
import { escapeHtml } from '../../../shared/utils.js';

export function renderWorkbenchShell({ state, task, executionMode, automationMode, phaseSteps, ruleStrip, playerStatusList, taskHtml }) {
  const automatic = executionMode === 'automatic';
  const pauseButton = automatic && automationMode === 'running' && !state.game.correctionMode.enabled && !['ended', 'result'].includes(state.game.phase)
    ? '<button class="button ghost small" data-ai-action="pause-automatic" type="button">一時停止</button>'
    : automatic && automationMode === 'paused'
      ? '<button class="button primary small" data-ai-action="resume-automatic" type="button">再開</button>'
      : '';
  return `<section class="page workbench-page">
    <div class="page-head">
      <div><span class="eyebrow">GM進行卓</span><h2>Day ${state.game.day}・${escapeHtml(PHASE_LABELS[state.game.phase] ?? state.game.phase)}</h2><p>${escapeHtml(task.label)}</p></div>
      <div class="rule-strip">${ruleStrip}</div>
    </div>
    ${state.game.correctionMode.enabled ? `<div class="alert danger-alert"><strong>訂正モード中</strong><span>${escapeHtml(state.game.correctionMode.reason)}</span><button class="button" data-action="exit-correction" type="button">訂正モード終了</button></div>` : ''}
    <div class="workbench-grid">
      <aside class="progress-panel panel"><h3>進行手順</h3>${phaseSteps}</aside>
      <main class="task-panel panel">${taskHtml}</main>
      <aside class="players-panel panel"><div class="panel-title-row"><h3>プレイヤー状態</h3><div class="panel-title-actions"><span>${state.players.filter((player) => player.alive).length}/${state.players.length} 生存</span><button class="button ghost small" data-action="open-player-relationship-dialog" type="button">相関図</button></div></div>${playerStatusList}</aside>
    </div>
    <div class="action-history"><span>最後の操作: ${escapeHtml(state.lastActionLabel || 'なし')}</span>${pauseButton}</div>
  </section>`;
}
