/**
 * 責務: Rendererで未捕捉になった同期例外とPromise rejectionを監視し、詳細を開発者コンソールへ残しつつ利用者へ機密情報を含まない要約通知を出す。
 * 変更ルール: エラー本文・スタック・LLM応答・秘密情報をtoastへ転記しない。同一原因の短時間連続通知は抑制し、既存の例外伝播やブラウザ既定ログをpreventDefaultで握り潰さない。
 */

const DEFAULT_DEDUPE_WINDOW_MS = 5000;
const GLOBAL_ERROR_TOAST_KEY = 'global-unhandled-renderer-error';

function normalizedErrorDetails(value) {
  if (value instanceof Error) {
    return {
      name: String(value.name ?? 'Error'),
      message: String(value.message ?? ''),
      stack: String(value.stack ?? ''),
    };
  }
  if (value && typeof value === 'object') {
    return {
      name: String(value.name ?? value.constructor?.name ?? 'Object'),
      message: String(value.message ?? ''),
      stack: String(value.stack ?? ''),
    };
  }
  return { name: typeof value, message: String(value ?? ''), stack: '' };
}

function errorFingerprint(kind, value) {
  const details = normalizedErrorDetails(value);
  return `${kind}:${details.name}:${details.message}:${details.stack.split('\n', 2).join('\n')}`;
}

/**
 * @typedef {Object} GlobalErrorReporterOptions
 * @property {EventTarget} [target]
 * @property {(message: string, type: string, options: { key: string }) => void} [toast]
 * @property {{ error?: (...args: unknown[]) => void }} [logger]
 * @property {() => number} [now]
 * @property {number} [dedupeWindowMs]
 */

/** @param {GlobalErrorReporterOptions} [options] */
export function installGlobalErrorReporter({
  target = window,
  toast,
  logger = console,
  now = () => Date.now(),
  dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
} = {}) {
  if (!target || typeof target.addEventListener !== 'function') throw new TypeError('Rendererエラー監視対象が不正です。');
  if (typeof toast !== 'function') throw new TypeError('Rendererエラー通知関数がありません。');

  let lastFingerprint = '';
  let lastReportedAt = -Infinity;

  function report(kind, value) {
    logger.error?.(
      kind === 'unhandledrejection'
        ? '未処理のPromise rejectionを検出しました。'
        : '未処理のRendererエラーを検出しました。',
      value,
    );
    const fingerprint = errorFingerprint(kind, value);
    const currentTime = Number(now());
    if (fingerprint === lastFingerprint && currentTime - lastReportedAt < dedupeWindowMs) return;
    lastFingerprint = fingerprint;
    lastReportedAt = currentTime;
    toast(
      kind === 'unhandledrejection'
        ? '予期しない非同期処理エラーが発生しました。詳細は開発者コンソールに記録しました。'
        : '予期しない画面エラーが発生しました。詳細は開発者コンソールに記録しました。',
      'error',
      { key: GLOBAL_ERROR_TOAST_KEY },
    );
  }

  function handleError(event) {
    report('error', event?.error ?? event?.message ?? 'unknown renderer error');
  }

  function handleUnhandledRejection(event) {
    report('unhandledrejection', event?.reason ?? 'unknown promise rejection');
  }

  target.addEventListener('error', handleError);
  target.addEventListener('unhandledrejection', handleUnhandledRejection);

  return () => {
    target.removeEventListener?.('error', handleError);
    target.removeEventListener?.('unhandledrejection', handleUnhandledRejection);
  };
}
