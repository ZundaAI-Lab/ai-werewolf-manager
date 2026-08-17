/**
 * 責務: UIで共有する死亡理由、夜行動表示、凍結強調、判断差分プレビュー、トースト種別・夜名伏せを純粋関数として提供する。
 * 変更ルール: DOMや状態を更新せず、表示変換だけを行う。ゲーム規則の独自判定を追加しない。
 */

import { isPersonalNightActionTask } from '../../config/personalNightActionTasks.js';
import { getPlayer } from '../../domain/game/standardRules.js';
import { isFrozenOnDay } from '../../domain/game/playerStatus.js';

export const NIGHT_ACTION_LABELS = Object.freeze({ inspect: '占い', guard: '護衛', visit: '訪問', freeze: '凍結', 'choose-owner': '家主選択' });
export const NIGHT_ACTION_TARGET_LABELS = Object.freeze({ inspect: '占い対象', guard: '護衛対象', visit: '訪問先', freeze: '凍結対象', 'choose-owner': '家主' });
export const TOAST_DURATION_MS = Object.freeze({ success: 2600, info: 3200, warning: 6500, error: 0 });

export function deathCauseLabel(cause) {
  return ({ 'wolf-attack': '人狼襲撃', 'fox-divination': '占いによる妖狐死亡', 'cat-revenge': '猫又の道連れ', 'owner-follow': '家主の死亡による後追い', execution: '処刑' })[cause] ?? cause;
}
export function normalizeToastType(type) { return ['success', 'info', 'warning', 'error'].includes(type) ? type : 'info'; }
export function maskNightActorNames(message, state) {
  const replacement = '夜行動担当';
  return [...(state?.players ?? [])].map((player) => String(player?.name ?? '').trim()).filter(Boolean).sort((a,b) => b.length-a.length).reduce((text,name) => text.split(name).join(replacement), String(message ?? ''));
}
export function isPersonalNightAction(taskType) { return isPersonalNightActionTask(taskType); }
export function nightActionLabel(taskType) { return NIGHT_ACTION_LABELS[taskType] ?? taskType; }
export function nightActionTargetLabel(taskType) { return NIGHT_ACTION_TARGET_LABELS[taskType] ?? '対象'; }
export function shouldHighlightFrozenPlayerPanel(state, playerId) {
  const player = getPlayer(state, playerId);
  return Boolean(player?.alive && !['result', 'ended'].includes(state.game.phase) && isFrozenOnDay(state, playerId));
}
export function formatDecisionUpdatePreview(decisionUpdate) {
  if (!decisionUpdate) return '';
  if (decisionUpdate.mode === 'keep') return '判断更新: 維持';
  const changes = decisionUpdate.changes ?? {};
  const candidates = (key) => !Object.hasOwn(changes, key) ? '変更なし' : changes[key]?.length ? changes[key].join('、') : '解除';
  return `判断更新: 疑い ${candidates('suspicionCandidateNames')} / 処刑価値 ${candidates('executionCandidateNames')}`;
}
