/**
 * 責務: ローカルOpenAI互換LLMのモデル一覧取得と接続診断に必要なURL差異を吸収する。
 * 変更ルール: ゲーム状態・画面・設定保存を扱わない。生成要求はproviderClients.jsへ委譲し、このモジュールではループバック接続の発見系APIだけを扱う。
 */

'use strict';

const { LOCAL_SERVER_PRESETS } = require('../shared/localLlmConfig.js');
const {
  ProviderRequestError,
  bearerAuthorizationHeaders,
  isLocalProvider,
  normalizeEndpoint,
  requestJson,
} = require('./providerClients.js');

function modelsEndpointFromChatEndpoint(endpoint) {
  const url = new URL(String(endpoint));
  const path = url.pathname.replace(/\/+$/u, '');
  if (/\/chat\/completions$/u.test(path)) url.pathname = path.replace(/\/chat\/completions$/u, '/models');
  else {
    const versionIndex = path.indexOf('/v1');
    url.pathname = versionIndex >= 0 ? `${path.slice(0, versionIndex)}/v1/models` : `${path}/models`;
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function modelIdsFromBody(body) {
  const values = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const ids = values.flatMap((item) => {
    if (typeof item === 'string') return [item];
    const id = item?.id ?? item?.model ?? item?.name;
    return id ? [String(id)] : [];
  });
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right, 'ja'));
}

async function listLocalModels({ profile, apiKey = '', signal }) {
  if (!isLocalProvider(profile)) {
    throw new ProviderRequestError('モデル一覧取得はローカルLLMプロファイルだけ利用できます。', {
      provider: profile?.provider,
      code: 'LOCAL_PROVIDER_REQUIRED',
    });
  }
  const endpoint = normalizeEndpoint(profile);
  const modelsEndpoint = modelsEndpointFromChatEndpoint(endpoint);
  const body = await requestJson({
    provider: profile.provider,
    url: modelsEndpoint,
    method: 'GET',
    headers: bearerAuthorizationHeaders(profile, apiKey),
    signal,
  });
  const models = modelIdsFromBody(body);
  if (models.length === 0) {
    throw new ProviderRequestError('ローカルLLMサーバーへ接続できましたが、モデル一覧が空です。モデルを読み込んでから再実行してください。', {
      provider: profile.provider,
      code: 'MODEL_LIST_EMPTY',
    });
  }
  return { endpoint, modelsEndpoint, models };
}

module.exports = {
  LOCAL_SERVER_PRESETS,
  listLocalModels,
  modelIdsFromBody,
  modelsEndpointFromChatEndpoint,
};
