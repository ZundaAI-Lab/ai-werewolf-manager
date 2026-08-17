/**
 * 責務: Main終了処理からRendererへ保留中の自動保存送信を要求し、MessagePortで完了を待つ。
 * 変更ルール: ゲーム状態を解釈せず、固定チャンネルと期限付き応答だけを扱う。Renderer不在時は保存対象なしとして成功扱いにする。
 */

'use strict';

const RENDERER_AUTOSAVE_FLUSH_TIMEOUT_MS = 1500;

function rendererFlushError(payload) {
  const error = new Error(String(payload?.message ?? 'Rendererの自動保存送信に失敗しました。'));
  error.code = String(payload?.code ?? 'AUTOSAVE_RENDERER_FLUSH_FAILED');
  return error;
}

function requestRendererAutosaveFlush(browserWindow, {
  createMessageChannel,
  timeoutMs = RENDERER_AUTOSAVE_FLUSH_TIMEOUT_MS,
} = {}) {
  if (!browserWindow || browserWindow.isDestroyed?.() || browserWindow.webContents?.isDestroyed?.()) {
    return Promise.resolve({ ok: true, skipped: true });
  }
  if (typeof createMessageChannel !== 'function') {
    throw new TypeError('Renderer自動保存flush用MessageChannel生成関数がありません。');
  }

  return new Promise((resolve, reject) => {
    const { port1, port2 } = createMessageChannel();
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port1.close?.();
      callback(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`Rendererの自動保存送信が${timeoutMs}ms以内に完了しませんでした。`);
      error.code = 'AUTOSAVE_RENDERER_FLUSH_TIMEOUT';
      settle(reject, error);
    }, timeoutMs);

    port1.on('message', (event) => {
      const result = event?.data ?? {};
      if (result.ok === true) settle(resolve, { ok: true, skipped: false });
      else settle(reject, rendererFlushError(result.error));
    });
    port1.start?.();

    try {
      browserWindow.webContents.postMessage('desktop:flush-autosave-request', null, [port2]);
    } catch (error) {
      settle(reject, error);
    }
  });
}

module.exports = {
  RENDERER_AUTOSAVE_FLUSH_TIMEOUT_MS,
  requestRendererAutosaveFlush,
};
