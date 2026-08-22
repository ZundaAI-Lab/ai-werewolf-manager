/**
 * 責務: automationモジュールからbootstrapのruntimeファサードを取得し、公開契約の欠落を起動時に明示する。
 * 変更ルール: runtimeメソッドを独自列挙しない。bootstrapが公開した契約を正本とし、必須操作をoptional chainingで無視しない。初期化失敗の詳細はconsoleだけへ残し、利用者向け通知へ例外本文や機密情報を転記しない。
 */
export function getRuntime() {
  const contract = globalThis.__AI_WEREWOLF_RUNTIME_CONTRACT__;
  const runtime = globalThis.__AI_WEREWOLF_RUNTIME__;
  if (!contract || !Array.isArray(contract.requiredMethods)) throw new Error('runtime公開契約を読み込めませんでした。');
  if (!runtime) throw new Error('runtimeファサードを読み込めませんでした。');
  const missing = contract.requiredMethods.filter((name) => typeof runtime[name] !== 'function');
  if (missing.length) throw new Error(`runtimeファサードの必須メソッドがありません: ${missing.join(', ')}`);
  return runtime;
}

export function reportInitializationFailure(error) {
  console.error('デスクトップ自動化の初期化に失敗しました。', error);
  const region = document.querySelector('#toast-region') ?? document.body;
  const notice = document.createElement('div');
  notice.className = 'toast error';
  notice.setAttribute('role', 'alert');
  notice.textContent = 'デスクトップ自動化を初期化できません。詳細は開発者コンソールに記録しました。';
  region.append(notice);
}
