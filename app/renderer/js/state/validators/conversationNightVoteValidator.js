/**
 * 責務: 会話・夜・処刑・霊能結果の各状態Validatorを順序付きで束ねる。
 * 変更ルール: 個別ドメインの検証規則を持たず、専用Validatorへcontextを委譲する。
 */

import { validateConversationState } from './conversationStateValidator.js';
import { validateNightState } from './nightStateValidator.js';
import { validateExecutionState } from './executionStateValidator.js';
import { validateMediumResultState } from './mediumResultStateValidator.js';

export function validateConversationNightVoteState(context) {
  validateConversationState(context);
  validateNightState(context);
  validateExecutionState(context);
  validateMediumResultState(context);
}
