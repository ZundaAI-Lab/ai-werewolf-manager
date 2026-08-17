/**
 * 責務: ゲーム準備中プレイヤーの詳細設定フォームを生成し、人物設定・会話のきっかけ・ゲーム参加者向け相手別呼称を一画面で編集できる形にする。
 * 変更ルール: 状態更新、入力検証、イベント登録、ゲーム規則判定を行わない。キャラクタープロフィール項目はcharacterProfileFormView.jsを正本とし、相手別呼称の編集対象は現在のゲーム参加者だけに限定する。
 */

import { createGameCallNameSnapshot } from '../../../characters/callNames/callNameResolver.js';
import { CHARACTER_TEXT_LIMITS, delimitedInputMaxLength } from '../../../characters/config/characterTextPolicyAdapter.js';
import { CALL_NAME_MAX_LENGTH } from '../../../domain/policies/playerIdentityPolicy.js';
import { escapeHtml } from '../../../shared/utils.js';
import { renderCharacterProfileSections } from '../characters/characterProfileFormView.js';

const ALIASES_INPUT_MAX_LENGTH = delimitedInputMaxLength(CHARACTER_TEXT_LIMITS.alias, CHARACTER_TEXT_LIMITS.aliasesMax);

function limitLabel(label, maxLength) {
  return `${label}（最大${maxLength}文字）`;
}

export function renderPlayerConversationSeedRow(seed = {}) {
  return `<div class="character-conversation-seed" data-player-conversation-seed-row>
    <input name="conversationSeedId" type="hidden" value="${escapeHtml(seed.id ?? '')}">
    <div class="form-grid">
      <label class="field"><span>${limitLabel('話題', CHARACTER_TEXT_LIMITS.conversationSeedSubject)}</span><input name="conversationSeedSubject" maxlength="${CHARACTER_TEXT_LIMITS.conversationSeedSubject}" value="${escapeHtml(seed.subject ?? '')}" required></label>
      <label class="field"><span>${limitLabel('雰囲気', CHARACTER_TEXT_LIMITS.conversationSeedTone)}</span><input name="conversationSeedTone" maxlength="${CHARACTER_TEXT_LIMITS.conversationSeedTone}" value="${escapeHtml(seed.tone ?? '')}" required></label>
    </div>
    <button class="button danger-ghost small character-conversation-seed-remove" data-player-detail-action="remove-conversation-seed" type="button">削除</button>
  </div>`;
}

function renderConversationSeeds(player) {
  const seeds = Array.isArray(player.character?.conversationSeeds) ? player.character.conversationSeeds : [];
  return `<fieldset class="player-detail-section">
    <legend>会話のきっかけ</legend>
    <p class="help">このゲームで日常会話の開始や序盤反応に使う話題と雰囲気を設定します。キャラクター管理の元データは変更しません。</p>
    <div class="character-conversation-seed-list" data-player-conversation-seed-list>${seeds.map((seed) => renderPlayerConversationSeedRow(seed)).join('')}</div>
    <button class="button ghost small" data-player-detail-action="add-conversation-seed" type="button"${seeds.length >= CHARACTER_TEXT_LIMITS.conversationSeedsMax ? ' disabled' : ''}>＋ 話題を追加</button><small class="help">最大${CHARACTER_TEXT_LIMITS.conversationSeedsMax}件。</small>
  </fieldset>`;
}

function renderGameCallNames(player, players) {
  const targets = players.filter((target) => target.id !== player.id);
  if (!targets.length) {
    return `<fieldset class="player-detail-section"><legend>相手別呼称</legend><p class="help">呼称を設定できる他の参加者はいません。</p></fieldset>`;
  }

  const snapshot = createGameCallNameSnapshot(players, { enabled: true, createdAt: null });
  const rows = targets.map((target) => {
    const override = String(player.callNameOverrides?.[target.id] ?? '');
    const resolved = snapshot.bySpeakerId?.[player.id]?.[target.id];
    const placeholder = resolved?.preferred || target.name;
    return `<div class="character-call-name-row">
      <input name="callNameTargetPlayerId" type="hidden" value="${escapeHtml(target.id)}">
      <strong>${escapeHtml(target.name)} <small>（最大${CALL_NAME_MAX_LENGTH}文字）</small></strong>
      <label class="field"><input name="callNamePreferred" maxlength="${CALL_NAME_MAX_LENGTH}" value="${escapeHtml(override)}" placeholder="${escapeHtml(placeholder)}"></label>
    </div>`;
  }).join('');

  return `<fieldset class="player-detail-section">
    <legend>相手別呼称</legend>
    <p class="help">このゲームに参加している相手だけを設定できます。空欄にするとキャラクターデータの登録呼称、未登録なら表示名を使用します。</p>
    <div class="character-call-name-list">${rows}</div>
  </fieldset>`;
}

export function renderPlayerDetailForm({ player, players }) {
  const character = player.character;

  return `<form id="player-detail-form">
    <div class="modal-header">
      <h3>${escapeHtml(player.name)}の詳細設定</h3>
      <button class="button icon ghost" data-modal-close type="button">×</button>
    </div>

    <div class="modal-body player-detail-body">
      <div class="validation error" data-player-detail-error hidden></div>

      <fieldset class="player-detail-section">
        <legend>識別情報</legend>
        <div class="form-grid">
          <label class="field full">
            <span>別名（各最大${CHARACTER_TEXT_LIMITS.alias}文字・${CHARACTER_TEXT_LIMITS.aliasesMax}件まで）</span>
            <input name="aliases" maxlength="${ALIASES_INPUT_MAX_LENGTH}" value="${escapeHtml(player.aliases.join('、'))}">
            <small>略称・読み違い・表記揺れなどを、読点区切りで登録します。</small>
          </label>
        </div>
      </fieldset>

      ${renderCharacterProfileSections(character)}
      ${renderConversationSeeds(player)}
      ${renderGameCallNames(player, players)}

      <fieldset class="player-detail-section player-detail-section-private">
        <legend>ゲーム固有情報</legend>
        <div class="form-grid">
          <label class="field full">
            <span>この参加者だけが知る追加情報</span>
            <textarea name="privateInfo">${escapeHtml(player.privateInfo)}</textarea>
            <small>この参加者のAIとGMだけが参照します。役職能力やゲームルールを変更するものではありません。</small>
          </label>
        </div>
      </fieldset>
    </div>

    <div class="modal-footer">
      <button class="button ghost" data-modal-close type="button">キャンセル</button>
      <button class="button primary" type="submit">保存</button>
    </div>
  </form>`;
}
