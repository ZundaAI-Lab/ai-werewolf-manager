/**
 * 責務: 共通Promise期限処理が期限超過コードを呼び出し元ごとに保持し、正常完了時は値を透過することを検証する。
 * 変更ルール: 実ファイル保存やElectron終了を行わず、短いテスト用タイマーだけを使用する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { settleWithin } = require('../../../app/main/promiseDeadline.js');

test('期限内に完了したPromiseの値をそのまま返す', async () => {
  assert.equal(await settleWithin(Promise.resolve('ok'), 50, 'timeout'), 'ok');
});

test('期限超過時は呼び出し元指定のエラーコードを返す', async () => {
  await assert.rejects(
    () => settleWithin(new Promise(() => {}), 5, 'チャット保存timeout', { code: 'CHAT_ROOM_FLUSH_TIMEOUT' }),
    (error) => error.code === 'CHAT_ROOM_FLUSH_TIMEOUT' && /チャット保存timeout/u.test(error.message),
  );
});
