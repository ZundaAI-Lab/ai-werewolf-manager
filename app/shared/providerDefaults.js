/**
 * 責務: Electron Main・Rendererで共有するLLMプロバイダーの既定エンドポイントと既定モデルだけを定義する。
 * 変更ルール: 通信能力、認証、UI表示、設定保存を扱わない。既定接続先・既定モデルを変更する場合はMain/Renderer双方の設定テストを同時更新する。
 */

(function initializeProviderDefaults(root, factory) {
  'use strict';

  const commonJs = typeof module === 'object' && module.exports;
  const localLlmConfig = commonJs
    ? require('./localLlmConfig.js')
    : root?.AiWerewolfLocalLlmConfig;
  const api = factory(localLlmConfig);
  if (commonJs) module.exports = api;
  else if (root) {
    root.AiWerewolfProviderDefaults = api;
    if (root.window && root.window !== root) root.window.AiWerewolfProviderDefaults = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, (localLlmConfig) => {
  'use strict';

  if (!localLlmConfig) throw new Error('ローカルLLM共通設定を読み込めませんでした。');
  const { LOCAL_OPENAI_PROVIDER, LOCAL_SERVER_PRESETS } = localLlmConfig;
  const PROVIDER_DEFAULTS = Object.freeze({
    demo: Object.freeze({ endpoint: '', model: 'demo-balanced' }),
    openai: Object.freeze({ endpoint: 'https://api.openai.com/v1/responses', model: '' }),
    anthropic: Object.freeze({ endpoint: 'https://api.anthropic.com/v1/messages', model: '' }),
    gemini: Object.freeze({ endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.6-flash' }),
    xai: Object.freeze({ endpoint: 'https://api.x.ai/v1/chat/completions', model: 'grok-4.5' }),
    deepseek: Object.freeze({ endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-pro' }),
    qwen: Object.freeze({ endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', model: '' }),
    kimi: Object.freeze({ endpoint: 'https://api.moonshot.ai/v1/chat/completions', model: '' }),
    glm: Object.freeze({ endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: '' }),
    'openai-compatible': Object.freeze({ endpoint: '', model: '' }),
    [LOCAL_OPENAI_PROVIDER]: Object.freeze({ endpoint: LOCAL_SERVER_PRESETS['lm-studio'].endpoint, model: '' }),
  });

  return Object.freeze({ PROVIDER_DEFAULTS });
});
