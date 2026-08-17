/**
 * 責務: Electron Main・Rendererで共有するローカルLLMプロバイダーIDとサーバープリセットを定義する。
 * 変更ルール: HTTP通信・設定保存・DOM操作を行わない。プリセット名・既定接続先・Ollama Thinking段階を変更する場合は、モデル発見・設定正規化・通信・管理画面の各テストを同時更新する。
 */

(function initializeLocalLlmConfig(root, factory) {
  'use strict';

  const api = factory();
  const commonJs = typeof module === 'object' && module.exports;
  if (commonJs) module.exports = api;
  else if (root) {
    root.AiWerewolfLocalLlmConfig = api;
    if (root.window && root.window !== root) root.window.AiWerewolfLocalLlmConfig = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const LOCAL_OPENAI_PROVIDER = 'local-openai-compatible';
  const OLLAMA_THINKING_LEVELS = Object.freeze(['none', 'low', 'medium', 'high', 'max']);
  const DEFAULT_OLLAMA_THINKING_LEVEL = 'low';
  const LOCAL_SERVER_PRESETS = Object.freeze({
    'lm-studio': Object.freeze({ label: 'LM Studio', endpoint: 'http://127.0.0.1:1234/v1/chat/completions' }),
    ollama: Object.freeze({ label: 'Ollama', endpoint: 'http://127.0.0.1:11434/v1/chat/completions' }),
    'llama-cpp': Object.freeze({ label: 'llama.cpp', endpoint: 'http://127.0.0.1:8080/v1/chat/completions' }),
    vllm: Object.freeze({ label: 'vLLM', endpoint: 'http://127.0.0.1:8000/v1/chat/completions' }),
    localai: Object.freeze({ label: 'LocalAI', endpoint: 'http://127.0.0.1:8080/v1/chat/completions' }),
    custom: Object.freeze({ label: 'カスタム', endpoint: '' }),
  });

  return Object.freeze({
    DEFAULT_OLLAMA_THINKING_LEVEL,
    LOCAL_OPENAI_PROVIDER,
    LOCAL_SERVER_PRESETS,
    OLLAMA_THINKING_LEVELS,
  });
});
