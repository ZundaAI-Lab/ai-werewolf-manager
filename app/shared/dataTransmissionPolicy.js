/**
 * 責務: AIプロバイダーをアプリ内デモ・ローカル処理・外部送信へ分類し、外部LLMデータ送信確認が必要な通信先をMain・Renderer共通で判定する。
 * 変更ルール: DOM表示・同意状態の保存・HTTP通信を行わない。ローカル扱いはshared/localLlmConfig.jsの専用ローカルプロバイダーだけとし、任意OpenAI互換APIは接続先URLに関係なく外部送信として扱う。確認文面の意味変更時はEXTERNAL_DATA_NOTICE_VERSIONを更新する。
 */

(function exposeDataTransmissionPolicy(root, factory) {
  'use strict';
  const commonJs = typeof module === 'object' && module.exports;
  const localLlmConfig = commonJs ? require('./localLlmConfig.js') : root?.AiWerewolfLocalLlmConfig;
  const api = factory(localLlmConfig);
  if (commonJs) module.exports = api;
  if (root) root.AiWerewolfDataTransmissionPolicy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (localLlmConfig) => {
  'use strict';

  const EXTERNAL_DATA_NOTICE_VERSION = 1;
  const LOCAL_OPENAI_PROVIDER = localLlmConfig?.LOCAL_OPENAI_PROVIDER;
  if (!LOCAL_OPENAI_PROVIDER) throw new Error('ローカルLLM設定をAIデータ送信Policyへ接続できませんでした。');

  function providerDataRoute(provider) {
    const id = String(provider ?? '');
    if (id === 'demo') return 'demo';
    if (id === LOCAL_OPENAI_PROVIDER) return 'local';
    return 'external';
  }

  function isExternalDataProvider(provider) {
    return providerDataRoute(provider) === 'external';
  }


  return Object.freeze({
    EXTERNAL_DATA_NOTICE_VERSION,
    providerDataRoute,
    isExternalDataProvider,
  });
}));
