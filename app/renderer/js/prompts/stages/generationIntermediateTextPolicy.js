/**
 * 責務: Analyze/Critique自由記述の推奨出力量、後続プロンプト参照上限、監査保存上限を一元管理する。
 * 変更ルール: API設定やゲーム状態を変更しない。後続参照と監査保存は別上限とし、外部LLMの過大応答をゲーム状態へ無制限に保持しない。上限変更時はAnalyze/Critiqueのプロンプト表示値、参照切り詰め、監査切り詰めを同時に確認する。
 */

const INTERMEDIATE_TEXT_POLICY = Object.freeze({
  analyze: Object.freeze({ promptMaxItems: 10, promptMaxChars: 1600, referenceMaxChars: 2400, auditMaxChars: 64_000 }),
  critique: Object.freeze({ promptMaxItems: 6, promptMaxChars: 1000, referenceMaxChars: 1600, auditMaxChars: 64_000 }),
});

export function generationIntermediateTextPolicy(stageId) {
  const policy = INTERMEDIATE_TEXT_POLICY[String(stageId ?? '')];
  if (!policy) throw new RangeError(`中間自由記述の対象外です: ${stageId}`);
  return policy;
}

export function limitGenerationIntermediateReference(stageId, value) {
  const policy = generationIntermediateTextPolicy(stageId);
  const rawText = String(value ?? '').trim();
  if (rawText.length <= policy.referenceMaxChars) {
    return { text: rawText, truncated: false, originalLength: rawText.length, maxChars: policy.referenceMaxChars };
  }
  const suffix = '…';
  const bodyLength = Math.max(0, policy.referenceMaxChars - suffix.length);
  return {
    text: `${rawText.slice(0, bodyLength).trimEnd()}${suffix}`,
    truncated: true,
    originalLength: rawText.length,
    maxChars: policy.referenceMaxChars,
  };
}

export function intermediateReferenceTruncationIssue(stageId, limited) {
  if (!limited?.truncated) return null;
  return {
    code: 'INTERMEDIATE_TEXT_TRUNCATED',
    message: `${stageId}の自由記述が${limited.originalLength}文字だったため、後続工程への参照は${limited.maxChars}文字に制限しました。`,
  };
}

export function limitGenerationIntermediateAudit(stageId, value) {
  const policy = generationIntermediateTextPolicy(stageId);
  const rawText = String(value ?? '');
  if (rawText.length <= policy.auditMaxChars) {
    return { text: rawText, truncated: false, originalLength: rawText.length, maxChars: policy.auditMaxChars };
  }
  const suffix = '…';
  const bodyLength = Math.max(0, policy.auditMaxChars - suffix.length);
  return {
    text: `${rawText.slice(0, bodyLength)}${suffix}`,
    truncated: true,
    originalLength: rawText.length,
    maxChars: policy.auditMaxChars,
  };
}

export function intermediateAuditTruncationIssue(stageId, limited) {
  if (!limited?.truncated) return null;
  return {
    code: 'INTERMEDIATE_AUDIT_TRUNCATED',
    message: `${stageId}の自由記述が${limited.originalLength}文字だったため、監査保存は${limited.maxChars}文字に制限しました。`,
  };
}
