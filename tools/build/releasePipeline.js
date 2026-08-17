/**
 * 責務: tools配下の固定依存導入、製造事前検査付き生成物更新、全検査、Windows配布版生成、利用者README・本体MIT License・Electron/Chromium第三者ライセンス同梱確認、output/dist整理、SHA-256・報告生成を単一手順で完了させる。
 * 変更ルール: appの業務処理を扱わない。buildBundle.jsが正式生成物の書換え前に製造事前ゲートを実行し、本パイプラインは生成後の完全製造ゲートで鮮度も検証する。README、本体LICENSE.txt、Electron/Chromiumの第三者ライセンスは展開済みWindowsアプリで確認してから中間ディレクトリを削除する。停止対象はtools/node_modules配下Electronだけとし、失敗時はoutput/distの不完全成果物を残さない。
 */

'use strict';

const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { basename, join } = require('node:path');

const toolsRoot = join(__dirname, '..');
const projectRoot = join(toolsRoot, '..');
const appRoot = join(projectRoot, 'app');
const outputRoot = join(projectRoot, 'output');
const distDir = join(outputRoot, 'dist');
const appPackagePath = join(appRoot, 'package.json');
const toolsPackagePath = join(toolsRoot, 'package.json');
const builderConfigPath = join(__dirname, 'electron-builder.json');
const minimumNodeVersion = Object.freeze([22, 12, 0]);
const retainedExtensions = new Set(['.exe', '.zip']);
const electronBuilderVersion = '26.15.3';
const dependencyInstallAttempts = 2;
const projectElectronExecutable = join(toolsRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const packagedUserReadmeName = 'README.txt';
const packagedLicenseName = 'LICENSE.txt';
const packagedElectronLicenseName = 'LICENSE.electron.txt';
const packagedChromiumLicensesName = 'LICENSES.chromium.html';

function parseVersion(value) {
  const match = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/u);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function assertReleaseEnvironment({ platform = process.platform, nodeVersion = process.version } = {}) {
  if (platform !== 'win32') throw new Error('Windows配布版の生成はWindows環境で実行してください。GitHub Actionsのwindows-latestでも実行できます。');
  const parsed = parseVersion(nodeVersion);
  if (!parsed || compareVersions(parsed, minimumNodeVersion) < 0) {
    throw new Error(`Node.js 22.12.0以上が必要です。現在値: ${nodeVersion}`);
  }
}

function normalizedTagVersion(value) {
  return String(value ?? '').trim().replace(/^v/u, '');
}

function assertTagMatchesPackageVersion(packageVersion, environment = process.env) {
  const refType = String(environment.GITHUB_REF_TYPE ?? '').trim();
  const refName = String(environment.GITHUB_REF_NAME ?? '').trim();
  if (refType !== 'tag' || !refName) return;
  const tagVersion = normalizedTagVersion(refName);
  if (tagVersion !== packageVersion) throw new Error(`Gitタグとapp/package.jsonの版番号が一致しません: tag=${refName}, package=${packageVersion}`);
}

function runNode(args, label, cwd = projectRoot) {
  const outcome = spawnSync(process.execPath, args, { cwd, env: process.env, stdio: 'inherit' });
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0) throw new Error(`${label}に失敗しました。終了コード: ${outcome.status}`);
}

function cleanDist() {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
}

function npmInvocation(args, { platform = process.platform, environment = process.env } = {}) {
  const normalizedArgs = args.map(String);
  if (platform !== 'win32') return Object.freeze({ command: 'npm', args: Object.freeze(normalizedArgs) });
  for (const token of normalizedArgs) {
    if (!/^[A-Za-z0-9@./:_=+\-]+$/u.test(token)) throw new Error(`Windows npm呼び出しへ安全でない引数が指定されました: ${token}`);
  }
  const commandInterpreter = String(environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe').trim() || 'cmd.exe';
  return Object.freeze({ command: commandInterpreter, args: Object.freeze(['/d', '/s', '/c', ['npm.cmd', ...normalizedArgs].join(' ')]) });
}

function sleepSync(milliseconds) {
  const blocker = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(blocker, 0, 0, milliseconds);
}

function encodePowerShellCommand(source) {
  return Buffer.from(source, 'utf16le').toString('base64');
}

function stopProjectElectronProcesses({ platform = process.platform, electronExecutable = projectElectronExecutable, spawn = spawnSync } = {}) {
  if (platform !== 'win32' || !existsSync(electronExecutable)) return 0;
  const script = [
    '$target = [System.IO.Path]::GetFullPath($env:AIWM_ELECTRON_PATH)',
    '$matches = @(Get-Process electron -ErrorAction SilentlyContinue | Where-Object {',
    '  try { $_.Path -and [System.IO.Path]::GetFullPath($_.Path).Equals($target, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }',
    '})',
    'foreach ($process in $matches) { Stop-Process -Id $process.Id -Force -ErrorAction Stop }',
    '[Console]::Out.Write($matches.Count)',
  ].join('\n');
  const outcome = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(script)], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, AIWM_ELECTRON_PATH: electronExecutable },
  });
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0) throw new Error(`実行中の開発版Electronを停止できませんでした。終了コード: ${outcome.status}\n${String(outcome.stderr ?? '').trim()}`);
  const stoppedCount = Number.parseInt(String(outcome.stdout ?? '').trim(), 10) || 0;
  if (stoppedCount > 0) console.log(`実行中の開発版Electronを${stoppedCount}プロセス停止しました。`);
  return stoppedCount;
}

const RETRYABLE_NPM_FILE_LOCK_CODES = new Set(['EBUSY', 'ENOTEMPTY']);

function npmFailureText(outcome) {
  return [outcome?.error?.message, outcome?.stdout, outcome?.stderr]
    .filter((value) => value !== undefined && value !== null)
    .map(String)
    .join('\n');
}

function isRetryableNpmCiFailure(outcome) {
  const errorCode = String(outcome?.error?.code ?? '').toUpperCase();
  if (RETRYABLE_NPM_FILE_LOCK_CODES.has(errorCode)) return true;
  const text = npmFailureText(outcome);
  if (/\b(?:EBUSY|ENOTEMPTY)\b/u.test(text)) return true;
  return /\bEPERM\b[\s\S]{0,240}\b(?:unlink|rmdir|rename)\b|\b(?:unlink|rmdir|rename)\b[\s\S]{0,240}\bEPERM\b/iu.test(text)
    && /(?:node_modules|electron(?:\.exe)?)/iu.test(text);
}

function writeCapturedProcessOutput(outcome, output = process) {
  if (outcome?.stdout) output.stdout.write(String(outcome.stdout));
  if (outcome?.stderr) output.stderr.write(String(outcome.stderr));
}

function installLockedDependencies({ attempts = dependencyInstallAttempts, platform = process.platform, environment = process.env, spawn = spawnSync, stopElectron = stopProjectElectronProcesses, wait = sleepSync, output = process } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    stopElectron();
    console.log(`\n[依存関係 ${attempt}/${attempts}] tools/package-lock.jsonの固定内容を導入しています...`);
    const invocation = npmInvocation(['ci', '--no-audit', '--no-fund'], { platform, environment });
    const outcome = spawn(invocation.command, invocation.args, {
      cwd: toolsRoot,
      env: environment,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    writeCapturedProcessOutput(outcome, output);
    if (outcome.status === 0 && !outcome.error) return;

    const retryable = isRetryableNpmCiFailure(outcome);
    if (retryable && attempt < attempts) {
      console.warn('npm ciがWindowsファイルロックで失敗しました。ロック解放を待って再試行します。');
      wait(1200);
      continue;
    }

    if (outcome.error && !retryable) throw outcome.error;
    const reason = retryable ? 'Windowsファイルロックが解消しませんでした。' : '再試行対象外のエラーです。';
    throw new Error(`固定依存関係の導入に失敗しました。終了コード: ${outcome.status ?? 'unknown'}。${reason}`);
  }
}

function buildWindowsArtifacts() {
  const invocation = npmInvocation([
    'exec', '--yes', `--package=electron-builder@${electronBuilderVersion}`, '--',
    'electron-builder', '--projectDir', '../app', '--config', '../tools/build/electron-builder.json',
    '--win', '--x64', '--publish', 'never',
  ]);
  const outcome = spawnSync(invocation.command, invocation.args, { cwd: toolsRoot, env: process.env, stdio: 'inherit' });
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0) throw new Error(`Electron Windows配布版の生成に失敗しました。終了コード: ${outcome.status}`);
}

function extensionOf(filename) {
  const index = filename.lastIndexOf('.');
  return index >= 0 ? filename.slice(index).toLowerCase() : '';
}

function removeBuilderIntermediates(directory = distDir) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) rmSync(absolute, { recursive: true, force: true });
    else if (!retainedExtensions.has(extensionOf(entry.name))) rmSync(absolute, { force: true });
  }
}

function assertPackagedUserReadme(packagedAppDirectory = join(distDir, 'win-unpacked')) {
  const readmePath = join(packagedAppDirectory, packagedUserReadmeName);
  if (!existsSync(readmePath) || !statSync(readmePath).isFile()) {
    throw new Error(`配布版へユーザー向けREADMEが同梱されていません: ${readmePath}`);
  }
  const contents = readFileSync(readmePath, 'utf8').trim();
  if (contents.length < 100 || !contents.includes('AI人狼マネージャー ユーザー向けREADME')) {
    throw new Error(`配布版のユーザー向けREADMEが空、または内容が不正です: ${readmePath}`);
  }
  return readmePath;
}

function assertPackagedLicense(packagedAppDirectory = join(distDir, 'win-unpacked')) {
  const licensePath = join(packagedAppDirectory, packagedLicenseName);
  if (!existsSync(licensePath) || !statSync(licensePath).isFile()) {
    throw new Error(`配布版へMIT Licenseが同梱されていません: ${licensePath}`);
  }
  const contents = readFileSync(licensePath, 'utf8').trim();
  if (!contents.startsWith('MIT License')
    || !contents.includes('Copyright (c) 2026 ずんだあい')
    || !contents.includes('Permission is hereby granted, free of charge')
    || !contents.includes('上記MIT Licenseは、AI人狼マネージャー本体の独自コードに適用されます。')
    || !contents.includes('第三者が権利を有するキャラクター、名称、ロゴ、AIサービス、その他の第三者素材には適用されません。')) {
    throw new Error(`配布版のLICENSE.txtがMIT License本文または適用範囲注記として不正です: ${licensePath}`);
  }
  return licensePath;
}

function assertPackagedRuntimeLicenses(packagedAppDirectory = join(distDir, 'win-unpacked')) {
  const electronLicensePath = join(packagedAppDirectory, packagedElectronLicenseName);
  const chromiumLicensesPath = join(packagedAppDirectory, packagedChromiumLicensesName);
  if (!existsSync(electronLicensePath) || !statSync(electronLicensePath).isFile()) {
    throw new Error(`配布版へElectronライセンスが同梱されていません: ${electronLicensePath}`);
  }
  if (!existsSync(chromiumLicensesPath) || !statSync(chromiumLicensesPath).isFile()) {
    throw new Error(`配布版へChromium第三者ライセンス一覧が同梱されていません: ${chromiumLicensesPath}`);
  }
  const electronLicense = readFileSync(electronLicensePath, 'utf8').trim();
  if (electronLicense.length < 500 || !electronLicense.includes('Permission is hereby granted')) {
    throw new Error(`配布版のElectronライセンス内容が不正です: ${electronLicensePath}`);
  }
  if (statSync(chromiumLicensesPath).size < 1024) {
    throw new Error(`配布版のChromium第三者ライセンス一覧が空、または小さすぎます: ${chromiumLicensesPath}`);
  }
  return Object.freeze({ electronLicensePath, chromiumLicensesPath });
}

function expectedArtifactNames(packageJson, arch = 'x64') {
  const config = JSON.parse(readFileSync(builderConfigPath, 'utf8'));
  const productName = config.productName ?? packageJson.productName ?? packageJson.name;
  return Object.freeze({
    portableZip: `${productName}-${packageJson.version}-win-${arch}.zip`,
    installer: `${productName}-${packageJson.version}-Setup-${arch}.exe`,
  });
}

function assertArtifacts(packageJson) {
  const expected = expectedArtifactNames(packageJson);
  const paths = [expected.portableZip, expected.installer].map((name) => join(distDir, name));
  for (const artifactPath of paths) {
    if (!existsSync(artifactPath)) throw new Error(`必須配布物が生成されていません: ${basename(artifactPath)}`);
    if (statSync(artifactPath).size < 1024 * 1024) throw new Error(`配布物のサイズが不正です: ${basename(artifactPath)}`);
  }
  return paths;
}

function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

function buildId() {
  const path = join(appRoot, 'renderer', 'generated', 'buildInfo.js');
  const match = readFileSync(path, 'utf8').match(/BUILD_ID\s*=\s*'([a-f0-9]{64})'/u);
  return match?.[1] ?? 'unknown';
}

function gitCommit() {
  const outcome = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  return outcome.status === 0 ? String(outcome.stdout).trim() : 'not-available';
}

function artifactRecords(paths) {
  return paths.map((path) => Object.freeze({ name: basename(path), bytes: statSync(path).size, sha256: sha256(path) }));
}

function writeChecksums(records) {
  writeFileSync(join(distDir, 'SHA256SUMS.txt'), `${records.map((record) => `${record.sha256}  ${record.name}`).join('\r\n')}\r\n`, 'utf8');
}

function writeBuildReport(packageJson, records) {
  const toolsPackage = JSON.parse(readFileSync(toolsPackagePath, 'utf8'));
  const signed = Boolean(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD);
  const lines = [
    'AI人狼マネージャー 配布ビルド報告', '', '結果: 成功',
    `生成日時(UTC): ${new Date().toISOString()}`,
    `アプリ版: ${packageJson.version}`,
    `ビルドID: ${buildId()}`,
    `Gitコミット: ${gitCommit()}`,
    `Node.js: ${process.version}`,
    `Electron: ${toolsPackage.devDependencies?.electron ?? 'unknown'}`,
    `electron-builder: ${electronBuilderVersion}`,
    `ビルドOS: ${process.platform} ${process.arch}`,
    `コード署名: ${signed ? '証明書環境変数を使用' : '未署名'}`,
    '', '実行済み検査:', '- bundle書換え前の製造事前ゲート', '- 決定的bundle生成検査', '- 生成後の完全製造規約ゲート（生成物鮮度・到達性・廃止物検査を含む）', '- ゲーム回帰テスト', '- デスクトップ回帰テスト', '- 配布版ユーザー向けREADME同梱検査', '- 配布版MIT License同梱検査', '- Electron/Chromium第三者ライセンス同梱検査', '- 必須配布物の存在・最小サイズ検査',
    '', '成果物:', ...records.map((record) => `- ${record.name} (${record.bytes} bytes) SHA-256=${record.sha256}`), '',
  ];
  writeFileSync(join(distDir, 'build-report.txt'), lines.join('\r\n'), 'utf8');
}

function readPackageJson() { return JSON.parse(readFileSync(appPackagePath, 'utf8')); }

function release() {
  assertReleaseEnvironment();
  const packageJson = readPackageJson();
  assertTagMatchesPackageVersion(packageJson.version);
  cleanDist();
  try {
    installLockedDependencies();
    runNode([join(__dirname, 'buildBundle.js')], '製造事前ゲート付き配布bundle生成');
    runNode([join(__dirname, 'manufacturingGate.js')], '製造規約ゲート');
    runNode(['--test', join(toolsRoot, 'tests', 'game', 'all.test.js')], 'ゲーム回帰テスト');
    runNode(['--test', join(toolsRoot, 'tests', 'desktop', 'all.test.js')], 'デスクトップ回帰テスト');
    buildWindowsArtifacts();
    assertPackagedUserReadme();
    assertPackagedLicense();
    assertPackagedRuntimeLicenses();
    removeBuilderIntermediates();
    const artifacts = assertArtifacts(packageJson);
    const records = artifactRecords(artifacts);
    writeChecksums(records);
    writeBuildReport(packageJson, records);
    console.log(`\n配布版を生成しました: ${distDir}`);
  } catch (error) {
    rmSync(distDir, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  try { release(); }
  catch (error) { console.error('\n配布版の生成に失敗しました。'); console.error(error); process.exitCode = 1; }
}

module.exports = {
  assertPackagedLicense,
  assertPackagedRuntimeLicenses,
  assertPackagedUserReadme,
  assertReleaseEnvironment,
  assertTagMatchesPackageVersion,
  compareVersions,
  expectedArtifactNames,
  installLockedDependencies,
  isRetryableNpmCiFailure,
  normalizedTagVersion,
  npmInvocation,
  parseVersion,
  release,
  stopProjectElectronProcesses,
};
