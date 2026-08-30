/**
 * 責務: 常設1ゲーム通しテストランナーが、回答不受理時に状態を進めず、受理時に本番AI登録境界を通して再開可能な次タスクへ進む代表経路を確認する。
 * 変更ルール: プロンプト自然文を固定せず、ランナー固有のファイル受け渡し・状態不変条件・本番生成監査の構造だけを検証する。ゲーム規則やタスク別登録分岐の重複テストはここへ追加しない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeRun, statusRun, submitRun } from '../game-runner/runFullGame.js';

const require = createRequire(import.meta.url);
const demoAi = require('../../../app/shared/demoAi.js');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('常設通しテストランナーは不受理回答を保持して同一タスク再試行し、受理回答だけを本番登録する', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'ai-werewolf-full-runner-'));
  try {
    const initialized = await initializeRun({ workspace, force: true });
    assert.equal(initialized.kind, 'ai-task');
    const before = await statusRun({ workspace });
    assert.ok(before.pending);

    await writeFile(join(workspace, 'current_response.txt'), 'not-json', 'utf8');
    const retry = await submitRun({ workspace });
    assert.equal(retry.kind, 'retry-required');
    const afterRetry = await statusRun({ workspace });
    assert.equal(afterRetry.aiTurnCount, before.aiTurnCount);
    assert.equal(afterRetry.pending.id, before.pending.id);
    assert.equal(afterRetry.pending.nextAttemptNumber, 2);

    const task = await readJson(join(workspace, 'current_task.json'));
    const state = await readJson(join(workspace, 'state.json'));
    const player = state.players.find((item) => item.id === task.playerId);
    assert.ok(player);
    const aiInput = await readFile(join(workspace, 'current_ai_input.txt'), 'utf8');
    const rawResponse = demoAi.generate({
      prompt: aiInput,
      taskType: task.taskType,
      playerName: player.name,
      requestPurpose: 'normal',
    });
    await writeFile(join(workspace, 'current_response.txt'), rawResponse, 'utf8');
    const submitted = await submitRun({ workspace });
    assert.ok(['ai-task', 'ended'].includes(submitted.kind));

    const committedState = await readJson(join(workspace, 'state.json'));
    assert.equal(committedState.aiTurns.length, before.aiTurnCount + 1);
    const committed = committedState.aiTurns.at(-1);
    assert.equal(committed.playerId, task.playerId);
    assert.equal(committed.generationRun.stages[0].rawResponse, rawResponse);
    assert.equal(committed.generationRun.executionMode, 'manual');
    assert.equal(committed.generationRun.depth, 1);
    assert.equal(committed.generationRun.totalCallCount, 0);

    const session = await readJson(join(workspace, 'session.json'));
    const audited = session.turns.find((turn) => turn.id === task.id);
    assert.equal(audited.attempts.length, 2);
    assert.equal(audited.attempts[0].ok, false);
    assert.equal(audited.attempts[1].ok, true);
    assert.equal(audited.commit.ok, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
