/**
 * 責務: 未使用export監査が、実際の製品参照・製造契約参照・テスト専用参照をシンボル単位で正しく区別できることを独立fixtureで検証する。
 * 変更ルール: 現在の製品リポジトリに未使用exportが何件あるかを合否条件にしない。監査器が壊れて常に空配列を返しても通らないよう、検出されるfixtureと除外されるfixtureを同時に用意する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { collectUnusedProductionExports } = require('../../build/unusedExportAudit.js');

function write(root, relativePath, source) {
  const file = join(root, relativePath);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, source, 'utf8');
}

test('未使用export監査は未参照・製品参照・製造契約参照・テスト専用参照を区別する', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aiwm-unused-export-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  write(root, 'app/renderer/js/example.js', [
    'export const unusedValue = 1;',
    'export const productUsed = 2;',
    'export const buildUsed = 3;',
    'export const testOnly = 4;',
  ].join('\n'));
  write(root, 'app/renderer/js/consumer.js', "import { productUsed } from './example.js';\nexport const consumed = productUsed;\n");
  write(root, 'tools/build/contract.js', "import { buildUsed } from '../../app/renderer/js/example.js';\nvoid buildUsed;\n");
  write(root, 'tools/tests/game/example.test.js', "import { testOnly } from '../../../app/renderer/js/example.js';\nvoid testOnly;\n");

  const candidates = collectUnusedProductionExports(root);
  const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));

  assert.equal(byName.has('unusedValue'), true, '製品・製造・テストのどこからも未参照なら候補にする');
  assert.equal(byName.has('testOnly'), true, 'テストだけの参照は製品利用扱いにしない');
  assert.equal(byName.get('testOnly')?.testReferenceCount, 1);
  assert.equal(byName.has('productUsed'), false, '製品コードから参照されるexportは候補にしない');
  assert.equal(byName.has('buildUsed'), false, '製造契約から参照されるexportは候補にしない');
});
