/**
 * 責務: AIターンが通常AI登録か必須項目／行フォールバック登録かを監査記録から判定し、公開履歴差分の基準となる最新の正常登録を一元取得する。
 * 変更ルール: ゲーム状態・公開履歴・API会話を更新しない。自動修復済みのAI回答は正常登録として扱い、システムが必須値または行全体を代替したターンだけを差分カーソルから除外する。判定用コードをUIやプロンプト生成層へ重複実装しない。
 */

const AUTOMATIC_FALLBACK_ISSUE_CODES = new Set([
  'REQUIRED_FIELD_FALLBACK_APPLIED',
  'ROW_FALLBACK_APPLIED',
]);

export function generationRunUsesAutomaticFallback(generationRun) {
  return (generationRun?.stages ?? []).some((stage) =>
    (stage?.issues ?? []).some((issue) => AUTOMATIC_FALLBACK_ISSUE_CODES.has(String(issue?.code ?? ''))));
}

export function shouldCompleteFullPublicHistorySync(taskArtifact, generationRun) {
  return Boolean(
    taskArtifact?.forceFullPublicHistory
    && taskArtifact?.publicHistoryMode === 'full'
    && !generationRunUsesAutomaticFallback(generationRun),
  );
}

export function isNormalAiRegistrationTurn(turn) {
  return Boolean(
    turn
    && Number.isInteger(turn.publicSequenceAtRegistration)
    && turn.publicSequenceAtRegistration >= 0
    && !generationRunUsesAutomaticFallback(turn.generationRun),
  );
}

export function findLatestNormalAiRegistrationTurn(state, playerId) {
  const normalizedPlayerId = String(playerId ?? '');
  return [...(state?.aiTurns ?? [])]
    .reverse()
    .find((turn) => String(turn?.playerId ?? '') === normalizedPlayerId && isNormalAiRegistrationTurn(turn))
    ?? null;
}
