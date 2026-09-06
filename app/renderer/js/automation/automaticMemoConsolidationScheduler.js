/**
 * 責務: 全自動実行中の内部メモ整理だけをプレイヤー単位のバックグラウンド処理として管理し、異なるAI同士は並列生成、同一AIは排他、API完了後は即commitする。本人の次AI生成前に未完了整理を待機できるbarrierと、停止時の全処理収束待ちも提供する。
 * 変更ルール: ゲーム規則や整理対象判定を独自に持たず、automaticAiBatchPolicyが渡したmemo-consolidate要求だけを開始する。処理中状態・失敗状態はAutomationメモリ内だけに保持しゲームstateへ追加しない。整理結果の正式反映はautomaticAiExecutor.commitAiStepを唯一の入口とし、同一プレイヤーへ複数整理を同時実行しない。
 */

export function createAutomaticMemoConsolidationScheduler({
  automationRunControl,
  executeAiStep,
  setStatus,
}) {
  if (!automationRunControl || !executeAiStep?.generateAiStep || !executeAiStep?.commitAiStep) {
    throw new Error('内部メモ並列整理の必須依存を初期化できません。');
  }

  const pendingByPlayerId = new Map();
  const failures = [];

  function recordsForSession(session) {
    return [...pendingByPlayerId.values()].filter((record) => record.session === session);
  }

  function pendingPlayerIds(session) {
    return recordsForSession(session).map((record) => record.playerId);
  }

  function takeFailure(session) {
    const index = failures.findIndex((item) => item.session === session);
    if (index < 0) return null;
    return failures.splice(index, 1)[0]?.error ?? null;
  }

  function assertHealthy(session) {
    const error = takeFailure(session);
    if (error) throw error;
  }

  function startRequest(request, session) {
    const playerId = String(request?.playerId ?? '').trim();
    if (!playerId || String(request?.taskType ?? '') !== 'memo-consolidate') return false;
    const existing = pendingByPlayerId.get(playerId);
    if (existing?.session === session) return false;
    if (existing) throw new Error(`別セッションの内部メモ整理が残っています: ${playerId}`);

    const record = { playerId, session, promise: null };
    record.promise = (async () => {
      try {
        automationRunControl.assertRunning(session);
        const generated = await executeAiStep.generateAiStep(request, session);
        automationRunControl.assertRunning(session);
        await executeAiStep.commitAiStep(generated, session);
        return { ok: true };
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error ?? '内部メモ整理に失敗しました。'));
        if (!automationRunControl.isStopped(session)) failures.push({ session, error: normalized });
        return { ok: false, error: normalized };
      } finally {
        if (pendingByPlayerId.get(playerId) === record) pendingByPlayerId.delete(playerId);
      }
    })();
    pendingByPlayerId.set(playerId, record);
    return true;
  }

  function startBatch(batch, session) {
    automationRunControl.assertRunning(session);
    if (batch?.source !== 'memo-consolidation') throw new Error('内部メモ整理以外のバッチは開始できません。');
    let startedCount = 0;
    for (const request of batch.taskRequests ?? []) {
      if (startRequest(request, session)) startedCount += 1;
    }
    if (startedCount > 0) setStatus?.(`内部メモ整理を並列実行中（${startedCount}件）`, 'working');
    return { status: startedCount > 0 ? 'advanced' : 'invalidated', advancedCount: startedCount };
  }

  async function waitForPlayer(playerId, session) {
    assertHealthy(session);
    const record = pendingByPlayerId.get(String(playerId ?? ''));
    if (record?.session === session) await record.promise;
    automationRunControl.assertRunning(session);
    assertHealthy(session);
  }

  async function waitForPlayers(playerIds, session) {
    const ids = [...new Set((playerIds ?? []).map((playerId) => String(playerId ?? '')).filter(Boolean))];
    assertHealthy(session);
    const promises = ids
      .map((playerId) => pendingByPlayerId.get(playerId))
      .filter((record) => record?.session === session)
      .map((record) => record.promise);
    if (promises.length) await Promise.all(promises);
    automationRunControl.assertRunning(session);
    assertHealthy(session);
  }

  async function waitForAll(session) {
    assertHealthy(session);
    const records = recordsForSession(session);
    if (records.length) await Promise.all(records.map((record) => record.promise));
    automationRunControl.assertRunning(session);
    assertHealthy(session);
  }

  async function settleAll(session) {
    const records = recordsForSession(session);
    if (records.length) await Promise.all(records.map((record) => record.promise));
    for (let index = failures.length - 1; index >= 0; index -= 1) {
      if (failures[index].session === session) failures.splice(index, 1);
    }
  }

  return Object.freeze({
    assertHealthy,
    pendingPlayerIds,
    settleAll,
    startBatch,
    waitForAll,
    waitForPlayer,
    waitForPlayers,
  });
}
