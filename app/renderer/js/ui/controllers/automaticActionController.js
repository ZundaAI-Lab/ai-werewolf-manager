/**
 * 責務: 状態から導出済みの全自動コマンドを、正式なドメインコマンドへ直接接続する。
 * 変更ルール: DOM要素、data-action、表示ラベルを探索しない。ゲーム規則を複製せず、各domainコマンドとAppUIの正式commit入口だけを使用する。
 */

import { startGame } from '../../domain/game/gameCommands.js';
import { acknowledgeRole, markBriefingShown } from '../../domain/briefing/briefingCommands.js';
import { designateDiscussionSpeaker, grantTargetedDiscussionReconsideration, resolveAllDeferred } from '../../domain/discussion/discussionCommands.js';
import { beginVote, finalizeVote, publishExecution, publishVoteResult, resolveExecution } from '../../domain/vote/voteCommands.js';
import { closeGraveyardConversation, closeMasonConversation, closeWolfConversation, publishDawn, resolveNight } from '../../domain/night/nightCommands.js';
import { confirmGameResult, publishGameResult } from '../../domain/result/resultCommands.js';

const RESULT_DISCLOSURE_DEFAULTS = Object.freeze({
  revealAllRoles: true,
  revealWolfConversation: false,
  revealMasonConversation: false,
  revealGraveyardConversation: false,
  revealInternalMemos: false,
});

function completeAiBriefing(state, playerId) {
  const shown = markBriefingShown(state, playerId);
  if (!shown?.ok) return shown;
  return acknowledgeRole(state, playerId);
}

export function createAutomaticActionController({ ui }) {
  if (!ui) throw new TypeError('AppUIがありません。');

  const handlers = Object.freeze({
    'start-game': (action) => ui.setupActionController._runEngine(action.label, (state) => startGame(state)),
    'complete-ai-briefing': (action) => ui.setupActionController._runEngine(action.label, (state) => completeAiBriefing(state, action.playerId), {
      informationBarrier: true,
      notification: { roleBriefingSummary: true, key: 'role-briefing' },
    }),
    'designate-speaker': (action) => ui.setupActionController._runEngine(action.label, (state) => designateDiscussionSpeaker(state, action.playerId)),
    'resolve-all-deferred': (action) => ui.setupActionController._runEngine(action.label, (state) => resolveAllDeferred(state, action.deferredAction, action.playerId ?? null)),
    'targeted-reconsideration': (action) => ui.setupActionController._runEngine(action.label, (state) => grantTargetedDiscussionReconsideration(state)),
    'begin-vote': (action) => ui.setupActionController._runEngine(action.label, (state) => beginVote(state)),
    'finalize-vote': (action) => ui.setupActionController._runEngine(action.label, (state) => finalizeVote(state)),
    'publish-vote': (action) => ui.setupActionController._runEngine(action.label, (state) => publishVoteResult(state), { publicBarrier: true }),
    'resolve-execution': (action) => ui.setupActionController._runEngine(action.label, (state) => resolveExecution(state)),
    'publish-execution': (action) => ui.setupActionController._runEngine(action.label, (state) => publishExecution(state), { publicBarrier: true }),
    'close-graveyard-chat': (action) => ui.setupActionController._runEngine(action.label, (state) => closeGraveyardConversation(state)),
    'close-mason-chat': (action) => ui.setupActionController._runEngine(action.label, (state) => closeMasonConversation(state)),
    'close-wolf-chat': (action) => ui.setupActionController._runEngine(action.label, (state) => closeWolfConversation(state)),
    'resolve-night': (action) => ui.setupActionController._runEngine(action.label, (state) => resolveNight(state)),
    'publish-dawn': (action) => ui.setupActionController._runEngine(action.label, (state) => publishDawn(state), { informationBarrier: true }),
    'confirm-result': (action) => ui.setupActionController._runEngine(action.label, (state) => confirmGameResult(state, RESULT_DISCLOSURE_DEFAULTS)),
    'publish-result': (action) => ui.setupActionController._runEngine(action.label, (state) => publishGameResult(state), { publicBarrier: true }),
  });

  function executeAutomaticAction(action) {
    const handler = handlers[action?.command];
    if (!handler) return { ok: false, message: `未対応の全自動コマンドです: ${String(action?.command ?? '')}` };
    return handler(action);
  }

  return Object.freeze({ executeAutomaticAction });
}
