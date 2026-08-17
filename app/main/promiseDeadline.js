/**
 * 責務: Mainプロセスの終了待機などで使うPromiseへ期限を付け、期限超過を構造化したErrorとして返す。
 * 変更ルール: 永続化・Electron終了・ログ記録を行わず、渡されたPromiseの完了待機とタイマー解放だけを担当する。呼び出し元固有のエラーコードと文言は引数で受け取る。
 */

'use strict';

async function settleWithin(promise, timeoutMs, message, { code = 'OPERATION_TIMEOUT' } = {}) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = code;
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { settleWithin };
