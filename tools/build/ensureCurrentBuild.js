/**
 * 責務: 開発起動・ソース抽出前にRenderer生成物の鮮度を確認し、不一致時だけ正式ビルド処理で再生成する。ビルド・製造監査に必要なtools依存物が欠落または要求版と不一致の場合は、固定TypeScript版だけをtools/node_modulesへ自己修復する。
 * 変更ルール:
 * - BUILD_ID計算やbundle生成を複製せず、buildIdentity.jsとbuildBundle.jsを使用する。
 * - TypeScript要求版の解釈はbuildToolContract.jsへ委譲し、ここでpackage.json解析規則を重複実装しない。
 * - 依存物の自己修復は呼出元が必要性を判断して実行し、package.json/package-lock.jsonは変更しない。
 * - Renderer再生成時はここで依存を保証し、製造監査前の保証はmanufacturingGate.jsから同じ処理を呼ぶ。再生成後も不一致なら必ず失敗終了する。
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  DEFAULT_PROJECT_ROOT,
  assertGeneratedBuildFreshness,
  inspectGeneratedBuildFreshness,
} = require('./buildIdentity.js');
const { requiredTypescriptVersion } = require('./buildToolContract.js');

function localTypescriptPackagePath(projectRoot) {
  return join(projectRoot, 'tools', 'node_modules', 'typescript', 'package.json');
}


function readInstalledTypescriptVersion(projectRoot) {
  const packagePath = localTypescriptPackagePath(projectRoot);
  if (!existsSync(packagePath)) return null;
  try {
    const version = JSON.parse(readFileSync(packagePath, 'utf8'))?.version;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

function ensureBuildToolDependencies({ projectRoot = DEFAULT_PROJECT_ROOT, spawn = spawnSync } = {}) {
  const toolsRoot = join(projectRoot, 'tools');
  const typescriptVersion = requiredTypescriptVersion(projectRoot);
  const installedVersion = readInstalledTypescriptVersion(projectRoot);
  if (installedVersion === typescriptVersion) return false;

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmArgs = [
    'install',
    '--no-save',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    `typescript@${typescriptVersion}`,
  ];

  const reason = installedVersion ? `現在 ${installedVersion}` : '未導入';
  console.log(`ビルド・製造監査に必要なTypeScript ${typescriptVersion} をtools/node_modulesへ導入します（${reason}）。`);
  const outcome = spawn(npmCommand, npmArgs, {
    cwd: toolsRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (outcome.error) {
    throw new Error(`ビルド・製造監査用TypeScriptの導入を開始できませんでした: ${outcome.error.message}`);
  }
  if (outcome.status !== 0) {
    throw new Error(`ビルド・製造監査用TypeScriptの導入に失敗しました: code=${outcome.status}`);
  }
  const resolvedVersion = readInstalledTypescriptVersion(projectRoot);
  if (resolvedVersion !== typescriptVersion) {
    throw new Error(`ビルド・製造監査用TypeScriptの版が要求と一致しません: required=${typescriptVersion}, installed=${resolvedVersion ?? 'unknown'}`);
  }
  return true;
}

function runBuild({ projectRoot = DEFAULT_PROJECT_ROOT, spawn = spawnSync } = {}) {
  const buildScript = join(projectRoot, 'tools', 'build', 'buildBundle.js');
  const outcome = spawn(process.execPath, [buildScript], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0) throw new Error(`Renderer生成物の再生成に失敗しました: code=${outcome.status}`);
}

function ensureCurrentBuild(options = {}) {
  const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const initial = inspectGeneratedBuildFreshness(projectRoot);
  if (!initial.ok) {
    console.log('Renderer生成物が現行ソースと一致しないため再生成します。');
    ensureBuildToolDependencies({ ...options, projectRoot });
    runBuild({ ...options, projectRoot });
  }
  const verified = assertGeneratedBuildFreshness(projectRoot);
  console.log(`Renderer生成物を確認しました: build=${verified.generatedBuildId}`);
  return verified;
}

if (require.main === module) {
  try {
    ensureCurrentBuild();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  ensureBuildToolDependencies,
  ensureCurrentBuild,
  readInstalledTypescriptVersion,
  runBuild,
};
