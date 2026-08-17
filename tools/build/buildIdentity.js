/**
 * 責務: Rendererソースの決定的ビルド識別子を計算し、buildInfo・bundle・HTMLキャッシュキーの鮮度を一元検査する。
 * 変更ルール:
 * - 生成処理そのものはbuildBundle.jsへ委譲する。
 * - 識別対象は実行に使用するJS・CSS・キャラクターJSON・index.htmlに加え、bundle生成規則とbuildToolContract.jsが検証した固定TypeScript版を含める。
 * - node_modulesなどの導入済み依存物は含めない。
 * - 生成物メタデータはgenerated/buildInfo.jsだけを正本とし、bundle完全性はbundle内のBUNDLE_SHA256値を正規化した決定的SHA-256で検証する。
 */

'use strict';

const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { inspectPublicViewCssAsset } = require('./publicViewCssAsset.js');
const { requiredTypescriptVersion } = require('./buildToolContract.js');

const DEFAULT_PROJECT_ROOT = join(__dirname, '..', '..');
const BUILD_ID_PATTERN = /^[a-f0-9]{64}$/u;
const BUNDLE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BUNDLE_SHA256_PLACEHOLDER = '0'.repeat(64);
const BUILD_TOOL_INPUT_FILES = Object.freeze([
  'tools/build/buildBundle.js',
  'tools/build/buildIdentity.js',
  'tools/build/publicViewCssAsset.js',
  'tools/build/buildToolContract.js',
]);


function rendererPaths(projectRoot = DEFAULT_PROJECT_ROOT) {
  const rendererRoot = join(projectRoot, 'app', 'renderer');
  return Object.freeze({
    projectRoot,
    rendererRoot,
    sourceRoot: join(rendererRoot, 'js'),
    sharedRoot: join(projectRoot, 'app', 'shared'),
    cssRoot: join(rendererRoot, 'css'),
    characterDataRoot: join(rendererRoot, 'data', 'characters'),
    generatedRoot: join(rendererRoot, 'generated'),
    indexPath: join(rendererRoot, 'index.html'),
    buildInfoPath: join(rendererRoot, 'generated', 'buildInfo.js'),
    bundlePath: join(rendererRoot, 'generated', 'bundle.js'),
  });
}

function collectFilesByExtension(directory, extension, relative = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childAbsolute = join(directory, entry.name);
    if (entry.isDirectory()) return collectFilesByExtension(childAbsolute, extension, childRelative);
    return entry.isFile() && entry.name.endsWith(extension) ? [childRelative] : [];
  });
}

function canonicalIndexHtml(projectRoot = DEFAULT_PROJECT_ROOT) {
  const { indexPath } = rendererPaths(projectRoot);
  return readFileSync(indexPath, 'utf8').replace(
    /generated\/bundle\.js(?:\?build=[^"']+)?/gu,
    'generated/bundle.js?build=<BUILD_ID>',
  );
}

function buildIdentityEntries(projectRoot = DEFAULT_PROJECT_ROOT) {
  const { sourceRoot, sharedRoot, cssRoot, characterDataRoot } = rendererPaths(projectRoot);
  const entries = collectFilesByExtension(sourceRoot, '.js')
    .map((filename) => ({
      name: `app/renderer/js/${filename}`,
      content: readFileSync(join(sourceRoot, filename)),
    }));
  collectFilesByExtension(sharedRoot, '.js').forEach((filename) => {
    entries.push({
      name: `app/shared/${filename}`,
      content: readFileSync(join(sharedRoot, filename)),
    });
  });
  collectFilesByExtension(cssRoot, '.css').forEach((filename) => {
    entries.push({
      name: `app/renderer/css/${filename}`,
      content: readFileSync(join(cssRoot, filename)),
    });
  });
  collectFilesByExtension(characterDataRoot, '.json').forEach((filename) => {
    entries.push({
      name: `app/renderer/data/characters/${filename}`,
      content: readFileSync(join(characterDataRoot, filename)),
    });
  });
  entries.push({
    name: 'app/renderer/index.html',
    content: Buffer.from(canonicalIndexHtml(projectRoot), 'utf8'),
  });
  BUILD_TOOL_INPUT_FILES.forEach((relativePath) => {
    entries.push({
      name: relativePath,
      content: readFileSync(join(projectRoot, relativePath)),
    });
  });
  entries.push({
    name: 'tools/typescript-version',
    content: Buffer.from(requiredTypescriptVersion(projectRoot), 'utf8'),
  });
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function sourceBuildId(projectRoot = DEFAULT_PROJECT_ROOT) {
  const hash = createHash('sha256');
  buildIdentityEntries(projectRoot).forEach(({ name, content }) => {
    hash.update(name);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  });
  return hash.digest('hex');
}

function readGeneratedBuildInfo(projectRoot = DEFAULT_PROJECT_ROOT) {
  const { buildInfoPath } = rendererPaths(projectRoot);
  if (!existsSync(buildInfoPath)) return null;
  const source = readFileSync(buildInfoPath, 'utf8');
  const buildId = source.match(/BUILD_ID\s*=\s*'([a-f0-9]{64})'/u)?.[1] ?? null;
  const bundleSha256 = source.match(/BUNDLE_SHA256\s*=\s*'([a-f0-9]{64})'/u)?.[1] ?? null;
  return Object.freeze({ buildId, bundleSha256 });
}

function readGeneratedBuildId(projectRoot = DEFAULT_PROJECT_ROOT) {
  return readGeneratedBuildInfo(projectRoot)?.buildId ?? null;
}

function canonicalBundleTextForIntegrity(content) {
  const source = Buffer.isBuffer(content) ? content.toString('utf8') : String(content ?? '');
  const normalized = source.replace(
    /(exports\.BUNDLE_SHA256\s*=\s*')[a-f0-9]{64}(';)/u,
    `$1${BUNDLE_SHA256_PLACEHOLDER}$2`,
  );
  if (normalized === source && !source.includes(`exports.BUNDLE_SHA256 = '${BUNDLE_SHA256_PLACEHOLDER}';`)) {
    throw new Error('generated/bundle.js内のBUNDLE_SHA256を特定できません。');
  }
  return normalized;
}

function bundleIntegritySha256(content) {
  return sha256(Buffer.from(canonicalBundleTextForIntegrity(content), 'utf8'));
}

function readBundleBuildInfo(content) {
  const source = Buffer.isBuffer(content) ? content.toString('utf8') : String(content ?? '');
  return Object.freeze({
    buildId: source.match(/exports\.BUILD_ID\s*=\s*'([a-f0-9]{64})';/u)?.[1] ?? null,
    bundleSha256: source.match(/exports\.BUNDLE_SHA256\s*=\s*'([a-f0-9]{64})';/u)?.[1] ?? null,
  });
}

function inspectGeneratedBuildFreshness(projectRoot = DEFAULT_PROJECT_ROOT) {
  const paths = rendererPaths(projectRoot);
  const errors = [];
  const expectedBuildId = sourceBuildId(projectRoot);
  const generatedBuildInfo = readGeneratedBuildInfo(projectRoot);
  const generatedBuildId = generatedBuildInfo?.buildId ?? null;
  const generatedBundleSha256 = generatedBuildInfo?.bundleSha256 ?? null;
  let currentBundleSha256 = null;
  let bundleBuildInfo = null;
  const publicViewCssAsset = inspectPublicViewCssAsset(projectRoot);
  if (!publicViewCssAsset.ok) errors.push(publicViewCssAsset.error);

  if (!generatedBuildId || !BUILD_ID_PATTERN.test(generatedBuildId)) {
    errors.push('generated/buildInfo.jsに有効なBUILD_IDがありません。');
  } else if (generatedBuildId !== expectedBuildId) {
    errors.push(`生成識別子が現行ソースと一致しません: generated=${generatedBuildId}, source=${expectedBuildId}`);
  }

  if (!generatedBundleSha256 || !BUNDLE_SHA256_PATTERN.test(generatedBundleSha256)) {
    errors.push('generated/buildInfo.jsに有効なBUNDLE_SHA256がありません。');
  }

  if (!existsSync(paths.bundlePath)) {
    errors.push('generated/bundle.jsがありません。');
  } else {
    const bundleBuffer = readFileSync(paths.bundlePath);
    const bundleText = bundleBuffer.toString('utf8');
    try {
      currentBundleSha256 = bundleIntegritySha256(bundleBuffer);
    } catch (error) {
      errors.push(error.message);
    }
    bundleBuildInfo = readBundleBuildInfo(bundleBuffer);
    if (generatedBuildId && bundleBuildInfo.buildId !== generatedBuildId) {
      errors.push('generated/bundle.jsへBUILD_IDが正しく反映されていません。');
    }
    if (generatedBundleSha256 && bundleBuildInfo.bundleSha256 !== generatedBundleSha256) {
      errors.push('generated/bundle.js内のBUNDLE_SHA256がbuildInfo.jsと一致しません。');
    }
    if (generatedBundleSha256 && currentBundleSha256 && currentBundleSha256 !== generatedBundleSha256) {
      errors.push(`generated/bundle.jsの整合性SHA-256がbuildInfo.jsと一致しません: bundle=${currentBundleSha256}, buildInfo=${generatedBundleSha256}`);
    }
    if (generatedBuildId && !bundleText.includes(generatedBuildId)) {
      errors.push('generated/bundle.jsへBUILD_IDが反映されていません。');
    }
  }

  if (!existsSync(paths.indexPath)) {
    errors.push('renderer/index.htmlがありません。');
  } else if (generatedBuildId) {
    const html = readFileSync(paths.indexPath, 'utf8');
    if (!html.includes(`./generated/bundle.js?build=${generatedBuildId}`)) {
      errors.push('renderer/index.htmlのbundleキャッシュキーがBUILD_IDと一致しません。');
    }
  }

  return Object.freeze({
    ok: errors.length === 0,
    expectedBuildId,
    generatedBuildId,
    generatedBundleSha256,
    currentBundleSha256,
    bundleBuildInfo,
    publicViewCssAsset,
    errors: Object.freeze(errors),
  });
}

function assertGeneratedBuildFreshness(projectRoot = DEFAULT_PROJECT_ROOT) {
  const result = inspectGeneratedBuildFreshness(projectRoot);
  if (!result.ok) {
    const error = new Error(`生成物鮮度検査に失敗しました:\n${result.errors.map((item) => `- ${item}`).join('\n')}`);
    error.details = result.errors;
    error.expectedBuildId = result.expectedBuildId;
    error.generatedBuildId = result.generatedBuildId;
    throw error;
  }
  return result;
}

module.exports = {
  BUILD_ID_PATTERN,
  BUNDLE_SHA256_PATTERN,
  BUNDLE_SHA256_PLACEHOLDER,
  DEFAULT_PROJECT_ROOT,
  assertGeneratedBuildFreshness,
  buildIdentityEntries,
  bundleIntegritySha256,
  canonicalBundleTextForIntegrity,
  canonicalIndexHtml,
  collectFilesByExtension,
  fileSha256,
  inspectGeneratedBuildFreshness,
  readBundleBuildInfo,
  readGeneratedBuildId,
  readGeneratedBuildInfo,
  rendererPaths,
  sha256,
  sourceBuildId,
};
