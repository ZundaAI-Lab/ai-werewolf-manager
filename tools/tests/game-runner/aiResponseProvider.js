/**
 * 責務: 1ゲーム通しテストで、本番生成済みAI入力をファイルへ公開し、外部AIが返した生回答を無加工で受け取る境界だけを所有する。
 * 変更ルール: AI本文を生成・補正・解析しない。再試行時も本番promptTextと直前の検証エラーだけを入力へ追加し、ゲーム状態・正解情報・候補優先度を混入させない。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const AI_RESPONSE_PROVIDER_FILES = Object.freeze({
  prompt: 'current_prompt.txt',
  aiInput: 'current_ai_input.txt',
  task: 'current_task.json',
  response: 'current_response.txt',
  validation: 'current_validation.json',
});

function normalizedIssue(issue) {
  return {
    code: String(issue?.code ?? 'VALIDATION_ERROR'),
    category: String(issue?.category ?? ''),
    path: String(issue?.path ?? ''),
    message: String(issue?.message ?? issue ?? 'AI応答の検証に失敗しました。'),
  };
}

export function buildAiInput(promptText, issues = []) {
  const base = String(promptText ?? '');
  const normalized = (issues ?? []).map(normalizedIssue);
  if (!normalized.length) return base;
  const lines = normalized.map((issue, index) => {
    const path = issue.path ? ` [${issue.path}]` : '';
    return `${index + 1}. ${issue.code}${path}: ${issue.message}`;
  });
  return `${base}\n\n---\n\n前回のAI応答は本番検証で不受理になりました。元の出力契約に従って再生成してください。追加情報は以下の検証エラーだけです。\n${lines.join('\n')}`;
}

export function providerPaths(workspace) {
  const root = resolve(workspace);
  return Object.freeze({
    root,
    prompt: join(root, AI_RESPONSE_PROVIDER_FILES.prompt),
    aiInput: join(root, AI_RESPONSE_PROVIDER_FILES.aiInput),
    task: join(root, AI_RESPONSE_PROVIDER_FILES.task),
    response: join(root, AI_RESPONSE_PROVIDER_FILES.response),
    validation: join(root, AI_RESPONSE_PROVIDER_FILES.validation),
  });
}

export async function publishPendingAiTask({ workspace, task, promptText, issues = [] }) {
  const paths = providerPaths(workspace);
  await mkdir(paths.root, { recursive: true });
  const normalizedIssues = (issues ?? []).map(normalizedIssue);
  await Promise.all([
    writeFile(paths.prompt, String(promptText ?? ''), 'utf8'),
    writeFile(paths.aiInput, buildAiInput(promptText, normalizedIssues), 'utf8'),
    writeFile(paths.task, `${JSON.stringify(task, null, 2)}\n`, 'utf8'),
    writeFile(paths.validation, `${JSON.stringify({ ok: normalizedIssues.length === 0, issues: normalizedIssues }, null, 2)}\n`, 'utf8'),
  ]);
  return paths;
}

export async function readSubmittedAiResponse({ workspace, responseFile = '' }) {
  const paths = providerPaths(workspace);
  const source = responseFile ? resolve(responseFile) : paths.response;
  const rawResponse = await readFile(source, 'utf8');
  return { rawResponse, source };
}

export async function clearSubmittedAiResponse(workspace) {
  const { response } = providerPaths(workspace);
  await rm(response, { force: true });
}
