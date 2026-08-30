/**
 * 責務: アプリ全体で共有する固定値、標準役職、推奨配役、既定ルールを定義する。
 * 変更ルール: 状態更新・DOM操作・保存処理を追加しない。識別子を変更する場合は全参照元を同時更新する。役職のdescriptionは役職通知用の短文、helpは人間向け役職ヘルプ用の統一説明として責務を分ける。
 */

import { DATA_SCHEMA_KIND, getCurrentDataSchemaVersion } from './dataCompatibilityAdapter.js';

export const APP_VERSION = '1.0.5';

// SCHEMA_VERSIONは製品版ゲーム保存JSONの項目構造・意味・必須条件を表す。
// アプリversionとは独立して管理し、旧schemaはdataCompatibilityの一方向migrationを通した後だけ本体へ渡す。
// 製品版1.0.0の基準schemaは1。項目追加・削除・意味変更・必須条件変更時だけ増やす。
export const SCHEMA_VERSION = getCurrentDataSchemaVersion(DATA_SCHEMA_KIND.GAME_STATE);

// PROMPT_SPEC_VERSIONはAIへ渡す情報構成・方針・優先度・生成指示の版を表し、対局状態のruntimeへ記録する。
// 製品版1.0.0では1を基準とし、正式リリース後はAIへ渡す契約・方針・情報構成を変更した場合だけ単調増加させ、リセットしない。
export const PROMPT_SPEC_VERSION = 4;
export const MAX_NIGHT_ACTION_RATIONALE_LENGTH = 240;
export const MAX_FREEZE_ACTION_RATIONALE_LENGTH = 360;
export const MAX_RESULT_IMPRESSION_LENGTH = 180;
export const MAX_UNDO = 80;
export const MAX_RESTORE_POINTS = 16;

export const MIN_PLAYER_COUNT = 4;
export const MAX_PLAYER_COUNT = 16;
export const SUPPORTED_PLAYER_COUNTS = Object.freeze([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

export const VOTE_TIE_RESOLUTIONS = Object.freeze([
  'random-execution',
  'no-execution',
]);

export const PHASES = Object.freeze([
  'setup',
  'briefing',
  'night',
  'dawn',
  'discussion',
  'vote',
  'runoff',
  'execution',
  'result',
  'ended',
]);

export const PHASE_LABELS = Object.freeze({
  setup: '準備',
  briefing: '役職通知',
  night: '夜',
  dawn: '夜明け確認',
  discussion: '昼議論',
  vote: '投票',
  runoff: '決選投票',
  execution: '処刑確認',
  result: '結果確認',
  ended: '終了',
});

export const TEAM_LABELS = Object.freeze({
  village: '村人陣営',
  wolf: '人狼陣営',
  fox: '妖狐陣営',
  draw: '引き分け',
});

function roleHelp(overview, ability, details) {
  return Object.freeze({ overview, ability, details });
}

export const ROLE_DEFINITIONS = Object.freeze({
  villager: Object.freeze({
    id: 'villager', name: '村人', baseTeam: 'village', roleClass: 'village', countsAsWolf: false,
    nightAction: null, maxCount: null, description: '特殊能力を持たず、会話と投票から人狼を探す。',
    help: roleHelp(
      '特殊能力を持たず、会話と投票で人狼を探す役職です。',
      '固有能力はありません。',
      '公開情報と他プレイヤーの発言・投票をもとに推理します。',
    ),
  }),
  mason: Object.freeze({
    id: 'mason', name: '共有者', baseTeam: 'village', roleClass: 'village', countsAsWolf: false,
    nightAction: 'mason-conversation', maxCount: null, description: '他の共有者を知り、夜に共有者同士で会話する。',
    help: roleHelp(
      '他の共有者を知っている村人陣営の役職です。',
      '夜に他の共有者と共有会話を行えます。',
      '共有会話の有効・無効や1夜の発言回数などはゲーム設定に従います。',
    ),
  }),
  seer: Object.freeze({
    id: 'seer', name: '占い師', baseTeam: 'village', roleClass: 'village', countsAsWolf: false,
    nightAction: 'inspect', maxCount: null, publicAbilityClaim: Object.freeze({ actionType: 'inspect', results: Object.freeze(['wolf', 'not-wolf']) }), description: '夜に一人を占い、人狼かどうかを知る。妖狐を占った場合は妖狐を死亡させる。',
    help: roleHelp(
      '生存者を調べて人狼を探す村人陣営の役職です。',
      '夜に一人を占い、「人狼」または「人狼ではない」の判定を得ます。',
      '白狼は「人狼ではない」と判定されます。妖狐を占うと妖狐を死亡させます。初夜の実行方法・自己占い・同じ相手の再占いはゲーム設定に従います。',
    ),
  }),
  medium: Object.freeze({
    id: 'medium', name: '霊能者', baseTeam: 'village', roleClass: 'village', countsAsWolf: false,
    nightAction: 'automatic-medium', maxCount: null, publicAbilityClaim: Object.freeze({ actionType: 'medium', results: Object.freeze(['wolf', 'not-wolf']) }), description: '直前に処刑された人物が人狼かどうかを知る。',
    help: roleHelp(
      '処刑された人物の正体を判定する村人陣営の役職です。',
      '直前に処刑された人物が「人狼」か「人狼ではない」かを自動で知ります。',
      '白狼は「人狼」と判定されます。処刑がなかった場合は判定対象もありません。',
    ),
  }),
  guard: Object.freeze({
    id: 'guard', name: '狩人', baseTeam: 'village', roleClass: 'village', countsAsWolf: false,
    nightAction: 'guard', maxCount: null, publicAbilityClaim: Object.freeze({ actionType: 'guard', results: Object.freeze(['unknown']) }), description: '夜に一人を護衛し、人狼の襲撃と雪女の凍結から守る。',
    help: roleHelp(
      '夜の襲撃や凍結から対象を守る村人陣営の役職です。',
      '夜に一人を護衛し、人狼の襲撃と雪女の凍結から守ります。',
      '初夜護衛・自己護衛・同じ相手の連続護衛の可否はゲーム設定に従います。',
    ),
  }),
  namahage: Object.freeze({
    id: 'namahage', name: 'なまはげ', baseTeam: 'village', roleClass: 'village', countsAsWolf: false,
    nightAction: 'visit', maxCount: 1, publicAbilityClaim: Object.freeze({ actionType: 'visit', results: Object.freeze(['unknown']) }),
    description: '毎夜一人を訪問する。相手が「悪い子」なら恐怖を与え、その夜の役職行動を阻害する。人狼が複数いる場合、恐怖でない人狼が一人でもいれば襲撃は行われ、全員が恐怖なら襲撃できない。恐怖は行動阻害後に解除される。前夜と同じ相手は選べない。',
    help: roleHelp(
      '「悪い子」の夜行動を妨害できる村人陣営の役職です。',
      'Day 1の夜以降、一人を訪問し、相手が「悪い子」なら恐怖を与えてその夜の役職行動を阻害します。',
      '自分自身と前夜と同じ相手は選べません。人狼の襲撃は、参加する生存人狼が全員恐怖の場合だけ阻害されます。恐怖は行動開始判定後に解除されます。',
    ),
  }),
  madman: Object.freeze({
    id: 'madman', name: '狂人', baseTeam: 'wolf', roleClass: 'madman', countsAsWolf: false, strategyProfile: 'madman',
    nightAction: null, maxCount: null, description: '人狼陣営だが生存人狼数には含まれず、標準設定では人狼を知らない。',
    help: roleHelp(
      '人狼の勝利を支援する、人狼陣営の非人狼役職です。',
      '固有の夜能力はありません。',
      '生存人狼数には数えられません。人狼の認識や共有会話への参加はゲーム設定に従います。標準設定では人狼を知りません。',
    ),
  }),
  snowWoman: Object.freeze({
    id: 'snowWoman', name: '雪女', baseTeam: 'wolf', roleClass: 'madman', countsAsWolf: false, strategyProfile: 'madman',
    badChild: true, fearActionGroup: 'freeze',
    nightAction: 'freeze', maxCount: 1, publicAbilityClaim: Object.freeze({ actionType: 'freeze', results: Object.freeze(['unknown']) }),
    description: 'Day 1の夜から毎晩、自分以外の一人を凍結する。対象は翌日の昼会話と投票ができず、その日に処刑された場合は遺言も残せないが、夜行動と能力結果の受領は行える。護衛されている場合は失敗し、同じ人物を連続指定できない。',
    help: roleHelp(
      '他者の翌日の行動を一部封じる人狼陣営の役職です。',
      'Day 1の夜以降、一人を凍結し、対象を翌日の昼会話と投票に参加できなくします。その日に処刑された場合は遺言も残せません。',
      '凍結されても夜行動と能力結果の受領は可能です。自分自身と前夜と同じ相手は選べず、対象が護衛されていると失敗します。',
    ),
  }),
  wolf: Object.freeze({
    id: 'wolf', name: '人狼', baseTeam: 'wolf', roleClass: 'wolf', countsAsWolf: true, strategyProfile: 'wolf',
    badChild: true, fearActionGroup: 'wolf-attack',
    nightAction: 'wolf-attack', maxCount: null, seerResult: 'wolf', mediumResult: 'wolf', description: '仲間と共有会話を行い、夜に一人を襲撃する。',
    help: roleHelp(
      '正体を隠しながら村人側を減らす、人狼陣営の中心役職です。',
      '仲間の人狼を知り、夜に生存者一人を襲撃します。',
      '人狼側の共有会話や参加者はゲーム設定に従います。占い・霊能では「人狼」と判定され、生存人狼数にも数えられます。',
    ),
  }),
  whiteWolf: Object.freeze({
    id: 'whiteWolf', name: '白狼', baseTeam: 'wolf', roleClass: 'wolf', countsAsWolf: true, strategyProfile: 'wolf',
    badChild: true, fearActionGroup: 'wolf-attack',
    nightAction: 'wolf-attack', maxCount: 1, seerResult: 'not-wolf', mediumResult: 'wolf',
    description: '占いでは人狼ではないと判定されるが、それ以外は通常の人狼と同じ。',
    help: roleHelp(
      '占い結果を偽装できる特殊な人狼です。',
      '仲間の人狼を知り、夜に生存者一人を襲撃します。',
      '占いでは「人狼ではない」、霊能では「人狼」と判定されます。生存人狼数には数えられ、人狼側の共有会話や参加者はゲーム設定に従います。',
    ),
  }),
  fox: Object.freeze({
    id: 'fox', name: '妖狐', baseTeam: 'fox', roleClass: 'fox', countsAsWolf: false, strategyProfile: 'fox',
    nightAction: null, maxCount: null, description: '第三陣営。人狼に襲撃されても死亡しないが、占われると死亡する。',
    help: roleHelp(
      '村人・人狼のどちらとも異なる独立した第三陣営の役職です。',
      '固有の夜行動はありません。',
      '人狼に襲撃されても死亡しませんが、占われると死亡します。',
    ),
  }),
  cat: Object.freeze({
    id: 'cat', name: '猫又', baseTeam: 'village', roleClass: 'village', countsAsWolf: false,
    nightAction: null, maxCount: null, description: '処刑されると生存者一人を、襲撃死すると生存人狼一人をランダムに道連れにする。',
    help: roleHelp(
      '処刑または人狼の襲撃で死亡したとき、別の人物を道連れにする村人陣営の役職です。',
      '能力は対象となる死亡時に自動で発動します。',
      '処刑された場合は自分以外の生存者一人をランダムに、襲撃された場合は生存人狼一人をランダムに道連れにします。道連れで死亡した猫又の能力は連鎖しません。',
    ),
  }),
  zashikiWarashi: Object.freeze({
    id: 'zashikiWarashi', name: '座敷わらし', baseTeam: null, roleClass: 'delayed', countsAsWolf: false,
    nightAction: 'choose-owner', maxCount: 1,
    description: '初日の夜に最優先で自分以外の家主を選び、その正確な役職を知って同じ陣営になる。家主が死亡すると同時に死亡し、第三陣営の家主とは同時に勝利する。',
    help: roleHelp(
      '初夜に選んだ家主と運命を共にする、陣営が後から決まる役職です。',
      '初夜に自分以外の一人を家主に選び、その人物の正確な役職を知ります。',
      '家主と同じ陣営になり、家主が死亡すると同時に死亡します。第三陣営の家主を選んだ場合も、その家主と同じ勝利を目指します。',
    ),
  }),
});

export const ROLE_IDS = Object.freeze(Object.keys(ROLE_DEFINITIONS));

export const PRESET_ROLES = Object.freeze({
  4: Object.freeze(['villager', 'villager', 'seer', 'wolf']),
  5: Object.freeze(['villager', 'villager', 'seer', 'guard', 'wolf']),
  6: Object.freeze(['villager', 'villager', 'seer', 'guard', 'madman', 'wolf']),
  7: Object.freeze(['villager', 'villager', 'seer', 'medium', 'guard', 'madman', 'wolf']),
  8: Object.freeze(['villager', 'villager', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf']),
  9: Object.freeze(['villager', 'villager', 'villager', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf']),
  10: Object.freeze(['villager', 'villager', 'mason', 'mason', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf']),
  // 11～12人は人狼2人を維持し、共有者込みの情報量に対して灰を増やす。
  11: Object.freeze(['villager', 'villager', 'villager', 'mason', 'mason', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf']),
  12: Object.freeze(['villager', 'villager', 'villager', 'villager', 'mason', 'mason', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf']),
  // 13人以上は処刑回数と灰数が増えるため、人狼を3人へ増やして陣営間の圧力を保つ。
  13: Object.freeze(['villager', 'villager', 'villager', 'villager', 'mason', 'mason', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf', 'wolf']),
  14: Object.freeze(['villager', 'villager', 'villager', 'villager', 'villager', 'mason', 'mason', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf', 'wolf']),
  15: Object.freeze(['villager', 'villager', 'villager', 'villager', 'villager', 'villager', 'mason', 'mason', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf', 'wolf']),
  16: Object.freeze(['villager', 'villager', 'villager', 'villager', 'villager', 'villager', 'villager', 'mason', 'mason', 'seer', 'medium', 'guard', 'madman', 'wolf', 'wolf', 'wolf']),
});

export const PRESET_NOTES = Object.freeze({
  4: '超短時間向け。1回の処刑が勝敗へ直結しやすい構成です。',
  5: '少人数向け。情報役職が強くなりやすい構成です。',
  6: '短時間向け。狂人を含むため議論の揺れが増えます。',
  7: '少人数の標準寄り構成です。',
  8: '人狼2人を含む標準構成です。',
  9: '人狼2人を維持し、村人を増やした中規模向け構成です。',
  10: '村人2人を共有者2人へ置き換えた、人狼2人を含む中規模向け構成です。',
  11: '人狼2人・狂人1人を維持し、共有者2人と灰3人で情報量と潜伏幅を両立した構成です。',
  12: '人狼2人・狂人1人に対して灰4人を確保し、役職情報が早期に盤面を固定しすぎない構成です。',
  13: '人狼を3人へ増やし、共有者2人を含む村側の情報力と人狼側の連携力を均衡させた構成です。',
  14: '人狼3人・狂人1人を軸に、灰5人を確保した大人数向けの標準構成です。',
  15: '人狼3人・狂人1人と灰6人で、身内関係・投票連合・役職真偽を長く検討できる構成です。',
  16: '人狼3人・狂人1人、共有者2人、基本能力役職3人、村人7人で大人数でも両陣営に十分な選択肢を持たせた構成です。',
});


// UIでは選択肢を瞬時に比較できる短い名称だけを表示する。
// evidenceFocusは人物の観察・判断傾向だけを表し、投票分析や役職構造理解など人狼固有の専門技能は含めない。
export const REASONING_PROFILE_OPTION_LABELS = Object.freeze({
  evidenceFocus: Object.freeze({
    balanced: 'バランス重視',
    response: '反応重視',
    chronology: '時系列重視',
    consistency: '一貫性重視',
    commitment: '立場重視',
    'social-reaction': '関係性重視',
  }),
  updateTempo: Object.freeze({
    rapid: '早めに更新',
    gradual: '段階的に更新',
    conservative: '慎重に更新',
  }),
  hypothesisBreadth: Object.freeze({
    narrow: '少数に絞る',
    balanced: '段階的に絞る',
    wide: '広く保つ',
  }),
  confrontationStyle: Object.freeze({
    direct: '直接伝える',
    moderate: '配慮して明示',
    indirect: '婉曲に確認',
  }),
  questionStyle: Object.freeze({
    focused: '一人・一論点',
    broad: '複数人を比較',
    reserved: '必要時のみ',
  }),
  uncertaintyStyle: Object.freeze({
    explicit: '確信度を明示',
    analytical: '複数案を整理',
    emotional: '違和感を表明',
  }),
});

// UI表示用ラベルと分離し、AIへは判断・発言上の差が伝わる説明文を渡す。
export const REASONING_PROFILE_PROMPT_DESCRIPTIONS = Object.freeze({
  evidenceFocus: Object.freeze({
    balanced: '複数の証拠を均等に扱う',
    response: '質問への反応を優先する',
    chronology: '発言順と時系列を優先する',
    consistency: '発言・CO・能力結果など公開した内容の前後整合性を優先する',
    commitment: '疑い先・CO・能力結果・投票など公開した立場の明確さと変化を優先する',
    'social-reaction': '擁護・反応・人物関係を優先する',
  }),
  updateTempo: Object.freeze({
    rapid: '新しい有力情報を得ると、比較的早く候補や評価を更新する',
    gradual: '複数の根拠を比較し、整合性を確認してから判断を更新する',
    conservative: '一つの情報だけでは判断を変えず、従来の判断と新しい情報の両方を再検討して更新する',
  }),
  hypothesisBreadth: Object.freeze({
    narrow: '十分な差がある場合は有力な一人または少数候補へ絞り、差が薄い場合は無理に順位を付けず保留する',
    balanced: '複数の候補を比較しながら、情報が増えるごとに段階的に絞る',
    wide: '複数候補と複数の役職内訳を並行して保持し、早い段階では切り捨てない',
  }),
  confrontationStyle: Object.freeze({
    direct: '矛盾や反対意見を明確かつ直接示す',
    moderate: '問題点を明示しつつ、根拠と相手への配慮を両立して伝える',
    indirect: '必要な問題点は示したうえで、確認や婉曲表現を中心に伝える',
  }),
  questionStyle: Object.freeze({
    focused: '一人の実際の発言について、一論点だけ確認する',
    broad: '複数人へ比較軸を広く質問する',
    reserved: '必要な場面だけ質問する',
  }),
  uncertaintyStyle: Object.freeze({
    explicit: '確信度と未確認部分を「まだ不明」「やや疑う」など明示して伝える',
    analytical: '複数の見方と、現在まだ区別できていない点を整理して伝える',
    emotional: '確認できた材料に対する違和感や警戒感を率直に示しつつ、それが未確定な感覚であることも伝える',
  }),
});

export const DEFAULT_REASONING_PROFILE = Object.freeze({
  evidenceFocus: 'balanced',
  updateTempo: 'gradual',
  hypothesisBreadth: 'balanced',
  confrontationStyle: 'moderate',
  questionStyle: 'focused',
  uncertaintyStyle: 'explicit',
});

export const DEFAULT_CHARACTER = Object.freeze({
  profile: '',
  firstPerson: '',
  genericSecondPerson: '',
  speakingStyle: '',
  defaultEndings: '',
  avoidedExpressions: '',
  speechLength: '標準',
  speechExamples: '',
  discussionBehavior: '',
  reasoningProfile: DEFAULT_REASONING_PROFILE,
});

export const DEFAULT_RULES = Object.freeze({
  speechCountPerDay: 3,
  discussion: Object.freeze({
    mode: 'ordered',
    answerPriorityEnabled: true,
  }),
  roleAssignment: Object.freeze({
    shuffleOnStart: false,
    roleMissingEnabled: false,
  }),
  firstNight: Object.freeze({
    wolfCommunicationEnabled: true,
    wolfAttackEnabled: false,
    seerMode: 'choose',
    guardEnabled: false,
  }),
  vote: Object.freeze({
    selfVoteAllowed: false,
    abstentionAllowed: false,
    visibilityDuringInput: 'secret',
    publicationAfterFinalize: 'all-ballots',
    runoffLimit: 1,
    tieResolution: 'random-execution',
    revealExecutedRole: false,
  }),
  seer: Object.freeze({
    selfTargetAllowed: false,
    repeatedTargetAllowed: true,
  }),
  guard: Object.freeze({
    selfGuardAllowed: false,
    consecutiveGuardAllowed: true,
  }),
  testament: Object.freeze({
    enabled: false,
  }),
  graveyardCommunication: Object.freeze({
    enabled: false,
    availability: 'night-only',
    includeConversationInAiPrompt: true,
    retainPastConversation: true,
    speechCountPerNight: 1,
  }),
  masonCommunication: Object.freeze({
    enabled: true,
    availability: 'night-only',
    includeConversationInAiPrompt: true,
    retainPastConversation: true,
    speechCountPerNight: 1,
  }),
  wolfCommunication: Object.freeze({
    enabled: true,
    participantMode: 'wolves-only',
    availability: 'night-only',
    includeConversationInAiPrompt: true,
    retainPastConversation: true,
    speechCountPerNight: 1,
  }),
  nightResolution: Object.freeze({
    deliverPrivateResultToDeadPlayer: false,
  }),
  callNames: Object.freeze({
    enabled: true,
  }),
  ai: Object.freeze({
    maxPublicSpeechLength: 450,
    maxWolfMessageLength: 450,
    maxMasonMessageLength: 450,
    maxGraveyardMessageLength: 450,
    maxHeartVoiceLength: 120,
    maxInternalMemoLength: 3000,
  }),
});

export const EVENT_TYPE_LABELS = Object.freeze({
  'role-notified': '役職通知',
  'public-speech': '公開発言',
  'wolf-conversation': '人狼共有会話',
  'mason-conversation': '共有者共有会話',
  'graveyard-conversation': '墓場会話',
  'vote-cast': '投票',
  'vote-finalized': '投票結果',
  execution: '処刑',
  'night-action': '夜行動',
  'private-result': '個人結果',
  dawn: '夜明け',
  correction: 'GM訂正',
  'correction-audit': '訂正監査',
  'game-result': 'ゲーム結果',
  'result-impression': '勝敗後の感想',
  'priority-answer-resolution': '優先回答のGM解決',
  system: 'システム',
});

export const AUDIENCE_LABELS = Object.freeze({
  public: '全体公開',
  player: '指定プレイヤー',
  participants: '指定参加者',
  gm: 'GMのみ',
});

export const TASK_LABELS = Object.freeze({
  setup: 'ゲーム準備',
  briefing: '役職通知',
  'briefing-complete': '役職通知完了',
  'private-notification': '個人結果通知',
  'discussion-designate': '次の発言者指定',
  'discussion-all-deferred': '後回し状態の解決',
  'wolf-conversation': '人狼共有会話',
  'mason-conversation': '共有者共有会話',
  'graveyard-conversation': '墓場会話',
  'wolf-attack': '襲撃先投票',
  'memo-consolidate': '内部メモ整理',
  inspect: '占い先選択',
  guard: '護衛先選択',
  visit: '訪問先選択',
  freeze: '凍結先選択',
  'choose-owner': '家主選択',
  'resolve-night': '夜行動解決',
  'publish-dawn': '夜明け公開',
  speech: '昼発言',
  'speech-designated': '昼発言（指名制）',
  'speech-free': '昼発言（発言希望制）',
  'discussion-opening-preference': '発言希望制・開始時発言希望',
  'priority-answer': '質問への優先回答',
  'discussion-complete': '昼議論完了',
  vote: '投票',
  'finalize-vote': '投票集計',
  'publish-vote': '投票結果公開',
  'resolve-execution': '処刑内容解決',
  testament: '遺言',
  'publish-execution': '処刑公開',
  'confirm-result': '結果確認',
  'publish-result': '結果公開',
  'result-impression': '勝敗後の感想',
  ended: 'ゲーム終了',
  correction: '訂正モード中',
});
