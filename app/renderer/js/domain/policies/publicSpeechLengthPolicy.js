/**
 * 責務: 人間向けの公開発言量区分を、AI公開発言の文字数目安・許容上限と会話局面モードへ変換する。設定された発言量は維持しつつ、既出論点による文字数の水増しは要求しない。
 * 変更ルール: 区分名・文字数目安・目安に対する許容上限倍率・deliveryModeの対応はこのファイルだけで管理する。人間向け区分名をAIプロンプト用ラベルとして再掲せず、実際のプロンプト文言はpromptTemplates.jsを正本とする。最初の会話開始と序盤反応は短くするが、同じ応答でCO・能力結果を公開する場合は通常の役職発言量を優先する。
 */

export const PUBLIC_SPEECH_LENGTH_OPTIONS = Object.freeze([
  'かなり短め',
  '短め',
  'やや短め',
  '標準',
  'やや長め',
  '長め',
  'かなり長め',
]);

const PUBLIC_SPEECH_LENGTH_POLICIES = Object.freeze({
  'かなり短め': Object.freeze({
    targetChars: 60,
    deliveryMode: 'very-concise',
  }),
  '短め': Object.freeze({
    targetChars: 80,
    deliveryMode: 'concise',
  }),
  'やや短め': Object.freeze({
    targetChars: 105,
    deliveryMode: 'slightly-concise',
  }),
  '標準': Object.freeze({
    targetChars: 135,
    deliveryMode: 'standard',
  }),
  'やや長め': Object.freeze({
    targetChars: 165,
    deliveryMode: 'slightly-detailed',
  }),
  '長め': Object.freeze({
    targetChars: 205,
    deliveryMode: 'detailed',
  }),
  'かなり長め': Object.freeze({
    targetChars: 240,
    deliveryMode: 'very-detailed',
  }),
});


export const PUBLIC_SPEECH_MAX_TARGET_MULTIPLIER = 1.5;

export function resolvePublicSpeechPromptMaxChars(targetChars, { absoluteMaxChars = 450 } = {}) {
  const target = Number(targetChars);
  if (!Number.isFinite(target) || target <= 0) return 0;
  const scaledMax = Math.ceil(target * PUBLIC_SPEECH_MAX_TARGET_MULTIPLIER);
  const absoluteMax = Number(absoluteMaxChars);
  return Number.isFinite(absoluteMax) && absoluteMax > 0
    ? Math.min(scaledMax, Math.floor(absoluteMax))
    : scaledMax;
}

export function isPublicSpeechLengthOption(value) {
  return Object.hasOwn(PUBLIC_SPEECH_LENGTH_POLICIES, value);
}

function withClaimOverride(base, policy) {
  return Object.freeze({
    ...policy,
    claimOverride: Object.freeze({
      targetChars: base.targetChars,
    }),
  });
}

export function resolvePublicSpeechLengthPolicy(speechLength, { conversationMode = 'normal' } = {}) {
  if (!isPublicSpeechLengthOption(speechLength)) {
    throw new RangeError(`未定義の公開発言量区分です: ${speechLength}`);
  }

  const base = PUBLIC_SPEECH_LENGTH_POLICIES[speechLength];
  if (conversationMode === 'first-speaker') {
    return withClaimOverride(base, {
      targetChars: Math.min(base.targetChars, 120),
      deliveryMode: 'first-speaker',
    });
  }
  if (conversationMode === 'early-reaction') {
    return withClaimOverride(base, {
      targetChars: Math.min(base.targetChars, 160),
      deliveryMode: 'early-reaction',
    });
  }
  if (conversationMode !== 'normal') {
    throw new RangeError(`未定義の会話形式です: ${conversationMode}`);
  }

  return Object.freeze({ ...base });
}
