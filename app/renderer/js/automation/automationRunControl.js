/**
 * 責務: 1回の自動実行セッションについて停止状態、実行中API要求ID、中断可能な待機、終了完了通知を一元管理する。
 * 変更ルール: 停止状態と終了待機を画面制御の個別フラグへ分散させない。API要求開始前・応答直後・登録直前はassertRunningを通し、停止済みセッションから新規要求や状態更新を開始しない。一時停止・明示停止ではwaitForCompletionまで待ってから競合操作を解禁する。
 */

(function initializeAutomationRunControl(global) {
  'use strict';

  class AutomationStoppedError extends Error {
    constructor() {
      super('利用者の操作により停止しました。');
      this.name = 'AutomationStoppedError';
      this.code = 'AUTOMATION_STOPPED';
    }
  }

  function createRunSession() {
    const randomId = global.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    return {
      id: `automation-run-${randomId}`,
      abortController: new AbortController(),
      currentRequestId: null,
      stopped: false,
      completed: false,
      completion,
      resolveCompletion,
    };
  }

  function isStopped(session) {
    return !session || session.stopped === true || session.abortController?.signal?.aborted === true;
  }

  function assertRunning(session) {
    if (isStopped(session)) throw new AutomationStoppedError();
    return session;
  }

  function requestStop(session) {
    if (!session || isStopped(session)) return;
    session.stopped = true;
    session.abortController.abort();
  }

  function beginRequest(session, requestId) {
    assertRunning(session);
    session.currentRequestId = String(requestId ?? '');
  }

  function endRequest(session, requestId) {
    if (!session) return;
    if (session.currentRequestId === String(requestId ?? '')) session.currentRequestId = null;
  }

  function delayWithAbort(milliseconds, session) {
    assertRunning(session);
    const delayMs = Math.max(0, Number(milliseconds) || 0);
    return new Promise((resolve, reject) => {
      const signal = session.abortController.signal;
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', handleAbort);
        callback();
      };
      const timerId = global.setTimeout(() => finish(resolve), delayMs);
      function handleAbort() {
        global.clearTimeout(timerId);
        finish(() => reject(new AutomationStoppedError()));
      }
      signal.addEventListener('abort', handleAbort, { once: true });
      if (signal.aborted) handleAbort();
    });
  }

  function completeSession(session) {
    if (!session || session.completed) return false;
    session.completed = true;
    session.resolveCompletion?.();
    session.resolveCompletion = null;
    return true;
  }

  function waitForCompletion(session) {
    if (!session || session.completed) return Promise.resolve();
    return session.completion;
  }

  function isAutomationStoppedError(error) {
    return error?.code === 'AUTOMATION_STOPPED' || error instanceof AutomationStoppedError;
  }

  global.AiWerewolfAutomationRunControl = Object.freeze({
    AutomationStoppedError,
    createRunSession,
    isStopped,
    assertRunning,
    requestStop,
    beginRequest,
    endRequest,
    delayWithAbort,
    completeSession,
    waitForCompletion,
    isAutomationStoppedError,
  });
})(globalThis);

// bundle側のside-effect ES Moduleとして到達させ、HTMLのscript順序へ依存しない。
export {};
