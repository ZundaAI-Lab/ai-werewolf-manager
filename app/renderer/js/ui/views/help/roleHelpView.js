/**
 * 責務: 人間ユーザー向けの役職一覧、陣営、能力、勝利条件を公開情報だけで描画する。
 * 変更ルール: 配役の担当者や秘密情報を表示せず、現在の配役はroleComposition.jsの公開構成を正本とする。役職説明はROLE_DEFINITIONS.helpを正本として「概要／能力／特徴・制約」の順で同じ粒度に描画する。役職通知用descriptionへヘルプ文面を混在させず、ゲーム状態の更新や役職能力の判定を行わない。
 */

import { ROLE_DEFINITIONS, TEAM_LABELS } from '../../../config/constants.js';
import { getPublicRoleComposition } from '../../../domain/roles/roleComposition.js';
import { escapeHtml } from '../../../shared/utils.js';

const ROLE_GROUPS = Object.freeze([
  Object.freeze({
    id: 'village',
    title: '村人陣営',
    summary: '会話、投票、能力を使って人狼を全員排除します。',
    roleIds: Object.freeze(['villager', 'mason', 'seer', 'medium', 'guard', 'cat', 'namahage']),
  }),
  Object.freeze({
    id: 'wolf',
    title: '人狼陣営',
    summary: '正体を隠しながら村人陣営を減らし、人狼側の勝利を目指します。',
    roleIds: Object.freeze(['wolf', 'whiteWolf', 'madman', 'snowWoman']),
  }),
  Object.freeze({
    id: 'other',
    title: '第三陣営・陣営遅延決定',
    summary: '村人陣営や人狼陣営とは異なる条件、またはゲーム中に決まる陣営で勝利を目指します。',
    roleIds: Object.freeze(['fox', 'zashikiWarashi']),
  }),
]);

function roleTeamLabel(role) {
  if (role?.id === 'zashikiWarashi') return '家主と同じ陣営（初夜に決定）';
  return TEAM_LABELS[role?.baseTeam] ?? '陣営未定';
}

function compositionCounts(state) {
  const composition = getPublicRoleComposition(state);
  return new Map(Object.entries(composition)
    .filter(([roleId, count]) => ROLE_DEFINITIONS[roleId] && Number(count) > 0)
    .map(([roleId, count]) => [roleId, Number(count)]));
}

function renderCurrentComposition(counts) {
  const rows = Object.keys(ROLE_DEFINITIONS)
    .filter((roleId) => (counts.get(roleId) ?? 0) > 0)
    .map((roleId) => `<span class="role-help-composition-item">${escapeHtml(ROLE_DEFINITIONS[roleId].name)}×${counts.get(roleId)}</span>`)
    .join('');
  if (!rows) return '<p class="help">現在の配役はまだ設定されていません。</p>';
  return `<div class="role-help-composition-list">${rows}</div>`;
}

function renderRoleCard(roleId, currentCounts) {
  const role = ROLE_DEFINITIONS[roleId];
  if (!role) return '';
  const currentCount = currentCounts.get(roleId) ?? 0;
  const help = role.help ?? {};
  const rows = [
    ['概要', help.overview ?? role.description ?? ''],
    ['能力', help.ability ?? '固有能力はありません。'],
    ['特徴・制約', help.details ?? '特別な制約はありません。'],
  ];
  return `<article class="role-help-card${currentCount > 0 ? ' is-current' : ''}">
    <div class="role-help-card-head">
      <h4>${escapeHtml(role.name)}</h4>
      <div class="role-help-badges">
        <span class="tag">${escapeHtml(roleTeamLabel(role))}</span>
        ${currentCount > 0 ? `<span class="role-help-current-badge">今回登場×${currentCount}</span>` : ''}
      </div>
    </div>
    <dl class="role-help-card-details">${rows.map(([label, text]) => `<div class="role-help-detail-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text)}</dd></div>`).join('')}</dl>
  </article>`;
}

export function renderRoleHelp({ state } = {}) {
  const counts = compositionCounts(state);
  const roleMissingNotice = state?.game?.rules?.roleAssignment?.roleMissingEnabled === true
    ? '<p class="help"><strong>役職欠けあり</strong>：表示している配役は開始前に公開された構成です。実際に欠けた役職は公開されません。</p>'
    : '';
  const groups = ROLE_GROUPS.map((group) => `<section class="role-help-section" aria-labelledby="role-help-${group.id}">
    <div class="role-help-section-head">
      <h3 id="role-help-${group.id}">${escapeHtml(group.title)}</h3>
      <p>${escapeHtml(group.summary)}</p>
    </div>
    <div class="role-help-grid">${group.roleIds.map((roleId) => renderRoleCard(roleId, counts)).join('')}</div>
  </section>`).join('');

  return `<div class="modal-body role-help-body">
    <section class="role-help-intro">
      <h3>勝利条件</h3>
      <ul>
        <li><strong>村人陣営:</strong> 生存している人狼を0人にする。</li>
        <li><strong>人狼陣営:</strong> 生存人狼数を、その他の生存者数以上にする。</li>
        <li><strong>妖狐陣営:</strong> 村人陣営または人狼陣営の勝利条件が成立した時点で生存している。</li>
      </ul>
      <p class="help">自己占い、自己護衛、連続護衛、初夜行動などの細かな条件は、ゲーム準備で設定された主要ルールが優先されます。</p>
    </section>
    <section class="role-help-current" aria-labelledby="role-help-current-title">
      <h3 id="role-help-current-title">現在の配役</h3>
      ${renderCurrentComposition(counts)}
      ${roleMissingNotice}
    </section>
    ${groups}
  </div>`;
}
