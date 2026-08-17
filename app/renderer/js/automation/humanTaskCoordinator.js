/**
 * 責務: 自動実行中の人間操作待ちを同じ進行卓上で表示・フォーカスし、操作完了後に全自動進行を再開する。
 * 変更ルール: 通常進行卓への画面切替や別画面DOMの疑似クリックを行わない。人間操作の登録はui側のhumanPlayerActionControllerを正本とし、このCoordinatorは表示位置と自動再開だけを担当する。
 */

(function initializeAiWerewolfHumanTaskCoordinator(globalScope) {
  'use strict';

  function createHumanTaskCoordinator(context) {
    const {
      controller,
      delay,
      refreshLiveView,
      runLoop,
      runtime,
      setAutomationMode,
      setStatus,
    } = context;

    function clearPendingHumanState() {
      controller.waitingHuman = false;
      controller.pendingHumanTask = null;
    }

    function resumeAutomaticAfterHuman() {
      const shouldResume = controller.resumeAfterHuman;
      controller.resumeAfterHuman = false;
      clearPendingHumanState();
      refreshLiveView();
      if (!shouldResume || controller.running || controller.settings.executionMode !== 'automatic') {
        if (controller.automationMode === 'waiting-human') setAutomationMode('idle');
        return;
      }
      setStatus('人間操作を受け付けました。自動実行を再開します。', 'working');
      window.setTimeout(() => runLoop().catch((error) => {
        setAutomationMode('error', { message: error.message });
        setStatus(`停止: ${error.message}`, 'error');
      }), 120);
    }

    async function openHumanTask() {
      if (controller.automationMode !== 'waiting-human' || !controller.pendingHumanTask) return;
      controller.liveView = true;
      runtime().setTab('workbench');
      await delay(0);
      refreshLiveView();
      await delay(0);
      const card = document.querySelector('#automation-live-view [data-human-task-card]');
      if (!card) throw new Error('人間プレイヤーの操作欄を進行卓へ表示できませんでした。');
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const roleButton = card.querySelector('[data-action="open-human-role-notice"]');
      if (roleButton) {
        roleButton.click();
        return;
      }
      const input = card.querySelector('[data-human-primary-input], textarea, select, input');
      input?.focus({ preventScroll: true });
    }

    return Object.freeze({
      resumeAutomaticAfterHuman,
      openHumanTask,
    });
  }

  globalScope.AiWerewolfHumanTaskCoordinator = Object.freeze({ createHumanTaskCoordinator });
}(typeof window === 'undefined' ? globalThis : window));

export {};
