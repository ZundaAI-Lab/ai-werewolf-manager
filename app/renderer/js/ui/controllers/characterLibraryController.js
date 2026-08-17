/**
 * 責務: キャラクター管理画面の選択・グループ/キャラクター並び替え・使用状態、編集/閲覧/複製ダイアログ、表示名/設定ランダム生成、AI一括生成、JSON入出力を調停し、永続化はcharacterLibraryManagerへ委譲する。
 * 変更ルール:
 * - ゲーム状態を変更しない。組み込みJSONは編集せず、組み込み側で変更できるのは使用状態・グループ/キャラクター並び順とユーザーデータへの複製だけとする。
 * - キャラクター編集は通常フォーム値から保存データを組み立て、通常編集でJSON構文の直接入力を要求しない。表示名だけを必須とし、その他は空欄を許可して内部標準値を維持する。文字数検証はキャラクターの保存時だけ対象IDへ適用し、削除・並び替え・使用切替・複製・グループ操作では既存データを再検証しない。表示名・設定ランダム生成・AI一括生成はcharacters/generationへ委譲する。AI一括生成はAPI生成と手動コピペ生成を同じ生成契約で扱い、手動回答JSONの入力は専用生成ダイアログ内だけに限定する。
 * - カタログ内容または使用可否の変更成功後はonCatalogChangedへ通知し、チャットルーム等の外部利用側にある孤立参照の整理は依存注入先へ委譲する。
 */

import { REASONING_PROFILE_OPTION_LABELS } from '../../config/constants.js';
import { generateRandomCharacterSettings } from '../../characters/generation/randomCharacterGenerator.js';
import { generateRandomCharacterName } from '../../characters/generation/randomCharacterNameGenerator.js';
import {
  buildManualCharacterGenerationPrompt,
  generateCharacterWithAi,
  parseManualCharacterGenerationResponse,
} from '../../characters/generation/aiCharacterGenerator.js';
import { getCharacterGroups, getEnabledCharacterCards, getUserCharacterGroups } from '../../characters/catalog/characterCatalog.js';
import { CHARACTER_TEXT_LIMITS, validateCharacterTextPayload } from '../../characters/config/characterTextPolicyAdapter.js';
import {
  cloneUserGroupsForEdit,
  createUserCharacterDraft,
  createUserCharacterFromCard,
  createUserConversationSeedDraft,
  createUserGroupDraft,
  currentUserCharacterLibrary,
  importUserCharacterLibrary,
  saveUserCharacterGroups,
  setCharacterEnabled,
  setCharacterGroupEnabled,
  setCharacterGroupOrder,
  setCharacterOrder,
} from '../../characters/catalog/characterLibraryManager.js';
import { copyText, downloadJson, readFileText } from '../../shared/utils.js';
import {
  renderAiCharacterGenerationDialog,
  renderCharacterDeleteConfirmation,
  renderCharacterDuplicateTarget,
  renderCharacterEditor,
  renderCharacterGroupEditor,
  renderConversationSeedEditorRow,
  selectCharacterLibraryGroup,
} from '../views/characters/characterLibraryView.js';

function splitDelimitedList(value) {
  return [...new Set(String(value ?? '')
    .split(/[、,]+/u)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function groupById(id) {
  return getCharacterGroups().find((group) => group.id === id) ?? null;
}

function cardById(id) {
  return getCharacterGroups().flatMap((group) => group.characters).find((card) => card.id === id) ?? null;
}

function collectConversationSeeds(data) {
  const ids = data.getAll('conversationSeedId').map((value) => String(value ?? '').trim());
  const subjects = data.getAll('conversationSeedSubject').map((value) => String(value ?? '').trim());
  const tones = data.getAll('conversationSeedTone').map((value) => String(value ?? '').trim());
  if (ids.length !== subjects.length || ids.length !== tones.length) {
    throw new Error('会話のきっかけを読み取れませんでした。');
  }
  const seeds = ids.flatMap((id, index) => {
    const subject = subjects[index];
    const tone = tones[index];
    if (!subject && !tone) return [];
    if (!id) throw new Error('会話のきっかけIDが不正です。');
    if (!subject || !tone) throw new Error(`会話のきっかけ${index + 1}の話題と雰囲気を両方入力してください。`);
    return [{ id, subject, tone }];
  });
  if (new Set(seeds.map((seed) => seed.id)).size !== seeds.length) throw new Error('会話のきっかけIDが重複しています。');
  if (seeds.length > CHARACTER_TEXT_LIMITS.conversationSeedsMax) throw new Error(`会話のきっかけは最大${CHARACTER_TEXT_LIMITS.conversationSeedsMax}件にしてください。`);
  return seeds;
}

function collectCallNames(data) {
  const targetIds = data.getAll('callNameTargetId').map((value) => String(value ?? '').trim());
  const preferredValues = data.getAll('callNamePreferred').map((value) => String(value ?? '').trim());
  if (targetIds.length !== preferredValues.length) {
    throw new Error('相手別呼称を読み取れませんでした。');
  }
  return Object.fromEntries(targetIds.flatMap((targetId, index) => {
    if (!targetId) return [];
    const preferred = preferredValues[index];
    if (!preferred) return [];
    return [[targetId, { preferred }]];
  }));
}

function pruneCallNameTargets(groups, targetIds) {
  const removed = new Set(targetIds);
  groups.forEach((group) => {
    group.characters.forEach((card) => {
      if (!card.callNames || typeof card.callNames !== 'object') return;
      Object.keys(card.callNames).forEach((targetId) => {
        if (removed.has(targetId)) delete card.callNames[targetId];
      });
    });
  });
}

function cleanValidationMessage(message) {
  let text = String(message ?? 'エラーが発生しました。').trim();
  text = text.replace(/^Error invoking remote method '[^']+':\s*/u, '');
  while (/^(?:RangeError|TypeError|Error):\s*/u.test(text)) {
    text = text.replace(/^(?:RangeError|TypeError|Error):\s*/u, '');
  }
  text = text.replace(/^ユーザーグループ\d+のキャラクター\d+の/u, '');
  text = text.replace(/^キャラクターの/u, '');
  return text || 'エラーが発生しました。';
}

function characterErrorControl(form, message) {
  const text = cleanValidationMessage(message);
  const seed = text.match(/^会話のきっかけ(\d+)の(話題|雰囲気)/u);
  if (seed) {
    const row = form.querySelectorAll('[data-conversation-seed-row]')[Number(seed[1]) - 1];
    return row?.querySelector(seed[2] === '話題' ? '[name="conversationSeedSubject"]' : '[name="conversationSeedTone"]') ?? null;
  }
  const callName = text.match(/^相手別呼称(\d+)/u);
  if (callName) {
    return form.querySelectorAll('input[name="callNamePreferred"]')[Number(callName[1]) - 1] ?? null;
  }
  const fieldMap = [
    ['表示名', 'name'],
    ['別名', 'aliases'],
    ['性格・人物設定', 'profile'],
    ['一人称', 'firstPerson'],
    ['汎用二人称', 'genericSecondPerson'],
    ['話し方の特徴', 'speakingStyle'],
    ['基本語尾', 'defaultEndings'],
    ['避ける表現', 'avoidedExpressions'],
    ['口調例', 'speechExamples'],
    ['議論での振る舞い補足', 'discussionBehavior'],
  ];
  const matched = fieldMap.find(([prefix]) => text.startsWith(prefix));
  return matched ? form.elements.namedItem(matched[1]) : null;
}

function focusCharacterError(form, message) {
  const control = characterErrorControl(form, message);
  if (!control || typeof control.focus !== 'function') return;
  control.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  control.focus({ preventScroll: true });
  if (typeof control.select === 'function' && !['SELECT', 'BUTTON'].includes(control.tagName)) control.select();
}

export function createCharacterLibraryController({ render, modal, aiGenerationDialog, toast, getAiProfiles, onCatalogChanged }) {
  if (typeof render !== 'function' || !modal || !aiGenerationDialog || typeof toast !== 'function' || typeof getAiProfiles !== 'function' || typeof onCatalogChanged !== 'function') throw new TypeError('キャラクター管理Controllerの依存が不足しています。');
  let activeAiGeneration = null;

  function closeModal() {
    if (modal.open) modal.close();
  }

  function openModal(html) {
    modal.innerHTML = html;
    if (!modal.open) modal.showModal();
  }

  function clearModalError() {
    const box = modal.querySelector('[data-character-library-modal-error]');
    if (!box) return;
    box.textContent = '';
    box.hidden = true;
  }

  function showError(message) {
    const cleaned = cleanValidationMessage(message);
    const box = modal.open ? modal.querySelector('[data-character-library-modal-error]') : null;
    if (!box) return toast(cleaned, 'error');
    box.textContent = cleaned;
    box.hidden = false;
    const form = modal.querySelector('[data-character-library-form="character"]');
    if (form) focusCharacterError(form, cleaned);
    else box.scrollIntoView?.({ block: 'nearest' });
  }

  async function notifyCatalogChanged() {
    try {
      await onCatalogChanged();
    } catch (error) {
      toast(`キャラクター変更後のチャットルーム同期に失敗しました: ${error.message}`, 'error', { key: 'character-catalog-chat-sync' });
    }
  }

  async function runMutation(task, successMessage) {
    clearModalError();
    try {
      await task();
      await notifyCatalogChanged();
      closeModal();
      render();
      toast(successMessage, 'success');
      return true;
    } catch (error) {
      showError(error.message);
      return false;
    }
  }

  function openGroupEditor(groupId = '') {
    const group = groupId ? groupById(groupId) : null;
    if (groupId && group?.origin !== 'user') return toast('組み込みグループは編集できません。', 'error');
    openModal(renderCharacterGroupEditor(group));
  }

  function availableAiProfiles() {
    return (getAiProfiles() ?? []).filter((profile) => profile?.enabled === true && profile?.provider !== 'demo' && profile?.id);
  }

  function openCharacterEditor(groupId, characterId = '') {
    const group = groupById(groupId);
    if (!group) return toast('キャラクターグループが見つかりません。', 'error');
    let card = group.characters.find((item) => item.id === characterId);
    if (!card) {
      if (group.origin !== 'user') return toast('組み込みキャラクターが見つかりません。', 'error');
      card = { ...createUserCharacterDraft(), __new: true };
    }
    openModal(renderCharacterEditor({ group, card, readonly: group.origin === 'builtin' }));
  }

  function closeAiGenerationDialog() {
    activeAiGeneration = null;
    if (aiGenerationDialog.open) aiGenerationDialog.close();
    aiGenerationDialog.innerHTML = '';
  }

  function showAiGenerationError(message) {
    const box = aiGenerationDialog.querySelector('[data-character-ai-generation-error]');
    if (!box) return toast(String(message ?? 'AI生成に失敗しました。'), 'error');
    box.textContent = String(message ?? 'AI生成に失敗しました。');
    box.hidden = false;
    box.scrollIntoView?.({ block: 'nearest' });
  }

  function aiGenerationTargets(form) {
    const currentId = String(form.querySelector('[data-character-library-action="save-character"]')?.dataset.characterId ?? '');
    return getEnabledCharacterCards()
      .filter((card) => card.id !== currentId)
      .map((card) => ({ id: card.id, name: card.name }));
  }

  function aiGenerationMode(requestForm) {
    return String(requestForm?.querySelector('input[name="generationMode"]:checked')?.value ?? 'manual');
  }

  function updateManualCharacterPrompt() {
    const requestForm = aiGenerationDialog.querySelector('[data-character-ai-generation-form]');
    const characterForm = modal.querySelector('[data-character-library-form="character"]');
    const promptBox = requestForm?.querySelector('[data-character-ai-manual-prompt]');
    if (!requestForm || !characterForm || !promptBox) return '';
    const data = new FormData(requestForm);
    const prompt = buildManualCharacterGenerationPrompt({
      instruction: String(data.get('instruction') ?? ''),
      targets: aiGenerationTargets(characterForm),
    });
    promptBox.value = prompt;
    return prompt;
  }

  function syncAiGenerationMode() {
    const requestForm = aiGenerationDialog.querySelector('[data-character-ai-generation-form]');
    if (!requestForm) return;
    activeAiGeneration = null;
    const manual = aiGenerationMode(requestForm) === 'manual';
    const apiPanel = requestForm.querySelector('[data-character-ai-api-panel]');
    const manualPanel = requestForm.querySelector('[data-character-ai-manual-panel]');
    const apiSubmit = requestForm.querySelector('[data-character-ai-generate-submit]');
    const manualApply = requestForm.querySelector('[data-character-ai-manual-apply]');
    const profileSelect = requestForm.elements.namedItem('profileId');
    if (apiPanel) apiPanel.hidden = manual;
    if (manualPanel) manualPanel.hidden = !manual;
    if (apiSubmit) apiSubmit.hidden = manual;
    if (manualApply) manualApply.hidden = !manual;
    if (profileSelect) profileSelect.required = !manual;
    if (manual) updateManualCharacterPrompt();
  }

  function openAiCharacterGeneration() {
    const form = modal.querySelector('[data-character-library-form="character"]');
    if (!form) return showError('キャラクター設定欄が見つかりません。');
    aiGenerationDialog.innerHTML = renderAiCharacterGenerationDialog({ profiles: availableAiProfiles() });
    if (!aiGenerationDialog.open) aiGenerationDialog.showModal();
    syncAiGenerationMode();
    aiGenerationDialog.querySelector('textarea[name="instruction"]')?.focus();
  }

  async function copyManualCharacterPrompt() {
    try {
      const prompt = updateManualCharacterPrompt();
      if (!prompt) throw new Error('手動生成プロンプトを作成できませんでした。');
      await copyText(prompt);
      toast('キャラクター生成プロンプトをコピーしました。', 'success');
    } catch (error) {
      showAiGenerationError(error.message);
    }
  }

  function applyAiGeneratedCharacter(form, generated) {
    const setValue = (name, value) => {
      const control = form.elements.namedItem(name);
      if (control && 'value' in control) control.value = value;
    };
    setValue('name', generated.name);
    setValue('aliases', generated.aliases.join('、'));
    setValue('profile', generated.profile);
    setValue('firstPerson', generated.firstPerson);
    setValue('genericSecondPerson', generated.genericSecondPerson);
    setValue('speakingStyle', generated.speakingStyle);
    setValue('defaultEndings', generated.defaultEndings);
    setValue('avoidedExpressions', generated.avoidedExpressions);
    setValue('speechLength', generated.speechLength);
    setValue('speechExamples', generated.speechExamples);
    setValue('discussionBehavior', generated.discussionBehavior);
    Object.entries(generated.reasoningProfile).forEach(([key, value]) => setValue(key, value));

    const seedList = form.querySelector('[data-conversation-seed-list]');
    if (seedList) {
      seedList.innerHTML = generated.conversationSeeds
        .map(({ subject, tone }) => renderConversationSeedEditorRow({ id: crypto.randomUUID(), subject, tone }))
        .join('');
    }

    const callNames = new Map(generated.callNames.map((entry) => [entry.targetId, entry]));
    form.querySelectorAll('.character-call-name-row').forEach((row) => {
      const targetId = String(row.querySelector('input[name="callNameTargetId"]')?.value ?? '');
      const entry = callNames.get(targetId);
      const preferred = row.querySelector('input[name="callNamePreferred"]');
      if (preferred) preferred.value = entry?.preferred ?? '';
    });
  }

  function applyManualCharacterResponse() {
    const requestForm = aiGenerationDialog.querySelector('[data-character-ai-generation-form]');
    const characterForm = modal.querySelector('[data-character-library-form="character"]');
    if (!requestForm || !characterForm) return showAiGenerationError('キャラクター生成画面を読み取れませんでした。');
    try {
      const data = new FormData(requestForm);
      const generated = parseManualCharacterGenerationResponse({
        response: String(data.get('manualResponse') ?? ''),
        targets: aiGenerationTargets(characterForm),
      });
      applyAiGeneratedCharacter(characterForm, generated);
      closeAiGenerationDialog();
      characterForm.elements.namedItem('name')?.focus?.();
      toast('手動AI生成の回答をキャラクター設定へ反映しました。保存前に内容を確認してください。', 'success');
    } catch (error) {
      showAiGenerationError(error.message);
    }
  }

  async function generateCharacterFromAi() {
    const requestForm = aiGenerationDialog.querySelector('[data-character-ai-generation-form]');
    const characterForm = modal.querySelector('[data-character-library-form="character"]');
    if (!requestForm?.reportValidity() || !characterForm) return;
    const data = new FormData(requestForm);
    const profileId = String(data.get('profileId') ?? '');
    if (!availableAiProfiles().some((profile) => profile.id === profileId)) return showAiGenerationError('選択したAIプロファイルを利用できません。');
    const submit = requestForm.querySelector('[data-character-ai-generate-submit]');
    const token = Symbol('character-ai-generation');
    activeAiGeneration = token;
    if (submit) {
      submit.disabled = true;
      submit.textContent = '生成中…';
    }
    const errorBox = requestForm.querySelector('[data-character-ai-generation-error]');
    if (errorBox) {
      errorBox.textContent = '';
      errorBox.hidden = true;
    }
    try {
      const generated = await generateCharacterWithAi({
        profileId,
        instruction: String(data.get('instruction') ?? ''),
        targets: aiGenerationTargets(characterForm),
      });
      if (activeAiGeneration !== token || !aiGenerationDialog.open) return;
      applyAiGeneratedCharacter(characterForm, generated);
      closeAiGenerationDialog();
      characterForm.elements.namedItem('name')?.focus?.();
      toast('AI生成したキャラクター設定を反映しました。保存前に内容を確認してください。', 'success');
    } catch (error) {
      if (activeAiGeneration === token) showAiGenerationError(error.message);
    } finally {
      if (activeAiGeneration === token) activeAiGeneration = null;
      if (submit?.isConnected) {
        submit.disabled = false;
        submit.textContent = 'AI生成';
      }
    }
  }

  function openDuplicateCharacter(characterId) {
    const card = cardById(characterId);
    const groups = getUserCharacterGroups();
    if (!card || !groups.length) return toast('複製先のユーザーグループがありません。', 'error');
    openModal(renderCharacterDuplicateTarget({ card, groups }));
  }

  async function saveGroup(button) {
    const form = modal.querySelector('[data-character-library-form="group"]');
    if (!form?.reportValidity()) return;
    const name = String(new FormData(form).get('name') ?? '').trim();
    if (!name) return showError('グループ名を入力してください。');
    const groups = cloneUserGroupsForEdit();
    const id = String(button.dataset.groupId ?? '');
    if (id) {
      const target = groups.find((group) => group.id === id);
      if (!target) return showError('編集対象のグループが見つかりません。');
      target.name = name;
    } else {
      const draft = createUserGroupDraft(name);
      groups.push(draft);
      selectCharacterLibraryGroup(draft.id);
    }
    await runMutation(() => saveUserCharacterGroups(groups), id ? 'グループ名を変更しました。' : 'グループを作成しました。');
  }

  async function saveCharacter(button) {
    const form = modal.querySelector('[data-character-library-form="character"]');
    if (!form?.reportValidity()) return;
    clearModalError();
    try {
      const data = new FormData(form);
      const groups = cloneUserGroupsForEdit();
      const group = groups.find((item) => item.id === button.dataset.groupId);
      if (!group) return showError('保存先のユーザーグループが見つかりません。');
      const isNew = button.dataset.isNew === 'true';
      const existing = isNew ? createUserCharacterDraft() : group.characters.find((item) => item.id === button.dataset.characterId);
      if (!existing) return showError('編集対象のキャラクターが見つかりません。');
      if (isNew) existing.id = String(button.dataset.characterId || existing.id);
      const reasoningProfile = Object.fromEntries(Object.keys(REASONING_PROFILE_OPTION_LABELS).map((key) => [key, String(data.get(key) ?? '')]));
      const next = {
        schemaVersion: 1,
        id: existing.id,
        name: String(data.get('name') ?? '').trim(),
        aliases: splitDelimitedList(data.get('aliases')),
        enabled: existing.enabled !== false,
        character: {
          profile: String(data.get('profile') ?? ''),
          firstPerson: String(data.get('firstPerson') ?? ''),
          genericSecondPerson: String(data.get('genericSecondPerson') ?? ''),
          speakingStyle: String(data.get('speakingStyle') ?? ''),
          defaultEndings: String(data.get('defaultEndings') ?? ''),
          avoidedExpressions: String(data.get('avoidedExpressions') ?? ''),
          speechLength: String(data.get('speechLength') ?? ''),
          speechExamples: String(data.get('speechExamples') ?? ''),
          discussionBehavior: String(data.get('discussionBehavior') ?? ''),
          reasoningProfile,
          conversationSeeds: collectConversationSeeds(data),
        },
        callNames: collectCallNames(data),
      };
      const validationErrors = validateCharacterTextPayload(next, { label: '', requireName: true });
      if (validationErrors.length) {
        showError(validationErrors[0]);
        return;
      }
      if (isNew) group.characters.push(next);
      else group.characters.splice(group.characters.findIndex((item) => item.id === existing.id), 1, next);
      await runMutation(() => saveUserCharacterGroups(groups, { validateCharacterIds: [next.id] }), isNew ? 'キャラクターを追加しました。' : 'キャラクターを更新しました。');
    } catch (error) {
      showError(error.message);
    }
  }

  async function duplicateCharacter(button) {
    const form = modal.querySelector('[data-character-library-form="duplicate"]');
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
    const targetGroupId = String(data.get('targetGroupId') ?? '');
    const source = cardById(String(button.dataset.characterId ?? ''));
    const groups = cloneUserGroupsForEdit();
    const targetGroup = groups.find((group) => group.id === targetGroupId);
    if (!source || !targetGroup) return showError('複製元または複製先が見つかりません。');
    const copy = createUserCharacterFromCard(source);
    const usedNames = new Set(getCharacterGroups().flatMap((group) => group.characters).map((card) => card.name));
    let suffix = 1;
    let candidate = `${source.name}（複製）`;
    while (usedNames.has(candidate)) {
      suffix += 1;
      candidate = `${source.name}（複製${suffix}）`;
    }
    copy.name = candidate;
    targetGroup.characters.push(copy);
    selectCharacterLibraryGroup(targetGroup.id);
    await runMutation(() => saveUserCharacterGroups(groups), 'キャラクターをユーザーグループへ複製しました。');
  }

  async function confirmDeleteGroup(groupId) {
    const groups = cloneUserGroupsForEdit();
    const target = groups.find((group) => group.id === groupId);
    const removedCharacterIds = target?.characters.map((card) => card.id) ?? [];
    const remaining = groups.filter((group) => group.id !== groupId);
    pruneCallNameTargets(remaining, removedCharacterIds);
    const fallback = getCharacterGroups().find((group) => group.id !== groupId);
    selectCharacterLibraryGroup(fallback?.id ?? '');
    await runMutation(() => saveUserCharacterGroups(remaining), 'ユーザーグループを削除しました。');
  }

  async function confirmDeleteCharacter(groupId, characterId) {
    const groups = cloneUserGroupsForEdit();
    const group = groups.find((item) => item.id === groupId);
    if (!group) return showError('ユーザーグループが見つかりません。');
    group.characters = group.characters.filter((card) => card.id !== characterId);
    pruneCallNameTargets(groups, [characterId]);
    await runMutation(() => saveUserCharacterGroups(groups), 'キャラクターを削除しました。');
  }

  function addConversationSeed(button) {
    const list = button.closest('fieldset')?.querySelector('[data-conversation-seed-list]');
    if (!list) return showError('会話のきっかけ編集欄が見つかりません。');
    if (list.querySelectorAll('[data-conversation-seed-row]').length >= CHARACTER_TEXT_LIMITS.conversationSeedsMax) {
      return showError(`会話のきっかけは最大${CHARACTER_TEXT_LIMITS.conversationSeedsMax}件です。`);
    }
    list.insertAdjacentHTML('beforeend', renderConversationSeedEditorRow(createUserConversationSeedDraft()));
    list.lastElementChild?.querySelector('input[name="conversationSeedSubject"]')?.focus();
    if (list.querySelectorAll('[data-conversation-seed-row]').length >= CHARACTER_TEXT_LIMITS.conversationSeedsMax) button.disabled = true;
  }

  function removeConversationSeed(button) {
    const fieldset = button.closest('fieldset');
    button.closest('[data-conversation-seed-row]')?.remove();
    const addButton = fieldset?.querySelector('[data-character-library-action="add-conversation-seed"]');
    if (addButton) addButton.disabled = false;
  }

  function randomizeCharacterName() {
    const form = modal.querySelector('[data-character-library-form="character"]');
    if (!form) return showError('キャラクター設定欄が見つかりません。');
    clearModalError();
    const control = form.elements.namedItem('name');
    if (!control || !('value' in control)) return showError('表示名入力欄が見つかりません。');
    control.value = generateRandomCharacterName();
    control.focus();
  }

  function randomizeCharacterSettings() {
    const form = modal.querySelector('[data-character-library-form="character"]');
    if (!form) return showError('キャラクター設定欄が見つかりません。');
    clearModalError();
    const generated = generateRandomCharacterSettings();
    const setValue = (name, value) => {
      const control = form.elements.namedItem(name);
      if (control && 'value' in control) control.value = value;
    };
    setValue('profile', generated.profile);
    setValue('firstPerson', generated.firstPerson);
    setValue('genericSecondPerson', generated.genericSecondPerson);
    setValue('speakingStyle', generated.speakingStyle);
    setValue('defaultEndings', generated.defaultEndings);
    setValue('avoidedExpressions', generated.avoidedExpressions);
    setValue('speechLength', generated.speechLength);
    setValue('speechExamples', generated.speechExamples);
    setValue('discussionBehavior', generated.discussionBehavior);
    Object.keys(REASONING_PROFILE_OPTION_LABELS).forEach((key) => setValue(key, generated.reasoningProfile[key]));
    const list = form.querySelector('[data-conversation-seed-list]');
    if (list) {
      list.innerHTML = generated.conversationSeeds
        .map(({ subject, tone }) => renderConversationSeedEditorRow({ id: crypto.randomUUID(), subject, tone }))
        .join('');
    }
  }

  async function toggleGroup(input) {
    const groupId = String(input.dataset.groupId ?? '');
    const group = groupById(groupId);
    if (!group) {
      input.checked = !input.checked;
      return toast('対象グループが見つかりません。', 'error');
    }
    const enabled = input.checked;
    try {
      await setCharacterGroupEnabled(groupId, enabled);
      await notifyCatalogChanged();
      render();
      toast(enabled ? 'グループと所属キャラクターを使用する設定にしました。' : 'グループと所属キャラクターを使用しない設定にしました。', 'success');
    } catch (error) {
      input.checked = !enabled;
      toast(error.message, 'error');
    }
  }

  async function toggleCharacter(input) {
    const groupId = String(input.dataset.groupId ?? '');
    const characterId = String(input.dataset.characterId ?? '');
    const enabled = input.checked;
    try {
      await setCharacterEnabled(groupId, characterId, enabled);
      await notifyCatalogChanged();
      render();
      toast(enabled ? 'キャラクターを使用する設定にしました。' : 'キャラクターを使用しない設定にしました。', 'success');
    } catch (error) {
      input.checked = !enabled;
      toast(error.message, 'error');
    }
  }

  async function moveGroup(groupId, delta) {
    const ids = getCharacterGroups().map((group) => group.id);
    const index = ids.indexOf(groupId);
    const nextIndex = index + delta;
    if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
    [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
    try {
      await setCharacterGroupOrder(ids);
      selectCharacterLibraryGroup(groupId);
      render();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function moveCharacter(groupId, characterId, delta) {
    const group = groupById(groupId);
    if (!group) return toast('対象グループが見つかりません。', 'error');
    const ids = group.characters.map((card) => card.id);
    const index = ids.indexOf(characterId);
    const nextIndex = index + delta;
    if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
    [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
    try {
      await setCharacterOrder(groupId, ids);
      selectCharacterLibraryGroup(groupId);
      render();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function handleImportFile(file) {
    if (!file) return;
    try {
      const raw = JSON.parse(await readFileText(file));
      const count = await importUserCharacterLibrary(raw);
      await notifyCatalogChanged();
      render();
      toast(`${count}グループのユーザーデータを読み込みました。`, 'success');
    } catch (error) {
      toast(`キャラクター読込失敗: ${error.message}`, 'error');
    }
  }

  async function handleAction(button) {
    const action = button.dataset.characterLibraryAction;
    const groupId = String(button.dataset.groupId ?? '');
    const characterId = String(button.dataset.characterId ?? '');
    if (action === 'select-group') {
      selectCharacterLibraryGroup(groupId);
      return render();
    }
    if (action === 'create-group') return openGroupEditor();
    if (action === 'edit-group') return openGroupEditor(groupId);
    if (action === 'add-character') return openCharacterEditor(groupId);
    if (action === 'edit-character') return openCharacterEditor(groupId, characterId);
    if (action === 'duplicate-character') return openDuplicateCharacter(characterId);
    if (action === 'confirm-duplicate-character') return duplicateCharacter(button);
    if (action === 'save-group') return saveGroup(button);
    if (action === 'save-character') return saveCharacter(button);
    if (action === 'randomize-character-name') return randomizeCharacterName();
    if (action === 'randomize-character-settings') return randomizeCharacterSettings();
    if (action === 'open-ai-character-generation') return openAiCharacterGeneration();
    if (action === 'add-conversation-seed') return addConversationSeed(button);
    if (action === 'remove-conversation-seed') return removeConversationSeed(button);
    if (action === 'move-group-up') return moveGroup(groupId, -1);
    if (action === 'move-group-down') return moveGroup(groupId, 1);
    if (action === 'move-character-up') return moveCharacter(groupId, characterId, -1);
    if (action === 'move-character-down') return moveCharacter(groupId, characterId, 1);
    if (action === 'delete-group') {
      const group = getUserCharacterGroups().find((item) => item.id === groupId);
      if (!group) return toast('ユーザーグループが見つかりません。', 'error');
      return openModal(renderCharacterDeleteConfirmation({ title: 'グループを削除', message: `「${group.name}」と所属キャラクター${group.characters.length}件を削除します。`, action: 'confirm-delete-group', groupId }));
    }
    if (action === 'delete-character') {
      const group = getUserCharacterGroups().find((item) => item.id === groupId);
      const card = group?.characters.find((item) => item.id === characterId);
      if (!group || !card) return toast('ユーザーキャラクターが見つかりません。', 'error');
      return openModal(renderCharacterDeleteConfirmation({ title: 'キャラクターを削除', message: `「${card.name}」を削除します。`, action: 'confirm-delete-character', groupId, characterId }));
    }
    if (action === 'confirm-delete-group') return confirmDeleteGroup(groupId);
    if (action === 'confirm-delete-character') return confirmDeleteCharacter(groupId, characterId);
    if (action === 'export') {
      const library = currentUserCharacterLibrary();
      downloadJson('ai-werewolf-user-characters.json', library);
      return toast('ユーザーキャラクターデータを出力しました。', 'success');
    }
    if (action === 'import') return document.querySelector('#character-library-import-file')?.click();
    return undefined;
  }

  function bind() {
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-character-ai-close]')) {
        event.preventDefault();
        return closeAiGenerationDialog();
      }
      if (event.target.closest('[data-character-ai-copy-manual-prompt]:not(:disabled)')) {
        event.preventDefault();
        return void Promise.resolve(copyManualCharacterPrompt()).catch((error) => showAiGenerationError(error.message));
      }
      if (event.target.closest('[data-character-ai-manual-apply]:not(:disabled)')) {
        event.preventDefault();
        return applyManualCharacterResponse();
      }
      if (event.target.closest('[data-character-ai-generate-submit]:not(:disabled)')) {
        event.preventDefault();
        return void Promise.resolve(generateCharacterFromAi()).catch((error) => showAiGenerationError(error.message));
      }
      if (event.target.closest('[data-modal-close]')) closeModal();
      const button = event.target.closest('[data-character-library-action]:not(:disabled)');
      if (!button) return;
      event.preventDefault();
      Promise.resolve(handleAction(button)).catch((error) => showError(error.message));
    });
    document.addEventListener('change', (event) => {
      if (event.target.closest('[data-character-ai-generation-form] input[name="generationMode"]')) {
        syncAiGenerationMode();
        return;
      }
      const groupInput = event.target.closest('[data-character-library-toggle]');
      if (groupInput) return void Promise.resolve(toggleGroup(groupInput)).catch((error) => toast(error.message, 'error'));
      const characterInput = event.target.closest('[data-character-library-character-toggle]');
      if (characterInput) return void Promise.resolve(toggleCharacter(characterInput)).catch((error) => toast(error.message, 'error'));
    });
    document.addEventListener('input', (event) => {
      if (!event.target.closest('[data-character-ai-generation-form] textarea[name="instruction"]')) return;
      const requestForm = aiGenerationDialog.querySelector('[data-character-ai-generation-form]');
      if (aiGenerationMode(requestForm) !== 'manual') return;
      try {
        updateManualCharacterPrompt();
      } catch (error) {
        showAiGenerationError(error.message);
      }
    });
    aiGenerationDialog.addEventListener('close', () => {
      activeAiGeneration = null;
      aiGenerationDialog.innerHTML = '';
    });
    const input = document.querySelector('#character-library-import-file');
    input?.addEventListener('change', () => {
      const [file] = input.files ?? [];
      input.value = '';
      handleImportFile(file);
    });
  }

  return Object.freeze({ bind, handleImportFile });
}
