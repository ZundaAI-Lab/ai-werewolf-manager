/**
 * 責務: 元のpromptEnvelopeから生成段階ごとの送信区画を投影する。
 * 変更ルール: directは既存Envelopeをそのまま維持する。decide/finalizeは共通ゲーム規則・タスク指示を保持しつつstablePlayerContextを送らず、人物情報は専用プロンプトから必要分だけ渡す。analyze/critiqueは自由記述分析用として共通ゲーム規則と専用プロンプトだけを送り、JSON出力契約を持たせない。renderは専用プロンプト以外のゲーム文脈を送らない。API通信、候補検証、ゲーム状態更新を行わない。
 */

export function isGenerationTextPatchStage(stageId) {
  return stageId === 'render';
}

export function isGenerationFreeTextStage(stageId) {
  return stageId === 'analyze' || stageId === 'critique';
}

export function projectGenerationStagePromptEnvelope({
  baseEnvelope,
  stageId,
  prompt,
  fallbackSystemInstruction = '',
} = {}) {
  if (!baseEnvelope || typeof baseEnvelope !== 'object') throw new TypeError('元promptEnvelopeがありません。');
  if (!['direct', 'decide', 'analyze', 'critique', 'finalize', 'render'].includes(stageId)) throw new RangeError(`未対応の生成段階です: ${stageId}`);
  const textPatchStage = isGenerationTextPatchStage(stageId);
  const freeTextStage = isGenerationFreeTextStage(stageId);
  const directStage = stageId === 'direct';
  const candidateStage = stageId === 'decide' || stageId === 'finalize';
  return {
    schemaVersion: 5,
    commonSystemInstruction: (textPatchStage || freeTextStage)
      ? ''
      : String(baseEnvelope.commonSystemInstruction ?? fallbackSystemInstruction ?? ''),
    commonGameContext: textPatchStage ? '' : String(baseEnvelope.commonGameContext ?? ''),
    taskInvariantContext: (directStage || candidateStage) ? String(baseEnvelope.taskInvariantContext ?? '') : '',
    taskVariableContext: (directStage || candidateStage) ? String(baseEnvelope.taskVariableContext ?? '') : '',
    stablePlayerContext: directStage ? String(baseEnvelope.stablePlayerContext ?? '') : '',
    dynamicTaskPrompt: String(prompt ?? ''),
    structuredOutput: (textPatchStage || freeTextStage)
      ? null
      : (baseEnvelope.structuredOutput ? structuredClone(baseEnvelope.structuredOutput) : null),
    cacheIdentity: {
      ...(baseEnvelope.cacheIdentity ?? {}),
      promptFamily: textPatchStage
        ? 'generation-text-patch'
        : freeTextStage
          ? `generation-${stageId}-text`
          : directStage
            ? String(baseEnvelope.cacheIdentity?.promptFamily ?? 'game-candidate')
            : `generation-${stageId}-candidate`,
    },
  };
}

export function flattenGenerationStagePromptEnvelope(envelope) {
  return [
    envelope?.commonGameContext,
    envelope?.taskInvariantContext,
    envelope?.stablePlayerContext,
    envelope?.taskVariableContext,
    envelope?.dynamicTaskPrompt,
  ].map((value) => String(value ?? '').trim()).filter(Boolean).join('\n\n---\n\n');
}
