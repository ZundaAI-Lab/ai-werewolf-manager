/**
 * 責務: Rendererの保留状態送信とMain自動保存flushへ期限を設け、成功・失敗・タイムアウトを一つの終了判定へまとめる。
 * 変更ルール: Electron終了操作や画面通知を行わず、渡されたRenderer準備処理とAutosaveStoreのflush・警告記録APIだけを呼ぶ。
 */
'use strict';

const { settleWithin } = require('./promiseDeadline.js');

const AUTOSAVE_FLUSH_TIMEOUT_MS = 5000;
const RENDERER_PREPARE_TIMEOUT_MS = 2000;
const FAILURE_RECORD_TIMEOUT_MS = 750;

async function flushAutosaveForShutdown(autosaveStore, {
  prepareLatestState = null,
  prepareTimeoutMs = RENDERER_PREPARE_TIMEOUT_MS,
  timeoutMs = AUTOSAVE_FLUSH_TIMEOUT_MS,
  failureRecordTimeoutMs = FAILURE_RECORD_TIMEOUT_MS,
} = {}) {
  let failure = null;
  if (typeof prepareLatestState === 'function') {
    try {
      await settleWithin(
        Promise.resolve().then(prepareLatestState),
        prepareTimeoutMs,
        `Rendererの自動保存準備が${prepareTimeoutMs}ms以内に完了しませんでした。`,
        { code: 'AUTOSAVE_FLUSH_TIMEOUT' },
      );
    } catch (error) {
      failure = error;
    }
  }

  try {
    await settleWithin(
      autosaveStore.flush(),
      timeoutMs,
      `終了前の自動保存が${timeoutMs}ms以内に完了しませんでした。`,
      { code: 'AUTOSAVE_FLUSH_TIMEOUT' },
    );
  } catch (error) {
    failure ??= error;
  }

  if (!failure) {
    await autosaveStore.clearShutdownFlushFailure().catch(() => {});
    return { ok: true, error: null };
  }

  await settleWithin(
    autosaveStore.recordShutdownFlushFailure(failure),
    failureRecordTimeoutMs,
    '終了前自動保存失敗の記録が期限内に完了しませんでした。',
    { code: 'AUTOSAVE_FAILURE_RECORD_TIMEOUT' },
  ).catch(() => {});
  return { ok: false, error: failure };
}

module.exports = { AUTOSAVE_FLUSH_TIMEOUT_MS, flushAutosaveForShutdown };
