/**
 * 責務: 未使用export監査がTypeScriptシンボル単位で候補を報告し、現段階では製造失敗へ昇格しないことを固定する。
 * 変更ルール: 候補件数そのものは固定せず、監査形式・report-only方針・製造契約からの参照を製品参照として数える境界だけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { collectUnusedProductionExports } = require('../../build/unusedExportAudit.js');

const projectRoot = join(__dirname, '../../..');

test('未使用export監査は製品内参照ゼロの候補をシンボル単位で報告する', () => {
  const candidates = collectUnusedProductionExports(projectRoot);
  assert.ok(Array.isArray(candidates));
  candidates.forEach((candidate) => {
    assert.match(candidate.file, /^app\/renderer\/js\//u);
    assert.equal(typeof candidate.name, 'string');
    assert.equal(candidate.productionReferenceCount, 0);
    assert.equal(Number.isInteger(candidate.testReferenceCount), true);
  });
});


test('製造契約から参照されるexportは未使用候補に含めない', () => {
  const candidates = collectUnusedProductionExports(projectRoot);
  const names = new Set(candidates.map((candidate) => candidate.name));
  assert.equal(names.has('AUTOMATIC_ACTION_POLICY'), false);
  assert.equal(names.has('validateResponseContractCatalogCoverage'), false);
});
