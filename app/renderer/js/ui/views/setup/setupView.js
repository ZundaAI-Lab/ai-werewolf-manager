/**
 * 責務: ゲーム準備画面のHTML生成と、入力変更後に必要な派生表示だけをDOM上で局所同期する。
 * 変更ルール: 状態更新・配役検証・ゲーム開始処理・ゲームデータ転送を行わず、渡された検証結果と状態だけを描画する。ゲームデータ読込／出力と新しいゲームはゲーム準備ヘッダーの同一操作領域へ集約する。参加者1行のHTMLはsetupPlayerRowView.jsを正本とし、入力中DOMを維持するため局所同期ではページ全体や参加者一覧全体を置換しない。
 */

import { MAX_PLAYER_COUNT, MIN_PLAYER_COUNT, SUPPORTED_PLAYER_COUNTS } from '../../../config/constants.js';
import { escapeHtml, checked } from '../../../shared/utils.js';
import { getPresetNoteForPlayerCount } from '../../../domain/setup/playerCountPolicy.js';
import { countsAsWolf } from '../../../domain/roles/roleAttributes.js';
import { option } from '../../components/components.js';
import { characterCardOptions, renderSetupPlayerRow } from './setupPlayerRowView.js';




function disabledAttr(...conditions) {
  return conditions.some(Boolean) ? 'disabled' : '';
}

function renderRuleCategory({ key = '', title, content, wide = false, inactive = false, inactiveLabel = '' }) {
  const classes = ['rule-category'];
  if (wide) classes.push('rule-category-wide');
  if (inactive) classes.push('is-inactive');
  const status = inactiveLabel
    ? `<small data-setup-inactive-label${inactive ? '' : ' hidden'}>${escapeHtml(inactiveLabel)}未選択</small>`
    : '';
  const keyAttribute = key ? ` data-setup-rule-category="${escapeHtml(key)}"` : '';
  return `<fieldset class="${classes.join(' ')}"${keyAttribute}><legend><span>${escapeHtml(title)}</span>${status}</legend><div class="form-grid">${content}</div></fieldset>`;
}

function renderSetupValidation(validation, locked) {
  return `${validation.errors.map((item) => `<div class="validation error">× ${escapeHtml(item)}</div>`).join('')}${validation.warnings.map((item) => `<div class="validation warning">! ${escapeHtml(item)}</div>`).join('')}${validation.ok ? '<div class="validation success">✓ 開始可能な構成です。</div>' : ''}${!locked ? `<button class="button primary wide" data-action="start-game" ${validation.ok ? '' : 'disabled'} type="button">配役を確定してゲーム開始</button>` : '<button class="button primary wide" data-action="go-workbench" type="button">進行卓へ戻る</button>'}`;
}

function ruleValue(rules, path) {
  if (path === 'wolfCommunication.mode') {
    return rules.wolfCommunication.enabled ? rules.wolfCommunication.participantMode : 'none';
  }
  return path.split('.').reduce((value, key) => value?.[key], rules);
}

function setDisabled(root, selector, disabled) {
  const control = root.querySelector(selector);
  if (control) control.disabled = Boolean(disabled);
}

function syncRoleCategory(root, key, inactive) {
  const category = root.querySelector(`[data-setup-rule-category="${key}"]`);
  if (!category) return;
  category.classList.toggle('is-inactive', Boolean(inactive));
  const label = category.querySelector('[data-setup-inactive-label]');
  if (label) label.hidden = !inactive;
}

function syncRuleControls(root, state, locked) {
  const rules = state.game.rules;
  root.querySelectorAll('[data-rule]').forEach((control) => {
    const value = ruleValue(rules, control.dataset.rule);
    if (control.type === 'checkbox') control.checked = Boolean(value);
    else if (value !== undefined && value !== null && control.value !== String(value)) control.value = String(value);
  });

  const selectedRoleIds = new Set(state.players.map((player) => player.roleId));
  const hasSeer = selectedRoleIds.has('seer');
  const hasGuard = selectedRoleIds.has('guard');
  const hasMason = selectedRoleIds.has('mason');
  const hasWolf = state.players.some((player) => countsAsWolf(state, player));
  syncRoleCategory(root, 'seer', !hasSeer);
  syncRoleCategory(root, 'guard', !hasGuard);
  syncRoleCategory(root, 'mason', !hasMason);
  syncRoleCategory(root, 'wolf', !hasWolf);

  setDisabled(root, '[data-rule="firstNight.seerMode"]', locked || !hasSeer);
  setDisabled(root, '[data-rule="nightResolution.deliverPrivateResultToDeadPlayer"]', locked || !hasSeer);
  setDisabled(root, '[data-rule="guard.selfGuardAllowed"]', locked || !hasGuard);
  setDisabled(root, '[data-rule="guard.consecutiveGuardAllowed"]', locked || !hasGuard);
  setDisabled(root, '[data-rule="firstNight.guardEnabled"]', locked || !hasGuard);
  setDisabled(root, '[data-rule="masonCommunication.enabled"]', locked || !hasMason);
  setDisabled(root, '[data-rule="masonCommunication.speechCountPerNight"]', locked || !hasMason || !rules.masonCommunication.enabled);
  setDisabled(root, '[data-rule="firstNight.wolfAttackEnabled"]', locked || !hasWolf);
  setDisabled(root, '[data-rule="wolfCommunication.mode"]', locked || !hasWolf);
  setDisabled(root, '[data-rule="firstNight.wolfCommunicationEnabled"]', locked || !hasWolf || !rules.wolfCommunication.enabled);
  setDisabled(root, '[data-rule="wolfCommunication.speechCountPerNight"]', locked || !hasWolf || !rules.wolfCommunication.enabled);
  setDisabled(root, '[data-rule="graveyardCommunication.speechCountPerNight"]', locked || !rules.graveyardCommunication?.enabled);
}

function syncParticipantControls(root, state, locked, { characterCards = false } = {}) {
  state.players.forEach((player, index) => {
    const id = CSS.escape(player.id);
    const nameInput = root.querySelector(`[data-player-field="name"][data-player-id="${id}"]`);
    if (nameInput && nameInput.value !== player.name) nameInput.value = player.name;
    const controller = root.querySelector(`[data-player-field="controller"][data-player-id="${id}"]`);
    if (controller && controller.value !== player.controller) controller.value = player.controller;
    const role = root.querySelector(`[data-player-field="roleId"][data-player-id="${id}"]`);
    if (role && role.value !== player.roleId) role.value = player.roleId;
    const character = root.querySelector(`[data-character-card][data-player-id="${id}"]`);
    if (character && characterCards) character.innerHTML = characterCardOptions(state.players, player);
    if (character && character.value !== (player.characterCardId ?? '')) character.value = player.characterCardId ?? '';
    const row = nameInput?.closest('.player-editor');
    const up = row?.querySelector('[data-action="move-player-up"]');
    const down = row?.querySelector('[data-action="move-player-down"]');
    if (up) {
      up.disabled = locked || index === 0;
      up.setAttribute('aria-label', `${player.name}を上へ移動`);
    }
    if (down) {
      down.disabled = locked || index === state.players.length - 1;
      down.setAttribute('aria-label', `${player.name}を下へ移動`);
    }
  });
}



export function refreshSetupViewDom({ root, state, locked, validation, roleSummaryText, refresh = {} }) {
  if (!root || !root.querySelector('.setup-layout')) return false;
  if (refresh.participants) syncParticipantControls(root, state, locked, { characterCards: Boolean(refresh.characterCards) });
  if (refresh.roleSummary) {
    const summary = root.querySelector('[data-setup-role-summary]');
    if (summary) summary.textContent = roleSummaryText;
  }
  if (refresh.rules) syncRuleControls(root, state, locked);
  if (refresh.validation) {
    const validationRoot = root.querySelector('[data-setup-validation]');
    if (validationRoot) validationRoot.innerHTML = renderSetupValidation(validation, locked);
  }
  return true;
}

export function renderSetupView({ state, locked, validation, roleSummaryText }) {
  const rules = state.game.rules;
  const wolfConversationMode = rules.wolfCommunication.enabled
    ? rules.wolfCommunication.participantMode
    : 'none';
  const selectedRoleIds = new Set(state.players.map((player) => player.roleId));
  const hasSeer = selectedRoleIds.has('seer');
  const hasGuard = selectedRoleIds.has('guard');
  const hasMason = selectedRoleIds.has('mason');
  const hasWolf = state.players.some((player) => countsAsWolf(state, player));
  return `<section class="page"><div class="page-head"><div><span class="eyebrow">ゲーム準備</span><h2>${locked ? '設定確認' : '標準人狼の準備'}</h2><p>${MIN_PLAYER_COUNT}～${MAX_PLAYER_COUNT}人の推奨配役を利用し、必要な項目だけ調整します。</p></div><div class="page-head-actions"><button class="button ghost" data-action="game-data-import" type="button">ゲームデータ読込</button><button class="button ghost" data-action="game-data-export" type="button">ゲームデータ出力</button><button class="button danger-ghost" data-action="new-game" type="button">新しいゲーム</button></div></div>
    ${locked ? '<div class="alert warning">ゲーム開始後の配役・主要ルールは固定されています。</div>' : ''}
    <div class="setup-layout">
      <div class="panel"><h3>基本設定</h3><div class="form-grid">
        <label class="field full"><span>ゲーム名</span><input data-setup="title" value="${escapeHtml(state.game.title)}" ${locked ? 'disabled' : ''}></label>
        <label class="field"><span>参加人数</span><select data-setup="player-count" ${locked ? 'disabled' : ''}>${SUPPORTED_PLAYER_COUNTS.map((count) => option(String(count), `${count}人`, String(state.players.length))).join('')}</select></label>
        <div class="field"><span>推奨配役</span><button class="button" data-action="apply-preset" ${locked ? 'disabled' : ''} type="button">${state.players.length}人プリセットを適用</button></div>
      </div><p class="help">${escapeHtml(getPresetNoteForPlayerCount(state.players.length))}</p></div>

      <div class="panel"><div class="panel-title-row setup-player-title"><div><h3>参加者・キャラクター・配役</h3><span data-setup-role-summary>${escapeHtml(roleSummaryText)}</span></div>${!locked ? '<div class="setup-random-actions"><button class="button ghost" data-action="randomize-characters" type="button">キャラクターをランダム配置</button><button class="button ghost" data-action="shuffle-roles" type="button">役職をランダム配置</button><button class="button ghost" data-action="shuffle-player-order" type="button">並び順をシャッフル</button></div>' : ''}</div><div class="player-editor-list"><div class="player-editor player-editor-head" aria-hidden="true"><span>順番</span><span>キャラクターカード</span><span>表示名</span><span>担当</span><span>役職</span><span>並び順</span><span>詳細</span></div>${state.players.map((player, index) => renderSetupPlayerRow({ players: state.players, player, index, locked })).join('')}</div></div>

      <div class="panel"><h3>主要ルール</h3><div class="rule-category-list">
        ${renderRuleCategory({
          title: '開始時の配役',
          wide: true,
          content: `
            <div class="setup-rule-check-grid full">
              <label class="check-row"><input type="checkbox" data-rule="roleAssignment.shuffleOnStart" ${checked(rules.roleAssignment.shuffleOnStart === true)} ${disabledAttr(locked)}>ゲーム開始時に役職をシャッフルする</label>
              <label class="check-row"><input type="checkbox" data-rule="roleAssignment.roleMissingEnabled" ${checked(rules.roleAssignment.roleMissingEnabled === true)} ${disabledAttr(locked)}>役職欠けあり</label>
            </div>
          `,
        })}
        ${renderRuleCategory({
          title: '昼の進行',
          wide: true,
          content: `
            <label class="field"><span>1日あたり発言回数</span><input type="number" min="1" max="10" data-rule="speechCountPerDay" value="${rules.speechCountPerDay}" ${disabledAttr(locked)}></label>
            <label class="field"><span>昼議論方式</span><select data-rule="discussion.mode" ${disabledAttr(locked)}>${option('ordered','順番制',rules.discussion.mode)}${option('designated','指名制',rules.discussion.mode)}${option('free','発言希望制',rules.discussion.mode)}</select></label>
            <div class="setup-rule-check-help-item">
              <label class="check-row"><input type="checkbox" data-rule="discussion.answerPriorityEnabled" ${checked(rules.discussion.answerPriorityEnabled === true)} ${disabledAttr(locked)}>回答優先モード</label>
              <p class="help">指名質問では対象者の回答を優先し、通常発言数は消費しません。</p>
            </div>
            <label class="check-row setup-rule-check-top"><input type="checkbox" data-rule="callNames.enabled" ${checked(rules.callNames?.enabled !== false)} ${disabledAttr(locked)}>相手別呼称を使用する</label>
          `,
        })}
        ${renderRuleCategory({
          title: '投票・処刑',
          wide: true,
          content: `
            <label class="field"><span>投票中の公開</span><select data-rule="vote.visibilityDuringInput" ${disabledAttr(locked)}>${option('secret','秘密投票',rules.vote.visibilityDuringInput)}${option('public','逐次公開',rules.vote.visibilityDuringInput)}</select></label>
            <label class="field"><span>投票確定後の公開</span><select data-rule="vote.publicationAfterFinalize" ${disabledAttr(locked)}>${option('tally-only','得票数のみ',rules.vote.publicationAfterFinalize)}${option('all-ballots','全投票先',rules.vote.publicationAfterFinalize)}${option('execution-target-only','処刑対象のみ',rules.vote.publicationAfterFinalize)}</select></label>
            <label class="field"><span>決選投票上限</span><input type="number" min="0" max="5" data-rule="vote.runoffLimit" value="${rules.vote.runoffLimit}" ${disabledAttr(locked)}></label>
            <label class="field"><span>決選投票上限後の同票処理</span><select data-rule="vote.tieResolution" ${disabledAttr(locked)}>${option('random-execution','ランダム吊り',rules.vote.tieResolution)}${option('no-execution','吊りなし',rules.vote.tieResolution)}</select></label>
            <div class="setup-rule-check-grid full">
              <label class="check-row"><input type="checkbox" data-rule="vote.selfVoteAllowed" ${checked(rules.vote.selfVoteAllowed)} ${disabledAttr(locked)}>自己投票を許可</label>
              <label class="check-row"><input type="checkbox" data-rule="vote.abstentionAllowed" ${checked(rules.vote.abstentionAllowed)} ${disabledAttr(locked)}>棄権を許可</label>
              <label class="check-row"><input type="checkbox" data-rule="vote.revealExecutedRole" ${checked(rules.vote.revealExecutedRole)} ${disabledAttr(locked)}>処刑者の役職を公開</label>
              <label class="check-row"><input type="checkbox" data-rule="testament.enabled" ${checked(rules.testament?.enabled === true)} ${disabledAttr(locked)}>遺言を有効にする</label>
              <p class="help setup-rule-check-help">処刑対象の確定後、死亡処理前に1回だけ公開発言できます。</p>
            </div>
          `,
        })}
        ${renderRuleCategory({
          key: 'seer',
          title: '占い師',
          inactive: !hasSeer,
          inactiveLabel: '占い師',
          content: `
            <label class="field"><span>初日占い</span><select data-rule="firstNight.seerMode" ${disabledAttr(locked, !hasSeer)}>${option('choose','対象を選ぶ',rules.firstNight.seerMode)}${option('random-non-wolf','ランダム白',rules.firstNight.seerMode)}${option('disabled','なし',rules.firstNight.seerMode)}</select></label>
            <label class="check-row setup-rule-control-align"><input type="checkbox" data-rule="nightResolution.deliverPrivateResultToDeadPlayer" ${checked(rules.nightResolution.deliverPrivateResultToDeadPlayer)} ${disabledAttr(locked, !hasSeer)}>同夜に死亡した占い師にも結果を通知</label>
          `,
        })}
        ${renderRuleCategory({
          key: 'guard',
          title: '狩人',
          inactive: !hasGuard,
          inactiveLabel: '狩人',
          content: `
            <label class="check-row"><input type="checkbox" data-rule="guard.selfGuardAllowed" ${checked(rules.guard.selfGuardAllowed)} ${disabledAttr(locked, !hasGuard)}>自己護衛可</label>
            <label class="check-row"><input type="checkbox" data-rule="guard.consecutiveGuardAllowed" ${checked(rules.guard.consecutiveGuardAllowed)} ${disabledAttr(locked, !hasGuard)}>連続護衛可</label>
            <label class="check-row"><input type="checkbox" data-rule="firstNight.guardEnabled" ${checked(rules.firstNight.guardEnabled)} ${disabledAttr(locked, !hasGuard)}>初日護衛あり</label>
          `,
        })}
        ${renderRuleCategory({
          key: 'mason',
          title: '共有者',
          inactive: !hasMason,
          inactiveLabel: '共有者',
          content: `
            <label class="check-row"><input type="checkbox" data-rule="masonCommunication.enabled" ${checked(rules.masonCommunication.enabled)} ${disabledAttr(locked, !hasMason)}>共有者共有会話を有効にする</label>
            <label class="field"><span>共有者共有会話・1人あたり発言回数</span><input type="number" min="1" max="10" data-rule="masonCommunication.speechCountPerNight" value="${rules.masonCommunication.speechCountPerNight}" ${disabledAttr(locked, !hasMason, !rules.masonCommunication.enabled)}></label>
          `,
        })}
        ${renderRuleCategory({
          key: 'wolf',
          title: '人狼',
          wide: true,
          inactive: !hasWolf,
          inactiveLabel: '人狼',
          content: `
            <label class="check-row"><input type="checkbox" data-rule="firstNight.wolfAttackEnabled" ${checked(rules.firstNight.wolfAttackEnabled)} ${disabledAttr(locked, !hasWolf)}>初日襲撃あり</label>
            <label class="field"><span>人狼共有会話</span><select data-rule="wolfCommunication.mode" ${disabledAttr(locked, !hasWolf)}>${option('none','なし',wolfConversationMode)}${option('wolves-only','人狼のみ',wolfConversationMode)}${option('wolves-and-madman','人狼＋狂人（特殊）',wolfConversationMode)}</select></label>
            <label class="check-row"><input type="checkbox" data-rule="firstNight.wolfCommunicationEnabled" ${checked(rules.firstNight.wolfCommunicationEnabled)} ${disabledAttr(locked, !hasWolf, !rules.wolfCommunication.enabled)}>初日人狼会話あり</label>
            <label class="field"><span>人狼共有会話・1人あたり発言回数</span><input type="number" min="1" max="10" data-rule="wolfCommunication.speechCountPerNight" value="${rules.wolfCommunication.speechCountPerNight}" ${disabledAttr(locked, !hasWolf, !rules.wolfCommunication.enabled)}></label>
          `,
        })}
        ${renderRuleCategory({
          title: '墓場',
          wide: true,
          content: `
            <label class="check-row"><input type="checkbox" data-rule="graveyardCommunication.enabled" ${checked(rules.graveyardCommunication?.enabled === true)} ${disabledAttr(locked)}>墓場会話を有効にする</label>
            <label class="field"><span>墓場会話・1人あたり発言回数</span><input type="number" min="1" max="10" data-rule="graveyardCommunication.speechCountPerNight" value="${rules.graveyardCommunication?.speechCountPerNight ?? 1}" ${disabledAttr(locked, !rules.graveyardCommunication?.enabled)}></label>
            <p class="help">各夜の開始時点ですでに死亡している2人以上で会話します。過去の墓場会話は継承されますが、死亡後の地上情報は自動共有されません。</p>
          `,
        })}
      </div></div>


      <div class="panel" data-setup-validation-panel><h3>開始前確認</h3><div data-setup-validation>${renderSetupValidation(validation, locked)}</div></div>
    </div>
  </section>`;
}
