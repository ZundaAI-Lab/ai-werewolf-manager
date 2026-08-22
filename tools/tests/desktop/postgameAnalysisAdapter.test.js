/**
 * 責務: ゲーム終了後AI分析が保存済みAIターン監査だけを再提示し、ゲーム用AIタスクや手動生成へ混入しないことを確認する。
 * 変更ルール: UI文言ではなく、当時プロファイル利用・保存済みprompt再提示・非ゲームタスク課金区分・現在実行方式からの独立・手動ターン／デモAI拒否の境界を固定する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esmSourceAsVmScript } = require('./esmTestSource.js');

function loadApi() {
  const source = esmSourceAsVmScript(fs.readFileSync(path.join(__dirname, '../../../app/renderer/js/automation/postgameAnalysisAdapter.js'), 'utf8'));
  const context = vm.createContext({ window: {}, structuredClone, console, setTimeout, clearTimeout });
  context.window.window = context.window;
  vm.runInContext(source, context, { filename: 'postgameAnalysisAdapter.js' });
  return { createPostgameAnalysisAdapter: vm.runInContext('createPostgameAnalysisAdapter', context) };
}

function sampleTurn(executionMode = 'automatic') {
  return {
    id: 'turn-1',
    day: 2,
    phase: 'discussion',
    taskType: 'speech',
    promptMode: 'normal',
    promptSpecVersion: 1,
    runtimeBuildId: 'build-x',
    promptText: 'ORIGINAL SAVED PROMPT: 公開履歴のA発言を比較してください。',
    rawResponse: '{"publicSpeech":"Aは村寄りです"}',
    parsedPublicSpeech: 'Aは村寄りです',
    parsedWolfConversationMessage: '',
    parsedMasonConversationMessage: '',
    parsedGraveyardConversationMessage: '',
    parsedActionAnswer: '',
    parsedSelectionRationale: 'Aの発言が一貫していたため',
    parsedHeartVoice: 'まだ断定はしない',
    parsedInternalMemoUpdate: null,
    parsedFullMemo: '',
    generationRun: {
      executionMode,
      depth: 3,
      ownerProfileId: 'profile-original',
      taskCategory: 'speech',
      finalStageId: 'proofread',
      stages: [
        { stageId: 'draft', executorProfileId: 'profile-original', status: 'accepted', targetTextFields: [], fallbackUsed: false, issues: [], rawResponse: 'DRAFT SAVED RESPONSE' },
        { stageId: 'render', executorProfileId: 'profile-render', status: 'applied', targetTextFields: ['publicSpeech'], fallbackUsed: false, issues: [], rawResponse: 'RENDER SAVED RESPONSE' },
      ],
    },
  };
}

test('終了後AI分析は当時のownerプロファイルへ保存済みprompt・応答・生成工程だけを再提示する', async () => {
  const api = loadApi();
  const requests = [];
  const controller = { settings: { executionMode: 'manual' }, usage: {} };
  const adapter = api.createPostgameAnalysisAdapter({
    bridge: {
      generate: async (request) => {
        requests.push(request);
        return {
          ok: true,
          text: JSON.stringify({
            answer: '公開履歴の影響が強いです。',
            attributions: [{ source: '生成時プロンプト / 公開履歴', influence: 'high', excerpt: 'A発言', reason: '直接比較しているため' }],
            otherFactors: '発言化工程も影響しています。',
            promptImprovement: '優先順位を明記します。',
            uncertainty: '事後分析です。',
          }),
          usage: {},
        };
      },
    },
    controller,
    profileById: (id) => ({ id, enabled: true, provider: 'openai' }),
    addUsage: () => {},
    refreshUsageSummary: async () => {},
  });

  const result = await adapter.analyzeTurn({
    gameId: 'game-1',
    player: { id: 'p1', name: 'ずんだもん' },
    turn: sampleTurn(),
    question: '「村寄り」は何に引っ張られた？',
    previousExchanges: [],
  });

  assert.equal(result.answer, '公開履歴の影響が強いです。');
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.profileId, 'profile-original');
  assert.equal(request.taskType, 'postgame-analysis');
  assert.equal(request.isTaskCall, false);
  assert.equal(request.taskStart, false);
  assert.match(request.promptEnvelope.dynamicTaskPrompt, /ORIGINAL SAVED PROMPT/u);
  assert.match(request.promptEnvelope.dynamicTaskPrompt, /DRAFT SAVED RESPONSE/u);
  assert.match(request.promptEnvelope.dynamicTaskPrompt, /RENDER SAVED RESPONSE/u);
  assert.match(request.promptEnvelope.dynamicTaskPrompt, /「村寄り」は何に引っ張られた？/u);
  assert.match(request.promptEnvelope.commonSystemInstruction, /Never claim access to hidden chain-of-thought/u);
  assert.equal(request.promptEnvelope.structuredOutput.name, 'postgame_ai_analysis');
});


test('終了後AI分析はデモAIを実分析として扱わない', async () => {
  const api = loadApi();
  let calls = 0;
  const adapter = api.createPostgameAnalysisAdapter({
    bridge: { generate: async () => { calls += 1; return { ok: true, text: '{}' }; } },
    controller: { settings: { executionMode: 'automatic' }, usage: {} },
    profileById: () => ({ enabled: true, provider: 'demo' }),
  });

  await assert.rejects(() => adapter.analyzeTurn({
    gameId: 'game-1',
    player: { id: 'p1', name: 'ずんだもん' },
    turn: sampleTurn('automatic'),
    question: 'なぜ？',
  }), /デモAIでは終了後分析できません/u);
  assert.equal(calls, 0);
});

test('終了後AI分析は手動生成ターンを別プロファイルへ代用しない', async () => {
  const api = loadApi();
  let calls = 0;
  const adapter = api.createPostgameAnalysisAdapter({
    bridge: { generate: async () => { calls += 1; return { ok: true, text: '{}' }; } },
    controller: { settings: { executionMode: 'automatic' }, usage: {} },
    profileById: () => ({ enabled: true }),
  });
  await assert.rejects(() => adapter.analyzeTurn({
    gameId: 'game-1',
    player: { id: 'p1', name: 'ずんだもん' },
    turn: sampleTurn('manual'),
    question: 'なぜ？',
  }), /手動生成/u);
  assert.equal(calls, 0);
});
