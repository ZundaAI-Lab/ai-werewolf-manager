/**
 * 責務: Electron Main・Rendererで共有するキャラクター自由記述の文字数・件数上限と、識別文字列の機械解析向け禁則を一元提供する。
 * 変更ルール: UI、保存、AI通信、ゲーム状態を直接変更しない。文字数・件数上限や表示名・別名・相手別呼称の禁則を変更する場合は本モジュールだけを正本とし、Main境界・Renderer入力・AI生成指示・生成後検証から同じ規則を参照する。複数項目を合算した総文字数上限は設けない。Provider共通Schemaには未対応キーワードを追加しない。
 */

(function initializeCharacterTextPolicy(root, factory) {
  'use strict';

  const api = factory();
  const commonJs = typeof module === 'object' && module.exports;
  if (commonJs) module.exports = api;
  else if (root) {
    root.AiWerewolfCharacterTextPolicy = api;
    if (root.window && root.window !== root) root.window.AiWerewolfCharacterTextPolicy = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const CHARACTER_TEXT_LIMITS = Object.freeze({
    name: 30,
    alias: 30,
    aliasesMax: 5,
    profile: 160,
    firstPerson: 12,
    genericSecondPerson: 24,
    speakingStyle: 100,
    defaultEndings: 30,
    avoidedExpressions: 30,
    speechExamples: 120,
    discussionBehavior: 100,
    conversationSeedSubject: 40,
    conversationSeedTone: 20,
    conversationSeedsMax: 8,
    callNamePreferred: 30,
    aiInstruction: 500,
  });

  const CHARACTER_TEXT_TARGETS = Object.freeze({
    profile: Object.freeze({ min: 60, max: 120 }),
    speakingStyle: Object.freeze({ min: 30, max: 70 }),
    discussionBehavior: Object.freeze({ min: 30, max: 70 }),
  });

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

  const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
  const MACHINE_SEPARATOR_PATTERN = /[\r\n、,：:]/u;
  const RESERVED_MACHINE_VALUES = new Set([
    'none',
    'なし',
    '未定',
    '棄権',
    'abstain',
  ]);

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function textLength(value) {
    return String(value ?? '').length;
  }

  function delimitedInputMaxLength(itemLimit, itemCount) {
    const count = Math.max(0, Number(itemCount) || 0);
    if (!count) return 0;
    return (Number(itemLimit) || 0) * count + Math.max(0, count - 1);
  }

  function validateTextLength(value, maxLength, label, { allowEmpty = true } = {}) {
    const text = String(value ?? '');
    const errors = [];
    if (!allowEmpty && !text.trim()) errors.push(`${label}を入力してください。`);
    if (textLength(text) > maxLength) errors.push(`${label}は${maxLength}文字以内にしてください。`);
    return errors;
  }

  function validateIdentityText(value, {
    label,
    maxLength,
    forbidMachineSeparators = true,
    allowEmpty = false,
  } = {}) {
    const text = String(value ?? '').trim();
    const errors = validateTextLength(text, maxLength, label, { allowEmpty });
    if (CONTROL_CHARACTER_PATTERN.test(text)) errors.push(`${label}に制御文字は使用できません。`);
    if (forbidMachineSeparators && MACHINE_SEPARATOR_PATTERN.test(text)) {
      errors.push(`${label}に改行、読点、カンマ、コロンは使用できません。`);
    }
    if (text && RESERVED_MACHINE_VALUES.has(text.toLowerCase())) {
      errors.push(`${label}に機械解析用の予約語は使用できません。`);
    }
    return errors;
  }

  function labelField(label, field) {
    const prefix = String(label ?? '').trim();
    return prefix ? `${prefix}の${field}` : field;
  }

  function validateCharacterDisplayName(value, { label = '表示名', allowEmpty = false } = {}) {
    return validateIdentityText(value, {
      label,
      maxLength: CHARACTER_TEXT_LIMITS.name,
      forbidMachineSeparators: true,
      allowEmpty,
    });
  }

  function validateCharacterAlias(value, { label = '別名', allowEmpty = false } = {}) {
    return validateIdentityText(value, {
      label,
      maxLength: CHARACTER_TEXT_LIMITS.alias,
      forbidMachineSeparators: true,
      allowEmpty,
    });
  }

  function validateCharacterCallName(value, { label = '呼称', allowEmpty = false } = {}) {
    return validateIdentityText(value, {
      label,
      maxLength: CHARACTER_TEXT_LIMITS.callNamePreferred,
      forbidMachineSeparators: true,
      allowEmpty,
    });
  }

  function validateCharacterTextPayload(payload, { label = 'キャラクター', requireName = true } = {}) {
    const source = isObject(payload) ? payload : {};
    const character = source.character === undefined ? {} : source.character;
    const errors = [];

    errors.push(...validateCharacterDisplayName(source.name, {
      label: labelField(label, '表示名'),
      allowEmpty: !requireName,
    }));

    if (source.aliases !== undefined && !Array.isArray(source.aliases)) {
      errors.push(`${labelField(label, '別名')}が配列ではありません。`);
    } else {
      const aliases = Array.isArray(source.aliases) ? source.aliases : [];
      if (aliases.length > CHARACTER_TEXT_LIMITS.aliasesMax) {
        errors.push(`${labelField(label, '別名')}は最大${CHARACTER_TEXT_LIMITS.aliasesMax}件にしてください。`);
      }
      aliases.forEach((value, index) => {
        errors.push(...validateCharacterAlias(value, { label: labelField(label, `別名${index + 1}`) }));
      });
    }

    if (!isObject(character)) {
      errors.push(`${labelField(label, 'character')}が不正です。`);
    } else {
      const fieldLabels = {
        profile: '性格・人物設定',
        firstPerson: '一人称',
        genericSecondPerson: '汎用二人称',
        speakingStyle: '話し方の特徴',
        defaultEndings: '基本語尾',
        avoidedExpressions: '避ける表現',
        speechExamples: '口調例',
        discussionBehavior: '議論での振る舞い補足',
      };
      CHARACTER_TEXT_FIELDS.forEach((key) => {
        if (character[key] !== undefined && typeof character[key] !== 'string') {
          errors.push(`${labelField(label, fieldLabels[key])}が文字列ではありません。`);
          return;
        }
        errors.push(...validateTextLength(character[key], CHARACTER_TEXT_LIMITS[key], labelField(label, fieldLabels[key])));
      });

      if (character.conversationSeeds !== undefined && !Array.isArray(character.conversationSeeds)) {
        errors.push(`${labelField(label, '会話のきっかけ')}が配列ではありません。`);
      } else {
        const seeds = Array.isArray(character.conversationSeeds) ? character.conversationSeeds : [];
        if (seeds.length > CHARACTER_TEXT_LIMITS.conversationSeedsMax) {
          errors.push(`${labelField(label, '会話のきっかけ')}は最大${CHARACTER_TEXT_LIMITS.conversationSeedsMax}件にしてください。`);
        }
        seeds.forEach((seed, index) => {
          errors.push(...validateTextLength(seed?.subject, CHARACTER_TEXT_LIMITS.conversationSeedSubject, labelField(label, `会話のきっかけ${index + 1}の話題`)));
          errors.push(...validateTextLength(seed?.tone, CHARACTER_TEXT_LIMITS.conversationSeedTone, labelField(label, `会話のきっかけ${index + 1}の雰囲気`)));
        });
      }
    }

    if (source.callNames !== undefined && !isObject(source.callNames) && !Array.isArray(source.callNames)) {
      errors.push(`${labelField(label, '相手別呼称')}が不正です。`);
    } else {
      const entries = Array.isArray(source.callNames)
        ? source.callNames
        : (isObject(source.callNames) ? Object.values(source.callNames) : []);
      entries.forEach((entry, index) => {
        const preferred = String(entry?.preferred ?? '').trim();
        if (!preferred) return;
        errors.push(...validateCharacterCallName(preferred, { label: labelField(label, `相手別呼称${index + 1}`) }));
      });
    }

    return errors;
  }

  function requireCharacterTextPayload(payload, options) {
    const errors = validateCharacterTextPayload(payload, options);
    if (errors.length) throw new RangeError(errors[0]);
    return payload;
  }

  return Object.freeze({
    CHARACTER_TEXT_LIMITS,
    CHARACTER_TEXT_TARGETS,
    CHARACTER_TEXT_FIELDS,
    textLength,
    delimitedInputMaxLength,
    validateTextLength,
    validateIdentityText,
    validateCharacterDisplayName,
    validateCharacterAlias,
    validateCharacterCallName,
    validateCharacterTextPayload,
    requireCharacterTextPayload,
  });
});
