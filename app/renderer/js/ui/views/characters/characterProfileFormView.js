/**
 * 責務: ゲーム準備の詳細設定とキャラクター管理で共用する、キャラクタープロフィール編集項目のHTMLを生成する。
 * 変更ルール: 項目名・入力形式・補足説明は両画面で共通化し、保存処理・状態更新・キャラクター固有値は持たない。キャラクター名以外のプロフィール項目は任意入力とし、未入力をUI検証で拒否しない。文字数上限は共有characterTextPolicyだけを正本とする。基本語尾・避ける表現は各1行を占有し、入力欄も行幅いっぱいにして短文項目を横並びへ戻さない。
 */

import { REASONING_PROFILE_OPTION_LABELS } from '../../../config/constants.js';
import { CHARACTER_TEXT_LIMITS } from '../../../characters/config/characterTextPolicyAdapter.js';
import {
  PUBLIC_SPEECH_LENGTH_OPTIONS,
  resolvePublicSpeechLengthPolicy,
} from '../../../domain/policies/publicSpeechLengthPolicy.js';
import { escapeHtml } from '../../../shared/utils.js';
import { option } from '../../components/components.js';

function reasoningOptionLabels(kind, current) {
  return Object.entries(REASONING_PROFILE_OPTION_LABELS[kind] ?? {})
    .map(([value, label]) => option(value, label, current))
    .join('');
}

function limitLabel(label, maxLength) {
  return `${label}（最大${maxLength}文字）`;
}

function speechLengthOptions(current) {
  return PUBLIC_SPEECH_LENGTH_OPTIONS
    .map((value) => {
      const policy = resolvePublicSpeechLengthPolicy(value);
      return option(value, `${value}（通常時約${policy.targetChars}字）`, current);
    })
    .join('');
}

export function renderCharacterProfileSections(character = {}, { readonly = false } = {}) {
  const reasoning = character.reasoningProfile ?? {};
  const readonlyAttribute = readonly ? ' disabled' : '';
  const profileHelp = '性格、経歴、趣味、日常的な関心を指定します。役職能力やゲーム上の確定情報は追加されません。';
  return `<fieldset class="player-detail-section">
    <legend>人物設定</legend>
    <div class="form-grid">
      <label class="field full">
        <span>${limitLabel('性格・人物設定', CHARACTER_TEXT_LIMITS.profile)}</span>
        <textarea name="profile" maxlength="${CHARACTER_TEXT_LIMITS.profile}"${readonlyAttribute}>${escapeHtml(character.profile ?? '')}</textarea>
        <small>${profileHelp}</small>
      </label>
    </div>
  </fieldset>

  <fieldset class="player-detail-section">
    <legend>話し方</legend>
    <div class="form-grid">
      <label class="field">
        <span>${limitLabel('一人称', CHARACTER_TEXT_LIMITS.firstPerson)}</span>
        <input name="firstPerson" maxlength="${CHARACTER_TEXT_LIMITS.firstPerson}" value="${escapeHtml(character.firstPerson ?? '')}"${readonlyAttribute}>
      </label>

      <label class="field">
        <span>${limitLabel('汎用二人称', CHARACTER_TEXT_LIMITS.genericSecondPerson)}</span>
        <input name="genericSecondPerson" maxlength="${CHARACTER_TEXT_LIMITS.genericSecondPerson}" value="${escapeHtml(character.genericSecondPerson ?? '')}"${readonlyAttribute}>
      </label>

      <label class="field full">
        <span>${limitLabel('話し方の特徴', CHARACTER_TEXT_LIMITS.speakingStyle)}</span>
        <textarea name="speakingStyle" maxlength="${CHARACTER_TEXT_LIMITS.speakingStyle}"${readonlyAttribute}>${escapeHtml(character.speakingStyle ?? '')}</textarea>
        <small>口調、テンポ、感情表現、方言、属性口調などを指定します。</small>
      </label>

      <label class="field full character-standard-text-field">
        <span>${limitLabel('基本語尾', CHARACTER_TEXT_LIMITS.defaultEndings)}</span>
        <input name="defaultEndings" maxlength="${CHARACTER_TEXT_LIMITS.defaultEndings}" value="${escapeHtml(character.defaultEndings ?? '')}"${readonlyAttribute}>
      </label>

      <label class="field full character-standard-text-field">
        <span>${limitLabel('避ける表現', CHARACTER_TEXT_LIMITS.avoidedExpressions)}</span>
        <input name="avoidedExpressions" maxlength="${CHARACTER_TEXT_LIMITS.avoidedExpressions}" value="${escapeHtml(character.avoidedExpressions ?? '')}"${readonlyAttribute}>
      </label>

      <label class="field">
        <span>発言量</span>
        <select name="speechLength"${readonlyAttribute}>${speechLengthOptions(character.speechLength)}</select>
      </label>

      <label class="field full">
        <span>${limitLabel('口調例', CHARACTER_TEXT_LIMITS.speechExamples)}</span>
        <textarea name="speechExamples" maxlength="${CHARACTER_TEXT_LIMITS.speechExamples}"${readonlyAttribute}>${escapeHtml(character.speechExamples ?? '')}</textarea>
        <small>一行に一例を入力します。題材や結論ではなく、文体・語彙・テンポの例を入力してください。</small>
      </label>
    </div>
  </fieldset>

  <fieldset class="player-detail-section">
    <legend>推理・議論傾向</legend>
    <div class="form-grid">
      <label class="field">
        <span>重視する証拠</span>
        <select name="evidenceFocus"${readonlyAttribute}>${reasoningOptionLabels('evidenceFocus', reasoning.evidenceFocus)}</select>
      </label>

      <label class="field">
        <span>判断更新の速さ</span>
        <select name="updateTempo"${readonlyAttribute}>${reasoningOptionLabels('updateTempo', reasoning.updateTempo)}</select>
      </label>

      <label class="field">
        <span>仮説の広さ</span>
        <select name="hypothesisBreadth"${readonlyAttribute}>${reasoningOptionLabels('hypothesisBreadth', reasoning.hypothesisBreadth)}</select>
      </label>

      <label class="field">
        <span>質問方法</span>
        <select name="questionStyle"${readonlyAttribute}>${reasoningOptionLabels('questionStyle', reasoning.questionStyle)}</select>
      </label>

      <label class="field">
        <span>対立表現</span>
        <select name="confrontationStyle"${readonlyAttribute}>${reasoningOptionLabels('confrontationStyle', reasoning.confrontationStyle)}</select>
      </label>

      <label class="field">
        <span>不確実性の表現</span>
        <select name="uncertaintyStyle"${readonlyAttribute}>${reasoningOptionLabels('uncertaintyStyle', reasoning.uncertaintyStyle)}</select>
      </label>

      <label class="field full">
        <span>${limitLabel('議論での振る舞い補足', CHARACTER_TEXT_LIMITS.discussionBehavior)}</span>
        <textarea name="discussionBehavior" maxlength="${CHARACTER_TEXT_LIMITS.discussionBehavior}"${readonlyAttribute}>${escapeHtml(character.discussionBehavior ?? '')}</textarea>
        <small>質問・仲裁・説得など、そのキャラクターらしい議論の仕方を補足します。</small>
      </label>
    </div>
  </fieldset>`;
}
