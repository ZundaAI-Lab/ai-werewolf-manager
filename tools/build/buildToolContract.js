/**
 * 責務: ビルド・製造監査で使用するツール依存の固定版契約を読み取り、決定的ビルドに使える形だけを受理する。
 * 変更ルール:
 * - TypeScript要求版の正本はtools/package.jsonのdevDependencies.typescriptとし、ここ以外で同じ解析規則を複製しない。
 * - 決定的bundle生成を守るため、TypeScriptはX.Y.Z形式の完全固定版だけを許可し、範囲指定やタグ指定を受理しない。
 * - この契約を変更した場合はbuildIdentity.jsのBUILD_ID入力にも反映される状態を維持する。
 */

'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/u;

function requiredTypescriptVersion(projectRoot) {
  const toolsPackagePath = join(projectRoot, 'tools', 'package.json');
  const toolsPackage = JSON.parse(readFileSync(toolsPackagePath, 'utf8'));
  const version = toolsPackage?.devDependencies?.typescript;
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('tools/package.jsonにTypeScriptの依存バージョンが定義されていません。');
  }
  const normalized = version.trim();
  if (!EXACT_SEMVER_PATTERN.test(normalized)) {
    throw new Error(`TypeScriptの依存バージョンはX.Y.Z形式で完全固定してください: ${normalized}`);
  }
  return normalized;
}

module.exports = {
  EXACT_SEMVER_PATTERN,
  requiredTypescriptVersion,
};
