/**
 * 責務: AI API要求の同時実行数を実行環境別に制御し、外部APIの全体並列数と同一ローカルLLMサーバーの並列数を一元管理する。
 * 変更ルール: ゲーム規則・タスク依存関係・応答再試行判断を持たない。並列可否はdomainのbatch policy、再試行可否は既存retry policyを正本とする。待機要求は登録時のAbortSignalとrunControlをgate内で保持し、停止時も枠解放と後続要求の解決を阻害しない。自動モードは外部4並列・同一ローカル接続先1並列を固定既定とし、有効モードだけ保存された上限値を使用する。
 */

const AUTO_EXTERNAL_CONCURRENCY = 4;
const AUTO_LOCAL_CONCURRENCY = 1;

function normalizedPositiveInteger(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(numeric)));
}

function localEndpointKey(profile) {
  const endpoint = String(profile?.endpoint ?? '').trim();
  if (!endpoint) return `profile:${String(profile?.id ?? '')}`;
  try {
    const parsed = new URL(endpoint);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return endpoint;
  }
}

class ConcurrencyGate {
  constructor(limit, runControl) {
    this.limit = limit;
    this.runControl = runControl;
    this.active = 0;
    this.queue = [];
  }

  async acquire(session) {
    this.runControl.assertRunning(session);
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const signal = session?.abortController?.signal;
      const entry = { resolve, reject, signal, onAbort: null };
      this.queue.push(entry);
      if (!signal) return;
      entry.onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal.removeEventListener('abort', entry.onAbort);
        reject(new this.runControl.AutomationStoppedError());
      };
      signal.addEventListener('abort', entry.onAbort, { once: true });
      if (signal.aborted) entry.onAbort();
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    while (this.queue.length) {
      const entry = this.queue.shift();
      const signal = entry.signal;
      if (entry.onAbort && signal) signal.removeEventListener('abort', entry.onAbort);
      if (signal?.aborted) {
        entry.reject(new this.runControl.AutomationStoppedError());
        continue;
      }
      this.active += 1;
      entry.resolve();
      break;
    }
  }
}

export function createAutomaticAiRequestScheduler({ controller, runControl, localProviderId }) {
  if (!controller || !runControl) throw new Error('AI要求Schedulerの必須依存を初期化できません。');
  const gates = new Map();

  function effectiveLimit(profile) {
    const options = controller.settings.aiOptions ?? {};
    const mode = ['auto', 'enabled', 'disabled'].includes(options.parallelExecutionMode)
      ? options.parallelExecutionMode
      : 'auto';
    const local = profile?.provider === localProviderId;
    if (mode !== 'enabled') return local ? AUTO_LOCAL_CONCURRENCY : AUTO_EXTERNAL_CONCURRENCY;
    return local
      ? normalizedPositiveInteger(options.localMaxConcurrency, AUTO_LOCAL_CONCURRENCY, 8)
      : normalizedPositiveInteger(options.externalMaxConcurrency, AUTO_EXTERNAL_CONCURRENCY, 16);
  }

  function gateKey(profile) {
    return profile?.provider === localProviderId
      ? `local:${localEndpointKey(profile)}`
      : 'external';
  }

  function gateFor(profile) {
    const key = gateKey(profile);
    const limit = effectiveLimit(profile);
    const existing = gates.get(key);
    if (existing?.limit === limit) return existing;
    if (existing && (existing.active > 0 || existing.queue.length > 0)) return existing;
    const gate = new ConcurrencyGate(limit, runControl);
    gates.set(key, gate);
    return gate;
  }

  async function run(profile, session, operation) {
    runControl.assertRunning(session);
    const gate = gateFor(profile);
    await gate.acquire(session);
    try {
      runControl.assertRunning(session);
      return await operation();
    } finally {
      gate.release();
    }
  }

  return Object.freeze({ run });
}

