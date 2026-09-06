/**
 * 責務: domainが並列可能と判定した連続AIタスクを同時生成し、既存workflowが示す順序を毎commit直前に再確認しながら決定論的に直列登録する。
 * 変更ルール: 並列対象のゲーム規則を独自判定しない。生成完了順では登録せず、batch policyのtaskRequests順だけでcommitする。先行commitにより内部メモ整理など別タスクが割り込んだ場合は残り生成結果を破棄し、次ループで最新状態から再生成する。Automationが別プレイヤーの内部メモ整理を通信中としてworkflowから一時除外している場合は、その除外条件をcommit直前の自動操作再判定にも同じく適用する。
 */

function sameTaskRequest(action, request) {
  if (action?.kind !== 'ai-task') return false;
  const actual = action.taskRequest ?? {};
  return String(actual.playerId ?? '') === String(request.playerId ?? '')
    && String(actual.taskType ?? '') === String(request.taskType ?? '')
    && String(actual.slotId ?? '') === String(request.slotId ?? '');
}

export function createAutomaticAiBatchExecutor({
  automationRunControl,
  controller,
  executeAiStep,
  runtime,
  setStatus,
  automaticActionOptions = null,
}) {
  if (!automationRunControl || !executeAiStep?.generateAiStep || !executeAiStep?.commitAiStep) {
    throw new Error('AIバッチ実行の必須依存を初期化できません。');
  }

  return async function executeAiBatch(batch, session) {
    automationRunControl.assertRunning(session);
    const taskRequests = [...(batch?.taskRequests ?? [])];
    if (taskRequests.length < 2) return { status: 'invalidated', advancedCount: 0 };

    setStatus?.(`独立AI行動を並列生成中（${taskRequests.length}件）`, 'working');
    const generated = await Promise.allSettled(
      taskRequests.map((request) => executeAiStep.generateAiStep(request, session)),
    );
    automationRunControl.assertRunning(session);

    let advancedCount = 0;
    for (let index = 0; index < generated.length; index += 1) {
      automationRunControl.assertRunning(session);
      const settled = generated[index];
      if (settled.status === 'rejected') {
        const error = settled.reason instanceof Error ? settled.reason : new Error(String(settled.reason ?? 'AI生成に失敗しました。'));
        error.advancedCount = advancedCount;
        throw error;
      }

      const request = taskRequests[index];
      const nextAction = runtime().resolveAutomaticAction({
        autoPublish: controller.settings.autoRun.autoPublish,
        ...(automaticActionOptions?.() ?? {}),
      });
      if (!sameTaskRequest(nextAction, request)) {
        return { status: advancedCount > 0 ? 'advanced' : 'invalidated', advancedCount };
      }

      await executeAiStep.commitAiStep(settled.value, session);
      advancedCount += 1;
    }

    return { status: 'advanced', advancedCount };
  };
}
