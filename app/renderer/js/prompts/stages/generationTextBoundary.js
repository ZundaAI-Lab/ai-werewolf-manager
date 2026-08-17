/**
 * 責務: 昼のAI公開発言について、他プレイヤーの公開発言全文または本人可視の秘密会話文を機械的に流用した回答を、意味解析なしの文字列比較で検出する。
 * 変更ルール: 公開発言から人物・役職・CO・能力結果・投票意思・秘密らしさを抽出または推定しない。stageSource.safetyReferencesだけを参照し、ゲーム状態、候補、履歴を変更しない。短い定型句は拒否しない。
 */

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';

const MIN_EXACT_COMPARISON_LENGTH = 18;
const MIN_PRIVATE_SHARED_LENGTH = 24;
const PRIVATE_SHARED_RATIO = 0.75;

function issue(code, message) {
  return {
    code,
    category: 'text-boundary',
    path: 'publicSpeech',
    message,
  };
}

export function normalizeBoundaryText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[「」『』【】（）()［\][\]{}〈〉《》<>＜＞“”‘’"'`´。、，,.!?！？:：;；・…―—ー~〜]/gu, '')
    .trim();
}

export function longestCommonSubstringLength(leftValue, rightValue) {
  const left = Array.from(String(leftValue ?? ''));
  const right = Array.from(String(rightValue ?? ''));
  if (!left.length || !right.length) return 0;
  let previous = new Uint32Array(right.length + 1);
  let longest = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Uint32Array(right.length + 1);
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] !== right[rightIndex - 1]) continue;
      current[rightIndex] = previous[rightIndex - 1] + 1;
      if (current[rightIndex] > longest) longest = current[rightIndex];
    }
    previous = current;
  }
  return longest;
}

function copiedOtherPublicSpeech(publicSpeech, references) {
  const candidate = normalizeBoundaryText(publicSpeech);
  if (candidate.length < MIN_EXACT_COMPARISON_LENGTH) return null;
  for (const reference of references ?? []) {
    const existing = normalizeBoundaryText(reference?.text);
    if (existing.length < MIN_EXACT_COMPARISON_LENGTH) continue;
    if (candidate === existing) {
      return issue(
        'PUBLIC_SPEECH_COPIES_OTHER_PLAYER',
        '他プレイヤーの公開発言全文と一致するため拒否しました。',
      );
    }
  }
  return null;
}

function copiedPrivateDialogue(publicSpeech, references) {
  const candidate = normalizeBoundaryText(publicSpeech);
  if (candidate.length < MIN_EXACT_COMPARISON_LENGTH) return null;
  for (const reference of references ?? []) {
    const privateText = normalizeBoundaryText(reference?.content);
    if (privateText.length < MIN_EXACT_COMPARISON_LENGTH) continue;
    if (candidate === privateText) {
      return issue(
        'PUBLIC_SPEECH_COPIES_PRIVATE_DIALOGUE',
        '秘密会話の文章を公開発言へそのまま転用しているため拒否しました。',
      );
    }
    const sharedLength = longestCommonSubstringLength(candidate, privateText);
    if (sharedLength >= MIN_PRIVATE_SHARED_LENGTH && sharedLength / candidate.length >= PRIVATE_SHARED_RATIO) {
      return issue(
        'PUBLIC_SPEECH_REUSES_PRIVATE_DIALOGUE',
        '秘密会話の長い文章断片を公開発言へ転用しているため拒否しました。',
      );
    }
  }
  return null;
}

export function validateGeneratedTextBoundary({ taskArtifact, candidateObject } = {}) {
  const taskType = String(taskArtifact?.taskType ?? '');
  if (!(isNormalSpeechTask(taskType) || ['priority-answer', 'testament'].includes(taskType))) {
    return { ok: true, issues: [] };
  }
  const publicSpeech = candidateObject?.publicSpeech;
  if (typeof publicSpeech !== 'string') return { ok: true, issues: [] };
  const references = taskArtifact?.stageSource?.safetyReferences ?? {};
  const issues = [
    copiedOtherPublicSpeech(publicSpeech, references.otherPublicSpeeches),
    copiedPrivateDialogue(publicSpeech, references.privateDialogueTexts),
  ].filter(Boolean);
  return { ok: issues.length === 0, issues };
}
