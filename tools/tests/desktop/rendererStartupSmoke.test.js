/**
 * 責務: 製品index.htmlの実script順序を使って、bundle内automation入口が後続classic scriptへ依存せず同期評価できることを検証する。
 * 変更ルール: DOM機能の詳細を再現せず、DOMContentLoaded前の同期初期化だけを対象にする。bundleのbootstrap起動はautomationEntry起動へ差し替え、HTMLロード順と同期初期化の成立だけを検証する。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.join(__dirname, '..', '..', '..');
const rendererRoot = path.join(projectRoot, 'app', 'renderer');
const indexHtml = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');

function scriptSources(html) {
  return [...html.matchAll(/<script\s+src="([^"]+)"\s+defer><\/script>/gu)].map((match) => match[1]);
}

function localScriptPath(source) {
  const clean = source.replace(/\?.*$/u, '');
  return path.resolve(rendererRoot, clean);
}

function startupContext() {
  const listeners = new Map();
  const document = {
    readyState: 'loading',
    body: {
      classList: { contains: () => false },
      append: () => {},
    },
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    querySelector: () => null,
    createElement: () => ({
      className: '',
      textContent: '',
      setAttribute: () => {},
      append: () => {},
    }),
  };
  const context = {
    console,
    document,
    navigator: {},
    structuredClone,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    MutationObserver: class MutationObserver { observe() {} },
    CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  context.window = context;
  context.globalThis = context;
  return vm.createContext(context);
}

test('製品script順でbundle内automation入口を同期評価できる', () => {
  const sources = scriptSources(indexHtml);
  const bundleIndex = sources.findIndex((source) => source.startsWith('./generated/bundle.js'));
  assert.ok(bundleIndex >= 0, 'index.htmlにbundle.jsが必要です。');
  const context = startupContext();

  for (const source of sources.slice(0, bundleIndex)) {
    vm.runInContext(fs.readFileSync(localScriptPath(source), 'utf8'), context, { filename: source });
  }

  const bundleSource = fs.readFileSync(localScriptPath(sources[bundleIndex]), 'utf8');
  const bootstrapCall = "load('js/app/bootstrap');";
  const callIndex = bundleSource.lastIndexOf(bootstrapCall);
  assert.ok(callIndex >= 0, 'bundleのbootstrap起動口が見つかりません。');
  const automationSmokeBundle = `${bundleSource.slice(0, callIndex)}load('js/automation/automationEntry');${bundleSource.slice(callIndex + bootstrapCall.length)}`;

  assert.doesNotThrow(() => {
    vm.runInContext(automationSmokeBundle, context, { filename: 'generated/bundle.js' });
  });
  assert.ok(context.AiWerewolfApiRetryPolicy, 'API再試行Policyはbundle評価時点で公開される必要があります。');
  assert.ok(context.AiWerewolfDesktopAutomation, 'automation Facadeはbundle内だけで初期化できる必要があります。');
});
