/**
 * 責務: 外部LLMへ送信され得るデータの説明表示、初回確認、確認済み状態の参照とMainへの永続化を担当する。
 * 変更ルール: AI設定・ゲーム状態・プロンプト内容を書き換えない。外部/ローカル分類はshared/dataTransmissionPolicy.jsを正本とし、確認前の外部送信可否はMain側ガードにも依存する。確認は外部プロバイダーを有効化・利用する直前だけ要求し、デモAIと専用ローカルLLMでは要求しない。
 */

function policy() {
  const value = globalThis.window?.AiWerewolfDataTransmissionPolicy ?? globalThis.AiWerewolfDataTransmissionPolicy;
  if (!value) throw new Error('AIデータ送信Policyを読み込めませんでした。');
  return value;
}

function bridge() {
  return globalThis.window?.desktopWerewolf ?? null;
}

let acceptedCache = null;
let activeDialogPromise = null;

function loadAcceptedStatus() {
  if (acceptedCache !== null) return acceptedCache;
  const desktopBridge = bridge();
  if (!desktopBridge?.isDesktop) {
    acceptedCache = true;
    return acceptedCache;
  }
  try {
    acceptedCache = desktopBridge.loadExternalDataNoticeStatusSync?.()?.accepted === true;
  } catch {
    acceptedCache = false;
  }
  return acceptedCache;
}

function noticeBodyHtml() {
  return `<div class="ai-data-privacy-dialog-copy">
    <p><strong>外部AIプロバイダーを使用する場合、AIによる判断・発言・分析・キャラクター生成に必要な情報が、選択したAIプロバイダーまたはOpenAI互換APIの接続先へ送信されます。</strong></p>
    <p>送信される可能性がある情報は、実行する機能やタスクによって異なります。</p>
    <ul>
      <li>プレイヤー名、キャラクター名、人物設定、口調、相手別呼称</li>
      <li>公開発言、チャットルームの会話、お題、ユーザーが入力した文章</li>
      <li>そのAI本人の判断に必要なゲーム状態、役職・能力結果・既知情報などの非公開情報</li>
      <li>そのAI本人の内部メモ、判断状態、未回答質問などの継続情報</li>
      <li>AIキャラクター生成時の生成指示や、生成対象に必要なキャラクター情報</li>
    </ul>
    <p class="help">機能の実行に必要な範囲の情報だけが、設定したAIサービスへ送信されます。</p>
    <p class="help">本ツールがゲーム・チャット内容を開発者独自の収集サーバーへ送信する機能はありません。外部AI利用時の送信先は、利用者がAIプロファイルで選択・設定したサービスまたは接続先です。</p>
    <p class="help">手動プロンプト方式では本ツール自身は外部LLM APIへ送信しませんが、コピーしたプロンプトを外部AIサービスへ貼り付けた時点で、そのプロンプトに含まれる情報が当該サービスへ送信されます。</p>
    <div class="alert warning ai-data-privacy-warning"><strong>実在人物の情報に注意</strong><span>家族・友人などの本名や、住所・連絡先・健康情報・勤務先など、外部サービスへ送信したくない個人情報や機密情報は入力しないでください。</span></div>
    <div class="ai-data-route-explanation">
      <p><span class="ai-data-route-badge is-external">外部送信</span><strong>OpenAI / Anthropic / Gemini / xAI / DeepSeek / Qwen / Kimi / GLM / OpenAI互換API</strong><br>設定した外部サービスへ送信されます。送信後の保存・利用・保持期間などは、そのサービスまたは接続先運営者の利用規約・プライバシーポリシーが適用されます。</p>
      <p><span class="ai-data-route-badge is-local">ローカル処理</span><strong>ローカルLLM（OpenAI互換）</strong><br>本ツールは localhost / 127.0.0.1 / ::1 のループバック接続だけを許可します。AI処理は設定した同一PC上のローカルLLMサーバーへ送信されます。</p>
      <p><span class="ai-data-route-badge is-demo">アプリ内</span><strong>デモAI</strong><br>外部LLM APIへゲーム・チャット内容を送信しません。</p>
    </div>
  </div>`;
}

function showNoticeDialog({ acknowledgement = false } = {}) {
  if (activeDialogPromise) return activeDialogPromise;
  const dialog = globalThis.document?.querySelector('#ai-data-privacy-dialog');
  if (!dialog || typeof dialog.showModal !== 'function' || dialog.open) return Promise.resolve(false);

  dialog.returnValue = 'cancel';
  dialog.innerHTML = `<form method="dialog">
    <div class="modal-header"><h3>AI通信とプライバシー</h3></div>
    <div class="modal-body">${noticeBodyHtml()}</div>
    <div class="modal-footer"><button class="button ghost" value="cancel" type="submit" autofocus>${acknowledgement ? 'キャンセル' : '閉じる'}</button>${acknowledgement ? '<button class="button primary" value="confirm" type="submit">内容を確認して外部LLMを使用</button>' : ''}</div>
  </form>`;

  activeDialogPromise = new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const accepted = dialog.returnValue === 'confirm';
      dialog.innerHTML = '';
      activeDialogPromise = null;
      resolve(accepted);
    }, { once: true });
    dialog.showModal();
  });
  return activeDialogPromise;
}

async function acceptNotice() {
  const desktopBridge = bridge();
  if (!desktopBridge?.isDesktop) {
    acceptedCache = true;
    return true;
  }
  const result = await desktopBridge.acceptExternalDataNotice?.(policy().EXTERNAL_DATA_NOTICE_VERSION);
  if (result?.accepted !== true) throw new Error('外部LLMデータ送信の確認状態を保存できませんでした。');
  acceptedCache = true;
  return true;
}

async function ensureAccepted() {
  if (loadAcceptedStatus()) return true;
  const confirmed = await showNoticeDialog({ acknowledgement: true });
  if (!confirmed) return false;
  return acceptNotice();
}

export async function ensureExternalDataNoticeForProfile(profile) {
  if (!profile || !policy().isExternalDataProvider(profile.provider)) return true;
  return ensureAccepted();
}

export async function ensureExternalDataNoticeForProfileId(profileId, { settings = null } = {}) {
  let currentSettings = settings;
  if (!currentSettings) currentSettings = await bridge()?.getSettings?.();
  const profile = currentSettings?.profiles?.find((item) => item.id === String(profileId ?? '')) ?? null;
  return ensureExternalDataNoticeForProfile(profile);
}

export function openExternalDataPrivacyHelp() {
  return showNoticeDialog({ acknowledgement: false });
}

export function externalDataNoticeAccepted() {
  return loadAcceptedStatus();
}

const api = Object.freeze({
  ensureExternalDataNoticeForProfile,
  ensureExternalDataNoticeForProfileId,
  openExternalDataPrivacyHelp,
  externalDataNoticeAccepted,
});

if (globalThis.window) globalThis.window.AiWerewolfDataTransmissionNotice = api;
