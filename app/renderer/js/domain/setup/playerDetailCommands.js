/**
 * 責務: 準備中プレイヤーの識別情報、キャラクター表現、会話のきっかけ、ゲーム参加者向け相手別呼称、推理傾向、本人限定追加情報を検証して状態へ反映する。
 * 変更ルール:
 * - DOM、FormData、HTMLを扱わない。
 * - ゲーム進行規則やプロンプト文章を生成しない。
 * - 会話のきっかけはプレイヤーのcharacterを、そのゲーム固有の相手別呼称はplayer.callNameOverridesを正本として更新する。
 * - 相手別呼称は基本呼称1件だけを保持し、対象は呼出元から渡された現在のゲーム参加者IDだけを許可する。
 */

import { REASONING_PROFILE_OPTION_LABELS } from '../../config/constants.js';
import { CHARACTER_TEXT_LIMITS, validateCharacterTextPayload } from '../../characters/config/characterTextPolicyAdapter.js';
import { validateCallName } from '../policies/playerIdentityPolicy.js';
import { isPublicSpeechLengthOption } from '../policies/publicSpeechLengthPolicy.js';
import { getPlayer } from '../game/standardRules.js';

const CHARACTER_TEXT_FIELDS = Object.freeze([
  'profile',
  'firstPerson',
  'genericSecondPerson',
  'speakingStyle',
  'defaultEndings',
  'avoidedExpressions',
  'speechExamples',
  'discussionBehavior',
]);

const REASONING_FIELDS = Object.freeze([
  'evidenceFocus',
  'updateTempo',
  'hypothesisBreadth',
  'confrontationStyle',
  'questionStyle',
  'uncertaintyStyle',
]);

function parseAliases(value) {
  return String(value ?? '')
    .split(/[、,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function prepareConversationSeeds(values, errors) {
  const ids = Array.isArray(values.conversationSeedIds) ? values.conversationSeedIds.map((value) => String(value ?? '').trim()) : [];
  const subjects = Array.isArray(values.conversationSeedSubjects) ? values.conversationSeedSubjects.map((value) => String(value ?? '').trim()) : [];
  const tones = Array.isArray(values.conversationSeedTones) ? values.conversationSeedTones.map((value) => String(value ?? '').trim()) : [];
  if (ids.length !== subjects.length || ids.length !== tones.length) {
    errors.push('会話のきっかけを読み取れませんでした。');
    return [];
  }
  if (ids.some((id) => !id)) errors.push('会話のきっかけIDが不正です。');
  if (new Set(ids).size !== ids.length) errors.push('会話のきっかけIDが重複しています。');
  if (ids.length > CHARACTER_TEXT_LIMITS.conversationSeedsMax) errors.push(`会話のきっかけは最大${CHARACTER_TEXT_LIMITS.conversationSeedsMax}件にしてください。`);
  subjects.forEach((subject, index) => {
    if (!subject || !tones[index]) errors.push(`会話のきっかけ${index + 1}の話題と雰囲気を入力してください。`);
  });
  return ids.map((id, index) => ({ id, subject: subjects[index], tone: tones[index] }));
}

function prepareCallNameOverrides(values, validTargetPlayerIds, errors) {
  const targetIds = Array.isArray(values.callNameTargetPlayerIds)
    ? values.callNameTargetPlayerIds.map((value) => String(value ?? '').trim())
    : [];
  const preferredValues = Array.isArray(values.callNamePreferredValues)
    ? values.callNamePreferredValues.map((value) => String(value ?? '').trim())
    : [];
  if (targetIds.length !== preferredValues.length) {
    errors.push('相手別呼称を読み取れませんでした。');
    return {};
  }
  if (new Set(targetIds).size !== targetIds.length) errors.push('相手別呼称の対象が重複しています。');

  const allowed = new Set(validTargetPlayerIds.map((value) => String(value ?? '')));
  const overrides = {};
  targetIds.forEach((targetId, index) => {
    if (!allowed.has(targetId)) {
      errors.push('現在のゲームに参加していない相手の呼称は変更できません。');
      return;
    }
    const preferred = preferredValues[index];
    if (!preferred) return;
    const preferredValidation = validateCallName(preferred);
    preferredValidation.errors.forEach((message) => errors.push(`相手別呼称${index + 1}: ${message}`));
    overrides[targetId] = preferred;
  });
  return overrides;
}

export function preparePlayerDetailUpdate(values = {}, { validCallNameTargetPlayerIds = [] } = {}) {
  const aliases = parseAliases(values.aliases);
  const errors = [];

  if (new Set(aliases).size !== aliases.length) errors.push('別名が重複しています。');
  if (aliases.length > CHARACTER_TEXT_LIMITS.aliasesMax) errors.push(`別名は最大${CHARACTER_TEXT_LIMITS.aliasesMax}件にしてください。`);

  const speechLength = String(values.speechLength ?? '');
  if (!isPublicSpeechLengthOption(speechLength)) {
    errors.push(`未定義の公開発言量区分です: ${speechLength}`);
  }

  const reasoningProfile = Object.fromEntries(
    REASONING_FIELDS.map((key) => [key, String(values[key] ?? '')]),
  );
  REASONING_FIELDS.forEach((key) => {
    if (!Object.hasOwn(REASONING_PROFILE_OPTION_LABELS[key] ?? {}, reasoningProfile[key])) {
      errors.push(`推理傾向${key}の値が不正です。`);
    }
  });

  const character = Object.fromEntries(
    CHARACTER_TEXT_FIELDS.map((key) => [key, String(values[key] ?? '')]),
  );
  character.speechLength = speechLength;
  character.reasoningProfile = reasoningProfile;
  character.conversationSeeds = prepareConversationSeeds(values, errors);
  const callNameOverrides = prepareCallNameOverrides(values, validCallNameTargetPlayerIds, errors);
  validateCharacterTextPayload({
    name: '',
    aliases,
    character,
    callNames: callNameOverrides,
  }, { label: 'キャラクター詳細', requireName: false }).forEach((message) => errors.push(message));

  return {
    ok: errors.length === 0,
    errors,
    patch: {
      aliases,
      character,
      callNameOverrides,
      privateInfo: String(values.privateInfo ?? ''),
    },
  };
}

export function applyPlayerDetailUpdate(state, playerId, patch) {
  const player = getPlayer(state, playerId);
  player.aliases = [...patch.aliases];
  Object.assign(player.character, patch.character);
  player.character.conversationSeeds = patch.character.conversationSeeds.map((seed) => ({ ...seed }));
  player.callNameOverrides = Object.fromEntries(
    Object.entries(patch.callNameOverrides ?? {}).map(([targetPlayerId, preferred]) => [targetPlayerId, String(preferred)]),
  );
  player.privateInfo = patch.privateInfo;
  state.game.callNameSnapshot = null;
}
