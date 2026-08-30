/**
 * 責務: Electron defaultSessionで未使用Web権限を要求時・確認時とも全拒否するMain防御境界を検証する。
 * 変更ルール: BrowserWindow・IPC・OS権限そのものを模擬せず、permissionPolicy.jsが登録する判定だけを固定する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installPermissionDenyPolicy } = require('../../../app/main/permissionPolicy.js');

test('defaultSessionはWeb権限要求と権限確認を常に拒否する', () => {
  let requestHandler = null;
  let checkHandler = null;
  const electronSession = {
    defaultSession: {
      setPermissionRequestHandler(handler) { requestHandler = handler; },
      setPermissionCheckHandler(handler) { checkHandler = handler; },
    },
  };
  installPermissionDenyPolicy(electronSession);
  let decision = true;
  requestHandler({}, 'media', (allowed) => { decision = allowed; });
  assert.equal(decision, false);
  assert.equal(checkHandler({}, 'notifications', 'file:///app/index.html', {}), false);
});

test('defaultSession権限APIが利用できない場合は起動時に明示失敗する', () => {
  assert.throws(() => installPermissionDenyPolicy({ defaultSession: {} }), /権限API/u);
});
