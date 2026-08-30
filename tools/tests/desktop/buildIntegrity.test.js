/**
 * 責務: 生成物鮮度、公開HTML埋め込み境界、Rendererモジュール到達性という製造時の高価値契約だけを確認する。
 * 変更ルール: manufacturingGate自身の内部実装、AMD変換手順、ハッシュ破壊fixtureなど製造監査と重複するテストは追加しない。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { assertGeneratedBuildFreshness } = require('../../build/buildIdentity.js');
const { renderPublicViewCssModule } = require('../../build/publicViewCssAsset.js');
const { inspectRendererModuleGraph } = require('../../build/moduleGraph.js');
const { tmpdir } = require('node:os');

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
test('Renderer製品JSはbootstrapまたはHTML直読込入口から全て到達できる', () => {
  const graph = inspectRendererModuleGraph(projectRoot);
  assert.deepEqual(graph.missingDependencies, []);
  assert.deepEqual(graph.unreachableModules, []);
  assert.equal(graph.entryPoints.includes('app/bootstrap.js'), true);
  assert.equal(graph.entryPoints.includes('automation/desktopAutomation.js'), false);
  assert.equal(graph.entryPoints.includes('automation/automationEntry.js'), false);
});
