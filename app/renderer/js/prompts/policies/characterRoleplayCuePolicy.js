/**
 * 責務: 通常の公開発言・回答優先発言へ渡す短いプロフィール表現の手掛かりを、既存の会話種から一つ選ぶ。
 * 変更ルール:
 * - 発言本文、推理内容、疑い先、質問先、投票先、CO、役職行動を生成・決定しない。
 * - 本人のキャラクター設定と公開発言件数だけを使用し、秘密情報や公開発言本文を参照・解析しない。
 * - 会話種はsubjectとtoneだけを扱い、公開会話へ短い表現手掛かりとして渡す。
 * - ゲーム最初の公開発言はcharacterConversationPolicy.jsへ委譲し、同じ入力から同じ結果を返してMath.randomを使用しない。
 */

import { isNormalSpeechTask } from '../../config/discussionAiTaskTypes.js';

import { hashText } from '../../shared/utils.js';
import { OPENING_CONVERSATION_MODES } from './openingSpeechPolicy.js';

function validRoleplayCues(character) {
  return (character?.conversationSeeds ?? [])
    .filter((item) => String(item?.subject ?? '').trim() && String(item?.tone ?? '').trim())
    .map((item) => ({
      subject: String(item.subject).trim(),
      tone: String(item.tone).trim(),
    }));
}

function ownPublicSpeechCount(context) {
  return (context.board.publicTimeline?.speeches ?? [])
    .filter((event) => event.actorId === context.player.id)
    .length;
}

export function resolveCharacterRoleplayCue(context, { conversationMode = 'normal' } = {}) {
  if (!(isNormalSpeechTask(context.task.type) || context.task.type === 'priority-answer')) return null;
  if (context.task.type === 'speech' && conversationMode === OPENING_CONVERSATION_MODES.FIRST_SPEAKER) return null;

  const cues = validRoleplayCues(context.player.character);
  if (!cues.length) return null;

  const offset = Number.parseInt(hashText(`${context.game.id}|${context.player.id}|roleplay-cue`), 16) % cues.length;
  const selected = cues[(offset + ownPublicSpeechCount(context)) % cues.length];
  return `${selected.subject}／${selected.tone}`;
}
