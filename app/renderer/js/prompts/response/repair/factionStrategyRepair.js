/**
 * 責務: factionStrategyを自動修復対象から隔離し、本人限定戦略の意味をパーサーと検証器へそのまま渡す。
 * 変更ルール: 戦略内容、許可キー、mode、partnerDispositionを削除・置換・補完しない。局面依存の無効値を含む不正入力は必ず再生成対象にし、保存前の正規化はdomain/game/factionStrategyState.jsだけで行う。
 */

function repairFactionStrategy(_state, _playerId, _payload, _operations) {
  // 陣営戦略は後続判断へ持続する意味情報であり、黙った項目削除や別値への置換を禁止する。
  // responseParser / responseValidatorとfactionStrategyState.jsの検証・登録規則を正本とする。
}

export { repairFactionStrategy };
