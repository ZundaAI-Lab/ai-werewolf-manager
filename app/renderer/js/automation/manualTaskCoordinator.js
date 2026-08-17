/**
 * 責務: AIプロファイル未設定参加者の手動生成待機、進行卓への表示、全自動再開を所有する。
 * 変更ルール: 待機タスクは現在表示中DOMから推測せずrequestをcontrollerへ保持する。画面遷移は利用者が待機タスクを開いた時だけ行い、ゲーム状態は直接変更しない。
 */

(function initializeAiWerewolfManualTaskCoordinator(globalScope) {
  'use strict';

  function createManualTaskCoordinator(context) {
    const {
      controller,
      delay,
      hideLiveView,
      isMatchingAiCommitResult,
      runLoop,
      runtime,
      setAutomationMode,
      setStatus,
    } = context;

    async function openManualAiTask({ resume = false, request = null } = {}) {
        const playerId = String(request?.playerId ?? '');
        const taskType = String(request?.taskType ?? '');
        const slotId = String(request?.slotId ?? '');
        if (!playerId || !taskType) throw new Error('手動生成へ切り替えるAIタスク情報がありません。');
        controller.pendingManualAiTask = { playerId, taskType, slotId };
        controller.resumeAfterManualAi = Boolean(resume);
        const guidance = resume
          ? 'AIプロファイル未設定の参加者です。進行卓でプロンプトを手動生成し、JSON回答を登録してください。登録後は全自動進行へ戻ります。'
          : 'AIプロファイル未設定の参加者です。進行卓でプロンプトを手動生成し、JSON回答を登録してください。';
        runtime().toast(guidance, 'warning', {
          key: 'manual-ai-generation',
          forceDisplay: true,
          durationMs: 0,
          source: 'automatic-run',
        });
      }

    async function showPendingManualAiTask() {
        if (!controller.pendingManualAiTask) return;
        hideLiveView();
        runtime().setTab('workbench');
        await delay(0);
        const button = document.querySelector('#app-content [data-action="commit-ai"]');
        if (!button) throw new Error('手動AI生成タスクを進行卓へ表示できませんでした。');
      }

    function resumeAutomaticAfterManualAi() {
        if (!controller.resumeAfterManualAi || controller.running || controller.settings.executionMode !== 'automatic') return;
        controller.resumeAfterManualAi = false;
        window.setTimeout(() => runLoop().catch((error) => { setAutomationMode('error', { message: error.message }); setStatus(`停止: ${error.message}`, 'error'); }), 120);
      }

    function handleManualAiCommitResult(detail) {
        const pending = controller.pendingManualAiTask;
        if (!pending || detail?.ok !== true || !isMatchingAiCommitResult(detail, pending)) return false;
        const shouldResume = controller.resumeAfterManualAi;
        controller.pendingManualAiTask = null;
        runtime().dismissToast('manual-ai-generation');
        setStatus('手動生成のAI回答を登録しました。', 'success');
        if (shouldResume) resumeAutomaticAfterManualAi();
        else setAutomationMode('idle');
        return true;
      }

    return Object.freeze({
      openManualAiTask,
      showPendingManualAiTask,
      resumeAutomaticAfterManualAi,
      handleManualAiCommitResult,
    });
  }

  globalScope.AiWerewolfManualTaskCoordinator = Object.freeze({ createManualTaskCoordinator });
}(typeof window === 'undefined' ? globalThis : window));

// bundle側のside-effect ES Moduleとして到達させ、HTMLのscript順序へ依存しない。
export {};
