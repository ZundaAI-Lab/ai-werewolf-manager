/**
 * 責務: AIプロファイルと同じ左右分割構成でキャラクター管理画面と、グループ/キャラクター並び替え・操作ダイアログのHTMLを生成する。
 * 変更ルール:
 * - 保存・削除・JSON入出力を実行しない。具体的なグループ名・キャラクター名を直書きせず、カタログから受け取った値だけを表示する。
 * - 組み込み/ユーザーの差は編集可否と表示トーンだけで表し、組み込み詳細も同じ詳細フォームを閲覧専用で表示する。
 * - 通常編集ではJSON構文を直接入力させず、人物設定・会話種・相手別呼称は通常のフォーム部品だけで扱う。ユーザーキャラクターは表示名だけを必須入力とし、表示名の独立ランダム生成操作を隣接配置する。その他は空欄を許可する。AI一括生成操作はAIプロファイルの有無に関係なく表示し、生成ダイアログ内でAPI生成と手動コピペ生成を切り替える。
 */

import { getCharacterGroups, getEnabledCharacterCards, getUserCharacterGroups } from '../../../characters/catalog/characterCatalog.js';
import { CHARACTER_TEXT_LIMITS, delimitedInputMaxLength } from '../../../characters/config/characterTextPolicyAdapter.js';
import { checked, escapeHtml } from '../../../shared/utils.js';
import { renderCharacterProfileSections } from './characterProfileFormView.js';

let selectedGroupId = '';

const ALIASES_INPUT_MAX_LENGTH = delimitedInputMaxLength(CHARACTER_TEXT_LIMITS.alias, CHARACTER_TEXT_LIMITS.aliasesMax);

function limitLabel(label, maxLength) {
  return `${label}（最大${maxLength}文字）`;
}

export function selectCharacterLibraryGroup(groupId) {
  selectedGroupId = String(groupId ?? '');
}

function activeGroup(groups) {
  const selected = groups.find((group) => group.id === selectedGroupId) ?? groups[0] ?? null;
  selectedGroupId = selected?.id ?? '';
  return selected;
}

function originLabel(group) {
  return group.origin === 'builtin' ? '組み込み' : 'ユーザー';
}

function groupListItem(group, selected) {
  const enabledCount = group.characters.filter((card) => card.enabled !== false).length;
  return `<button class="character-library-group-list-item is-${group.origin}${selected ? ' is-selected' : ''}${group.enabled ? '' : ' is-disabled'}" data-character-library-action="select-group" data-group-id="${escapeHtml(group.id)}" type="button" aria-pressed="${selected ? 'true' : 'false'}">
    <span class="character-library-group-list-copy"><strong>${escapeHtml(group.name)}</strong><small>${enabledCount}/${group.characters.length}キャラクター使用</small></span>
    <span class="character-library-origin-badge">${originLabel(group)}</span>
  </button>`;
}

function characterRows(group, userGroups) {
  if (!group.characters.length) return '<p class="help character-library-empty">キャラクターはまだ登録されていません。</p>';
  const canDuplicate = userGroups.length > 0;
  return `<div class="character-library-character-list">${group.characters.map((card, index) => {
    const aliases = (card.aliases ?? []).join('、');
    const effective = group.enabled && card.enabled !== false;
    return `<div class="character-library-character-row${effective ? '' : ' is-disabled'}">
      <label class="character-library-character-enabled" title="このキャラクターをゲームの選択候補に含めます">
        <input data-character-library-character-toggle data-group-id="${escapeHtml(group.id)}" data-character-id="${escapeHtml(card.id)}" type="checkbox"${checked(card.enabled !== false)}${group.enabled ? '' : ' disabled'}>
        <span>使用</span>
      </label>
      <div class="character-library-character-main"><strong>${escapeHtml(card.name)}</strong>${aliases ? `<small>${escapeHtml(aliases)}</small>` : ''}</div>
      <div class="character-library-row-actions">
        <button class="button ghost small" data-character-library-action="move-character-up" data-group-id="${escapeHtml(group.id)}" data-character-id="${escapeHtml(card.id)}" type="button"${index > 0 ? '' : ' disabled'}>上へ</button>
        <button class="button ghost small" data-character-library-action="move-character-down" data-group-id="${escapeHtml(group.id)}" data-character-id="${escapeHtml(card.id)}" type="button"${index < group.characters.length - 1 ? '' : ' disabled'}>下へ</button>
        <button class="button ghost small" data-character-library-action="edit-character" data-group-id="${escapeHtml(group.id)}" data-character-id="${escapeHtml(card.id)}" type="button">詳細設定</button>
        <button class="button ghost small" data-character-library-action="duplicate-character" data-group-id="${escapeHtml(group.id)}" data-character-id="${escapeHtml(card.id)}" type="button"${canDuplicate ? '' : ' disabled'} title="${canDuplicate ? 'ユーザーグループへ複製' : 'ユーザーグループを先に作成してください'}">複製</button>
        ${group.origin === 'user' ? `<button class="button danger-ghost small" data-character-library-action="delete-character" data-group-id="${escapeHtml(group.id)}" data-character-id="${escapeHtml(card.id)}" type="button">削除</button>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function groupPanel(group, groups) {
  if (!group) return '<div class="empty-state compact"><p>キャラクターグループがありません。</p></div>';
  const index = groups.findIndex((item) => item.id === group.id);
  const userGroups = getUserCharacterGroups();
  return `<article class="character-library-group-editor is-${group.origin}${group.enabled ? '' : ' is-disabled'}">
    <header class="character-library-group-editor-head">
      <div class="character-library-group-editor-title">
        <span class="character-library-origin-badge">${originLabel(group)}</span>
        <h3>${escapeHtml(group.name)}</h3>
        <p>${group.characters.length}キャラクター</p>
      </div>
      <div class="character-library-group-controls">
        <label class="character-library-group-enabled-switch"><input data-character-library-toggle data-group-id="${escapeHtml(group.id)}" type="checkbox"${checked(group.enabled)}><span>グループを使用</span></label>
        <div class="character-library-group-actions">
          <button class="button ghost small" data-character-library-action="move-group-up" data-group-id="${escapeHtml(group.id)}" type="button"${index > 0 ? '' : ' disabled'}>上へ</button>
          <button class="button ghost small" data-character-library-action="move-group-down" data-group-id="${escapeHtml(group.id)}" type="button"${index >= 0 && index < groups.length - 1 ? '' : ' disabled'}>下へ</button>
          ${group.origin === 'user' ? `<button class="button ghost small" data-character-library-action="edit-group" data-group-id="${escapeHtml(group.id)}" type="button">名前変更</button><button class="button danger-ghost small" data-character-library-action="delete-group" data-group-id="${escapeHtml(group.id)}" type="button">削除</button>` : ''}
        </div>
      </div>
    </header>
    <div class="character-library-group-body">
      ${characterRows(group, userGroups)}
      ${group.origin === 'user' ? `<div class="character-library-group-footer"><button class="button primary small" data-character-library-action="add-character" data-group-id="${escapeHtml(group.id)}" type="button">＋ キャラクター追加</button></div>` : ''}
    </div>
  </article>`;
}

export function renderCharacterLibraryView() {
  const groups = getCharacterGroups();
  const userCount = groups.filter((group) => group.origin === 'user').length;
  const selected = activeGroup(groups);
  return `<section class="page character-library-page">
    <div class="page-head">
      <div><span class="eyebrow">キャラクター管理</span><h2>キャラクター管理</h2><p>グループとキャラクターごとにゲームで使用するデータを管理します。</p></div>
      <div class="page-head-actions">
        <button class="button ghost" data-character-library-action="import" type="button">キャラクター読込</button>
        <button class="button ghost" data-character-library-action="export" type="button" ${userCount ? '' : 'disabled'}>キャラクター出力</button>
        <button class="button primary" data-character-library-action="create-group" type="button">グループ作成</button>
      </div>
    </div>
    <div class="character-library-workspace">
      <aside class="character-library-sidebar" aria-label="キャラクターグループ一覧">
        <div class="character-library-group-list">${groups.map((group) => groupListItem(group, group.id === selected?.id)).join('')}</div>
      </aside>
      <div class="character-library-group-editor-wrap">${groupPanel(selected, groups)}</div>
    </div>
  </section>`;
}

function modalErrorHtml() {
  return '<div class="validation error character-library-modal-error" data-character-library-modal-error hidden></div>';
}

export function renderCharacterGroupEditor(group = null) {
  const editing = Boolean(group);
  return `<form class="modal-form character-library-modal-form" data-character-library-form="group">
    <div class="modal-header"><h3>${editing ? 'グループ名変更' : 'グループ作成'}</h3><button class="button icon ghost" data-modal-close type="button">×</button></div>
    <div class="modal-body">
      ${modalErrorHtml()}
      <label class="field"><span>グループ名</span><input name="name" maxlength="120" value="${escapeHtml(group?.name ?? '')}" required autofocus></label>
    </div>
    <div class="modal-footer"><button class="button ghost" data-modal-close type="button">キャンセル</button><button class="button primary" data-character-library-action="save-group" data-group-id="${escapeHtml(group?.id ?? '')}" type="button">保存</button></div>
  </form>`;
}

export function renderConversationSeedEditorRow(seed = {}, { readonly = false } = {}) {
  const disabled = readonly ? ' disabled' : '';
  return `<div class="character-conversation-seed" data-conversation-seed-row>
    <input name="conversationSeedId" type="hidden" value="${escapeHtml(seed.id ?? '')}"${disabled}>
    <div class="form-grid">
      <label class="field"><span>${limitLabel('話題', CHARACTER_TEXT_LIMITS.conversationSeedSubject)}</span><input name="conversationSeedSubject" maxlength="${CHARACTER_TEXT_LIMITS.conversationSeedSubject}" value="${escapeHtml(seed.subject ?? '')}"${disabled}></label>
      <label class="field"><span>${limitLabel('雰囲気', CHARACTER_TEXT_LIMITS.conversationSeedTone)}</span><input name="conversationSeedTone" maxlength="${CHARACTER_TEXT_LIMITS.conversationSeedTone}" value="${escapeHtml(seed.tone ?? '')}"${disabled}></label>
    </div>
    ${readonly ? '' : '<button class="button danger-ghost small character-conversation-seed-remove" data-character-library-action="remove-conversation-seed" type="button">削除</button>'}
  </div>`;
}

function renderConversationSeeds(card, readonly) {
  const seeds = card.character?.conversationSeeds ?? [];
  return `<fieldset class="player-detail-section">
    <legend>会話のきっかけ</legend>
    <p class="help character-editor-section-help">任意設定です。必要な場合だけ、日常会話で使える話題と雰囲気を追加します。</p>
    <div class="character-conversation-seed-list" data-conversation-seed-list>${seeds.map((seed) => renderConversationSeedEditorRow(seed, { readonly })).join('')}</div>
    ${readonly ? '' : `<button class="button ghost small" data-character-library-action="add-conversation-seed" type="button"${seeds.length >= CHARACTER_TEXT_LIMITS.conversationSeedsMax ? ' disabled' : ''}>＋ 話題を追加</button><small class="help">最大${CHARACTER_TEXT_LIMITS.conversationSeedsMax}件。</small>`}
  </fieldset>`;
}

function renderCallNameRows(card, readonly) {
  const targets = getEnabledCharacterCards().filter((target) => target.id !== card.id);
  if (!targets.length) return '<p class="help">呼称を設定できる他のキャラクターはまだありません。</p>';
  const disabled = readonly ? ' disabled' : '';
  return `<div class="character-call-name-list">${targets.map((target) => {
    const entry = card.callNames?.[target.id] ?? {};
    return `<div class="character-call-name-row">
      <input name="callNameTargetId" type="hidden" value="${escapeHtml(target.id)}"${disabled}>
      <strong>${escapeHtml(target.name)} <small>（最大${CHARACTER_TEXT_LIMITS.callNamePreferred}文字）</small></strong>
      <label class="field"><input name="callNamePreferred" maxlength="${CHARACTER_TEXT_LIMITS.callNamePreferred}" value="${escapeHtml(entry.preferred ?? '')}" placeholder="未設定なら表示名を使用"${disabled}></label>
    </div>`;
  }).join('')}</div>`;
}

function renderCallNames(card, readonly) {
  return `<fieldset class="player-detail-section">
    <legend>相手別呼称</legend>
    <p class="help character-editor-section-help">このキャラクターが他のキャラクターを呼ぶときの名前を設定します。空欄の相手には表示名を使用します。</p>
    <details class="call-name-speaker character-editor-call-names"><summary>相手別呼称を${readonly ? '表示' : '設定'}</summary>${renderCallNameRows(card, readonly)}</details>
  </fieldset>`;
}

export function renderCharacterEditor({ group, card, readonly = false }) {
  const profile = card.character ?? {};
  const disabled = readonly ? ' disabled' : '';
  return `<form class="modal-form character-library-modal-form character-editor-form" data-character-library-form="character">
    <div class="modal-header"><div><h3>${card.__new ? 'キャラクター追加' : `${escapeHtml(card.name)}の詳細設定`}</h3><p>${escapeHtml(group.name)}${readonly ? ' ・ 閲覧専用' : ''}</p></div><button class="button icon ghost" data-modal-close type="button">×</button></div>
    <div class="modal-body player-detail-body character-editor-body">
      ${modalErrorHtml()}
      <fieldset class="player-detail-section">
        <legend>識別情報</legend>
        <div class="character-identity-fields">
          <div class="character-display-name-row">
            <label class="field"><span>${limitLabel('表示名', CHARACTER_TEXT_LIMITS.name)}</span><input name="name" maxlength="${CHARACTER_TEXT_LIMITS.name}" value="${escapeHtml(card.name)}"${readonly ? '' : ' required autofocus'}${disabled}></label>
            ${readonly ? '' : '<button class="button ghost character-name-randomize" data-character-library-action="randomize-character-name" type="button">ランダム生成</button>'}
          </div>
          <label class="field"><span>別名（各最大${CHARACTER_TEXT_LIMITS.alias}文字・${CHARACTER_TEXT_LIMITS.aliasesMax}件まで）</span><input name="aliases" maxlength="${ALIASES_INPUT_MAX_LENGTH}" value="${escapeHtml((card.aliases ?? []).join('、'))}"${disabled}><small>略称・読み違い・表記揺れなどを、読点区切りで登録します。</small></label>
        </div>
      </fieldset>

      ${renderCharacterProfileSections(profile, { readonly })}
      ${renderConversationSeeds(card, readonly)}
      ${renderCallNames(card, readonly)}
    </div>
    <div class="modal-footer">
      ${readonly ? '' : `<div class="character-editor-generation-actions">
        <button class="button ghost character-editor-randomize" data-character-library-action="randomize-character-settings" type="button">設定をランダム生成</button>
        <button class="button ghost character-editor-ai-generate" data-character-library-action="open-ai-character-generation" type="button">AI生成</button>
      </div>`}
      <button class="button ghost" data-modal-close type="button">${readonly ? '閉じる' : 'キャンセル'}</button>
      ${readonly ? '' : `<button class="button primary" data-character-library-action="save-character" data-group-id="${escapeHtml(group.id)}" data-character-id="${escapeHtml(card.id)}" data-is-new="${card.__new ? 'true' : 'false'}" type="button">保存</button>`}
    </div>
  </form>`;
}

export function renderCharacterDuplicateTarget({ card, groups }) {
  return `<form class="modal-form character-library-modal-form" data-character-library-form="duplicate">
    <div class="modal-header"><div><h3>キャラクターを複製</h3><p>${escapeHtml(card.name)}</p></div><button class="button icon ghost" data-modal-close type="button">×</button></div>
    <div class="modal-body">
      ${modalErrorHtml()}
      <label class="field"><span>複製先のユーザーグループ</span><select name="targetGroupId" required>${groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('')}</select></label>
    </div>
    <div class="modal-footer"><button class="button ghost" data-modal-close type="button">キャンセル</button><button class="button primary" data-character-library-action="confirm-duplicate-character" data-character-id="${escapeHtml(card.id)}" type="button">複製</button></div>
  </form>`;
}

export function renderCharacterDeleteConfirmation({ title, message, action, groupId, characterId = '' }) {
  return `<div class="modal-form character-library-modal-form"><div class="modal-header"><h3>${escapeHtml(title)}</h3><button class="button icon ghost" data-modal-close type="button">×</button></div><div class="modal-body">${modalErrorHtml()}<p>${escapeHtml(message)}</p><p class="validation warning">削除したデータはキャラクター管理へ戻せません。必要なら先にキャラクター出力してください。</p></div><div class="modal-footer"><button class="button ghost" data-modal-close type="button">キャンセル</button><button class="button danger" data-character-library-action="${escapeHtml(action)}" data-group-id="${escapeHtml(groupId)}" data-character-id="${escapeHtml(characterId)}" type="button">削除</button></div></div>`;
}


export function renderAiCharacterGenerationDialog({ profiles = [] }) {
  const hasApiProfile = profiles.length > 0;
  const apiChecked = hasApiProfile ? ' checked' : '';
  const manualChecked = hasApiProfile ? '' : ' checked';
  return `<form class="modal-form character-ai-generation-form" data-character-ai-generation-form>
    <div class="modal-header"><div><h3>AIでキャラクター生成</h3><p>API生成または手動コピペで、表示名を含むキャラクター設定を一括生成します。</p></div><button class="button icon ghost" data-character-ai-close type="button">×</button></div>
    <div class="modal-body">
      <div class="validation error character-library-modal-error" data-character-ai-generation-error hidden></div>
      <fieldset class="character-ai-generation-methods">
        <legend>生成方法</legend>
        <label class="character-ai-generation-method${hasApiProfile ? '' : ' is-disabled'}"><input name="generationMode" type="radio" value="api"${apiChecked}${hasApiProfile ? '' : ' disabled'}><span><strong>AIプロファイルでAPI生成</strong><small>${hasApiProfile ? '設定済みのAIプロファイルへ直接送信して生成します。' : '利用可能なAIプロファイルがありません。'}</small></span></label>
        <label class="character-ai-generation-method"><input name="generationMode" type="radio" value="manual"${manualChecked}><span><strong>手動コピペ</strong><small>本ツールからAPI送信せず、プロンプトを外部AIへ貼り付け、返答JSONをここへ戻します。</small></span></label>
      </fieldset>
      <label class="field"><span>${limitLabel('特徴指示', CHARACTER_TEXT_LIMITS.aiInstruction)}</span><textarea name="instruction" maxlength="${CHARACTER_TEXT_LIMITS.aiInstruction}" rows="5" placeholder="例：中二病のキャラを作って\n例：一見おっとりしているが推理になると鋭い和風キャラ"></textarea><small>空欄でも生成できます。雰囲気、ジャンル、年齢感、口調、トンデモ設定などを自由に指定できます。</small></label>
      <section class="character-ai-generation-panel" data-character-ai-api-panel${hasApiProfile ? '' : ' hidden'}>
        <label class="field"><span>使用するAIプロファイル</span><select name="profileId">${profiles.map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.label)} / ${escapeHtml(profile.model || profile.provider)}</option>`).join('')}</select></label>
      </section>
      <section class="character-ai-generation-panel character-ai-manual-panel" data-character-ai-manual-panel${hasApiProfile ? ' hidden' : ''}>
        <div class="character-ai-manual-head"><div><strong>1. プロンプトを外部AIへ渡す</strong><small>特徴指示を編集すると、下のプロンプトも更新されます。</small></div><button class="button ghost" data-character-ai-copy-manual-prompt type="button">プロンプトをコピー</button></div>
        <textarea class="character-ai-manual-prompt" data-character-ai-manual-prompt readonly aria-label="手動生成プロンプト"></textarea>
        <label class="field"><span>2. AIの回答JSONを貼り付ける</span><textarea name="manualResponse" class="character-ai-manual-response" rows="9" placeholder="AIが返したJSONオブジェクトをそのまま貼り付けてください"></textarea><small>MarkdownのJSONコードフェンス付きでも読み取れます。登録前に既存と同じ文字数・項目検証を行います。</small></label>
      </section>
    </div>
    <div class="modal-footer"><button class="button ghost" data-character-ai-close type="button">キャンセル</button><button class="button primary" data-character-ai-manual-apply type="button"${hasApiProfile ? ' hidden' : ''}>回答を反映</button><button class="button primary" data-character-ai-generate-submit type="button"${hasApiProfile ? '' : ' hidden'}>API生成</button></div>
  </form>`;
}
