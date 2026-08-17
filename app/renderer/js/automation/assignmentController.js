/**
 * 責務: 参加者割り当て、実行方式表示、一括割り当て結果表示を所有する。
 * 変更ルール: 設定保存と画面遷移を独自実装せず、desktopAutomation.jsから渡された正式依存へ委譲する。AI管理全体のイベント振り分けを持たない。
 */

(function initializeAiWerewolfAssignmentController(globalScope) {
  'use strict';

  function createAssignmentController(context) {
    const {
      assignmentSummary,
      assignmentValidation,
      controller,
      currentGameState,
      persistSettings,
      readinessHtml,
      updateButtons,
    } = context;

    function updateManagementReadouts() {
            const state = currentGameState();
            const validation = assignmentValidation(state);
            const automatic = controller.settings.executionMode !== 'manual';
            document.querySelectorAll('[data-ai-summary-execution]').forEach((node) => {
              node.textContent = automatic ? '自動API実行' : '手動プロンプト';
            });
            document.querySelectorAll('[data-ai-summary-readiness]').forEach((node) => {
              node.textContent = validation.ok ? '実行可能' : `要修正 ${validation.errors.length}件`;
              node.closest('span')?.classList.toggle('is-ready', validation.ok);
              node.closest('span')?.classList.toggle('needs-attention', !validation.ok);
            });
            document.querySelectorAll('[data-ai-assignment-summary]').forEach((node) => {
              node.textContent = assignmentSummary(state);
            });
            const readiness = document.querySelector('[data-ai-readiness]');
            if (readiness) readiness.outerHTML = readinessHtml(state);
            updateButtons();
          }

    function applyManagementExecutionModeUi() {
            const manual = controller.settings.executionMode === 'manual';
            document.querySelectorAll('[data-ai-profile-player-id]').forEach((select) => {
              const assignable = select.dataset.aiProfileAssignable === 'true';
              const locked = select.dataset.aiProfileLocked === 'true';
              select.disabled = manual || !assignable || locked;
            });
            const bulkProfile = document.querySelector('#ai-bulk-profile');
            const bulkButton = document.querySelector('[data-ai-action="bulk-assign"]');
            if (bulkProfile) bulkProfile.disabled = manual;
            if (bulkButton) bulkButton.disabled = manual;
            updateManagementReadouts();
          }

    async function saveAssignment(playerId, profileId) {
            const assignments = { ...controller.settings.assignments, [playerId]: profileId || null };
            await persistSettings({ ...controller.settings, assignments }, { refresh: false, statusMessage: '参加者のAIプロファイル割り当てを保存しました。' });
            updateManagementReadouts();
          }

    function showBulkAssignmentFeedback(message, aiPlayerIds) {
            const feedback = document.querySelector('[data-ai-bulk-feedback]');
            if (feedback) {
              feedback.textContent = message;
              feedback.hidden = false;
            }
            const targets = new Set(aiPlayerIds);
            document.querySelectorAll('[data-ai-assignment-row]').forEach((row) => {
              const updated = targets.has(row.dataset.aiAssignmentRow);
              row.classList.toggle('is-bulk-updated', updated);
              if (updated) window.setTimeout(() => row.classList.remove('is-bulk-updated'), 1200);
            });
          }

    return Object.freeze({
      updateManagementReadouts,
      applyManagementExecutionModeUi,
      saveAssignment,
      showBulkAssignmentFeedback,
    });
  }

  globalScope.AiWerewolfAssignmentController = Object.freeze({ createAssignmentController });
}(typeof window === 'undefined' ? globalThis : window));

// bundle側のside-effect ES Moduleとして到達させ、HTMLのscript順序へ依存しない。
export {};
