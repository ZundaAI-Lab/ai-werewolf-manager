/**
 * 責務: AI応答自動修復で使用する許可キーと列挙値別名を定義する。
 * 変更ルール: 修復処理やゲーム状態参照を実装せず、静的契約だけを保持する。
 */



const FACTION_STRATEGY_KEYS = Object.freeze([
  'publicWorld', 'dayWinPath', 'partnerDisposition', 'collapsePlan', 'linkageRisk',
  'fallbackRoute', 'pressureGoal', 'failureRisk', 'nextDayPlan',
]);
const SHARED_STRATEGY_KEYS = Object.freeze([
  'claimPlan', 'blackReceivedPlan', 'partnerExecutionPlan',
  'collapsePlan', 'discussionPlan', 'attackPlan',
]);
const ATTACK_ASSESSMENT_KEYS = Object.freeze([
  'hunterAliveChance', 'guardRisk', 'otherTarget', 'otherGuardRisk',
]);
const RISK_ALIASES = Object.freeze(new Map([
  ['low', 'low'], ['低', 'low'], ['low risk', 'low'], ['low-risk', 'low'],
  ['medium', 'medium'], ['mid', 'medium'], ['normal', 'medium'], ['中', 'medium'],
  ['high', 'high'], ['高', 'high'], ['high risk', 'high'], ['high-risk', 'high'],
]));


export { ATTACK_ASSESSMENT_KEYS, FACTION_STRATEGY_KEYS, RISK_ALIASES, SHARED_STRATEGY_KEYS };
