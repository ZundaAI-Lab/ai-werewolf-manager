/**
 * 責務: 生成物鮮度、Rendererモジュール到達性、現行ディレクトリ構造、起動・ソース抽出前検査の製造契約を確認する。
 * 変更ルール: 業務挙動を重複検証せず、buildIdentity.js・moduleGraph.js・各操作入口の接続だけを検査する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { delimiter, join } = require('node:path');
const { assertGeneratedBuildFreshness, sourceBuildId } = require('../../build/buildIdentity.js');
const { normalizeAmdModuleNames, parseAmdDefinitions, findBrowserStorageReferences } = require('../../build/buildBundle.js');
const { ensureCurrentBuild } = require('../../build/ensureCurrentBuild.js');
const { requiredTypescriptVersion } = require('../../build/buildToolContract.js');
const { renderPublicViewCssModule } = require('../../build/publicViewCssAsset.js');
const { inspectRendererModuleGraph } = require('../../build/moduleGraph.js');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const projectRoot = join(__dirname, '..', '..', '..');

function copyBuildIdentityInputs(temporaryRoot) {
  const temporaryToolsBuild = join(temporaryRoot, 'tools', 'build');
  mkdirSync(temporaryToolsBuild, { recursive: true });
  cpSync(join(projectRoot, 'tools', 'package.json'), join(temporaryRoot, 'tools', 'package.json'));
  for (const filename of ['buildBundle.js', 'buildIdentity.js', 'publicViewCssAsset.js', 'buildToolContract.js']) {
    cpSync(join(projectRoot, 'tools', 'build', filename), join(temporaryToolsBuild, filename));
  }
}

test('現行ソース・buildInfo・bundle・HTMLキャッシュキーが一致する', () => {
  const result = assertGeneratedBuildFreshness(projectRoot);
  assert.equal(result.ok, true);
  assert.equal(result.expectedBuildId, result.generatedBuildId);
  assert.equal(result.generatedBundleSha256, result.currentBundleSha256);
  assert.equal(result.bundleBuildInfo.buildId, result.generatedBuildId);
  assert.equal(result.bundleBuildInfo.bundleSha256, result.generatedBundleSha256);
});


test('publicView.css改変は埋め込みCSS生成物の不一致として検出する', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aiwm-public-view-css-freshness-'));
  try {
    const temporaryRenderer = join(temporaryRoot, 'app', 'renderer');
    mkdirSync(join(temporaryRoot, 'app'), { recursive: true });
    cpSync(join(projectRoot, 'app', 'renderer'), temporaryRenderer, { recursive: true });
    cpSync(join(projectRoot, 'app', 'shared'), join(temporaryRoot, 'app', 'shared'), { recursive: true });
    copyBuildIdentityInputs(temporaryRoot);
    const cssPath = join(temporaryRenderer, 'css', 'publicView.css');
    writeFileSync(cssPath, `${readFileSync(cssPath, 'utf8')}\n/* freshness-test */\n`, 'utf8');
    assert.throws(
      () => assertGeneratedBuildFreshness(temporaryRoot),
      /generated\/publicViewStyles\.jsがpublicView\.cssと一致しません/u,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('bundle生成規則の変更はBUILD_IDへ反映する', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aiwm-build-tool-identity-'));
  try {
    const temporaryRenderer = join(temporaryRoot, 'app', 'renderer');
    mkdirSync(join(temporaryRoot, 'app'), { recursive: true });
    cpSync(join(projectRoot, 'app', 'renderer'), temporaryRenderer, { recursive: true });
    cpSync(join(projectRoot, 'app', 'shared'), join(temporaryRoot, 'app', 'shared'), { recursive: true });
    copyBuildIdentityInputs(temporaryRoot);
    const before = sourceBuildId(temporaryRoot);
    const buildBundlePath = join(temporaryRoot, 'tools', 'build', 'buildBundle.js');
    writeFileSync(buildBundlePath, `${readFileSync(buildBundlePath, 'utf8')}\n// build-identity-test\n`, 'utf8');
    assert.notEqual(sourceBuildId(temporaryRoot), before);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('TypeScript固定版の変更はBUILD_IDへ反映し範囲指定は拒否する', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aiwm-typescript-contract-'));
  try {
    const temporaryRenderer = join(temporaryRoot, 'app', 'renderer');
    mkdirSync(join(temporaryRoot, 'app'), { recursive: true });
    cpSync(join(projectRoot, 'app', 'renderer'), temporaryRenderer, { recursive: true });
    cpSync(join(projectRoot, 'app', 'shared'), join(temporaryRoot, 'app', 'shared'), { recursive: true });
    copyBuildIdentityInputs(temporaryRoot);
    const before = sourceBuildId(temporaryRoot);
    const toolsPackagePath = join(temporaryRoot, 'tools', 'package.json');
    const toolsPackage = JSON.parse(readFileSync(toolsPackagePath, 'utf8'));
    toolsPackage.devDependencies.typescript = '5.8.4';
    writeFileSync(toolsPackagePath, `${JSON.stringify(toolsPackage, null, 2)}\n`, 'utf8');
    assert.equal(requiredTypescriptVersion(temporaryRoot), '5.8.4');
    assert.notEqual(sourceBuildId(temporaryRoot), before);

    toolsPackage.devDependencies.typescript = '^5.8.3';
    writeFileSync(toolsPackagePath, `${JSON.stringify(toolsPackage, null, 2)}\n`, 'utf8');
    assert.throws(
      () => requiredTypescriptVersion(temporaryRoot),
      /TypeScriptの依存バージョンはX\.Y\.Z形式で完全固定してください/u,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('単体公開HTML用CSSはstyle要素を途中終了させる文字列を拒否する', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aiwm-public-view-style-boundary-'));
  try {
    const cssRoot = join(temporaryRoot, 'app', 'renderer', 'css');
    mkdirSync(cssRoot, { recursive: true });
    writeFileSync(join(cssRoot, 'publicView.css'), '.example::after { content: "</style>"; }\n', 'utf8');
    assert.throws(
      () => renderPublicViewCssModule(temporaryRoot),
      /style要素を終了させる文字列/u,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('AMDモジュール名正規化はdefineヘッダーだけを書き換え業務文字列を保持する', () => {
  const source = `define("renderer/js/example", ["require", "exports", "renderer/js/dependency"], function (require, exports, dependency) {
    const productText = "renderer/js/business-literal";
    return productText;
});`;
  const normalized = normalizeAmdModuleNames(source);
  assert.match(normalized, /define\("js\/example", \["require", "exports", "js\/dependency"\]/u);
  assert.match(normalized, /const productText = "renderer\/js\/business-literal";/u);
});

test('AMD解析は出力形式の取りこぼしと重複モジュールを黙って受理しない', () => {
  assert.throws(
    () => parseAmdDefinitions('define("js/example", ["exports"], () => {});'),
    /AMDモジュール定義を完全に解析できません/u,
  );
  assert.throws(
    () => parseAmdDefinitions([
      'define("js/example", ["exports"], function (exports) {});',
      'define("js/example", ["exports"], function (exports) {});',
    ].join('\n')),
    /AMDモジュール定義が重複しています: js\/example/u,
  );
});

test('ブラウザストレージ検査は実参照だけを拒否し文字列・無関係プロパティ名は許可する', () => {
  const source = [
    'const message = "localStorage / sessionStorage は使用しません";',
    'const object = { localStorage: "監査ラベル", sessionStorage: "監査ラベル" };',
    'const value = object.localStorage;',
    'window.localStorage.getItem("key");',
    'sessionStorage.setItem("key", "value");',
  ].join('\n');
  assert.deepEqual(findBrowserStorageReferences(source), [
    { token: 'localStorage', line: 4, column: 8 },
    { token: 'sessionStorage', line: 5, column: 1 },
  ]);
});

test('BUILD_IDを残したbundle本文改変もSHA-256不一致として拒否する', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aiwm-bundle-integrity-'));
  try {
    const temporaryRenderer = join(temporaryRoot, 'app', 'renderer');
    mkdirSync(join(temporaryRoot, 'app'), { recursive: true });
    cpSync(join(projectRoot, 'app', 'renderer'), temporaryRenderer, { recursive: true });
    cpSync(join(projectRoot, 'app', 'shared'), join(temporaryRoot, 'app', 'shared'), { recursive: true });
    copyBuildIdentityInputs(temporaryRoot);
    const bundlePath = join(temporaryRenderer, 'generated', 'bundle.js');
    writeFileSync(bundlePath, `${readFileSync(bundlePath, 'utf8')}\nload('js/app/does-not-exist');\n`, 'utf8');
    assert.throws(
      () => assertGeneratedBuildFreshness(temporaryRoot),
      /bundle\.jsの整合性SHA-256がbuildInfo\.jsと一致しません/u,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});


test('bundle内のBUNDLE_SHA256だけを書き換えてもbuildInfo不一致として拒否する', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aiwm-bundle-metadata-integrity-'));
  try {
    const temporaryRenderer = join(temporaryRoot, 'app', 'renderer');
    mkdirSync(join(temporaryRoot, 'app'), { recursive: true });
    cpSync(join(projectRoot, 'app', 'renderer'), temporaryRenderer, { recursive: true });
    cpSync(join(projectRoot, 'app', 'shared'), join(temporaryRoot, 'app', 'shared'), { recursive: true });
    copyBuildIdentityInputs(temporaryRoot);
    const bundlePath = join(temporaryRenderer, 'generated', 'bundle.js');
    const source = readFileSync(bundlePath, 'utf8');
    const tampered = source.replace(/(exports\.BUNDLE_SHA256\s*=\s*')[a-f0-9]{64}(';)/u, `$1${'f'.repeat(64)}$2`);
    assert.notEqual(tampered, source);
    writeFileSync(bundlePath, tampered, 'utf8');
    assert.throws(
      () => assertGeneratedBuildFreshness(temporaryRoot),
      /bundle\.js内のBUNDLE_SHA256がbuildInfo\.jsと一致しません/u,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});


test('Renderer製品JSはbootstrapまたはHTML直読込入口から全て到達できる', () => {
  const graph = inspectRendererModuleGraph(projectRoot);
  assert.deepEqual(graph.missingDependencies, []);
  assert.deepEqual(graph.unreachableModules, []);
  assert.equal(graph.entryPoints.includes('app/bootstrap.js'), true);
  assert.equal(graph.entryPoints.includes('automation/desktopAutomation.js'), false);
  assert.equal(graph.entryPoints.includes('automation/automationEntry.js'), false);
});


test('製造ゲートはTypeScript監査をトップレベル読込せず依存保証後に読み込む', () => {
  const script = `
    const assert = require('node:assert/strict');
    const gate = require(${JSON.stringify(join(projectRoot, 'tools', 'build', 'manufacturingGate.js'))});
    const order = [];
    gate.prepareManufacturingDependencies({
      ensureDependencies() { order.push('ensure'); },
      loadUnusedExportAudit() {
        order.push('load-audit');
        return { collectUnusedProductionExports() { return []; } };
      },
    });
    assert.deepEqual(order, ['ensure', 'load-audit']);
  `;
  const outcome = spawnSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });
  assert.equal(outcome.status, 0, outcome.stderr || outcome.stdout);
});

test('現行構造では一時パッチ領域を製造物へ持たない', () => {
  assert.equal(existsSync(join(projectRoot, 'tools', 'patch')), false);
});


