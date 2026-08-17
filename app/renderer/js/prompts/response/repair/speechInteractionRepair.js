/**
 * 責務: speechInteractionを自動修復対象から隔離し、質問先・回答参照の意味をパーサーと検証器へそのまま渡す。
 * 変更ルール: 公開本文を解析しない。外部契約にないキー、空構造、対象名、公開イベント参照を削除・置換・補完せず、不正時は必ず再生成対象にする。
 */

function repairSpeechInteraction(_state, _playerId, _payload, _operations) {
  // 質問・回答関係はゲーム進行へ影響するため、決定的に見える補正でも意味変更になり得る。
  // 本モジュールでは一切書き換えず、responseParser / responseValidatorを正本とする。
}

export { repairSpeechInteraction };
