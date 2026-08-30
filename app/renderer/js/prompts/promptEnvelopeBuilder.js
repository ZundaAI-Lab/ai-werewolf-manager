/**
 * 責務: 共通ゲーム規則、タスク不変指示、本人固定情報、タスク可変指示、現在タスクを順序固定したProvider非依存プロンプトEnvelopeへ構成する。
 * 変更ルール: API固有のキャッシュ指定を生成しない。順序はcommonGameContext→taskInvariantContext→stablePlayerContext→taskVariableContext→dynamicTaskPromptで固定し、キャッシュ対象は最初の3区画だけとする。可変情報をキャッシュ効率のために不変区画へ移さず、dynamicTaskPrompt末尾の「最終確認」以下は位置・内容とも変更しない。stablePlayerContextの本人プロフィール・相手別呼称はpromptSectionPolicy.jsで解決済みの表示可否だけに従い、構造化行動タスクへ呼称を再掲せず、memo-consolidateへ人物プロフィールを再掲しない。継続アンカー・当日カプセル・AIターン履歴をEnvelopeへ含めず、正式な現在状態はdynamicTaskPromptを正本とする。構造化出力Schemaはゲーム契約側で生成済みの値だけを保持し、Provider形式へ変換しない。全文章区画は可視性検証可能な文字列として返す。
 */
import { PROMPT_SPEC_VERSION, ROLE_DEFINITIONS, TEAM_LABELS } from '../config/constants.js';
import { getPlayerTeam } from '../domain/roles/roleAttributes.js';
import { hashText } from '../shared/utils.js';
import { buildCharacterPromptProfile } from './context/characterPromptProfile.js';
import { callNameSection, compactPromptValue, initialGameRulesSection, initialRoleRulesSection } from './sections/promptFormatters.js';
import { renderPromptDataBlock } from './serialization/promptDataSerializer.js';
function stablePlayerContextData(state, context, { showPlayerProfile = true } = {}) {
  const player = context.player;
  const role = ROLE_DEFINITIONS[player.roleId] ?? null;
  return {
    name: player.name,
    ...(showPlayerProfile
      ? { character: buildCharacterPromptProfile(player.character, { mode: 'initial-full' }) }
      : {}),
    trueRole: {
      id: player.roleId,
      name: role?.name ?? player.roleId,
      team: TEAM_LABELS[getPlayerTeam(state, player)] ?? '未決定',
    },
  };
}
function renderCommonGameContext(context) {
  return [
    '# AI人狼 共通ゲーム規則',
    '対局共通。最新状態を優先。',
    initialRoleRulesSection(context),
    initialGameRulesSection(context),
  ].filter(Boolean).join('\n\n');
}
function renderStablePlayerContext(state, context, {
  showPlayerProfile = true,
  callNameMode = 'full',
} = {}) {
  return [
    '# AI人狼プレイヤー 本人設定',
    '以下はあなた自身の確定設定です。名前・一人称・話し方に加え、reasoningとdiscussionBehaviorを発言の着眼点・判断・他者との関わり方へ反映してください。最新状態と今回タスクを優先。',
    renderPromptDataBlock('stable-player-context', compactPromptValue(stablePlayerContextData(state, context, { showPlayerProfile }))),
    callNameMode === 'full' ? callNameSection(context) : '',
  ].filter(Boolean).join('\n\n');
}
export function flattenPromptEnvelope(envelope) {
  return [
    envelope?.commonGameContext,
    envelope?.taskInvariantContext,
    envelope?.stablePlayerContext,
    envelope?.taskVariableContext,
    envelope?.dynamicTaskPrompt,
  ].map((value) => String(value ?? '').trim()).filter(Boolean).join('\n\n---\n\n');
}
export function buildPromptEnvelope({
  state,
  context,
  commonSystemInstruction = '',
  taskInvariantContext = '',
  taskVariableContext = '',
  dynamicTaskPrompt = '',
  structuredOutput = null,
  promptFamily = 'game-candidate',
  stablePlayerContextPolicy = null,
}) {
  const commonGameContext = renderCommonGameContext(context);
  const stablePlayerContext = renderStablePlayerContext(state, context, stablePlayerContextPolicy ?? undefined);
  const commonGameFingerprint = hashText(commonGameContext);
  const taskInvariantFingerprint = hashText(taskInvariantContext);
  const taskVariableFingerprint = hashText(taskVariableContext);
  const stablePlayerFingerprint = hashText(stablePlayerContext);
  const dynamicFingerprint = hashText(dynamicTaskPrompt);
  const envelope = {
    schemaVersion: 5,
    commonSystemInstruction: String(commonSystemInstruction ?? ''),
    commonGameContext,
    taskInvariantContext: String(taskInvariantContext ?? ''),
    stablePlayerContext,
    taskVariableContext: String(taskVariableContext ?? ''),
    dynamicTaskPrompt: String(dynamicTaskPrompt ?? ''),
    structuredOutput: structuredOutput ? structuredClone(structuredOutput) : null,
    cacheIdentity: {
      promptSpecVersion: PROMPT_SPEC_VERSION,
      promptFamily,
      gameId: String(state?.game?.id ?? ''),
      commonGameFingerprint,
    },
  };
  return {
    ...envelope,
    combinedText: flattenPromptEnvelope(envelope),
    diagnostics: {
      commonGameFingerprint,
      taskInvariantFingerprint,
      stablePlayerFingerprint,
      taskVariableFingerprint,
      dynamicFingerprint,
    },
  };
}
