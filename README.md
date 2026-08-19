# AI人狼マネージャー 開発者向けREADME

複数のLLMを個別プレイヤーとして動作させ、人間参加者とAI参加者が混在する4～16人の人狼ゲームを進行・記録し、同じキャラクターデータとAIプロファイルを使った人狼非依存の自由会話と、人狼卓を推理視点／神視点で追っかけ・リアルタイム実況する観戦チャットも提供するElectronアプリです。

ユーザー向けの操作説明は `app/README.txt` に分離しています。配布版では、このファイルを実行ファイルと同じ階層へ `README.txt` として配置し、プロジェクト直下の `LICENSE.txt` も同じ階層へ同梱します。

## 1. 開発環境

- Windows x64
- Node.js 22.12.0以上
- npm
- 配布版生成時のみ、Windows PowerShellとelectron-builderが必要

依存関係は `tools/package-lock.json` を正本とし、開発用ElectronやTypeScriptは `tools/node_modules` にだけ導入します。`app` 側へ開発依存を追加しないでください。

## 2. 最初の起動

プロジェクト直下の次のファイルを実行します。

```text
AI人狼を起動.cmd
```

この起動入口は以下を自動実行します。

1. Node.jsとnpmの存在確認
2. `tools/node_modules` の固定依存関係導入またはElectron本体の復旧
3. 現行Rendererソースと生成bundleの一致確認
4. 開発版Electronの起動

コマンドラインから起動する場合は次を使用します。

```powershell
cd tools
npm ci --no-audit --no-fund
npm run start
```

## 3. ディレクトリ責務

```text
app/
  main/                    Electron Main、IPC、設定、秘密鍵、LLM通信、自動保存
  renderer/
    js/domain/             人狼のルール・状態遷移、独立した自由会話状態、人狼観戦状態
    js/state/              現行ゲーム状態の検証、Undo・Redo、復元
    js/prompts/            LLMプロンプト、応答契約、解析、修復
    js/services/           生成工程とAIタスクサービス
    js/ui/                 画面調停とビュー
    js/automation/         自動実行状態、AI管理、手動生成、実行中ロックと画面接続
    js/ai/                 API再試行、デモAI、ローカルLLM共有設定
    js/public/             公開表示、公開HTML出力、観戦用の時点再生Projection
    css/styles.css         通常アプリ全体の表示スタイル
    css/publicView.css     公開表示と単体公開HTMLの表示スタイル正本
    data/characters/       管理グループ別のキャラクターJSON・呼称・クレジット
    generated/             自動生成bundle・ビルド識別情報・公開表示埋め込みCSS
  README.txt               配布利用者向けREADME
  shared/dataCompatibility/ 製品版ユーザーデータschemaと一方向Migrationの正本
tools/
  build/                   bundle生成、製造ゲート、配布製造、ソース抽出
  tests/game/              ゲーム規則とRenderer側回帰テスト
  tests/desktop/           Main、IPC、配布、生成物の回帰テスト
docs/
  AI_WORK_RULES.md         実装時に必ず守る製造規約
  DATA_COMPATIBILITY.md    製品版ユーザーデータの後方互換・Migration仕様
  CHAT_ROOM_SPEC.md        人狼非依存の自由会話の現行仕様
  SPECTATOR_ROOM_SPEC.md   人狼観戦チャットの現行仕様
  tests/                   ゲーム／1プレイヤー／自由会話／人狼観戦の手動通しテスト手順
```

Mainはゲーム規則やDOMを扱いません。RendererのUIは秘密鍵を扱いません。ゲーム規則、状態検証、プロンプト、通信、画面の責務を横断して重複実装しないでください。

## 4. 生成物

`app/renderer/generated/` は手編集禁止です。実行ロジックの正本は `app/renderer/js/`、組み込みキャラクターデータの正本は `app/renderer/data/characters/` 配下です。

生成物を更新する場合は次を実行します。

```powershell
cd tools
npm run verify
```

`verify` は次を順番に実行します。

1. 製造事前ゲート
2. 決定的なRenderer bundle生成
3. 生成後の完全製造ゲート
4. ゲーム契約テスト
5. デスクトップ契約テスト

`bundle.js`、`buildInfo.js`、`index.html`のbundleキャッシュキーは同一の現行JS・CSS・キャラクターJSON・HTMLから決定的に生成されます。`buildInfo.js`が生成メタデータの唯一の正本で、`BUILD_ID`と`BUNDLE_SHA256`を保持します。個別に書き換えないでください。

## 5. テスト

```powershell
cd tools
npm run test:game
npm run test:desktop
npm run verify
```

変更時は現行仕様の契約・境界・代表経路をテストで確認し、最終的に `npm run verify` を通してください。過去の不具合だけを再現する専用テストや、同じ契約の重複テストは残しません。製品版データMigrationの旧schema fixture／移行テストだけは、将来の後方互換そのものを保証する契約として保持します。

主な検査対象は次のとおりです。

- ゲーム状態と参照整合性
- 公開情報と秘密情報の境界
- AI応答契約と生成工程
  - Prompt Envelopeは`commonGameContext → taskInvariantContext → stablePlayerContext → taskVariableContext → dynamicTaskPrompt`の順とし、キャッシュ効率より応答品質と意味上の責務を優先します。役職・局面・出力契約などの可変情報をキャッシュ対象へ移しません。キャッシュ可否とProviderのsystem/user配置は別に扱い、Envelope再区分で指示のmessage roleを不用意に弱めません。
  - `最終確認`以下は軽量LLM向けの最低限の返却条件として必ず末尾に維持します。深度3・4のdraftは公開履歴の射影だけを使用し、生イベント管理情報を工程プロンプトへ渡しません。内部UUIDは雪女の能力対象など機械契約がID返却を明示要求する箇所以外へ渡しません。
- Main／RendererのIPC境界
- API設定、APIキー暗号化、エラー分類
- 自動保存の順序保証、書込失敗後の最新状態保持、終了時flush
- AI全自動開始の直列化と二重実行防止
- 人狼Stateと自由会話Stateの分離、通常巡回と質問回答優先ターンの分離、弱い会話きっかけ、個別内部メモ・参加者差し替え
- 人狼観戦StateとゲームStateの分離、任意公開ログからの追っかけ再生、1ログ送り、再生時点盤面Projection、未来情報遮断、リアルタイム合流と共通1手進行
- API使用量・料金のAIプロファイル別集計とプロファイル利用上限
- 自動実行状態と表示タブの分離、一時停止／再開の非ゲーム状態化、競合操作ロック
- 公開HTML出力時の機密スナップショット分離。機密非表示で出力したHTMLへ機密表示専用データを埋め込まないこと
- 設定ファイル保存成功後だけの実行中設定反映
- Rendererモジュールの到達可能性
- 生成bundleの鮮度・決定性
- 配布対象と開発物の分離
- ユーザー向けREADMEと本体MIT Licenseの配布同梱

## 6. 配布版の生成

Windows環境で、プロジェクト直下の次のファイルを実行します。

```text
配布版を作成.cmd
```

または次を実行します。

```powershell
cd tools
npm run release
```

生成先は `output/dist` です。

```text
AI人狼マネージャー-<version>-win-x64.zip
AI人狼マネージャー-<version>-Setup-x64.exe
SHA256SUMS.txt
build-report.txt
```

配布工程では依存関係を固定導入し、bundle生成、製造ゲート、全回帰テスト、Windows x64配布物生成、成果物サイズ検査、ユーザー向けREADME、本体MIT License、Electron/Chromium第三者ライセンスの同梱検査、SHA-256生成を行います。失敗時は不完全な `output/dist` を削除します。

`tools/build/electron-builder.json` の `extraFiles` により、`app/README.txt` は配布版の実行ファイルと同じ階層へ `README.txt` として、プロジェクト直下の `LICENSE.txt` は同じ階層へ `LICENSE.txt` として配置されます。この契約を削除・変更する場合は、製造ゲートと配布回帰テストも同時に更新してください。

## 7. AI修正依頼用ソースZIP

プロジェクト直下の次のファイルを実行します。

```text
ソース一式作成.cmd
```

`output/ai_werewolf_manager_vXX_XX_XX.zip` が生成されます。`.github`、`output`、`tools/node_modules`だけを除外し、ディレクトリ構成を維持します。生成前にRenderer生成物の鮮度と製造ゲートを確認します。

## 8. バージョン管理

製品版の初期versionは `1.0.0` とします。アプリversionは利用者向けのリリース番号、`BUILD_ID`は同一version内の生成物識別子として分離します。

版番号の正本は以下です。

- `app/package.json`
- `tools/package.json`

両方を同じ値へ更新してください。生成bundle更新後、`npm run verify`を通してから配布してください。GitHubのタグから配布する場合、タグ名の先頭`v`を除いた値と`app/package.json`の版番号が一致する必要があります。

アプリversionはSemantic Versioningの`MAJOR.MINOR.PATCH`で更新します。更新区分は次を正本とし、同一リリースで複数区分に該当する場合は最も大きい区分を採用します。

- `PATCH`（例: `1.0.0` → `1.0.1`）: 不具合修正、既存仕様どおりの挙動へ戻す修正、利用方法や互換契約を変えない内部改善。
- `MINOR`（例: `1.0.1` → `1.1.0`）: 新機能、新役職、新しい設定項目など、既存の利用方法を壊さない機能追加・拡張。
- `MAJOR`（例: `1.1.0` → `2.0.0`）: 既存の利用方法・公開契約・製品仕様を互換でない形に変更する大幅変更。

`schemaVersion`と`PROMPT_SPEC_VERSION`はアプリversionとは独立した規則で管理し、PATCH / MINOR / MAJOR更新だけを理由に変更しません。

## 9. 永続データ

Electronのユーザーデータ領域へ、次のデータを保存します。

```text
game-autosave.json          ゲームの自動保存
chat-room-session.json      人狼Stateと独立した最新自由会話セッション
spectator-room-session.json 人狼Stateと独立した最新人狼観戦セッション
desktop-settings.json       AIプロファイル、割り当て、進行設定
appearance.json             外観設定
character-library.json      ユーザー追加・編集キャラクター
llm-usage-summary.json      AIプロファイル別API使用量・料金集計
llm-request-log.jsonl       設定時のみ保存するAPI詳細ログ
autosave-shutdown-warning.json  終了時にゲーム自動保存flushが完了しなかった場合の警告情報
```

APIキーはElectronの`safeStorage`で暗号化し、Rendererへ平文を返しません。ゲームJSON、自由会話セッション、人狼観戦セッション、AI接続設定は別管理です。ログ保存前には認証ヘッダーと既知のAPIキー形式をマスクします。API使用量の永続集計は`profileId`を正本とし、人狼・自由会話・人狼観戦・診断など用途が異なっても同じAIプロファイルへ合算します。

自動保存はRendererから状態変更ごとにMainへ渡し、Mainの`AutosaveStore`が最新状態へ集約して原子的に保存します。書込中または書込失敗後に新しい状態を受け取った場合も最新状態を保持し、次回保存または終了時flushで再処理します。Renderer側へ単純な遅延debounceを再導入しないでください。

`desktop-settings.json`は候補設定を原子的に保存できた後だけMainの実行中設定へ反映します。保存失敗時にメモリ上の設定だけを先行変更してはいけません。AI全自動開始は準備中を含め単一の開始Promiseへ集約し、同時に複数の実行セッションを作成しません。

自動実行の`running / paused / waiting-human / waiting-manual-ai / error / idle`はautomation層の一時状態であり、ゲームState・保存JSON・revision・Undo／Redoへ混在させません。自動実行ループは表示中タブを変更せず、利用者が別画面へ移動しても進行を継続します。一時停止は実行セッションを中断して`paused`へ移すだけとし、再開時は現在のゲーム状態から新しい実行セッションを開始します。ゲーム状態やAI設定を書き換える操作は実行中／入力待ち中にロックし、AI接続テストと生成工程テストは実際の`running`中だけ生成リソース競合としてロックします。

公開訂正・役職訂正・復元は、利用者に事前の訂正モード開始を要求せず、各正式コマンドが必要な場合だけ訂正モードへ自動的に入ります。利用者向けUIは訂正モード中の明示終了だけを提供します。

製品版`1.0.0`以降のユーザーデータJSONは、アプリversionとは独立した`schemaVersion`で後方互換を管理します。旧schemaは`app/shared/dataCompatibility/`の一方向Migrationで現行schemaへ変換してから各現行validatorへ渡し、未来schema・無版schemaは推測して読みません。ゲームJSONではMigration後も、現在必要なゲーム事実の構造・型・参照整合性を検証し、履歴から再生成できる派生状態は現行形式で再構築します。`appVersion`・`buildId`・`promptSpecVersion`は出自メタデータであり、それ自体を拒否条件にはしません。詳細は`docs/DATA_COMPATIBILITY.md`を正本として参照してください。

自由会話はゲームState・`discussionRuntime`・Undo／Redoへ混在させず、`app/main/chatRoomStore.js`と`app/renderer/js/domain/chat/`で独立管理します。通常巡回と質問回答の優先ターンを分離し、質問1件ごとの追加回答と低頻度の会話きっかけを独立して扱います。会話ログはセッション内で最大1200件、AIへ渡す生ログは直近48件です。長期情報はキャラクターごとの個別内部メモとして保持し、他キャラクターへ共有しません。詳細は `docs/CHAT_ROOM_SPEC.md` を正本として参照してください。

人狼観戦は`app/main/spectatorRoomStore.js`と`app/renderer/js/domain/spectator/`で独立保存・管理し、公開ログの再生位置をゲームStateそのものへ書き戻しません。追っかけ中は`app/renderer/js/public/publicReplaySnapshot.js`が再生地点までの公開履歴から盤面を再構成し、最新公開ログへ到達した時だけリアルタイムへ合流します。リアルタイム時の「人狼卓を1手進める」はAI管理の共通`runSingleAutomaticStep`へ委譲します。詳細は `docs/SPECTATOR_ROOM_SPEC.md` を正本として参照してください。

AIプロファイルJSON転送も`ai-profile-package`として共通schema互換層の対象とし、製品版`1.0.0`の基準`schemaVersion`は1です。APIキー、使用量、参加者割り当ては転送対象外です。生成工程が参照する依存プロファイルは同一パッケージへ含め、読込時に新しいプロファイルIDへ付け替えます。

`desktop-settings.json`も共通schema互換層を通し、旧schemaは現行schemaへMigrationしてから共有`settingsSchema.js`の完全な現行保存形として検証します。Migration前の永続ファイルは`*.pre-schema-N.json`へ退避し、未来schemaや無版schemaは推測して読みません。

## 10. 実装ルール

変更前に `docs/AI_WORK_RULES.md` を確認してください。特に次を厳守します。

- 既存機能を利用者の明示なしに削除しない
- モジュール化前後で挙動を変えない
- 公開発言、心の声、内部メモ、判断状態、陣営戦略を別責務として維持する
- Main、状態、ドメイン、プロンプト、UI、通信の境界を崩さない
- 全JS先頭の「責務」「変更ルール」を、責務変更と同時に更新する
- 廃止した旧実装や一時パッチを残さない
- 生成物を直接修正しない
- 変更後は製造ゲートと全回帰テストを通す

## 11. 変更時の標準手順

1. 現行生成物とソースの一致を確認する
2. 変更対象モジュールの責務と関連テストを確認する
3. 正本モジュールだけを修正する
4. 責務・更新規則が変わる場合は先頭コメントを更新する
5. 現行仕様の契約テストで確認する。過去不具合専用・重複テストは残さず、公開済み旧schemaのMigrationテストだけは後方互換契約として保持する
6. `npm run verify`を実行する
7. 配布契約を変更した場合は`npm run release`で実配布物も確認する

## 12. ライセンスと出典

AI人狼マネージャー本体の利用条件の正本は、プロジェクト直下の `LICENSE.txt` です。本体の独自コードはMIT Licenseで提供し、事前許可なく利用・複製・改変・結合・公開・再配布・再許諾・販売を含む商用利用を認めます。再配布時は、MIT Licenseが定める著作権表示とライセンス本文を保持してください。`LICENSE.txt`末尾の適用範囲注記では、本体MITが第三者キャラクター等へ及ばず、Electron/Chromium等の第三者OSSには各ライセンスが適用されることを明記します。`app/package.json` と `tools/package.json` の `license` も `MIT` に統一します。

組み込みキャラクターデータの管理情報・公式サイト・利用規約・確認日の正本は `app/renderer/data/characters/` 配下の管理グループ別 `group.json` です。1キャラクター固有の設定は1キャラクター1JSONとして管理し、グループやキャラクターの追加・削除ではJSへ固有名を追加せずJSONを更新します。アプリ内の「ライセンス」画面は、これらの正本データと本体ライセンスを利用者向けに表示するビューであり、正本そのものではありません。

企画・設計・開発は「ずんだあい」、Xは `https://x.com/ZundaAI` です。実装支援にはOpenAIのGPTおよびAnthropicのClaudeを使用しています。第三者が権利を持つキャラクター、名称、ロゴ、AIサービス、その他の素材には本体のMIT Licenseを適用しません。本ソフトはOpenAI、Anthropic、各キャラクター管理元、その他AIサービス提供元の公式製品・公式サービスではありません。
