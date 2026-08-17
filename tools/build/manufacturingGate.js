/**
 * 責務: 正式bundle生成前の製造事前検査と、生成後の鮮度を含む完全製造検査を提供し、開発者・利用者README、本体MIT Licenseの適用範囲注記、配布同梱設定も保証する。製造監査が使用するTypeScript依存は監査モジュール読込前に自己修復する。
 * 変更ルール: 事前検査は生成物へ書き込まず、現行構成・全製品JSの責務ヘッダ・テスト入口・情報境界・Prompt Envelope・README/ライセンス配布契約を検査する。Git管理メタデータの.gitignoreは正規のルートファイルとして許可する。完全検査だけが生成物鮮度を追加検査し、一時パッチ・到達不能モジュール・製品内未使用export・不一致生成物を製造物へ混入させない。TypeScriptを必要とする監査はensureCurrentBuild.jsの共通依存保証後にだけ読み込む。
 */

'use strict';

const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertGeneratedBuildFreshness } = require('./buildIdentity.js');
const { inspectRendererModuleGraph } = require('./moduleGraph.js');
const { ensureBuildToolDependencies } = require('./ensureCurrentBuild.js');
const { normalizePromptEnvelope } = require('../../app/main/llm/promptEnvelopeValidator.js');

const toolsRoot = join(__dirname, '..');
const projectRoot = join(toolsRoot, '..');
const IGNORED_WORKSPACE_DIRECTORIES = new Set(['node_modules', '.git', 'output']);
const IGNORED_MONITORED_FILES = new Set([
  'app/renderer/generated/buildInfo.js',
  'app/renderer/generated/bundle.js',
  'app/renderer/generated/publicViewStyles.js',
]);
const REQUIRED_ROOT_OPERATION_FILES = new Set(['AI人狼を起動.cmd', '配布版を作成.cmd']);
const ALLOWED_ROOT_FILES = new Set(['.gitignore', 'README.md', 'LICENSE.txt']);
const REQUIRED_DOCUMENTATION_FILES = Object.freeze(['README.md', 'app/README.txt', 'LICENSE.txt']);
const REQUIRED_DIRECTORIES = Object.freeze(['app', 'tools', 'docs']);
const PRODUCTION_JS_PREFIXES = Object.freeze(['app/main/', 'app/shared/', 'app/renderer/js/']);
const REQUIRED_RULE_SNIPPETS = Object.freeze([
  'ユーザーが明示していない既存機能を削除してはならない',
  '公開発言、心の声、内部メモ、判断状態、陣営戦略は別責務として扱う',
  '絶対禁止: heartVoice機能、状態、履歴、保存、GM監査表示を削除してはならない',
  '昼議論の生成指示・JSON例からは**絶対に削除してはならない**',
  '任意とは回答検証上の必須条件ではないことを意味し',
  'CO・能力結果だけは無操作を主例へ置かず、必要時だけ使用する条件付き形式として別掲する',
  '任意項目の未入力だけを理由として回答拒否、修復要求、再生成要求を行わない',
  'プロンプト掲載必須=true`と`回答検証必須=false`は矛盾せず',
  'これらの表現を根拠に、`requiredTopLevelKeys`、必須Schema、欠落バリデーション、再生成条件へ項目を追加してはならない',
  '「プロンプトに必ず掲載する」という要件を実装するために、`requiredTopLevelKeys`へ追加することを絶対に禁止する',
  '生成機会は確保するが、生成を強制しない',
  '`heartVoice`を含まない正常回答も、修復・再生成なしで解析・検証・登録できる',
  '自由文解析の禁止を理由に、自由文表現機能そのものを削除してはならない',
  'モジュールの一部が不要でも、モジュール全体を削除してはならない',
]);
const GAME_TEST_DIRECTORY = 'tools/tests/game';
const DESKTOP_TEST_DIRECTORY = 'tools/tests/desktop';
const GAME_TEST_ENTRY = `${GAME_TEST_DIRECTORY}/all.test.js`;
const DESKTOP_TEST_ENTRY = `${DESKTOP_TEST_DIRECTORY}/all.test.js`;

let collectUnusedProductionExports = null;

function prepareManufacturingDependencies({
  ensureDependencies = ensureBuildToolDependencies,
  loadUnusedExportAudit = () => require('./unusedExportAudit.js'),
} = {}) {
  ensureDependencies({ projectRoot });
  if (!collectUnusedProductionExports) {
    const audit = loadUnusedExportAudit();
    if (typeof audit?.collectUnusedProductionExports !== 'function') {
      throw new TypeError('未使用export監査モジュールを読み込めません。');
    }
    collectUnusedProductionExports = audit.collectUnusedProductionExports;
  }
}

function normalized(relativePath) {
  return String(relativePath ?? '').replaceAll('\\', '/');
}

function read(relativePath) {
  return readFileSync(join(projectRoot, relativePath), 'utf8');
}

function isIgnoredWorkspaceArtifact(relativePath) {
  const rel = normalized(relativePath);
  return rel.startsWith('output/') || rel.includes('/node_modules/') || rel.startsWith('tools/node_modules/');
}

function collectCurrentFiles(directory = projectRoot, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_WORKSPACE_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const rel = normalized(relative(projectRoot, absolute));
    if (entry.isDirectory()) collectCurrentFiles(absolute, output);
    else if (entry.isFile() && !IGNORED_MONITORED_FILES.has(rel) && !isIgnoredWorkspaceArtifact(rel)) output.push(rel);
  }
  return output.sort();
}

function assertIncludes(errors, source, token, label) {
  if (!source.includes(token)) errors.push(`${label}が見つかりません: ${token}`);
}

function validateRootLayout(errors) {
  const files = readdirSync(projectRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  [...REQUIRED_ROOT_OPERATION_FILES].filter((name) => !files.includes(name))
    .forEach((name) => errors.push(`プロジェクト直下の必須操作ファイルがありません: ${name}`));
  for (const relativePath of REQUIRED_DOCUMENTATION_FILES) {
    const path = join(projectRoot, relativePath);
    if (!existsSync(path) || !statSync(path).isFile() || !readFileSync(path, 'utf8').trim()) {
      errors.push(`必須ドキュメントがありません、または空です: ${relativePath}`);
    }
  }
  for (const directory of REQUIRED_DIRECTORIES) {
    const path = join(projectRoot, directory);
    if (!existsSync(path) || !statSync(path).isDirectory()) errors.push(`必須ディレクトリがありません: ${directory}`);
  }
  const rootDirectories = readdirSync(projectRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const allowedRootDirectories = new Set([...REQUIRED_DIRECTORIES, '.github', ...IGNORED_WORKSPACE_DIRECTORIES]);
  rootDirectories.filter((name) => !allowedRootDirectories.has(name))
    .forEach((name) => errors.push(`現行構成で許可していないディレクトリがプロジェクト直下にあります: ${name}`));
  files.filter((name) => !ALLOWED_ROOT_FILES.has(name) && !name.endsWith('.cmd'))
    .forEach((name) => errors.push(`現行構成で許可していないファイルがプロジェクト直下にあります: ${name}`));
}

function validateCurrentStructure(errors) {
  const patchDirectory = join(projectRoot, 'tools', 'patch');
  if (existsSync(patchDirectory)) errors.push('製造物へ一時パッチ用のtools/patchディレクトリを含めてはなりません。');
}

function validateGeneratedArtifacts(errors) {
  try {
    assertGeneratedBuildFreshness(projectRoot);
  } catch (error) {
    (error.details ?? [error.message]).forEach((detail) => errors.push(`生成物不整合: ${detail}`));
  }
}

function validateModuleReachability(errors) {
  const graph = inspectRendererModuleGraph(projectRoot);
  graph.missingDependencies.forEach((dependency) => errors.push(`Renderer依存先がありません: ${dependency}`));
  graph.unreachableModules.forEach((modulePath) => errors.push(`実行入口から到達不能な製品モジュールです: app/renderer/js/${modulePath}`));
}

function validateRules(errors) {
  const path = join(projectRoot, 'docs', 'AI_WORK_RULES.md');
  if (!existsSync(path)) {
    errors.push('docs/AI_WORK_RULES.mdがありません。');
    return;
  }
  const rules = readFileSync(path, 'utf8');
  REQUIRED_RULE_SNIPPETS.forEach((snippet) => assertIncludes(errors, rules, snippet, '製造規約'));
}

function discoverTestFiles(directoryRelativePath) {
  const directory = join(projectRoot, directoryRelativePath);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js') && entry.name !== 'all.test.js')
    .map((entry) => `${directoryRelativePath}/${entry.name}`)
    .sort();
}

function entryTestReferences(entrySource, style) {
  const pattern = style === 'import'
    ? /import\s+['"]\.\/([^'"]+\.test\.js)['"]\s*;/gu
    : /require\(\s*['"]\.\/([^'"]+\.test\.js)['"]\s*\)\s*;/gu;
  return [...entrySource.matchAll(pattern)].map((match) => match[1]);
}

function validateTestEntry(errors, { directory, entry, style, label }) {
  if (!existsSync(join(projectRoot, entry))) {
    errors.push(`${label}がありません: ${entry}`);
    return;
  }
  const expected = discoverTestFiles(directory).map((rel) => rel.split('/').at(-1));
  const references = entryTestReferences(read(entry), style);
  const counts = new Map();
  references.forEach((fileName) => counts.set(fileName, (counts.get(fileName) ?? 0) + 1));
  expected.filter((fileName) => !counts.has(fileName))
    .forEach((fileName) => errors.push(`${label}へ個別テストが登録されていません: ${directory}/${fileName}`));
  references.filter((fileName) => !expected.includes(fileName))
    .forEach((fileName) => errors.push(`${label}が存在しない個別テストを参照しています: ${directory}/${fileName}`));
  [...counts.entries()].filter(([, count]) => count > 1)
    .forEach(([fileName, count]) => errors.push(`${label}が同じ個別テストを${count}回参照しています: ${directory}/${fileName}`));
}

function isProductionJsModule(relativePath) {
  const rel = normalized(relativePath);
  return rel.endsWith('.js') && PRODUCTION_JS_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function validateResponsibilityHeader(errors, relativePath, source) {
  const leadingComment = String(source).match(/^\s*\/\*\*[\s\S]*?\*\//u)?.[0] ?? '';
  if (!leadingComment.includes('責務:')) errors.push(`製品JS先頭コメントに責務がありません: ${relativePath}`);
  if (!leadingComment.includes('変更ルール:')) errors.push(`製品JS先頭コメントに変更ルールがありません: ${relativePath}`);
}

function validateModulesAndTests(errors) {
  const currentFiles = collectCurrentFiles();
  const productionModules = currentFiles.filter(isProductionJsModule);
  for (const rel of productionModules) {
    const source = read(rel).trim();
    if (!source) errors.push(`実行モジュールが空です: ${rel}`);
    if (/^(?:export\s+default\s+)?(?:null|undefined|\{\}|\[\]);?$/u.test(source)) errors.push(`実行モジュールが空スタブです: ${rel}`);
    validateResponsibilityHeader(errors, rel, source);
  }
  if (currentFiles.some((rel) => rel.startsWith('app/') && rel.includes('/tests/'))) {
    errors.push('app配下へテストコードを配置してはなりません。');
  }
  validateTestEntry(errors, {
    directory: GAME_TEST_DIRECTORY,
    entry: GAME_TEST_ENTRY,
    style: 'import',
    label: 'ゲームテスト入口',
  });
  validateTestEntry(errors, {
    directory: DESKTOP_TEST_DIRECTORY,
    entry: DESKTOP_TEST_ENTRY,
    style: 'require',
    label: 'デスクトップテスト入口',
  });
}


function currentMainSources() {
  return collectCurrentFiles()
    .filter((rel) => rel.startsWith('app/main/') && rel.endsWith('.js'))
    .map((rel) => read(rel))
    .join('\n');
}

function validateRuntimeAndPackaging(errors) {
  const appPackage = JSON.parse(read('app/package.json'));
  const toolsPackage = JSON.parse(read('tools/package.json'));
  const builder = JSON.parse(read('tools/build/electron-builder.json'));
  if (appPackage.main !== 'main/main.js') errors.push('app/package.jsonのMainエントリーが不正です。');
  if (toolsPackage.scripts?.start !== 'node build/ensureCurrentBuild.js && electron ../app') errors.push('toolsの開発版起動前に生成物鮮度保証を実行していません。');
  if (builder.directories?.output !== '../output/dist') errors.push('配布物出力先はoutput/distでなければなりません。');
  const files = builder.files ?? [];
  const extraFiles = Array.isArray(builder.extraFiles) ? builder.extraFiles : [];
  const includesUserReadme = extraFiles.some((entry) => (
    entry === 'README.txt'
    || (entry && typeof entry === 'object' && entry.from === 'README.txt' && entry.to === 'README.txt')
  ));
  const includesLicense = extraFiles.some((entry) => (
    entry === '../LICENSE.txt'
    || (entry && typeof entry === 'object' && entry.from === '../LICENSE.txt' && entry.to === 'LICENSE.txt')
  ));
  if (!includesUserReadme) errors.push('配布版の実行ファイルと同じ階層へapp/README.txtをREADME.txtとして同梱していません。');
  if (!includesLicense) errors.push('配布版の実行ファイルと同じ階層へ本体MIT LicenseをLICENSE.txtとして同梱していません。');
  if (appPackage.license !== 'MIT') errors.push('app/package.jsonのlicenseはMITでなければなりません。');
  if (toolsPackage.license !== 'MIT') errors.push('tools/package.jsonのlicenseはMITでなければなりません。');
  const licenseText = read('LICENSE.txt');
  assertIncludes(errors, licenseText, '上記MIT Licenseは、AI人狼マネージャー本体の独自コードに適用されます。', '本体MIT Licenseの適用範囲注記');
  assertIncludes(errors, licenseText, '第三者が権利を有するキャラクター、名称、ロゴ、AIサービス、その他の第三者素材には適用されません。', '第三者権利のMIT除外注記');
  assertIncludes(errors, licenseText, 'Electron、Chromiumその他の第三者OSSには、それぞれのライセンスが適用されます。', '第三者OSSのライセンス注記');
  for (const required of ['package.json', 'main/**/*', 'shared/**/*', 'renderer/index.html', 'renderer/css/**/*', 'renderer/data/characters/**/*', 'renderer/generated/bundle.js', 'renderer/js/ai/**/*', 'renderer/js/automation/**/*']) {
    if (!files.includes(required)) errors.push(`配布対象が不足しています: ${required}`);
  }
  for (const forbidden of ['tools/**/*', 'docs/**/*', 'renderer/js/domain/**/*', 'renderer/js/prompts/**/*']) {
    if (files.includes(forbidden)) errors.push(`配布対象へ開発物または未バンドルソースを含めています: ${forbidden}`);
  }
  const mainSources = currentMainSources();
  if (/renderer[\\/]js/gu.test(mainSources)) errors.push('MainからRendererソースツリーへの逆依存が残っています。');
  assertIncludes(errors, read('app/main/main.js'), "join(__dirname, '..', 'renderer', 'index.html')", 'Renderer読込先');
  const html = read('app/renderer/index.html');
  assertIncludes(errors, html, '../shared/localLlmConfig.js', '共有ローカルLLM設定読込');
  assertIncludes(errors, html, '../shared/settingsSchema.js', '共有AI設定schema読込');
  assertIncludes(errors, html, './generated/bundle.js?build=', '配布bundle読込');
  const bootstrapSource = read('app/renderer/js/app/bootstrap.js');
  assertIncludes(errors, bootstrapSource, "import '../automation/automationEntry.js'", 'automation bundle入口');
  if (/\.\/js\/automation\/[^"']+\.js/gu.test(html)) errors.push('automation製品JSをHTMLから直接読み込んではいけません。bundle入口へ統合してください。');
}

function validatePromptEnvelopeContract(errors) {
  const canonicalEnvelope = {
    schemaVersion: 5,
    commonSystemInstruction: 'system',
    commonGameContext: 'common-game',
    taskInvariantContext: 'task-invariant',
    stablePlayerContext: 'stable-player',
    taskVariableContext: 'task-variable',
    dynamicTaskPrompt: 'dynamic-task',
    structuredOutput: null,
    cacheIdentity: {
      promptSpecVersion: 1,
      promptFamily: 'manufacturing-gate',
      gameId: 'game',
      commonGameFingerprint: 'fingerprint',
    },
  };
  try {
    const normalizedEnvelope = normalizePromptEnvelope(canonicalEnvelope);
    if (JSON.stringify(Object.keys(normalizedEnvelope)) !== JSON.stringify(Object.keys(canonicalEnvelope))) {
      errors.push('Prompt Envelopeの現行トップレベル構造が製造契約と一致しません。');
    }
    const withUnknownField = { ...canonicalEnvelope, unknownField: true };
    try {
      normalizePromptEnvelope(withUnknownField);
      errors.push('Prompt Envelopeが現行契約外のトップレベル項目を受理しています。');
    } catch (error) {
      if (!/未知の項目/u.test(String(error?.message ?? ''))) throw error;
    }
  } catch (error) {
    errors.push(`Prompt Envelope現行契約の検査に失敗しました: ${error.message}`);
  }
}

function validateUnusedProductionExports(errors) {
  for (const candidate of collectUnusedProductionExports(projectRoot)) {
    errors.push(`製品内で参照されないexportがあります: ${candidate.file}:${candidate.line} ${candidate.name}`);
  }
}

function validateBehaviorContracts(errors) {
  const contractPath = join(projectRoot, 'tools', 'build', 'manufacturingContracts.mjs');
  const run = spawnSync(process.execPath, [contractPath], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (run.status === 0) return;
  const detail = String(run.stderr || run.stdout || `exit=${run.status}`).trim();
  errors.push(`実行契約検査に失敗しました: ${detail}`);
}

function validateManufacturingPreflight(errors) {
  validateRootLayout(errors);
  validateCurrentStructure(errors);
  validateRules(errors);
  validateModulesAndTests(errors);
  validateModuleReachability(errors);
  validateRuntimeAndPackaging(errors);
  validatePromptEnvelopeContract(errors);
  validateUnusedProductionExports(errors);
  validateBehaviorContracts(errors);
}

function manufacturingSummary() {
  return {
    checkedProductionModuleCount: collectCurrentFiles().filter(isProductionJsModule).length,
    gameTestFileCount: discoverTestFiles(GAME_TEST_DIRECTORY).length,
    desktopTestFileCount: discoverTestFiles(DESKTOP_TEST_DIRECTORY).length,
    unusedProductionExportCandidateCount: collectUnusedProductionExports(projectRoot).length,
  };
}

function throwGateErrors(label, errors) {
  if (!errors.length) return;
  const error = new Error(`${label}:\n${errors.map((item) => `- ${item}`).join('\n')}`);
  error.details = errors;
  throw error;
}

function runManufacturingPreflight() {
  prepareManufacturingDependencies();
  const errors = [];
  validateManufacturingPreflight(errors);
  throwGateErrors('製造事前ゲート失敗', errors);
  return manufacturingSummary();
}

function runManufacturingGate() {
  prepareManufacturingDependencies();
  const errors = [];
  validateManufacturingPreflight(errors);
  validateGeneratedArtifacts(errors);
  throwGateErrors('製造規約ゲート失敗', errors);
  return manufacturingSummary();
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runManufacturingGate(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  collectCurrentFiles,
  prepareManufacturingDependencies,
  isIgnoredWorkspaceArtifact,
  runManufacturingGate,
  runManufacturingPreflight,
};
