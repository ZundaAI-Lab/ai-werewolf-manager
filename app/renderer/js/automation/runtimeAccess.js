/**
 * 責務: classic automationモジュールからruntimeファサードを取得し、公開契約の欠落を起動時に明示する。
 * 変更ルール: runtimeメソッドを独自列挙しない。bootstrapが公開した契約を正本とし、必須操作をoptional chainingで無視しない。
 */
(function initializeRuntimeAccess(globalScope) {
  'use strict';

  function getRuntime() {
    const contract = globalScope.__AI_WEREWOLF_RUNTIME_CONTRACT__;
    const runtime = globalScope.__AI_WEREWOLF_RUNTIME__;
    if (!contract || !Array.isArray(contract.requiredMethods)) throw new Error('runtime公開契約を読み込めませんでした。');
    if (!runtime) throw new Error('runtimeファサードを読み込めませんでした。');
    const missing = contract.requiredMethods.filter((name) => typeof runtime[name] !== 'function');
    if (missing.length) throw new Error(`runtimeファサードの必須メソッドがありません: ${missing.join(', ')}`);
    return runtime;
  }

  function reportInitializationFailure(error) {
    console.error('デスクトップ自動化の初期化に失敗しました。', error);
    const region = document.querySelector('#toast-region') ?? document.body;
    const notice = document.createElement('div');
    notice.className = 'toast error';
    notice.setAttribute('role', 'alert');
    notice.textContent = `デスクトップ自動化を初期化できません: ${error?.message ?? error}`;
    region.append(notice);
  }

  globalScope.AiWerewolfRuntimeAccess = Object.freeze({ getRuntime, reportInitializationFailure });
}(typeof window === 'undefined' ? globalThis : window));

// bundle側のside-effect ES Moduleとして到達させ、HTMLのscript順序へ依存しない。
export {};
