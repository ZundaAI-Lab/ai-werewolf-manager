/**
 * 責務: 保存済み霊能結果の対象参照と公開イベント参照を検査する。
 * 変更ルール: 霊能判定の生成や公開処理を行わず、保存済み参照の存在確認だけを担当する。
 */

export function validateMediumResultState(context) {
  const { raw, label, errors, checkId, eventIdSet } = context;
  (raw.mediumResults ?? []).forEach((entry) => {
    checkId(entry.mediumId, '霊能者');
    checkId(entry.executedPlayerId, '霊能対象');
    if (entry.eventId && !eventIdSet.has(entry.eventId)) errors.push(`${label}: 霊能結果イベント参照先が存在しません。`);
  });
}
