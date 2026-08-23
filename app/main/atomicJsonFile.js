/**
 * 責務: JSON文字列またはJSON値を同期・非同期の一時ファイルへ書き込み、fsync後のrenameで原子的に永続化する低レベルI/Oを提供する。
 * 変更ルール:
 * - ゲーム状態・チャット・観戦など保存対象の意味解釈、schema検証、migration、保存キュー管理を行わない。
 * - 一時ファイルは保存先と同じディレクトリへ作成し、失敗時に残骸を削除する。
 * - rename後は対応環境で親ディレクトリもfsyncし、未対応エラーだけを限定的に無視する。
 */

'use strict';

const {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { mkdir, open, rename, rm } = require('node:fs/promises');
const { dirname } = require('node:path');

async function fsyncDirectoryBestEffort(directoryPath) {
  let handle = null;
  try {
    handle = await open(directoryPath, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWriteSerializedJson(path, serialized) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let handle = null;
  try {
    handle = await open(temporary, 'w', 0o600);
    await handle.writeFile(`${serialized}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await fsyncDirectoryBestEffort(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicWriteJson(path, value) {
  await atomicWriteSerializedJson(path, JSON.stringify(value));
}

function fsyncDirectoryBestEffortSync(directoryPath) {
  let descriptor = null;
  try {
    descriptor = openSync(directoryPath, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function atomicWriteSerializedJsonSync(path, serialized) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let descriptor = null;
  try {
    descriptor = openSync(temporary, 'w', 0o600);
    writeFileSync(descriptor, `${serialized}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    fsyncDirectoryBestEffortSync(dirname(path));
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

module.exports = {
  atomicWriteJson,
  atomicWriteSerializedJson,
  atomicWriteSerializedJsonSync,
};
