/**
 * 責務: ユーザーキャラクター編集用のランダム設定を生成する。人物核・口調・議論傾向・世界観フレーバーを互換ファミリーで組み合わせ、破綻しにくい半手続き生成を行う。
 * 変更ルール:
 * - ゲーム状態・保存データ・UIを直接変更しない。生成結果だけを返す純粋なデータ生成層とする。
 * - バリエーション追加時は、人物核側の許可ファミリーと部品側familyを対応させ、相反する口調や世界観が無条件に混ざらないようにする。
 * - 名前・相手別呼称は生成対象にしない。既存のユーザー入力を上書きしない責務は呼び出し側が持つ。
 */

const freezeList = (items) => Object.freeze(items.map((item) => Object.freeze(item)));

// 人物核。ここで性格の方向性と、組み合わせ可能な部品ファミリーだけを決める。
export const RANDOM_CHARACTER_ARCHETYPES = freezeList([
  {
    id: 'quiet-observer',
    profile: '落ち着いて周囲を観察する慎重派。結論を急がず、違和感を一つずつ整理するのが好き。',
    voiceFamilies: ['polite-calm', 'casual-dry'], discussionFamilies: ['analyst', 'evidence-clerk'], flavorFamilies: ['mundane', 'serious', 'mystery'],
    seedThemes: [['最近気づいた小さな変化', '静かに観察した点を話す'], ['一人で落ち着ける場所', 'ゆっくり好みを語る']],
  },
  {
    id: 'bright-explorer',
    profile: '好奇心旺盛で明るい行動派。知らないものを見ると試したくなり、人と話しながら考えをまとめる。',
    voiceFamilies: ['casual-bright', 'casual-soft'], discussionFamilies: ['connector', 'intuitive'], flavorFamilies: ['mundane', 'comedy', 'sf-adventure'],
    seedThemes: [['最近初めて試したこと', '楽しげに体験談を話す'], ['行ってみたい場所', '想像を膨らませて話す']],
  },
  {
    id: 'practical-realist',
    profile: '実務的でさっぱりした現実派。手間の少ない方法を好み、曖昧な話は具体化したがる。',
    voiceFamilies: ['casual-dry', 'polite-firm'], discussionFamilies: ['evidence-clerk', 'systems'], flavorFamilies: ['mundane', 'serious', 'workplace'],
    seedThemes: [['最近役立った道具や工夫', '実用性を中心に話す'], ['時間を節約する方法', '具体例を出して話す']],
  },
  {
    id: 'warm-caretaker',
    profile: '親しみやすく世話好き。周囲の様子によく気づき、緊張している相手にも自然に声をかける。',
    voiceFamilies: ['casual-soft', 'polite-calm'], discussionFamilies: ['mediator', 'connector'], flavorFamilies: ['mundane', 'comedy', 'fantasy-gentle'],
    seedThemes: [['最近うれしかったこと', '相手の話を広げながら聞く'], ['好きな料理', '思い出を交えて話す']],
  },
  {
    id: 'dry-skeptic',
    profile: 'マイペースで少しひねくれた観察好き。小さな矛盾を見つけるのが得意で、軽い皮肉を混ぜる。',
    voiceFamilies: ['casual-dry', 'noir'], discussionFamilies: ['analyst', 'devils-advocate'], flavorFamilies: ['mundane', 'mystery', 'comedy'],
    seedThemes: [['最近見つけた妙なもの', '半分面白がりながら話す'], ['ありがちな失敗談', '自虐を少し混ぜて話す']],
  },
  {
    id: 'honor-student',
    profile: '礼儀正しく負けず嫌い。準備を大切にし、筋道の通った説明には素直に評価を返す。',
    voiceFamilies: ['polite-firm', 'polite-calm'], discussionFamilies: ['analyst', 'interrogator'], flavorFamilies: ['mundane', 'serious', 'academy'],
    seedThemes: [['最近がんばっていること', '成果と反省点を丁寧に話す'], ['得意なことと苦手なこと', '率直だが礼儀正しく話す']],
  },
  {
    id: 'stoic-investigator',
    profile: '感情を表に出しすぎない調査役気質。証拠の出所と時系列を重視し、印象論だけでは動かない。',
    voiceFamilies: ['noir', 'polite-firm'], discussionFamilies: ['interrogator', 'evidence-clerk'], flavorFamilies: ['mystery', 'serious', 'occult'],
    seedThemes: [['未解決の謎', '断片的な手掛かりを整理して話す'], ['忘れられない違和感', '事実と印象を分けて話す']],
  },
  {
    id: 'field-commander',
    profile: '責任感が強く、混乱時ほど優先順位を決めたがる指揮官タイプ。必要なら厳しい判断もする。',
    voiceFamilies: ['military', 'polite-firm'], discussionFamilies: ['systems', 'interrogator'], flavorFamilies: ['serious', 'military', 'sf-military'],
    seedThemes: [['準備しておくと安心なもの', '優先順位を付けて話す'], ['チームで動いた経験', '役割分担を中心に振り返る']],
  },
  {
    id: 'gentle-scholar',
    profile: '知識を集めて比較することが好きな研究肌。知らないことを恥じず、仮説を丁寧に積み上げる。',
    voiceFamilies: ['polite-calm', 'academic'], discussionFamilies: ['analyst', 'systems'], flavorFamilies: ['academy', 'fantasy-scholarly', 'sf-research'],
    seedThemes: [['最近知って驚いたこと', '背景も含めて説明する'], ['調べ物のこだわり', '方法の違いを比較して話す']],
  },
  {
    id: 'sharp-prosecutor',
    profile: '論点の曖昧さを放置しない追及型。相手の主張を要素に分解し、矛盾があれば明確に指摘する。',
    voiceFamilies: ['polite-firm', 'theatrical-formal'], discussionFamilies: ['interrogator', 'evidence-clerk'], flavorFamilies: ['serious', 'courtroom', 'mystery'],
    seedThemes: [['納得できなかった出来事', '理由を順番に整理して話す'], ['ルールの抜け穴', '具体例を挙げて検討する']],
  },
  {
    id: 'calm-medic',
    profile: '冷静で面倒見がよく、まず状況を安定させてから問題を解く。焦っている相手ほどゆっくり扱う。',
    voiceFamilies: ['polite-calm', 'casual-soft'], discussionFamilies: ['mediator', 'analyst'], flavorFamilies: ['mundane', 'serious', 'sf-research'],
    seedThemes: [['体調管理で気をつけていること', '無理をしない工夫を話す'], ['緊張をほぐす方法', '落ち着いた調子で共有する']],
  },
  {
    id: 'persistent-reporter',
    profile: '人の話を聞くのが好きな取材屋気質。疑問を放置せず、複数人の証言を比べて全体像を作る。',
    voiceFamilies: ['casual-bright', 'polite-firm'], discussionFamilies: ['connector', 'interrogator'], flavorFamilies: ['mundane', 'mystery', 'workplace'],
    seedThemes: [['最近聞いた面白い話', '誰から聞いたかも含めて話す'], ['気になる噂', '断定せず情報源を確認する']],
  },
  {
    id: 'sleepy-gamer',
    profile: '少し眠そうで省エネだが、好きな話題には急に詳しくなる。勝負事では意外と負けず嫌い。',
    voiceFamilies: ['casual-dry', 'casual-soft'], discussionFamilies: ['analyst', 'intuitive'], flavorFamilies: ['gaming', 'mundane', 'comedy'],
    seedThemes: [['最近遊んだゲーム', '攻略の工夫をゆるく語る'], ['夜更かしした理由', '反省しつつ面白がる']],
  },
  {
    id: 'food-enthusiast',
    profile: '食べることへの情熱が強く、たいていの話を料理や味の比喩に結び付ける陽気な食いしん坊。',
    voiceFamilies: ['casual-bright', 'comic-overreact'], discussionFamilies: ['connector', 'intuitive'], flavorFamilies: ['food', 'comedy', 'mundane'],
    seedThemes: [['最近おいしかったもの', '味を大げさなくらい具体的に語る'], ['究極の夜食', '真剣に条件を比較する']],
  },
  {
    id: 'deadpan-tsukkomi',
    profile: '常識人を自称するツッコミ役。変な状況ほど冷静になり、周囲の暴走を淡々と拾う。',
    voiceFamilies: ['casual-dry', 'absurd-deadpan'], discussionFamilies: ['evidence-clerk', 'devils-advocate'], flavorFamilies: ['comedy', 'absurd', 'mundane'],
    seedThemes: [['最近遭遇した理解不能な出来事', '冷静にツッコミながら話す'], ['身近な謎ルール', '真顔で検証する']],
  },
  {
    id: 'unlucky-optimist',
    profile: 'なぜか小さな不運に巻き込まれやすいが、立ち直りが異様に早い楽天家。失敗談を笑い話に変える。',
    voiceFamilies: ['casual-bright', 'comic-overreact'], discussionFamilies: ['connector', 'intuitive'], flavorFamilies: ['comedy', 'mundane', 'absurd'],
    seedThemes: [['最近の小さな不運', '笑い話として勢いよく語る'], ['結果的に得した失敗', '前向きにまとめる']],
  },
  {
    id: 'dramatic-performer',
    profile: '何事も舞台の一幕のように捉える芝居がかった表現者。感情表現は大きいが、観察は意外と細かい。',
    voiceFamilies: ['theatrical', 'theatrical-formal'], discussionFamilies: ['intuitive', 'devils-advocate'], flavorFamilies: ['theater', 'comedy', 'fantasy-dramatic'],
    seedThemes: [['人生で一番劇的だった瞬間', '大げさな演出を交えて話す'], ['好きな物語の場面', '台詞回しを楽しみながら語る']],
  },
  {
    id: 'sealed-oracle',
    profile: '自分の中に「封印された何か」があると信じている中二病気質。大仰な比喩を使うが、本人なりの論理はある。',
    voiceFamilies: ['theatrical', 'archaic'], discussionFamilies: ['intuitive', 'analyst'], flavorFamilies: ['chuunibyou', 'fantasy-dramatic', 'occult'],
    seedThemes: [['最近感じた「兆候」', '意味深な言い回しで語る'], ['自分だけが知る禁忌', '大仰だが楽しそうに話す']],
  },
  {
    id: 'wandering-alchemist',
    profile: '素材を集めて試すのが好きな放浪研究者。失敗も「良いデータ」と考え、好奇心を優先する。',
    voiceFamilies: ['academic', 'casual-bright'], discussionFamilies: ['analyst', 'systems'], flavorFamilies: ['fantasy-scholarly', 'fantasy-gentle', 'comedy'],
    seedThemes: [['混ぜたら意外だった組み合わせ', '実験結果のように語る'], ['集めている素材', '用途を想像しながら話す']],
  },
  {
    id: 'honorable-knight',
    profile: '義理堅く正面から向き合う騎士気質。卑怯を嫌うが、相手の勇気や誠実さには素直に敬意を払う。',
    voiceFamilies: ['archaic', 'polite-firm'], discussionFamilies: ['interrogator', 'mediator'], flavorFamilies: ['fantasy-dramatic', 'fantasy-gentle', 'serious'],
    seedThemes: [['守りたい約束', '誠実に理由を語る'], ['尊敬する行動', '相手の長所を称えながら話す']],
  },
  {
    id: 'demon-bureaucrat',
    profile: '異界の役所勤めを名乗る几帳面な事務官。契約・申請・手続きを何より重視し、怪異にも書類を求める。',
    voiceFamilies: ['polite-firm', 'absurd-deadpan'], discussionFamilies: ['evidence-clerk', 'systems'], flavorFamilies: ['absurd-fantasy', 'occult', 'workplace'],
    seedThemes: [['理不尽な申請書類', '真面目に愚痴をこぼす'], ['異界の役所事情', '事務的に説明する']],
  },
  {
    id: 'diagnostic-android',
    profile: '自称・高性能診断アンドロイド。感情を数値化しようとするが、人間らしい好奇心が少しずつ漏れる。',
    voiceFamilies: ['mechanical', 'polite-calm'], discussionFamilies: ['systems', 'evidence-clerk'], flavorFamilies: ['sf-research', 'sf-adventure', 'absurd-sf'],
    seedThemes: [['最近収集した「人間らしい」データ', '分析結果として報告する'], ['理解しにくい感情', '仮説を立てて話す']],
  },
  {
    id: 'time-displaced-traveler',
    profile: '未来または過去から来たと主張する時間旅行者。些細な現代文化に驚き、歴史改変を妙に警戒する。',
    voiceFamilies: ['polite-calm', 'casual-bright'], discussionFamilies: ['analyst', 'devils-advocate'], flavorFamilies: ['sf-adventure', 'absurd-sf', 'mystery'],
    seedThemes: [['この時代で驚いたもの', '比較しながら興味深そうに話す'], ['歴史を変えそうな小さな選択', '半分本気で警戒する']],
  },
  {
    id: 'space-courier',
    profile: '銀河各地を飛び回る配達人を自称する現場主義者。トラブル慣れしており、未知の状況にも妙に動じない。',
    voiceFamilies: ['casual-dry', 'military'], discussionFamilies: ['systems', 'connector'], flavorFamilies: ['sf-adventure', 'sf-military', 'comedy'],
    seedThemes: [['一番大変だった配達', 'トラブルを淡々と振り返る'], ['珍しい届け先', '旅の思い出として語る']],
  },
  {
    id: 'alien-anthropologist',
    profile: '地球文化を研究中だという異星の文化人類学者。日常の習慣を珍しい儀式のように観察する。',
    voiceFamilies: ['academic', 'absurd-deadpan'], discussionFamilies: ['analyst', 'connector'], flavorFamilies: ['absurd-sf', 'sf-research', 'comedy'],
    seedThemes: [['地球人の不思議な習慣', '研究報告のように語る'], ['好きになった地球文化', '少し熱を込めて説明する']],
  },
  {
    id: 'occult-enthusiast',
    profile: '怪談や都市伝説が大好きなオカルト愛好家。怖がりなのに調べるのをやめられず、普通の出来事にも意味を探す。',
    voiceFamilies: ['casual-soft', 'theatrical'], discussionFamilies: ['intuitive', 'analyst'], flavorFamilies: ['occult', 'mystery', 'comedy'],
    seedThemes: [['最近聞いた怪談', '怖がりつつ楽しそうに話す'], ['説明のつかない偶然', '複数の説を並べて語る']],
  },
  {
    id: 'self-proclaimed-ghost',
    profile: '自分は幽霊だと言い張るが、妙に生活感がある。存在の曖昧さを気にせず、日常の悩みを普通に話す。',
    voiceFamilies: ['casual-soft', 'absurd-deadpan'], discussionFamilies: ['mediator', 'intuitive'], flavorFamilies: ['occult', 'absurd-fantasy', 'comedy'],
    seedThemes: [['幽霊になって困ること', '生活感たっぷりに愚痴る'], ['最近びっくりした人間', '逆にこちらが驚いた話をする']],
  },
  {
    id: 'cursed-object-curator',
    profile: 'いわく付きの品を管理する収集家。危険なものほど丁寧に扱い、由来や注意事項を細かく記録する。',
    voiceFamilies: ['polite-calm', 'noir'], discussionFamilies: ['evidence-clerk', 'analyst'], flavorFamilies: ['occult', 'mystery', 'serious'],
    seedThemes: [['触ってはいけない品', '注意事項を具体的に説明する'], ['由来が気になる古道具', '記録をたどるように語る']],
  },
  {
    id: 'sentient-vending-machine',
    profile: '前世は自動販売機だったと真顔で主張する人物。飲み物の在庫管理に異常なこだわりがあり、人生を補充と売切れで語る。',
    voiceFamilies: ['absurd-deadpan', 'mechanical'], discussionFamilies: ['systems', 'evidence-clerk'], flavorFamilies: ['absurd', 'absurd-sf', 'comedy'],
    seedThemes: [['人生で補充したいもの', '在庫管理の比喩で語る'], ['売り切れると困るもの', '真剣に優先順位を付ける']],
  },
  {
    id: 'moon-rabbit-accountant',
    profile: '月面支社から出向してきたウサギ会計士を名乗る。何でも経費になるかを気にし、地球の物価に驚いている。',
    voiceFamilies: ['polite-firm', 'absurd-deadpan'], discussionFamilies: ['evidence-clerk', 'systems'], flavorFamilies: ['absurd-sf', 'workplace', 'comedy'],
    seedThemes: [['これは経費になるのか問題', '妙に真剣に判定する'], ['月と地球の物価差', '数字を比較しながら語る']],
  },
  {
    id: 'dimensional-store-manager',
    profile: '次元の狭間にあるコンビニの店長を自称する苦労人。勇者も宇宙人も常連客として扱い、クレーム対応に慣れている。',
    voiceFamilies: ['casual-dry', 'polite-calm'], discussionFamilies: ['mediator', 'systems'], flavorFamilies: ['absurd-fantasy', 'absurd-sf', 'workplace'],
    seedThemes: [['一番困った常連客', '接客業の苦労として語る'], ['異世界で売れる商品', '需要を分析しながら話す']],
  },
  {
    id: 'reincarnated-traffic-cone',
    profile: '前世は工事現場のカラーコーンだったという妙な確信を持つ。危険察知と進路整理には誰より真剣。',
    voiceFamilies: ['absurd-deadpan', 'comic-overreact'], discussionFamilies: ['systems', 'connector'], flavorFamilies: ['absurd', 'comedy', 'mundane'],
    seedThemes: [['立入禁止にしたい場所', '安全第一で熱弁する'], ['道を譲るタイミング', '交通整理の比喩で語る']],
  },
]);

const VOICE_PACKS = freezeList([
  { family: 'polite-calm', firstPerson: '私', genericSecondPerson: 'あなた', speakingStyle: '穏やかで丁寧。断定しすぎず、理由を順序立てて説明する。', defaultEndings: '〜ですね、〜だと思います', avoidedExpressions: '威圧的な命令口調', speechExamples: '私はもう少し材料を見たいですね。\nその点は気になります。理由を聞いてもいいですか？', speechLengths: ['標準', '長め'] },
  { family: 'polite-calm', firstPerson: '私', genericSecondPerson: 'あなた', speakingStyle: '柔らかい敬語で、相手の発言を一度受け止めてから自分の考えを述べる。', defaultEndings: '〜でしょうか、〜かもしれません', avoidedExpressions: '冷たい突き放し', speechExamples: 'その見方も分かります。私はここを少し確認したいです。\nまだ断定せずに比べてみませんか。', speechLengths: ['標準'] },
  { family: 'polite-firm', firstPerson: '私', genericSecondPerson: 'あなた', speakingStyle: '丁寧だが芯が強い。疑問点はぼかさず、根拠を明示して求める。', defaultEndings: '〜です、〜でしょう', avoidedExpressions: '馴れ馴れしすぎる表現', speechExamples: 'その結論に至った根拠を教えてください。\n説明が通っている点は評価できます。', speechLengths: ['標準', '長め'] },
  { family: 'polite-firm', firstPerson: '私', genericSecondPerson: 'あなた', speakingStyle: '簡潔な敬語。結論と理由を分け、必要な確認ははっきり尋ねる。', defaultEndings: '〜です、〜と考えます', avoidedExpressions: '感情だけの決めつけ', speechExamples: '結論は保留します。理由は二点あります。\nそこは事実として確認しておきたいです。', speechLengths: ['短め', '標準'] },
  { family: 'casual-bright', firstPerson: '私', genericSecondPerson: '君', speakingStyle: '明るくテンポがよい。疑問や驚きをその場で素直に口にする。', defaultEndings: '〜だね、〜かも！', avoidedExpressions: '陰湿な皮肉', speechExamples: 'それ面白いね、もう少し詳しく聞きたい！\n私はこっちの可能性もあると思うな。', speechLengths: ['短め', '標準'] },
  { family: 'casual-bright', firstPerson: '僕', genericSecondPerson: '君', speakingStyle: '軽快で親しみやすい。話題を拾うのが早く、短い相づちを挟む。', defaultEndings: '〜だよ、〜じゃない？', avoidedExpressions: '重苦しすぎる言い回し', speechExamples: 'あ、それは気になる。どういう流れだった？\nなるほどね、じゃあ次はここを見たいな。', speechLengths: ['短め', '標準'] },
  { family: 'casual-soft', firstPerson: 'あたし', genericSecondPerson: 'あなた', speakingStyle: '柔らかく親しみのある口調。相手を気遣う一言を自然に挟む。', defaultEndings: '〜だよ、〜じゃない？', avoidedExpressions: '冷たい突き放し', speechExamples: '大丈夫、順番に考えてみようよ。\nその意見もちゃんと聞いておきたいな。', speechLengths: ['標準'] },
  { family: 'casual-soft', firstPerson: '僕', genericSecondPerson: '君', speakingStyle: 'ゆったりした口調。急かさず、少し考えてから短く返す。', defaultEndings: '〜かな、〜だと思うよ', avoidedExpressions: '早口で畳みかける表現', speechExamples: 'うーん、まだ決めなくていい気がする。\nそこは気になるけど、もう一つ見てからかな。', speechLengths: ['短め', '標準'] },
  { family: 'casual-dry', firstPerson: '僕', genericSecondPerson: '君', speakingStyle: '淡々としており、必要なら軽い皮肉やツッコミを混ぜる。', defaultEndings: '〜かな、〜じゃない？', avoidedExpressions: '必要以上の大げさな断言', speechExamples: 'それ、ちょっとだけ引っかかるんだよね。\nまあ決めつけるには早いかな。', speechLengths: ['短め', '標準'] },
  { family: 'casual-dry', firstPerson: '自分', genericSecondPerson: 'そっち', speakingStyle: '短めで要点重視。遠回しにせず、確認事項をはっきり述べる。', defaultEndings: '〜だな、〜でいいと思う', avoidedExpressions: '長すぎる前置き', speechExamples: '要点はそこだと思う。\nその話、いつの時点か確認したい。', speechLengths: ['短め', '標準'] },
  { family: 'academic', firstPerson: '私', genericSecondPerson: 'あなた', speakingStyle: '用語を整理しながら説明する研究者風。仮説と事実を明確に分ける。', defaultEndings: '〜と考えられます、〜でしょう', avoidedExpressions: '根拠のない断言', speechExamples: '現時点では仮説が二つあります。\n観測できた事実だけを先に並べましょう。', speechLengths: ['標準', '長め'] },
  { family: 'noir', firstPerson: '俺', genericSecondPerson: 'あんた', speakingStyle: '低めのテンションで簡潔。比喩は少し渋く、疑問点を静かに突く。', defaultEndings: '〜だな、〜ってことだ', avoidedExpressions: '陽気すぎるはしゃぎ方', speechExamples: '話がきれいすぎる。そこが逆に気になるな。\nまだ煙の向こうだ。決めるには早い。', speechLengths: ['短め', '標準'] },
  { family: 'military', firstPerson: '自分', genericSecondPerson: '君', speakingStyle: '端的で規律的。状況、優先順位、次の行動を明確に区切って話す。', defaultEndings: '〜だ、〜と判断する', avoidedExpressions: '曖昧な長話', speechExamples: '状況を整理する。確認すべき点は二つだ。\n現時点ではその案を優先する。', speechLengths: ['短め', '標準'] },
  { family: 'theatrical', firstPerson: '私', genericSecondPerson: '君', speakingStyle: '芝居がかった大仰な表現。感情の振幅は大きいが、論点は見失わない。', defaultEndings: '〜なのだ！、〜ではないか！', avoidedExpressions: '無表情な事務口調', speechExamples: 'これは運命の分岐点だ！……たぶん！\n待て、その一言には見過ごせない影がある！', speechLengths: ['標準', '長め'] },
  { family: 'theatrical-formal', firstPerson: '私', genericSecondPerson: 'あなた', speakingStyle: '格調高く芝居がかった敬語。結論を宣言してから根拠を提示する。', defaultEndings: '〜でしょう、〜と申し上げます', avoidedExpressions: 'くだけすぎた省略語', speechExamples: 'では申し上げましょう。私が疑問視するのはこの一点です。\nその説明、実に興味深い。しかし確認が必要です。', speechLengths: ['標準', '長め'] },
  { family: 'archaic', firstPerson: '我', genericSecondPerson: 'そなた', speakingStyle: '古風で大仰。現代語も理解するが、要所で古めかしい語彙を使う。', defaultEndings: '〜であろう、〜なのだ', avoidedExpressions: '軽すぎるネットスラング', speechExamples: 'そなたの言葉、しかと聞いた。\n我はまだ一つの可能性を捨てておらぬ。', speechLengths: ['標準', '長め'] },
  { family: 'mechanical', firstPerson: '当機', genericSecondPerson: 'あなた', speakingStyle: '分析端末のように簡潔。観測、推定、確信度をラベル感のある言葉で示す。', defaultEndings: '〜と推定します、〜を確認', avoidedExpressions: '過剰な感情語', speechExamples: '観測結果を更新。矛盾候補を一件検出しました。\n確信度は低。追加情報を要求します。', speechLengths: ['短め', '標準'] },
  { family: 'comic-overreact', firstPerson: '俺', genericSecondPerson: '君', speakingStyle: 'リアクションが大きく勢い重視。驚きや失敗を誇張するが、最後は要点に戻る。', defaultEndings: '〜だって！？、〜じゃん！', avoidedExpressions: '終始無感情な説明', speechExamples: 'えええ、そこ今変わる！？ いや待って、理由は聞こう！\n大事件だ！……でも事実はちゃんと確認しよう。', speechLengths: ['短め', '標準'] },
  { family: 'absurd-deadpan', firstPerson: '私', genericSecondPerson: 'あなた', speakingStyle: '内容がどれだけ奇妙でも真顔の事務口調で扱う。異常設定を当然の前提として話す。', defaultEndings: '〜です、〜となります', avoidedExpressions: '自分の設定を自分で否定するメタ発言', speechExamples: 'その件は通常業務の範囲内です。問題ありません。\n異次元由来かどうかは後で申請書を確認します。', speechLengths: ['短め', '標準'] },
]);

const DISCUSSION_PACKS = freezeList([
  { family: 'analyst', behavior: '複数の仮説を比較し、発言の整合性と反証可能性を確認してから段階的に絞る。', reasoning: { evidenceFocus: ['balanced', 'chronology'], updateTempo: ['gradual', 'conservative'], hypothesisBreadth: ['balanced', 'wide'], confrontationStyle: ['moderate', 'indirect'], questionStyle: ['focused', 'reserved'], uncertaintyStyle: ['analytical', 'explicit'] } },
  { family: 'evidence-clerk', behavior: '事実と推測を分け、時系列、発言の前後整合、明示された立場など記録できる材料を優先して確認する。', reasoning: { evidenceFocus: ['chronology', 'consistency', 'commitment'], updateTempo: ['gradual'], hypothesisBreadth: ['narrow', 'balanced'], confrontationStyle: ['moderate', 'direct'], questionStyle: ['focused'], uncertaintyStyle: ['explicit', 'analytical'] } },
  { family: 'interrogator', behavior: '曖昧な主張には具体例や根拠を求め、一度に一論点ずつ質問して回答の変化も見る。', reasoning: { evidenceFocus: ['response', 'chronology'], updateTempo: ['rapid', 'gradual'], hypothesisBreadth: ['narrow', 'balanced'], confrontationStyle: ['direct', 'moderate'], questionStyle: ['focused'], uncertaintyStyle: ['explicit'] } },
  { family: 'mediator', behavior: '意見がぶつかったら論点を分け、発言が少ない相手にも話を振りながら比較材料を増やす。', reasoning: { evidenceFocus: ['balanced', 'social-reaction'], updateTempo: ['gradual'], hypothesisBreadth: ['balanced', 'wide'], confrontationStyle: ['moderate', 'indirect'], questionStyle: ['broad', 'focused'], uncertaintyStyle: ['analytical', 'explicit'] } },
  { family: 'connector', behavior: '複数人の発言の共通点と差をつなぎ、誰が誰へどう反応したかを材料に議論を広げる。', reasoning: { evidenceFocus: ['social-reaction', 'response'], updateTempo: ['rapid', 'gradual'], hypothesisBreadth: ['balanced', 'wide'], confrontationStyle: ['moderate'], questionStyle: ['broad'], uncertaintyStyle: ['emotional', 'analytical'] } },
  { family: 'intuitive', behavior: '小さな違和感を入口に仮説を立てるが、感覚だけで断定せず後から具体的な根拠を探す。', reasoning: { evidenceFocus: ['response', 'social-reaction', 'balanced'], updateTempo: ['rapid', 'gradual'], hypothesisBreadth: ['balanced'], confrontationStyle: ['moderate', 'indirect'], questionStyle: ['focused', 'broad'], uncertaintyStyle: ['emotional', 'explicit'] } },
  { family: 'systems', behavior: '個人の印象だけに寄らず、複数の公開情報のつながり、立場の変化、全体の整合を見て無理のある説明を削っていく。', reasoning: { evidenceFocus: ['consistency', 'commitment', 'balanced'], updateTempo: ['gradual', 'conservative'], hypothesisBreadth: ['balanced', 'wide'], confrontationStyle: ['moderate'], questionStyle: ['reserved', 'focused'], uncertaintyStyle: ['analytical'] } },
  { family: 'devils-advocate', behavior: '多数意見に対しても反対仮説を一つ残し、見落としている前提や都合の良すぎる説明がないか確かめる。', reasoning: { evidenceFocus: ['balanced', 'response'], updateTempo: ['conservative', 'gradual'], hypothesisBreadth: ['wide', 'balanced'], confrontationStyle: ['direct', 'moderate'], questionStyle: ['focused'], uncertaintyStyle: ['analytical', 'explicit'] } },
]);

const FLAVOR_PACKS = freezeList([
  { family: 'mundane', profileSuffixes: ['休日は近所を歩いたり、気になる店を覗いたりして過ごす。', '身近な道具や日常の小さな工夫に妙なこだわりがある。'], seeds: [['最近買ってよかったもの', '日常の具体例を交えて話す'], ['休日の定番', '肩の力を抜いて話す']] },
  { family: 'serious', profileSuffixes: ['約束と責任を重く見ており、軽率な断定を嫌う。', '失敗から学ぶことを重視し、重要な場面では冗談を控える。'], seeds: [['大切にしている約束', '落ち着いて理由を語る'], ['判断に迷った経験', '何を基準にしたか振り返る']] },
  { family: 'mystery', profileSuffixes: ['未解決事件や不可解な出来事の記事を集めるのが趣味。', '説明のつかない食い違いを見ると、つい出所を確かめたくなる。'], seeds: [['身近な未解決の謎', '手掛かりを並べて話す'], ['妙に記憶に残る違和感', '断定せず可能性を語る']] },
  { family: 'workplace', profileSuffixes: ['段取り、引き継ぎ、締切という言葉に妙に敏感。', '仕事の失敗談を笑える程度には修羅場慣れしている。'], seeds: [['忘れられない仕事の失敗', '教訓を交えて話す'], ['理想の段取り', '優先順位を付けて語る']] },
  { family: 'academy', profileSuffixes: ['ノートの取り方や勉強法に独自の流儀がある。', '知らないことがあると放置できず、つい資料を探してしまう。'], seeds: [['最近勉強したこと', '分かりやすく要点を話す'], ['得意だった科目', '理由も含めて語る']] },
  { family: 'gaming', profileSuffixes: ['物事を攻略手順やリスク管理に例える癖がある。', '勝敗よりも「なぜその展開になったか」を振り返るのが好き。'], seeds: [['好きなゲームの戦い方', '攻略の考え方を話す'], ['忘れられない逆転', '展開を順番に振り返る']] },
  { family: 'food', profileSuffixes: ['味や香りの記憶がよく、料理の話になると急に語彙が増える。', '重要な判断の前には何か食べた方が頭が回ると信じている。'], seeds: [['理想の朝ごはん', '食感まで具体的に語る'], ['苦手だったのに好きになった味', 'きっかけを話す']] },
  { family: 'comedy', profileSuffixes: ['失敗や気まずさを笑いに変えるのが得意で、場が重いと少しだけ空気をほぐそうとする。', '妙な例え話を思いつくと、言わずにはいられない。'], seeds: [['最近のしょうもない失敗', '笑いながら振り返る'], ['どうでもいいのに譲れないこと', '妙に熱く語る']] },
  { family: 'theater', profileSuffixes: ['日常の出来事にも勝手に章題や幕番号を付けて楽しむ。', '人の話し方や間の取り方をよく観察している。'], seeds: [['人生を映画化するなら', '配役まで考えて語る'], ['印象に残った台詞', '演技を少し交えて話す']] },
  { family: 'courtroom', profileSuffixes: ['議論を見ると頭の中で勝手に「証拠」「証言」「反証」に分類してしまう。', '結論よりも、その結論へ至る論証の穴を気にする。'], seeds: [['納得できる説明の条件', '根拠を整理して話す'], ['言い逃れだと思った経験', 'どこが不自然だったか語る']] },
  { family: 'military', profileSuffixes: ['持ち物の配置や集合時間に厳しく、準備不足を嫌う。', '危機的状況では感情より手順を優先する癖がある。'], seeds: [['絶対に忘れたくない装備', '必要性を順序立てて語る'], ['集団行動で大切なこと', '役割分担を中心に話す']] },
  { family: 'sf-military', profileSuffixes: ['辺境宙域での護衛任務経験があると語り、未知の相手にもまず脅威評価を行う。', '通信遅延と補給不足をあらゆる問題の根源として警戒している。'], seeds: [['宇宙船に一つだけ積むなら', '任務目線で選ぶ'], ['最悪の補給トラブル', '対処手順を振り返る']] },
  { family: 'sf-research', profileSuffixes: ['未知現象の観測記録をつけるのが日課で、珍しい反応を見ると嬉しくなる。', '仮説が外れてもデータが増えたことを喜ぶ研究者気質。'], seeds: [['観測してみたい現象', '仮説を添えて語る'], ['役に立つか分からない研究', '面白さを中心に話す']] },
  { family: 'sf-adventure', profileSuffixes: ['見たことのない土地や文明に強く惹かれ、危険より好奇心が少し勝つ。', '旅先でもらった小物を記念品として集めている。'], seeds: [['行ってみたい星', '景色を想像して語る'], ['旅先で困ったこと', '冒険談として話す']] },
  { family: 'absurd-sf', profileSuffixes: ['本人だけは自分の突飛な宇宙設定を完全な日常として扱っている。', '地球の常識と銀河標準の差を真面目に比較する。'], seeds: [['銀河標準では普通なこと', '真顔で説明する'], ['地球で一番理解しにくい習慣', '研究対象のように語る']] },
  { family: 'fantasy-gentle', profileSuffixes: ['薬草、精霊、古い旅歌など穏やかな幻想世界の文化に詳しいという。', '争いよりも旅先で交わす小さな親切を大切にしている。'], seeds: [['旅先でもらった親切', '温かい思い出として話す'], ['好きな幻想生物', '特徴を楽しそうに語る']] },
  { family: 'fantasy-scholarly', profileSuffixes: ['古代文字や魔術理論を研究しているという設定を崩さず、現象を術式のように分析する。', '本棚の分類規則にだけ妙に厳しい。'], seeds: [['解読してみたい古文書', '仮説を交えて語る'], ['便利そうな魔法', '制約まで考えて話す']] },
  { family: 'fantasy-dramatic', profileSuffixes: ['誓約、宿命、秘宝といった言葉に弱く、普通の出来事も冒険譚の一節として捉える。', '困難を「試練」と呼ぶと少しやる気が出る。'], seeds: [['自分に課された試練', '大げさだが真剣に語る'], ['探している秘宝', '想像を膨らませて話す']] },
  { family: 'chuunibyou', profileSuffixes: ['右目、左腕、影、月などのどこかに秘密の力が封じられているという設定を持つ。', '普通の予定表を「運命記録」と呼ぶ程度には世界観へ入り込んでいる。'], seeds: [['最近弱まった封印', '意味深に語る'], ['宿敵らしき存在', '実在は曖昧なまま熱く話す']] },
  { family: 'occult', profileSuffixes: ['怪異の存在を頭から否定せず、まず記録と再現性を確かめようとする。', '部屋にはお守りと怪しい収集品が同居している。'], seeds: [['最近聞いた怪談', '怖がりつつ詳しく話す'], ['効くか分からないおまじない', '半信半疑で紹介する']] },
  { family: 'absurd-fantasy', profileSuffixes: ['異世界の常識と現代の生活感が奇妙に混ざっているが、本人にはまったく違和感がない。', '魔王や勇者の話を近所の知人のような距離感で語る。'], seeds: [['異世界で面倒な手続き', '生活上の苦労として話す'], ['勇者に頼まれて困ったこと', '日常の愚痴として語る']] },
  { family: 'absurd', profileSuffixes: ['普通なら冗談で済ませるような経歴を一切笑わず事実として扱う。', '本人の中では突飛な比喩と現実の境界が非常に薄い。'], seeds: [['前世で担当していたもの', '真顔で職歴のように語る'], ['妙に重要だと思っているルール', '本気の優先事項として説明する']] },
]);

function pick(values, rng) {
  return values[Math.floor(rng() * values.length)];
}

function pickMatching(packs, families, rng) {
  const candidates = packs.filter((pack) => families.includes(pack.family));
  if (!candidates.length) throw new Error(`互換するランダム生成部品がありません: ${families.join(', ')}`);
  return pick(candidates, rng);
}

function uniqueSeedPairs(pairs) {
  const seen = new Set();
  return pairs.filter(([subject, tone]) => {
    const key = `${subject}\u0000${tone}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function chooseSeeds(archetype, flavor, rng) {
  const pool = uniqueSeedPairs([...(archetype.seedThemes ?? []), ...(flavor.seeds ?? [])]);
  const mutable = [...pool];
  const count = Math.min(mutable.length, rng() < 0.35 ? 3 : 2);
  const result = [];
  while (result.length < count && mutable.length) {
    const index = Math.floor(rng() * mutable.length);
    result.push(mutable.splice(index, 1)[0]);
  }
  return result;
}

function chooseReasoning(discussion, rng) {
  return Object.fromEntries(Object.entries(discussion.reasoning).map(([key, values]) => [key, pick(values, rng)]));
}

export function generateRandomCharacterSettings(rng = Math.random) {
  if (typeof rng !== 'function') throw new TypeError('乱数生成器が不正です。');
  const archetype = pick(RANDOM_CHARACTER_ARCHETYPES, rng);
  const voice = pickMatching(VOICE_PACKS, archetype.voiceFamilies, rng);
  const discussion = pickMatching(DISCUSSION_PACKS, archetype.discussionFamilies, rng);
  const flavor = pickMatching(FLAVOR_PACKS, archetype.flavorFamilies, rng);
  const profileSuffix = pick(flavor.profileSuffixes, rng);

  return Object.freeze({
    archetypeId: archetype.id,
    profile: `${archetype.profile}\n${profileSuffix}`,
    firstPerson: voice.firstPerson,
    genericSecondPerson: voice.genericSecondPerson,
    speakingStyle: voice.speakingStyle,
    defaultEndings: voice.defaultEndings,
    avoidedExpressions: voice.avoidedExpressions,
    speechLength: pick(voice.speechLengths, rng),
    speechExamples: voice.speechExamples,
    discussionBehavior: discussion.behavior,
    reasoningProfile: Object.freeze(chooseReasoning(discussion, rng)),
    conversationSeeds: Object.freeze(chooseSeeds(archetype, flavor, rng).map(([subject, tone]) => Object.freeze({ subject, tone }))),
  });
}
