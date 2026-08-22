/**
 * 責務: ゲーム終了後AI分析のUI利用可否が、現在の実行方式ではなく対象ターンの生成記録と元プロファイル状態から決まることを確認する。
 * 変更ルール: API送信内容はadapterテストへ委譲し、ここでは入力欄を出す／出さないUI境界と利用不可理由だけを固定する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadControllerFactory(document = undefined) {
  const source = fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/ui/controllers/postgameAnalysisController.js'), 'utf8')
    .replace('export function createPostgameAnalysisController', 'function createPostgameAnalysisController')
    .concat('\nglobalThis.__postgameControllerFactory = createPostgameAnalysisController;\n');
  const context = vm.createContext({ structuredClone, console, document });
  vm.runInContext(source, context, { filename: 'postgameAnalysisController.js' });
  return context.__postgameControllerFactory;
}

function sampleState(executionMode = 'automatic') {
  return {
    game: { id: 'game-1', phase: 'ended' },
    players: [{ id: 'p1', name: 'ずんだもん' }],
    aiTurns: [{
      id: 'turn-1',
      playerId: 'p1',
      generationRun: {
        executionMode,
        ownerProfileId: 'profile-original',
      },
    }],
  };
}

function createUi(state, profiles) {
  return {
    aiExecutionSettings: {
      executionMode: 'manual',
      profiles,
      assignments: {},
    },
    drafts: new Map(),
    store: { getState: () => state },
    render: () => {},
    toast: () => {},
    _controlValue: () => '',
  };
}

test('終了後AI分析UIは現在の実行方式が手動でも自動生成ターンを利用可能にする', () => {
  const createController = loadControllerFactory();
  const state = sampleState('automatic');
  const ui = createUi(state, [{ id: 'profile-original', enabled: true, provider: 'openai' }]);
  const controller = createController({ ui });
  controller.setAdapter({ analyzeTurn: async () => ({}) });

  const view = controller.viewModel(state);
  assert.equal(view.enabled, true);
  assert.equal(view.byTurnId['turn-1'].available, true);
  assert.equal(view.byTurnId['turn-1'].unavailableReason, '');
});

test('終了後AI分析UIはデモAIを無効化して理由を表示する', () => {
  const createController = loadControllerFactory();
  const state = sampleState('automatic');
  const ui = createUi(state, [{ id: 'profile-original', enabled: true, provider: 'demo' }]);
  const controller = createController({ ui });
  controller.setAdapter({ analyzeTurn: async () => ({}) });

  const analysis = controller.viewModel(state).byTurnId['turn-1'];
  assert.equal(analysis.available, false);
  assert.equal(analysis.unavailableReason, 'デモAIでは終了後分析できません。');
});

test('終了後AI分析UIは手動生成ターンを表示対象にしない', () => {
  const createController = loadControllerFactory();
  const state = sampleState('manual');
  const ui = createUi(state, [{ id: 'profile-original', enabled: true, provider: 'openai' }]);
  const controller = createController({ ui });
  controller.setAdapter({ analyzeTurn: async () => ({}) });

  const analysis = controller.viewModel(state).byTurnId['turn-1'];
  assert.equal(analysis.available, false);
  assert.equal(analysis.unavailableReason, '');
});


function createDetailsDocument(turnId = 'turn-1') {
  let nodes = null;
  function replaceNodes() {
    nodes = {
      audit: { open: false },
      turn: { open: false, dataset: { aiTurnId: turnId } },
      analysis: { open: false, dataset: { postgameAnalysisTurnId: turnId } },
    };
  }
  replaceNodes();
  return {
    querySelector(selector) { return selector === '#records-audit-support' ? nodes.audit : null; },
    querySelectorAll(selector) {
      if (selector === '[data-ai-turn-id]') return [nodes.turn];
      if (selector === '[data-postgame-analysis-turn-id]') return [nodes.analysis];
      return [];
    },
    replaceNodes,
    nodes: () => nodes,
  };
}

test('GM質問の開始・完了再描画でも現在の詳細開閉状態を保持する', async () => {
  const document = createDetailsDocument();
  const createController = loadControllerFactory(document);
  const state = sampleState('automatic');
  const ui = createUi(state, [{ id: 'profile-original', enabled: true, provider: 'openai' }]);
  ui._controlValue = () => 'この判断の根拠は？';
  ui.render = () => document.replaceNodes();
  const controller = createController({ ui });
  let resolveAnalysis = null;
  controller.setAdapter({
    analyzeTurn: () => new Promise((resolve) => { resolveAnalysis = resolve; }),
  });

  document.nodes().audit.open = true;
  document.nodes().turn.open = true;
  document.nodes().analysis.open = true;

  const asking = controller.ask('turn-1');
  await Promise.resolve();
  assert.equal(document.nodes().audit.open, true, '質問開始時も詳細・補助情報を閉じない');
  assert.equal(document.nodes().turn.open, true, '質問開始時も対象AI応答を閉じない');
  assert.equal(document.nodes().analysis.open, true, '質問開始時もGM分析欄を閉じない');

  document.nodes().turn.open = false;
  document.nodes().analysis.open = false;
  resolveAnalysis({ answer: '回答', attributions: [] });
  await asking;

  assert.equal(document.nodes().audit.open, true, '回答完了時も親詳細を維持する');
  assert.equal(document.nodes().turn.open, false, '待機中に利用者が閉じたAI応答は勝手に再オープンしない');
  assert.equal(document.nodes().analysis.open, false, '待機中に利用者が閉じた分析欄も尊重する');
});
