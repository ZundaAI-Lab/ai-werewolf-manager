/**
 * 責務: 製造時に守るゲーム・プロンプト・UI公開契約を、実モジュールのexport値で検査する。
 * 変更ルール: ソース文字列、インデント、クォート、コメントへ依存しない。契約変更時は正本モジュールとこの期待値を同時更新する。
 */

import assert from 'node:assert/strict';
import {
  RESPONSE_MODE_DEFINITIONS,
  buildResponseContractExample,
} from '../../app/renderer/js/prompts/response/responseContract.js';
import {
  BRIEFING_AI_SYSTEM_INSTRUCTION,
  PERSISTENT_AI_SYSTEM_INSTRUCTION,
  validateResponseContractCatalogCoverage,
} from '../../app/renderer/js/prompts/response/responseContractCatalog.js';
import { HUMAN_SPEECH_DRAFT_FIELDS } from '../../app/renderer/js/ui/views/workbench/workbenchTaskRenderer.js';
import { AUTOMATIC_ACTION_POLICY } from '../../app/renderer/js/domain/game/automaticActionPolicy.js';
import { RUNTIME_REQUIRED_METHODS } from '../../app/renderer/js/app/runtimeFacade.js';

assert.deepEqual([...RESPONSE_MODE_DEFINITIONS.speech.allowedTopLevelKeys], [
  'publicSpeech', 'speechInteraction', 'coOperation', 'abilityClaims',
  'decisionPatch', 'factionStrategy', 'heartVoice', 'memoAdd',
]);
assert.deepEqual([...RESPONSE_MODE_DEFINITIONS.speech.requiredTopLevelKeys], ['publicSpeech']);
assert.deepEqual([...RESPONSE_MODE_DEFINITIONS['speech-designated'].allowedTopLevelKeys], [
  'publicSpeech', 'speechInteraction', 'coOperation', 'abilityClaims',
  'decisionPatch', 'factionStrategy', 'heartVoice', 'memoAdd', 'nextSpeakerPreference',
]);
assert.deepEqual([...RESPONSE_MODE_DEFINITIONS['speech-free'].allowedTopLevelKeys], [
  'publicSpeech', 'speechInteraction', 'coOperation', 'abilityClaims',
  'decisionPatch', 'factionStrategy', 'heartVoice', 'memoAdd', 'discussionPreference',
]);
assert.deepEqual([...RESPONSE_MODE_DEFINITIONS['discussion-opening-preference'].allowedTopLevelKeys], ['openingPreference']);
assert.deepEqual([...RESPONSE_MODE_DEFINITIONS['priority-answer'].allowedTopLevelKeys], [
  'publicSpeech', 'coOperation', 'abilityClaims', 'decisionPatch',
  'factionStrategy', 'heartVoice', 'memoAdd',
]);
assert.deepEqual([...RESPONSE_MODE_DEFINITIONS['priority-answer'].requiredTopLevelKeys], ['publicSpeech']);
assert.equal(Object.hasOwn(buildResponseContractExample({ mode: 'speech' }), 'heartVoice'), true);
assert.equal(Object.hasOwn(buildResponseContractExample({ mode: 'speech' }), 'speechInteraction'), true);
assert.equal(validateResponseContractCatalogCoverage().ok, true);
assert.match(PERSISTENT_AI_SYSTEM_INSTRUCTION, /\[game-data:\.\.\.\]/u);
assert.match(BRIEFING_AI_SYSTEM_INSTRUCTION, /\[game-data:\.\.\.\]/u);
assert.match(BRIEFING_AI_SYSTEM_INSTRUCTION, /回答.*不要/u);
assert.deepEqual(HUMAN_SPEECH_DRAFT_FIELDS, {
  speech: 'human-speech',
  questionTarget: 'human-question-target',
  coAction: 'human-co-action',
  coRole: 'human-co-role',
  nextSpeaker: 'human-next-speaker',
  discussionPreference: 'human-discussion-preference',
  openingPreference: 'human-discussion-opening-preference',
});
assert.deepEqual([...AUTOMATIC_ACTION_POLICY.publicationCommands].sort(), [
  'publish-dawn', 'publish-execution', 'publish-result', 'publish-vote',
]);
assert.equal(RUNTIME_REQUIRED_METHODS.includes('resolveAutomaticAction'), true);
assert.equal(RUNTIME_REQUIRED_METHODS.includes('executeAutomaticAction'), true);

console.log(JSON.stringify({ ok: true, contractCount: 15 }));
