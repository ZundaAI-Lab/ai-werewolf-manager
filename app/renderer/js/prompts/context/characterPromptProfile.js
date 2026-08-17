/**
 * 責務: 保存されたキャラクター設定を、AIタスクごとのプロンプト用データへ投影する。
 * 変更ルール:
 * - 状態を書き換えない。
 * - キャラクター設定の保存形式やUIを扱わない。
 * - タスクごとの公開項目差はこのファイルだけで管理する。
 * - 通常プロフィールから外した推理傾向は、判断に必要な非公開タスクへ短い判断方針としてだけ投影する。
 * - 公開会話用roleplayCueは短い表現手掛かりとしてだけ投影し、推理内容や完成台詞へ変換しない。
 */

import { REASONING_PROFILE_PROMPT_DESCRIPTIONS } from '../../config/constants.js';

function reasoningProfileText(profile = {}) {
  return Object.entries(REASONING_PROFILE_PROMPT_DESCRIPTIONS)
    .map(([key, options]) => options?.[profile[key]] ?? null)
    .filter(Boolean)
    .join('。');
}

function speechExampleLines(value) {
  return String(value ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function buildCharacterPromptProfile(character = {}, { mode = 'day-compact', roleplayCue = null } = {}) {
  const style = {
    profile: character.profile || null,
    firstPerson: character.firstPerson || null,
    genericSecondPerson: character.genericSecondPerson || null,
    speakingStyle: character.speakingStyle || null,
    defaultEndings: character.defaultEndings || null,
    avoidedExpressions: character.avoidedExpressions || null,
    speechExamples: speechExampleLines(character.speechExamples),
  };

  if (mode === 'initial-full') {
    return {
      ...style,
      speechLength: character.speechLength || null,
      reasoning: reasoningProfileText(character.reasoningProfile) || null,
      discussionBehavior: character.discussionBehavior || null,
    };
  }

  if (mode === 'day-dialogue-compact') {
    return {
      profile: style.profile,
      firstPerson: style.firstPerson,
      genericSecondPerson: style.genericSecondPerson,
      speakingStyle: style.speakingStyle,
      defaultEndings: style.defaultEndings,
      avoidedExpressions: style.avoidedExpressions,
      roleplayCue: roleplayCue || null,
    };
  }

  if (mode === 'day-compact') {
    return {
      firstPerson: style.firstPerson,
      genericSecondPerson: style.genericSecondPerson,
      speakingStyle: style.speakingStyle,
      defaultEndings: style.defaultEndings,
      avoidedExpressions: style.avoidedExpressions,
    };
  }

  if (mode === 'night-compact' || mode === 'result-compact') {
    return {
      firstPerson: style.firstPerson,
      speakingStyle: style.speakingStyle,
      defaultEndings: style.defaultEndings,
      avoidedExpressions: style.avoidedExpressions,
    };
  }

  throw new RangeError(`未定義のキャラクタープロンプト形式です: ${mode}`);
}
