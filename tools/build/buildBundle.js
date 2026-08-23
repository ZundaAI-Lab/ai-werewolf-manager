/**
 * 責務: 製造事前ゲート通過後に、配布メタデータ検証、Renderer用決定的AMDバンドル生成、生成識別子とHTMLキャッシュキーの更新を行う。
 * 変更ルール: appの業務モジュールをtoolsへ複製しない。正式生成物へ書き込む前にrunManufacturingPreflightを必ず実行する。生成物はapp/renderer/generatedだけへ出力し、識別子計算はbuildIdentity.jsを正本とする。ブラウザストレージ禁止は文字列検索ではなくAST上の実参照だけを検出する。生成後の完全製造ゲートと回帰テストは呼び出し側が実行する。
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { accessSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { BUNDLE_SHA256_PLACEHOLDER, bundleIntegritySha256, fileSha256, sourceBuildId } = require('./buildIdentity.js');
const { runManufacturingPreflight } = require('./manufacturingGate.js');
const { writePublicViewCssModule } = require('./publicViewCssAsset.js');
const { pathToFileURL } = require('node:url');

const toolsRoot = join(__dirname, '..');
const projectRoot = join(toolsRoot, '..');
const appRoot = join(projectRoot, 'app');
const rendererRoot = join(appRoot, 'renderer');
const sourceRoot = join(rendererRoot, 'js');
const generatedRoot = join(rendererRoot, 'generated');
const entryPoint = 'js/app/bootstrap.js';
const outfile = 'generated/bundle.js';
const temporaryAmdOutput = 'generated/.bundle.amd.js';
const verifyOutput = 'generated/.bundle.verify.js';
const requiredFiles = [
  'js/app/bootstrap.js',
  'js/config/constants.js',
  'js/ai/apiRetryPolicy.js',
  'js/ai/responseRetryPolicy.js',
  'js/prompts/context/promptContext.js',
  'js/prompts/promptEnvelopeBuilder.js',
  'js/automation/automationRunControl.js',
  'js/automation/automaticAiExecutor.js',
  'js/automation/desktopAutomation.js',
  'js/shared/utils.js',
  'js/state/stateStore.js',
  'js/domain/game/gameRuntime.js',
  'js/prompts/promptBuilder.js',
  'js/ui/AppUI.js',
  'index.html',
];

const CLASSIC_SIDE_EFFECT_AMD_MODULES = Object.freeze({
  'js/ai/apiRetryPolicy': 'AiWerewolfApiRetryPolicy',
  'js/ai/responseRetryPolicy': 'AiWerewolfResponseRetryPolicy',
  'shared/entityIdPolicy': 'AiWerewolfEntityIdPolicy',
  'shared/userCharacterLibraryPolicy': 'AiWerewolfUserCharacterLibraryPolicy',
  'shared/characterTextPolicy': 'AiWerewolfCharacterTextPolicy',
  'shared/appearanceSchema': 'AiWerewolfAppearanceSchema',
  'shared/dataCompatibility/schemaVersions': 'AiWerewolfDataSchemaVersions',
  'shared/dataCompatibility/migrationRegistry': 'AiWerewolfMigrationRegistry',
  'shared/dataCompatibility/migrateData': 'AiWerewolfDataMigration',
});

const AMD_RUNTIME_HEADER = `/**
 * 配布用bundle。ES Modulesを決定的なAMDレジストリへ統合し、file://環境で単独実行する。
 * 生成物のため手動編集しない。
 */
(() => {
  'use strict';
  const definitions = Object.create(null);
  const cache = Object.create(null);
  function define(name, dependencies, factory) {
    if (definitions[name]) throw new Error(\`Duplicate module: \${name}\`);
    definitions[name] = { dependencies, factory };
  }
  define.amd = Object.freeze({});
  function load(name) {
    if (cache[name]) return cache[name].exports;
    const definition = definitions[name];
    if (!definition) throw new Error(\`Unknown module: \${name}\`);
    const module = { exports: {} };
    cache[name] = module;
    const localRequire = (dependency) => load(dependency);
    const args = definition.dependencies.map((dependency) => {
      if (dependency === 'require') return localRequire;
      if (dependency === 'exports') return module.exports;
      if (dependency === 'module') return module;
      return load(dependency);
    });
    const returned = definition.factory(...args);
    if (returned !== undefined) module.exports = returned;
    return module.exports;
  }
`;
const AMD_RUNTIME_FOOTER = `\n\n  load('js/app/bootstrap');\n})();\n`;

requiredFiles.forEach((filename) => accessSync(join(rendererRoot, filename)));

async function validateReleaseMetadata() {
  const packageJson = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
  const constantsUrl = pathToFileURL(join(sourceRoot, 'config', 'constants.js')).href;
  const { APP_VERSION } = await import(constantsUrl);
  if (packageJson.version !== APP_VERSION) {
    throw new Error(`版番号が一致しません: app/package.json=${packageJson.version}, APP_VERSION=${APP_VERSION}`);
  }
}

function compileAmd(entry, output) {
  const args = [
    require.resolve('typescript/bin/tsc'),
    '--allowJs',
    '--checkJs', 'false',
    '--module', 'amd',
    '--target', 'es2020',
    '--outFile', output,
    '--skipLibCheck',
    '--pretty', 'false',
    entry,
  ];
  const outcome = spawnSync(process.execPath, args, { cwd: rendererRoot, stdio: 'inherit' });
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0) throw new Error(`TypeScript AMD変換に失敗しました: code=${outcome.status}`);
}

function normalizeAmdModuleNames(amdSource) {
  // app/sharedをRendererから参照するとTypeScriptが共通ルートをappへ広げるため、
  // AMDのdefineヘッダーに現れるモジュール名・依存名だけをrenderer/接頭辞なしへ正規化する。
  // 業務コード本体の文字列リテラルは書き換えない。
  return amdSource.replace(
    /^define\("([^"]+)",\s*\[([^\]]*)\],\s*function\s*\(/gmu,
    (definitionHeader, moduleName, dependencySource) => {
      const normalizedModuleName = moduleName.startsWith('renderer/')
        ? moduleName.slice('renderer/'.length)
        : moduleName;
      const normalizedDependencies = dependencySource.replace(/"renderer\/([^"]+)"/gu, '"$1"');
      return definitionHeader
        .replace(`define("${moduleName}"`, `define("${normalizedModuleName}"`)
        .replace(dependencySource, normalizedDependencies);
    },
  );
}

function parseAmdDefinitions(amdSource) {
  const definitions = new Map();
  const definePattern = /^define\("([^"]+)",\s*\[([^\]]*)\],\s*function\s*\(/gmu;
  let parsedDefinitionCount = 0;
  for (const match of amdSource.matchAll(definePattern)) {
    const moduleName = match[1];
    if (definitions.has(moduleName)) {
      throw new Error(`AMDモジュール定義が重複しています: ${moduleName}`);
    }
    const dependencies = [...match[2].matchAll(/"([^"]+)"/gu)].map((dependency) => dependency[1]);
    definitions.set(moduleName, dependencies);
    parsedDefinitionCount += 1;
  }

  const namedDefinitionCount = [...amdSource.matchAll(/^define\("/gmu)].length;
  if (parsedDefinitionCount !== namedDefinitionCount) {
    throw new Error(`AMDモジュール定義を完全に解析できません: parsed=${parsedDefinitionCount}, found=${namedDefinitionCount}`);
  }
  return definitions;
}

function classicSideEffectAmdDefinitions(amdSource) {
  const definitions = parseAmdDefinitions(amdSource);
  const unresolved = new Set();
  for (const dependencies of definitions.values()) {
    for (const dependency of dependencies) {
      if (dependency === 'require' || dependency === 'exports' || dependency === 'module') continue;
      if (!definitions.has(dependency)) unresolved.add(dependency);
    }
  }
  return [...unresolved].map((moduleName) => {
    const globalName = CLASSIC_SIDE_EFFECT_AMD_MODULES[moduleName];
    if (!globalName) return '';
    return `define(${JSON.stringify(moduleName)}, [], function () {\n  const api = globalThis[${JSON.stringify(globalName)}];\n  if (!api) throw new Error(${JSON.stringify(`クラシックスクリプトを初期化できません: ${moduleName}`)});\n  return api;\n});`;
  }).filter(Boolean).join('\n');
}

function validateAmdModuleGraph(amdSource) {
  const definitions = parseAmdDefinitions(amdSource);
  if (!definitions.has('js/app/bootstrap')) {
    throw new Error('AMD変換結果にjs/app/bootstrapがありません。');
  }
  const unresolved = [];
  for (const [moduleName, dependencies] of definitions.entries()) {
    for (const dependency of dependencies) {
      if (dependency === 'require' || dependency === 'exports' || dependency === 'module') continue;
      if (!definitions.has(dependency)) unresolved.push(`${moduleName} -> ${dependency}`);
    }
  }
  if (unresolved.length) {
    throw new Error(`AMD依存モジュールが生成されていません: ${unresolved.join(', ')}`);
  }
}

function writeAmdBundle(entry, output) {
  rmSync(join(rendererRoot, temporaryAmdOutput), { force: true });
  compileAmd(entry, temporaryAmdOutput);
  const amdSource = normalizeAmdModuleNames(readFileSync(join(rendererRoot, temporaryAmdOutput), 'utf8'));
  rmSync(join(rendererRoot, temporaryAmdOutput), { force: true });
  const classicDefinitions = classicSideEffectAmdDefinitions(amdSource);
  const completeAmdSource = classicDefinitions ? `${amdSource}\n${classicDefinitions}\n` : amdSource;
  validateAmdModuleGraph(completeAmdSource);
  writeFileSync(join(rendererRoot, output), `${AMD_RUNTIME_HEADER}${completeAmdSource}${AMD_RUNTIME_FOOTER}`, 'utf8');
}


function findBrowserStorageReferences(sourceText) {
  const ts = require('typescript');
  const sourceFile = ts.createSourceFile('bundle.js', sourceText, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
  const forbiddenNames = new Set(['localStorage', 'sessionStorage']);
  const references = [];

  function isDeclarationOrPropertyName(node) {
    const parent = node.parent;
    if (!parent) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
      return !(ts.isIdentifier(parent.expression) && ['window', 'globalThis', 'self'].includes(parent.expression.text));
    }
    if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
    if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
    if (ts.isGetAccessorDeclaration(parent) && parent.name === node) return true;
    if (ts.isSetAccessorDeclaration(parent) && parent.name === node) return true;
    if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
    if (ts.isParameter(parent) && parent.name === node) return true;
    if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
    if (ts.isClassDeclaration(parent) && parent.name === node) return true;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
    if (ts.isLabeledStatement(parent) && parent.label === node) return true;
    return false;
  }

  function visit(node) {
    if (ts.isIdentifier(node) && forbiddenNames.has(node.text) && !isDeclarationOrPropertyName(node)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      references.push({ token: node.text, line: position.line + 1, column: position.character + 1 });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function writeBuildInfo(buildId, bundleSha256 = BUNDLE_SHA256_PLACEHOLDER) {
  const content = `/**
 * 責務: ビルド時に生成されたソース識別子とbundle完全性識別子を公開する。
 * 変更ルール: 手動編集しない。tools/build/buildBundle.jsだけが更新する。BUNDLE_SHA256はbundle内の同値をプレースホルダーへ正規化した決定的SHA-256を表し、自己参照によるハッシュ循環を作らない。
 */

export const BUILD_ID = '${buildId}';
export const BUNDLE_SHA256 = '${bundleSha256}';
`;
  writeFileSync(join(generatedRoot, 'buildInfo.js'), content, 'utf8');
}

function updateBundleCacheKey(buildId) {
  const indexPath = join(rendererRoot, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  const updated = html.replace(
    /<script src="\.\/generated\/bundle\.js(?:\?build=[^"]+)?" defer><\/script>/u,
    `<script src="./generated/bundle.js?build=${buildId}" defer></script>`,
  );
  if (updated === html && !html.includes(`generated/bundle.js?build=${buildId}`)) {
    throw new Error('index.htmlのbundle.js読込口を更新できませんでした。');
  }
  writeFileSync(indexPath, updated, 'utf8');
}

async function buildBundle() {
  await validateReleaseMetadata();
  runManufacturingPreflight();
  mkdirSync(generatedRoot, { recursive: true });
  writePublicViewCssModule(projectRoot);
  const buildId = sourceBuildId(projectRoot);

  // BUNDLE_SHA256自身をbundleへ含めても循環しないよう、まずプレースホルダーで正規化ハッシュを決める。
  writeBuildInfo(buildId, BUNDLE_SHA256_PLACEHOLDER);
  writeAmdBundle(entryPoint, outfile);
  const integritySha256 = bundleIntegritySha256(readFileSync(join(rendererRoot, outfile)));

  // 決定した整合性ハッシュを唯一の生成メタデータbuildInfo.jsへ反映し、正式bundleを再生成する。
  writeBuildInfo(buildId, integritySha256);
  writeAmdBundle(entryPoint, outfile);
  const bundleText = readFileSync(join(rendererRoot, outfile), 'utf8');
  if (!bundleText.includes(buildId)) throw new Error('bundle.jsへビルドIDが反映されていません。');
  if (bundleIntegritySha256(bundleText) !== integritySha256) throw new Error('bundle.jsの整合性SHA-256が再生成後に変化しました。');
  const browserStorageReferences = findBrowserStorageReferences(bundleText);
  if (browserStorageReferences.length) {
    const details = browserStorageReferences
      .map(({ token, line, column }) => `${token}@${line}:${column}`)
      .join(', ');
    throw new Error(`ブラウザストレージ参照がbundle.jsへ残っています: ${details}`);
  }

  // 同じ最終buildInfoから生成した生bundleも完全一致することを保証する。
  const firstHash = fileSha256(join(rendererRoot, outfile));
  writeAmdBundle(entryPoint, verifyOutput);
  const secondHash = fileSha256(join(rendererRoot, verifyOutput));
  rmSync(join(rendererRoot, verifyOutput), { force: true });
  if (firstHash !== secondHash) throw new Error('同一ソースから生成したbundle.jsが一致しません。');
  updateBundleCacheKey(buildId);
  console.log(`bundle.js generated. build=${buildId} integritySha256=${integritySha256} fileSha256=${firstHash}`);
}

if (require.main === module) {
  buildBundle().catch((error) => {
    rmSync(join(rendererRoot, temporaryAmdOutput), { force: true });
    rmSync(join(rendererRoot, verifyOutput), { force: true });
    console.error('bundle.jsの生成に失敗しました。', error);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ normalizeAmdModuleNames, parseAmdDefinitions, findBrowserStorageReferences });
