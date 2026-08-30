# 製品版データschema仕様

## 1. 目的

AI人狼マネージャーは製品版 `1.0.0` をユーザーデータschema管理の基準点とする。

ソースコード・内部API・DOM・モジュール構成だけでなく、過去schemaの後方互換も恒久保証しない。保存形式を変更する場合は対象データの`schemaVersion`を更新し、現行schemaを唯一の保存正本とする。

旧schemaを読み込めるよう明示的に提供する場合だけ、`app/shared/dataCompatibility/` の一方向Migrationへ互換処理を閉じ込める。Migrationが登録されていない旧schemaは現行形式として推測・読み替えせず拒否する。

## 2. versionの分離

アプリversionとデータschemaVersionは別物として管理する。

```text
アプリversion:       1.0.0, 1.0.1, 1.1.0, 2.0.0, ...
データschemaVersion: 1, 2, 3, 4, ...
```

アプリversionを更新しても、保存形式に変更がなければschemaVersionは変更しない。逆に、ユーザーデータschemaの互換性はアプリSemVerとは独立して管理するため、schemaVersionの変更だけを理由にアプリversionのMAJOR更新を強制しない。

製品版 `1.0.0` の初期schemaVersionは、schema管理対象の全データ種別で `1` とする。開発版で使用していたschema番号は引き継がない。

現行schema番号の正本は `app/shared/dataCompatibility/schemaVersions.js` とする。

## 3. schema管理対象

現行のschema管理対象は次のとおり。

| 種別 | kind | 主な保存・転送先 |
|---|---|---|
| ゲーム状態 | `game-state` | `game-autosave.json`、ゲームJSON出力 |
| デスクトップ設定 | `desktop-settings` | `desktop-settings.json` |
| 外観設定 | `appearance` | `appearance.json` |
| 自由会話 | `chat-room` | `chat-room-session.json`、履歴JSON出力 |
| 人狼観戦 | `spectator-room` | `spectator-room-session.json` |
| ユーザーキャラクター | `user-character-library` | `character-library.json` |
| AIプロファイル転送 | `ai-profile-package` | AIプロファイルJSON出力・読込 |
| API使用量集計 | `usage-summary` | `llm-usage-summary.json` |
| 外部LLM確認 | `privacy-notice` | `privacy-notice.json` |

API詳細ログJSONLや終了失敗警告など、製品データの復元元ではない診断・警告ファイルはschema管理対象外とする。

LLMが各タスクで返すAI応答JSONも対象外とする。AI応答の現行外部キーは`app/renderer/js/prompts/response/responseContract.js`を正本とし、`responseParser.js`は現行キーだけを受理する。ゲーム状態へ保存された`rawResponse`は監査用の不透明文字列であり、ゲームJSONの再読込時に現行AI応答パーサーへ再投入しない。パーサー後の解析済み・解決済み状態はゲーム状態schemaの一部として扱う。

## 4. 読込規則

読込時は次の順序を固定する。

```text
JSON parse
  ↓
schemaVersion検査
  ↓
旧schemaかつ登録済みMigrationが全段存在する場合だけ N → N+1 Migration
  ↓
現行schemaの構造・型・参照・意味を検証
  ↓
各Domain / Storeへ渡す
```

判定は次のとおり。

- `schemaVersion < current`: 必要な全Migrationが登録されている場合だけ順番に適用する。1段でも存在しなければ拒否する。
- `schemaVersion === current`: Migrationなしで現行検証へ進む。
- `schemaVersion > current`: 推測して読まず、より新しいアプリで作成されたデータとして拒否する。
- `schemaVersion`なし、非整数、0以下: 現行製品データとして扱わず拒否する。

`appVersion`、`buildId`、`promptSpecVersion`などは出自・診断用メタデータであり、それ自体をschema判定へ使用しない。

永続設定の読込では、保存データの構造妥当性と「現在の通信ポリシーでそのendpointを使用できるか」を分離する。現行schemaとして正しい`desktop-settings.json`に、後から強化された通信規則では使用できないendpointが含まれていても設定ファイル全体を破損扱いにしない。そのendpoint文字列と暗号化APIキーは保持し、利用者へ使用不能を通知する。新規追加・provider変更・endpoint変更の保存境界と実通信直前では、現行`endpointPolicy.js`を必ず適用する。

## 5. Migration規則

Migrationの正本は `app/shared/dataCompatibility/migrationRegistry.js` とする。Migrationは後方互換を明示的に提供する変更にだけ実装し、schemaVersionを上げるたびに必ず追加する契約ではない。

- Migrationは `N → N+1` の一方向だけを定義する。
- `N → N+2` の飛び級Migrationを作らない。
- 旧schemaを本体Domain・Store・UIへ直接分岐として追加しない。
- Migrationは入力オブジェクトを破壊せず、新しいJSON値を返す。
- Migration後の意味検証は各データ種別の現行validatorへ委譲する。
- 一度提供を継続すると決めたMigrationを変更する場合は、現行製品契約として明示的に判断する。
- 新しいアプリのデータを古いアプリ向けへ戻すdowngradeは提供しない。

## 6. 保存・退避規則

保存・エクスポートは常に現行schemaだけを書き出す。旧schema形式を選択して保存する機能は持たない。

Mainの永続ファイルへ登録済みMigrationを適用する場合は、現行形式へ上書きする前に同一ディレクトリへ次の形式で変換前ファイルを1世代保存する。

```text
<original>.pre-schema-<N>.json
```

読込不能・schema不一致・現行検証失敗時の扱いは、データ種別ごとのStore責務に従う。全Storeが一律に退避・既定値化する仕様ではない。現行実装は次のとおり。

| データ | 読込失敗時の現行動作 | 元ファイル保護 |
|---|---|---|
| `desktop-settings.json` | 一意名へ退避して既定設定で起動し、理由・退避先をRendererへ構造化通知する | 退避失敗時はその起動中の設定保存を禁止する |
| `llm-usage-summary.json` | 一意名へ退避して空の集計を使用する | 退避失敗時は使用量集計の保存を禁止する |
| `chat-room-session.json` / `spectator-room-session.json` | `JsonDocumentStore`が一意名へ退避して空状態を返す | 退避失敗時は対象セッション保存を禁止する |
| `appearance.json` | 既定外観を使用する | 読めなかった元ファイルは変更しない |
| `privacy-notice.json` | 未確認として扱い、次回外部LLM送信時に再確認を要求する | 読込失敗だけでは元ファイルを書き換えない |
| `character-library.json` | ファイルなしだけ空ライブラリとして扱い、それ以外の読込・schema検証失敗は呼出側へエラーを返す | 失敗時に既存ファイルを自動上書きしない |
| `game-autosave.json` | MainではJSONとして読めなければ`null`を返し、復元可否・Migration・現行検証はゲーム読込側で判定する | `loadSync()`自体は元ファイルを退避・変更しない。新規状態で起動後に通常の自動保存が発生すれば同じ保存先は更新され得る |

`desktop-settings.json`の現行schemaに、現在の通信規則では使用できないendpointが含まれている場合は読込失敗にしない。そのプロファイルと暗号化APIキーを保持し、使用不能理由をRendererへ通知する。新規追加・provider変更・endpoint変更の保存境界と実通信直前では現行`endpointPolicy.js`で拒否する。

## 7. schemaVersionを上げる条件

次のいずれかに該当し、旧データをそのまま現行validatorへ渡せない場合は対象データ種別のschemaVersionを `+1` する。

- 保存項目の追加・削除で既存データの形が変わる。
- 項目の型、意味、単位、列挙値、必須条件を変更する。
- ID参照関係やネスト構造を変更する。
- 現行validatorが旧保存形を正規形として受理できなくなる。

単なるアプリversion更新、UI変更、内部関数名変更、保存JSONへ影響しない計算変更ではschemaVersionを上げない。

## 8. schema変更時の実装手順

1. 対象kindのcurrent schemaVersionを `schemaVersions.js` で `+1` する。
2. 後方互換を提供するかを明示的に決定する。
3. 互換を提供する場合だけ、専用Migrationを実装し `migrationRegistry.js`へ `N → N+1` として登録する。
4. 互換を提供する場合だけ、代表fixtureと旧schema→currentの契約テストを保持する。
5. current schemaの保存・再読込、未来schema拒否、無版・破損データ拒否を確認する。
6. Main永続ファイルでMigrationする場合はpre-schemaバックアップを確認する。互換を提供しない場合は、対象Store固有の拒否・退避／原本保持・保存禁止・利用者通知が本節の仕様どおりか確認する。
7. 本文書、README、対象モジュールの責務・変更ルールを実装方針へ一致させる。
8. 生成bundleを更新し、ゲーム／デスクトップの全契約テストと製造ゲートを通す。

## 9. テスト資産の保持規則

通常のテストは現在および将来の現行製品動作を保証する契約、境界、代表経路だけを検証する。

旧schemaのfixture・Migrationテストは、現在もそのMigrationを提供すること自体が製品契約である場合だけ保持する。互換提供を終了した旧schema、開発版だけで使用したschema番号、旧実装の内部形状、修正済みバグ専用fixtureを恒久資産として残さない。

## 10. `1.0.0` 基準点

製品版 `1.0.0` はschema番号の基準点であり、すべての将来版がschema `1` を読み続ける保証ではない。`schemaVersion`がないデータや開発版独自schema番号を製品版schema `1` と推測して読み替えない。

旧schemaの読込可否は、現行`schemaVersions.js`と`migrationRegistry.js`の組み合わせを正本とする。
