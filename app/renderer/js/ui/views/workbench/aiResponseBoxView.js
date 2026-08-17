/**
 * 責務: AI応答入力欄、プロンプト診断、解析プレビュー、登録操作のHTML生成を所有する。
 * 変更ルール: AI応答の解析・検証・状態更新を行わず、AppUIから渡された解析済みViewModelだけを描画する。ユーザー入力・AI出力・識別子は本ファイル内で必ずescapeHtmlを通す。
 */

import { isNormalSpeechTask } from '../../../config/discussionAiTaskTypes.js';
import { getPlayerName } from '../../../state/selectors.js';
import { escapeHtml } from '../../../shared/utils.js';
import { formatDecisionUpdatePreview } from '../../controllers/uiStateFormatters.js';

export function renderPromptDiagnostics(built) {
  if (!built?.diagnostics) return '';
  const diagnostics = built.diagnostics;
  const historyLabel = diagnostics.publicHistoryMode === 'delta'
    ? `差分（#${diagnostics.historyCursorSequence ?? 0}以降）`
    : diagnostics.publicHistoryMode === 'compact'
      ? `過去圧縮＋差分全文（境界 #${diagnostics.historyCursorSequence ?? 0}）`
      : diagnostics.publicHistoryMode === 'night-delta'
        ? `夜履歴差分（#${diagnostics.historyCursorSequence ?? 0}以降）`
        : diagnostics.publicHistoryMode === 'night'
          ? '夜判断用履歴'
          : '全履歴・無圧縮';
  return `<div class="prompt-diagnostics">
    <span>アプリ ${escapeHtml(diagnostics.appVersion)}</span>
    <span>Build ${escapeHtml(diagnostics.buildId.slice(0, 8))}</span>
    <span>Prompt ${escapeHtml(String(diagnostics.promptSpecVersion))}</span>
    <span>可視性監査 ${escapeHtml(diagnostics.visibilityAudit)}</span>
    <span>${diagnostics.aliveCount}人生存・過半数${diagnostics.majorityThreshold}票</span>
    <span>公開履歴 ${escapeHtml(historyLabel)}</span>
  </div>`;
}

function renderParsedPreview({ state, taskType, parsed, parseErrors }) {
  if (!parsed) return '';
  const speechPreview = taskType === 'wolf-conversation'
    ? parsed.wolfMessage
    : taskType === 'mason-conversation'
      ? parsed.masonMessage
      : taskType === 'graveyard-conversation'
        ? parsed.graveyardMessage
        : parsed.publicSpeech;
  const speechLabel = ['wolf-conversation', 'mason-conversation', 'graveyard-conversation'].includes(taskType)
    ? '共有発言'
    : taskType === 'testament'
      ? '遺言'
      : '公開発言';
  const freezeWolfNames = parsed.estimatedWerewolfIds?.map((id) => getPlayerName(state, id)).join('、') || 'なし';
  const freezeAttackNames = parsed.predictedAttackTargetIds?.map((id) => getPlayerName(state, id)).join('、') || 'なし';
  const interaction = isNormalSpeechTask(taskType) && parsed.speechInteraction
    ? `<span>質問先: ${escapeHtml(parsed.speechInteraction.questionTargetNames.join('、') || 'なし')} / 回答元: ${escapeHtml(parsed.speechInteraction.answerEventSequences.map((sequence) => `#${sequence}`).join('、') || 'なし')}</span>`
    : '';
  const coOperation = (isNormalSpeechTask(taskType) || ['priority-answer', 'testament'].includes(taskType)) && parsed.coOperation
    ? `<span>CO操作: ${escapeHtml(parsed.coOperation.action)}${parsed.coOperation.action === 'withdraw' ? '' : ` / ${escapeHtml(parsed.coOperation.roleId)}`} </span>`
    : '';
  const abilityClaims = (isNormalSpeechTask(taskType) || ['priority-answer', 'testament'].includes(taskType)) && parsed.abilityClaims?.action === 'publish'
    ? `<span>能力結果公開: ${escapeHtml(String(parsed.abilityClaims.claims?.length ?? 0))}件</span>`
    : '';
  const decisionUpdate = parsed.decisionUpdate
    ? `<span>${escapeHtml(formatDecisionUpdatePreview(parsed.decisionUpdate))}</span>`
    : '';
  const attackAssessment = parsed.attackAssessment
    ? `<span>襲撃判断: 狩人生存 ${escapeHtml(parsed.attackAssessment.hunterSurvivalLikelihood || 'なし')} / 護衛リスク ${escapeHtml(parsed.attackAssessment.selectedTargetGuardRisk || 'なし')}</span>`
    : '';
  const freezePreview = taskType === 'freeze'
    ? `<span>雪女戦術: 人狼候補 ${escapeHtml(freezeWolfNames)} / 予想襲撃先 ${escapeHtml(freezeAttackNames)}</span>`
    : '';
  const discussionControl = taskType === 'speech-designated'
    ? `<span>次発言者希望: ${escapeHtml(parsed.nextSpeakerPreference || '指名なし')}</span>`
    : taskType === 'speech-free'
      ? `<span>次巡希望: ${escapeHtml(parsed.discussionPreference || 'NORMAL')}</span>`
      : taskType === 'discussion-opening-preference'
        ? `<span>1巡目発言順希望: ${escapeHtml(parsed.openingPreference || '')}</span>`
        : '';
  return `<div class="parse-preview ${parseErrors.length ? 'has-error' : ''}">
    <strong>解析結果</strong>
    ${speechPreview ? `<span>${speechLabel}: ${escapeHtml(speechPreview)}</span>` : ''}
    ${parsed.actionRationale ? `<span>選択理由: ${escapeHtml(parsed.actionRationale)}</span>` : ''}
    <span>心の声: ${parsed.heartVoice ? 'あり' : 'なし'}</span>
    <span>内部メモ更新: ${parsed.internalMemoUpdate ? '追記' : parsed.consolidatedMemo ? '整理' : 'なし'}</span>
    ${interaction}
    ${coOperation}
    ${abilityClaims}
    ${decisionUpdate}
    ${attackAssessment}
    ${freezePreview}
    ${discussionControl}
    ${parsed.sharedStrategyUpdate ? '<span>共有作戦更新: あり</span>' : ''}
    ${parsed.actionAnswer ? `<span>行動回答: ${escapeHtml(parsed.actionAnswer)}</span>` : ''}
    ${parseErrors.map((error) => `<em>${escapeHtml(error)}</em>`).join('')}
  </div>`;
}

export function renderAiResponseBox({ state, player, taskType, slotId = '', key, cache, raw, parsed, parseErrors = [], manualNotice = '' }) {
  const playerId = escapeHtml(player.id);
  const safeTaskType = escapeHtml(taskType);
  const safeSlotId = escapeHtml(slotId);
  const promptSection = cache
    ? `${renderPromptDiagnostics(cache)}
      <details class="prompt-preview">
        <summary>生成したプロンプトを確認</summary>
        <textarea readonly>${escapeHtml(cache.text)}</textarea>
      </details>`
    : '';
  return `<div class="ai-box" data-ai-key="${escapeHtml(key)}">
    ${manualNotice}
    <div class="ai-actions">
      <button class="button primary" data-action="copy-prompt" data-player-id="${playerId}" data-task-type="${safeTaskType}" data-slot-id="${safeSlotId}" type="button">${cache ? '最新プロンプトを再コピー' : 'プロンプトをコピー'}</button>
      ${cache ? '<span class="success-text">生成済み</span>' : ''}
    </div>
    ${promptSection}
    <label class="field">
      <span>AI JSON応答</span>
      <textarea data-draft="ai-response:${escapeHtml(key)}" placeholder="AIが返したJSONオブジェクトをそのまま貼り付けてください">${escapeHtml(raw)}</textarea>
    </label>
    ${renderParsedPreview({ state, taskType, parsed, parseErrors })}
    <div class="button-row">
      <button class="button ghost" data-action="preview-ai" type="button">解析プレビュー</button>
      <button class="button primary" data-action="commit-ai" data-player-id="${playerId}" data-task-type="${safeTaskType}" data-slot-id="${safeSlotId}" type="button">解析して登録</button>
    </div>
  </div>`;
}
