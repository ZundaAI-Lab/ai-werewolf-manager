/**
 * 責務: 企画・設計・開発クレジット、実装支援技術、本ソフト本体の利用ライセンス、組み込みキャラクター管理元の公式サイト・利用規約・権利上の注意事項を一つの権利情報として描画する。
 * 変更ルール: ゲーム状態や外部通信へ依存せず、キャラクター管理元・公式URL・利用規約URL・確認日・所属キャラクター名はキャラクターグループJSONを正本として表示する。外部URLはHTTPSのみ表示し、個別キャラクター固有情報をUIソースへ直書きしない。本体MIT Licenseは「権利について」へ統合し、第三者権利と適用範囲を明確に区別する。管理元・権利者名は補助情報扱いにせず本文相当の視認性を保つ。
 */

import { getBuiltinCharacterGroups } from '../../../characters/catalog/characterCatalog.js';
import { escapeHtml } from '../../../shared/utils.js';

function safeHttpsUrl(value) {
  const url = String(value ?? '').trim();
  return /^https:\/\/[^\s]+$/u.test(url) ? url : '';
}

function characterGroupRows() {
  return getBuiltinCharacterGroups()
    .filter((group) => group.characters.length)
    .map((group) => {
      const holder = String(group.credits?.holder ?? '').trim();
      const credit = String(group.credits?.creditText ?? '').trim();
      const officialUrl = safeHttpsUrl(group.source?.officialUrl);
      const termsUrl = safeHttpsUrl(group.source?.termsUrl);
      const verifiedAt = String(group.source?.classificationVerifiedAt ?? '').trim();
      const characterNames = group.characters
        .map((character) => `<li>${escapeHtml(character.name)}</li>`)
        .join('');
      const sourceLinks = [
        officialUrl ? `<a href="${escapeHtml(officialUrl)}" target="_blank" rel="noreferrer">公式サイト</a>` : '',
        termsUrl ? `<a href="${escapeHtml(termsUrl)}" target="_blank" rel="noreferrer">利用規約</a>` : '',
        verifiedAt ? `<span>確認日: ${escapeHtml(verifiedAt)}</span>` : '',
      ].filter(Boolean).join('');
      return `<div class="license-source-row">
        <div class="license-source-head">
          <strong class="license-source-group-name">${escapeHtml(group.name)}</strong>
          <span class="license-source-count">${group.characters.length}キャラクター</span>
        </div>
        ${holder ? `<p class="license-source-holder"><span>管理・権利情報</span><strong>${escapeHtml(holder)}</strong></p>` : ''}
        ${sourceLinks ? `<div class="license-source-links">${sourceLinks}</div>` : ''}
        <ul class="license-character-name-list" aria-label="${escapeHtml(group.name)}のキャラクター">${characterNames}</ul>
        ${credit ? `<code>${escapeHtml(credit)}</code>` : ''}
      </div>`;
    }).join('');
}

export function renderLicenseView({ appVersion = '', buildId = '' } = {}) {
  const shortBuildId = String(buildId ?? '').slice(0, 12);
  return `<section class="page license-page">
    <div class="page-head license-page-head">
      <div>
        <span class="eyebrow">LICENSE & CREDITS</span>
        <h2>ライセンス・クレジット</h2>
        <p>本ソフトの企画・設計・開発、実装支援技術、キャラクター管理元のクレジット・権利情報を表示します。</p>
      </div>
      <div class="license-version" aria-label="アプリ情報">
        <span>AI人狼マネージャー</span>
        <strong>v${escapeHtml(appVersion)}</strong>
        ${shortBuildId ? `<code>Build ${escapeHtml(shortBuildId)}</code>` : ''}
      </div>
    </div>

    <div class="license-credit-grid">
      <article class="panel license-credit-card license-credit-card-creator">
        <div class="license-credit-mark creator" aria-hidden="true">ZA</div>
        <div>
          <span class="license-card-kicker">企画・設計・開発</span>
          <h3>ずんだあい</h3>
          <p><a class="license-creator-link" href="https://x.com/ZundaAI" target="_blank" rel="noreferrer">X：@ZundaAI</a></p>
        </div>
      </article>

      <article class="panel license-credit-card">
        <div class="license-credit-mark" aria-hidden="true">GPT</div>
        <div>
          <span class="license-card-kicker">実装支援</span>
          <h3>GPT</h3>
          <p><strong>本ソフトの実装には、OpenAIのGPTを使用しています。</strong></p>
          <p class="help">設計、ソースコード作成、修正、検証の支援に利用しています。ゲーム中に使用するAIモデルは「AI管理」の設定により選択され、GPTに限定されません。</p>
        </div>
      </article>

      <article class="panel license-credit-card">
        <div class="license-credit-mark" aria-hidden="true">Claude</div>
        <div>
          <span class="license-card-kicker">実装支援</span>
          <h3>Claude</h3>
          <p><strong>本ソフトの実装支援には、AnthropicのClaudeを使用しています。</strong></p>
          <p class="help">主にソースコードのレビュー、修正内容や設計方針の確認に利用しています。</p>
        </div>
      </article>

    </div>

    <div class="license-detail-grid">
      <section class="panel license-section" aria-labelledby="license-character-groups-title">
        <div class="license-section-head">
          <span class="license-section-icon" aria-hidden="true">◎</span>
          <div><h3 id="license-character-groups-title">キャラクターデータ</h3><p>組み込みJSONに登録されているグループと管理情報です。</p></div>
        </div>
        <div class="license-source-list">${characterGroupRows()}</div>
      </section>

      <section class="panel license-section license-rights-section" aria-labelledby="license-rights-title">
        <div class="license-section-head">
          <span class="license-section-icon" aria-hidden="true">©</span>
          <div><h3 id="license-rights-title">権利について</h3><p>本ソフトの利用条件と、第三者の名称・キャラクター・サービスに関する権利情報です。</p></div>
        </div>
        <div class="license-software-license">
          <span class="license-card-kicker">SOFTWARE LICENSE</span>
          <h4>AI人狼マネージャー — MIT License</h4>
          <p><strong>Copyright (c) 2026 ずんだあい</strong></p>
          <p>本ソフトウェア本体の独自コードはMIT Licenseで提供します。事前許可なく利用・複製・改変・結合・公開・再配布・再許諾・販売を含む商用利用が可能です。</p>
          <p class="help">再配布時は著作権表示とMIT License本文を保持してください。この許諾は第三者が権利を持つキャラクター、名称、ロゴ、サービス、その他の素材には適用されません。</p>
        </div>
        <ul class="license-notice-list">
          <li>GPTおよびOpenAIに関する名称・権利は、OpenAIおよび各権利者に帰属します。</li>
          <li>ClaudeおよびAnthropicに関する名称・権利は、Anthropicおよび各権利者に帰属します。</li>
          <li>各組み込みキャラクターの名称・設定等に関する権利は、それぞれの権利者に帰属します。</li>
          <li>本ソフトはOpenAI、Anthropicまたは各キャラクター管理元の公式製品・公式サービスではありません。</li>
        </ul>
      </section>
    </div>
  </section>`;
}
