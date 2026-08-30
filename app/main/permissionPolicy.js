/**
 * 責務: Electron defaultSessionのWeb権限要求・権限確認を全拒否し、未使用のカメラ・マイク・位置情報・通知等を明示的に無効化する。
 * 変更ルール: BrowserWindow生成、IPC、外部URL遷移、ゲーム規則を扱わない。製品でWeb権限が必要になった場合は個別許可を暗黙追加せず、このポリシーと利用箇所を同時に見直す。
 */

'use strict';

function installPermissionDenyPolicy(electronSession) {
  const target = electronSession?.defaultSession;
  if (!target
    || typeof target.setPermissionRequestHandler !== 'function'
    || typeof target.setPermissionCheckHandler !== 'function') {
    throw new TypeError('Electron defaultSessionの権限APIを利用できません。');
  }
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}

module.exports = Object.freeze({ installPermissionDenyPolicy });
