/**
 * 責務: TypeScript Compiler APIでRenderer製品モジュールのimport/exportシンボルを監査し、製品実行コード・製造契約の双方から未参照なexport候補をレポートする。
 * 変更ルール: 製造失敗条件にはしない。tools/buildの実行契約参照は製品参照として数え、テスト専用参照は候補として区別する。動的importは対象モジュール全exportを使用扱いにし、固定件数の暫定ゲートは設けない。
 */

'use strict';

const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { dirname, join, relative, resolve } = require('node:path');
const ts = require('typescript');

function normalized(path) {
  return String(path ?? '').replaceAll('\\', '/');
}

function collectScriptFiles(directory, output = []) {
  if (!existsSync(directory)) return output;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'generated' || entry.name === 'node_modules') continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) collectScriptFiles(absolute, output);
    else if (entry.isFile() && /\.(?:js|mjs)$/u.test(entry.name)) output.push(absolute);
  }
  return output;
}

function parse(fileName) {
  return ts.createSourceFile(fileName, readFileSync(fileName, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
}

function hasExportModifier(node) {
  return Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function resolveRelativeModule(sourceFileName, specifier) {
  if (!String(specifier).startsWith('.')) return null;
  const absolute = resolve(dirname(sourceFileName), specifier);
  return normalized(absolute.endsWith('.js') ? absolute : `${absolute}.js`);
}

function exportedDeclarations(sourceFile, projectRoot) {
  const result = [];
  const identifierCounts = new Map();
  const countIdentifiers = (node) => {
    if (ts.isIdentifier(node)) identifierCounts.set(node.text, (identifierCounts.get(node.text) ?? 0) + 1);
    ts.forEachChild(node, countIdentifiers);
  };
  countIdentifiers(sourceFile);
  const register = (nameNode) => {
    if (!nameNode || !ts.isIdentifier(nameNode)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(nameNode.getStart(sourceFile));
    result.push({
      file: normalized(relative(projectRoot, sourceFile.fileName)),
      absoluteFile: normalized(sourceFile.fileName),
      name: nameNode.text,
      line: position.line + 1,
      localReferenceCount: Math.max(0, (identifierCounts.get(nameNode.text) ?? 0) - 1),
    });
  };
  for (const statement of sourceFile.statements) {
    if (!hasExportModifier(statement)) continue;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      register(statement.name);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      statement.declarationList.declarations.forEach((declaration) => register(declaration.name));
    }
  }
  return result;
}

function collectUsage(sourceFile, category, usage) {
  const mark = (modulePath, name = '*') => {
    if (!modulePath) return;
    const entry = usage.get(modulePath) ?? { production: new Set(), test: new Set() };
    entry[category].add(name);
    usage.set(modulePath, entry);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const modulePath = resolveRelativeModule(sourceFile.fileName, node.moduleSpecifier.text);
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        bindings.elements.forEach((element) => mark(modulePath, element.propertyName?.text ?? element.name.text));
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        mark(modulePath, '*');
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const modulePath = resolveRelativeModule(sourceFile.fileName, node.moduleSpecifier.text);
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        node.exportClause.elements.forEach((element) => mark(modulePath, element.propertyName?.text ?? element.name.text));
      } else {
        mark(modulePath, '*');
      }
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])) {
      mark(resolveRelativeModule(sourceFile.fileName, node.arguments[0].text), '*');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function collectUnusedProductionExports(projectRoot) {
  const productionFiles = collectScriptFiles(join(projectRoot, 'app', 'renderer', 'js')).map(normalized);
  const productionContractFiles = collectScriptFiles(join(projectRoot, 'tools', 'build')).map(normalized);
  const testFiles = [
    ...collectScriptFiles(join(projectRoot, 'tools', 'tests', 'game')),
    ...collectScriptFiles(join(projectRoot, 'tools', 'tests', 'desktop')),
  ].map(normalized);
  const declarations = productionFiles.flatMap((fileName) => exportedDeclarations(parse(fileName), projectRoot));
  const usage = new Map();
  [...productionFiles, ...productionContractFiles].forEach((fileName) => collectUsage(parse(fileName), 'production', usage));
  testFiles.forEach((fileName) => collectUsage(parse(fileName), 'test', usage));

  return declarations.filter((declaration) => {
    const counts = usage.get(declaration.absoluteFile);
    return declaration.localReferenceCount === 0
      && !counts?.production.has('*')
      && !counts?.production.has(declaration.name);
  }).map((declaration) => {
    const counts = usage.get(declaration.absoluteFile);
    return {
      file: declaration.file,
      name: declaration.name,
      line: declaration.line,
      productionReferenceCount: 0,
      testReferenceCount: counts?.test.has('*') || counts?.test.has(declaration.name) ? 1 : 0,
    };
  }).sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.name.localeCompare(right.name));
}

if (require.main === module) {
  const projectRoot = join(__dirname, '..', '..');
  const candidates = collectUnusedProductionExports(projectRoot);
  console.log(JSON.stringify({ count: candidates.length, candidates }, null, 2));
}

module.exports = { collectUnusedProductionExports };
