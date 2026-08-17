/**
 * 責務: RendererのES Module依存、HTML直読込スクリプト、app/sharedの共有実行モジュールを解析し、実行入口から到達不能な製品JSを検出する。
 * 変更ルール: 業務モジュールの内容を解釈しない。相対import/export/dynamic importとindex.htmlのscript srcだけを依存正本とし、Main専用モジュールは対象に含めない。
 */

'use strict';

const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { dirname, extname, join, normalize, relative, resolve } = require('node:path');

const DEFAULT_PROJECT_ROOT = join(__dirname, '..', '..');
const MODULE_SPECIFIER_PATTERN = /(?:\bimport\s+(?:[^'"()]*?\s+from\s*)?|\bexport\s+(?:[^'"]*?\s+from\s*)?)["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gsu;
const HTML_SCRIPT_PATTERN = /<script\s+[^>]*src=["'](\.\/js\/[^"']+\.js|\.\.\/shared\/[^"']+\.js)(?:\?[^"']*)?["'][^>]*><\/script>/gu;

function normalizedPath(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

function collectProductionModules(sourceRoot, directory = sourceRoot, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) collectProductionModules(sourceRoot, absolute, output);
    else if (entry.isFile() && entry.name.endsWith('.js')) output.push(normalizedPath(relative(sourceRoot, absolute)));
  }
  return output.sort();
}

function resolveModuleSpecifier(sourceRoot, importerRelativePath, specifier) {
  if (!specifier.startsWith('.')) return null;
  const importerAbsolute = join(sourceRoot, importerRelativePath);
  let target = resolve(dirname(importerAbsolute), specifier);
  if (!extname(target)) target += '.js';
  const sourceRootAbsolute = resolve(sourceRoot);
  const targetRelative = normalizedPath(relative(sourceRootAbsolute, target));
  if (targetRelative.startsWith('../') || targetRelative === '..') return null;
  return targetRelative;
}

function extractRelativeDependencies(sourceRoot, importerRelativePath, source) {
  const dependencies = [];
  for (const match of source.matchAll(MODULE_SPECIFIER_PATTERN)) {
    const resolved = resolveModuleSpecifier(sourceRoot, importerRelativePath, match[1] ?? match[2] ?? '');
    if (resolved) dependencies.push(resolved);
  }
  return [...new Set(dependencies)].sort();
}

function moduleIdForAbsolute(sourceRoot, sharedRoot, absolutePath) {
  const rendererRelative = normalizedPath(relative(resolve(sourceRoot), absolutePath));
  if (!rendererRelative.startsWith('../') && rendererRelative !== '..') return rendererRelative;
  const sharedRelative = normalizedPath(relative(resolve(sharedRoot), absolutePath));
  if (!sharedRelative.startsWith('../') && sharedRelative !== '..') return `shared/${sharedRelative}`;
  return null;
}

function resolveProjectModuleSpecifier({ sourceRoot, sharedRoot, importerAbsolute, specifier }) {
  if (!specifier.startsWith('.')) return null;
  let target = resolve(dirname(importerAbsolute), specifier);
  if (!extname(target)) target += '.js';
  return moduleIdForAbsolute(sourceRoot, sharedRoot, target);
}

function htmlScriptEntries(projectRoot, moduleSet) {
  const htmlPath = join(projectRoot, 'app', 'renderer', 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  return [...html.matchAll(HTML_SCRIPT_PATTERN)]
    .map((match) => {
      const src = normalizedPath(match[1]);
      if (src.startsWith('./js/')) return src.slice('./js/'.length);
      if (src.startsWith('../shared/')) return `shared/${src.slice('../shared/'.length)}`;
      return null;
    })
    .filter((entry) => entry && moduleSet.has(entry));
}

function inspectRendererModuleGraph(projectRoot = DEFAULT_PROJECT_ROOT) {
  const sourceRoot = join(projectRoot, 'app', 'renderer', 'js');
  const sharedRoot = join(projectRoot, 'app', 'shared');
  const rendererModules = collectProductionModules(sourceRoot);
  const sharedModules = existsSync(sharedRoot)
    ? collectProductionModules(sharedRoot).map((modulePath) => `shared/${modulePath}`)
    : [];
  const modules = [...rendererModules, ...sharedModules].sort();
  const moduleSet = new Set(modules);
  const absoluteByModule = new Map([
    ...rendererModules.map((modulePath) => [modulePath, join(sourceRoot, modulePath)]),
    ...sharedModules.map((modulePath) => [modulePath, join(sharedRoot, modulePath.slice('shared/'.length))]),
  ]);
  const dependencies = new Map();
  const missingDependencies = [];

  for (const modulePath of modules) {
    const absolutePath = absoluteByModule.get(modulePath);
    const source = readFileSync(absolutePath, 'utf8');
    const resolvedDependencies = [];
    for (const match of source.matchAll(MODULE_SPECIFIER_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? '';
      const dependency = resolveProjectModuleSpecifier({ sourceRoot, sharedRoot, importerAbsolute: absolutePath, specifier });
      if (dependency) resolvedDependencies.push(dependency);
    }
    const uniqueDependencies = [...new Set(resolvedDependencies)].sort();
    dependencies.set(modulePath, uniqueDependencies);
    for (const dependency of uniqueDependencies) {
      const dependencyPath = absoluteByModule.get(dependency);
      if (!moduleSet.has(dependency) || !dependencyPath || !existsSync(normalize(dependencyPath))) {
        missingDependencies.push(`${modulePath} -> ${dependency}`);
      }
    }
  }

  const entryPoints = [...new Set([
    'app/bootstrap.js',
    ...htmlScriptEntries(projectRoot, moduleSet),
  ])].sort();
  const reachable = new Set();
  const pending = [...entryPoints];
  while (pending.length) {
    const modulePath = pending.pop();
    if (reachable.has(modulePath) || !moduleSet.has(modulePath)) continue;
    reachable.add(modulePath);
    for (const dependency of dependencies.get(modulePath) ?? []) pending.push(dependency);
  }

  return Object.freeze({
    moduleCount: modules.length,
    entryPoints: Object.freeze(entryPoints),
    missingDependencies: Object.freeze([...new Set(missingDependencies)].sort()),
    unreachableModules: Object.freeze(modules.filter((modulePath) => !reachable.has(modulePath))),
  });
}

module.exports = {
  DEFAULT_PROJECT_ROOT,
  collectProductionModules,
  extractRelativeDependencies,
  inspectRendererModuleGraph,
  normalizedPath,
  resolveModuleSpecifier,
};
