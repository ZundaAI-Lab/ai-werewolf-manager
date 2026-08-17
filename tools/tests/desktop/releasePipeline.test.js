/**
 * 責務: 配布環境、版番号、成果物、依存導入、利用者README・本体MIT License・Electron/Chromium第三者ライセンス同梱、配布入口の主要契約を外部ビルドなしで確認する。
 * 変更ルール: 過去の起動障害ごとの再現テストを追加せず、配布成立に必要な代表経路とREADME・本体LICENSE.txt・ランタイム第三者ライセンス同梱失敗だけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const {
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
  stopProjectElectronProcesses,
} = require('../../build/releasePipeline.js');

test('WindowsとNode.js 22.12.0以上だけを配布環境として受理する', () => {
  assert.doesNotThrow(() => assertReleaseEnvironment({ platform: 'win32', nodeVersion: 'v22.12.0' }));
  assert.doesNotThrow(() => assertReleaseEnvironment({ platform: 'win32', nodeVersion: 'v24.1.0' }));
  assert.throws(() => assertReleaseEnvironment({ platform: 'linux', nodeVersion: 'v24.1.0' }), /Windows環境/u);
  assert.throws(() => assertReleaseEnvironment({ platform: 'win32', nodeVersion: 'v22.11.9' }), /22\.12\.0以上/u);
});


test('GitHubのリリースタグはpackage.json版番号と一致しなければならない', () => {
  assert.doesNotThrow(() => assertTagMatchesPackageVersion('3.69.0', {
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: 'v3.69.0',
  }));
  assert.throws(() => assertTagMatchesPackageVersion('3.69.0', {
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: 'v3.69.1',
  }), /一致しません/u);
  assert.doesNotThrow(() => assertTagMatchesPackageVersion('3.69.0', {
    GITHUB_REF_TYPE: 'branch',
    GITHUB_REF_NAME: 'main',
  }));
});

test('ポータブルZIPとインストーラーの成果物名を一意に決定する', () => {
  assert.deepEqual(expectedArtifactNames({
    name: 'fallback-name',
    version: '3.69.0',
    build: { productName: 'AI人狼マネージャー' },
  }), {
    portableZip: 'AI人狼マネージャー-3.69.0-win-x64.zip',
    installer: 'AI人狼マネージャー-3.69.0-Setup-x64.exe',
  });
});


test('verifyと配布パイプラインは事前検査付きbundle生成後に完全製造ゲートと全テストを実行する', () => {
  const toolsPackage = require('../../package.json');
  const verify = toolsPackage.scripts.verify;
  for (const command of [
    'node build/manufacturingGate.js',
    'node --test tests/game/all.test.js',
    'node build/buildBundle.js',
    'node --test tests/desktop/all.test.js',
  ]) {
    assert.equal(verify.split(command).length - 1, 1, `verify内の実行回数が不正です: ${command}`);
  }

  const releaseSource = readFileSync(join(__dirname, '..', '..', 'build', 'releasePipeline.js'), 'utf8');
  assert.equal((releaseSource.match(/join\(__dirname, 'manufacturingGate\.js'\)/gu) ?? []).length, 1);
  assert.equal((releaseSource.match(/tests', 'game', 'all\.test\.js'/gu) ?? []).length, 1);
  assert.equal((releaseSource.match(/tests', 'desktop', 'all\.test\.js'/gu) ?? []).length, 1);
  assert.equal((releaseSource.match(/join\(__dirname, 'buildBundle\.js'\)/gu) ?? []).length, 1);

  const bundleSource = readFileSync(join(__dirname, '..', '..', 'build', 'buildBundle.js'), 'utf8');
  const preflightCallIndex = bundleSource.indexOf('runManufacturingPreflight();');
  const generatedWritePreparationIndex = bundleSource.indexOf('mkdirSync(generatedRoot');
  assert.match(bundleSource, /require\('\.\/manufacturingGate\.js'\)/u);
  assert.equal(preflightCallIndex >= 0, true);
  assert.equal(generatedWritePreparationIndex >= 0, true);
  assert.equal(preflightCallIndex < generatedWritePreparationIndex, true);
  assert.doesNotMatch(bundleSource, /runManufacturingGate|tests[\/]game[\/]all\.test\.js/u);
});

test('配布設定はユーザー向けREADMEとMIT Licenseを実行ファイルと同じ階層へ配置する', () => {
  const projectRoot = join(__dirname, '..', '..', '..');
  const builder = JSON.parse(readFileSync(join(projectRoot, 'tools', 'build', 'electron-builder.json'), 'utf8'));
  const appPackage = JSON.parse(readFileSync(join(projectRoot, 'app', 'package.json'), 'utf8'));
  const readmePath = join(projectRoot, 'app', 'README.txt');
  const developerReadmePath = join(projectRoot, 'README.md');
  const licensePath = join(projectRoot, 'LICENSE.txt');

  assert.equal(readFileSync(readmePath, 'utf8').includes('AI人狼マネージャー ユーザー向けREADME'), true);
  assert.equal(readFileSync(developerReadmePath, 'utf8').includes('AI人狼マネージャー 開発者向けREADME'), true);
  const licenseText = readFileSync(licensePath, 'utf8');
  assert.equal(licenseText.startsWith('MIT License'), true);
  assert.equal(licenseText.includes('上記MIT Licenseは、AI人狼マネージャー本体の独自コードに適用されます。'), true);
  assert.equal(appPackage.license, 'MIT');
  assert.deepEqual(builder.extraFiles, [
    { from: 'README.txt', to: 'README.txt' },
    { from: '../LICENSE.txt', to: 'LICENSE.txt' },
  ]);
});

test('配布前検査は展開済みWindowsアプリのREADME同梱を確認する', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aiwm-readme-package-'));
  try {
    const packagedDirectory = join(temporaryRoot, 'win-unpacked');
    mkdirSync(packagedDirectory, { recursive: true });
    assert.throws(() => assertPackagedUserReadme(packagedDirectory), /同梱されていません/u);

    writeFileSync(join(packagedDirectory, 'README.txt'), '短いREADME', 'utf8');
    assert.throws(() => assertPackagedUserReadme(packagedDirectory), /内容が不正/u);

    writeFileSync(
      join(packagedDirectory, 'README.txt'),
      `AI人狼マネージャー ユーザー向けREADME\n${'利用方法と注意事項。'.repeat(20)}`,
      'utf8',
    );
    assert.equal(assertPackagedUserReadme(packagedDirectory), join(packagedDirectory, 'README.txt'));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('配布前検査は展開済みWindowsアプリのMIT License同梱を確認する', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aiwm-license-package-'));
  try {
    const packagedDirectory = join(temporaryRoot, 'win-unpacked');
    mkdirSync(packagedDirectory, { recursive: true });
    assert.throws(() => assertPackagedLicense(packagedDirectory), /同梱されていません/u);

    writeFileSync(join(packagedDirectory, 'LICENSE.txt'), 'MIT License', 'utf8');
    assert.throws(() => assertPackagedLicense(packagedDirectory), /不正/u);

    const projectRoot = join(__dirname, '..', '..', '..');
    const licenseText = readFileSync(join(projectRoot, 'LICENSE.txt'), 'utf8');
    writeFileSync(join(packagedDirectory, 'LICENSE.txt'), licenseText, 'utf8');
    assert.equal(assertPackagedLicense(packagedDirectory), join(packagedDirectory, 'LICENSE.txt'));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('配布前検査はElectronとChromiumの第三者ライセンス同梱を確認する', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aiwm-runtime-license-package-'));
  try {
    const packagedDirectory = join(temporaryRoot, 'win-unpacked');
    mkdirSync(packagedDirectory, { recursive: true });
    assert.throws(() => assertPackagedRuntimeLicenses(packagedDirectory), /Electronライセンス/u);

    writeFileSync(
      join(packagedDirectory, 'LICENSE.electron.txt'),
      `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
${'license text '.repeat(60)}`,
      'utf8',
    );
    assert.throws(() => assertPackagedRuntimeLicenses(packagedDirectory), /Chromium第三者ライセンス一覧/u);

    writeFileSync(join(packagedDirectory, 'LICENSES.chromium.html'), `<html>${'third-party licenses '.repeat(100)}</html>`, 'utf8');
    const result = assertPackagedRuntimeLicenses(packagedDirectory);
    assert.equal(result.electronLicensePath, join(packagedDirectory, 'LICENSE.electron.txt'));
    assert.equal(result.chromiumLicensesPath, join(packagedDirectory, 'LICENSES.chromium.html'));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

