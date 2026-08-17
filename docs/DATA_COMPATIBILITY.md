# 製品版データ互換性仕様

## 1. 目的

AI人狼マネージャーは製品版 `1.0.0` をユーザーデータ互換性の基準点とする。

ソースコード・内部API・DOM・モジュール構成の後方互換は保証しない。廃止した実装、旧API分岐、一時パッチは本体へ残さない。

一方、製品版 `1.0.0` 以降に本アプリが正式に保存・出力したユーザーデータJSONは、将来版から読み込めることを製品契約とする。旧形式の解釈は本体へ分散させず、`app/shared/dataCompatibility/` の一方向Migrationだけで現行schemaへ変換する。

## 2. versionの分離

アプリversionとデータschemaVersionは別物として管理する。

```text
アプリversion:       1.0.0, 1.0.1, 1.1.0, 2.0.0, ...
データschemaVersion: 1, 2, 3, 4, ...
```

アプリversionを更新しても、保存形式に互換上の変更がなければschemaVersionは変更しない。

製品版 `1.0.0` の初期schemaVersionは、互換管理対象の全データ種別で `1` とする。開発版で使用していたschema番号は引き継がない。

現行schema番号の正本は `app/shared/dataCompatibility/schemaVersions.js` とする。

## 3. 互換管理対象

現行の互換管理対象は次のとおり。

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

API詳細ログJSONLや終了失敗警告など、製品データの復元元ではない診断・警告ファイルはこのschema互換契約の対象外とする。

## 4. 読込規則

読込時は次の順序を固定する。

```text
JSON parse
  ↓
schemaVersion検査
  ↓
旧schemaなら N → N+1 Migrationを順番に適用
  ↓
現行schemaの構造・型・参照・意味を検証
  ↓
各Domain / Storeへ渡す
```

判定は次のとおり。

- `schemaVersion < current`: 登録済みMigrationを順番に適用する。
- `schemaVersion === current`: Migrationなしで現行検証へ進む。
- `schemaVersion > current`: 推測して読まず、より新しいアプリで作成されたデータとして拒否する。
- `schemaVersion`なし、非整数、0以下: 製品版互換データとして扱わず拒否する。

`appVersion`、`buildId`、`promptSpecVersion`などは出自・診断用メタデータであり、それ自体をschema互換判定へ使用しない。

## 5. Migration規則

Migrationの正本は `app/shared/dataCompatibility/migrationRegistry.js` とする。

- Migrationは `N → N+1` の一方向だけを定義する。
- `N → N+2` の飛び級Migrationを作らない。
- 旧schemaを本体Domain・Store・UIへ直接分岐として追加しない。
- Migrationは入力オブジェクトを破壊せず、新しいJSON値を返す。
- Migration後の意味検証は各データ種別の現行validatorへ委譲する。
- 新schema追加後、既存Migrationの削除・意味変更・番号の振り直しを行わない。
- 新しいアプリのデータを古いアプリ向けへ戻すdowngradeは提供しない。

## 6. 保存規則

保存・エクスポートは常に現行schemaだけを書き出す。旧schema形式を選択して保存する機能は持たない。

Mainの永続ファイルをMigrationする場合は、現行形式へ上書きする前に同一ディレクトリへ次の形式で変換前ファイルを1世代保存する。

```text
<original>.pre-schema-<N>.json
```

バックアップ作成後にMigration・現行検証が成功した場合だけ、原子的に現行schemaを書き戻す。Migrationまたは検証に失敗した場合は元ファイルを変更しない。

## 7. schemaVersionを上げる条件

次のいずれかに該当し、旧データをそのまま現行validatorへ渡せない場合は対象データ種別のschemaVersionを `+1` する。

- 保存項目の追加・削除で既存データの変換が必要になる。
- 項目の型、意味、単位、列挙値、必須条件を変更する。
- ID参照関係やネスト構造を変更する。
- 旧値を現行値へ決定的に変換する必要がある。

単なるアプリversion更新、UI変更、内部関数名変更、保存JSONへ影響しない計算変更ではschemaVersionを上げない。

## 8. schema変更時の実装手順

1. 対象kindのcurrent schemaVersionを `schemaVersions.js` で `+1` する。
2. `migrations/<kind>/` 相当の専用Migrationを実装し、`migrationRegistry.js`へ `N → N+1` として登録する。
3. 旧schemaの代表fixtureをテスト資産へ追加する。
4. `旧schema fixture → current` が成功する契約テストを追加する。
5. current schemaの保存・再読込、未来schema拒否、破損データ拒否を確認する。
6. Migration前バックアップと、Migration失敗時に元ファイルを変更しないことを確認する。
7. 本文書と対象仕様書を更新する。
8. 生成bundleを更新し、ゲーム／デスクトップの全契約テストと製造ゲートを通す。

## 9. テスト資産の保持規則

通常のテストは「過去に起きた不具合そのもの」を再現するために残さない。現在および将来の製品動作を保証する契約、境界、代表経路だけを検証する。

ただしデータ互換性だけは例外である。製品版 `1.0.0` 以降に正式リリースされた旧schemaを将来も読めること自体が現行製品契約なので、次は削除しない。

- 既に公開済みschemaから次schemaへのMigration
- 各公開済み旧schemaの代表fixture
- 各旧schemaからcurrent schemaまで移行できることを確認するテスト

開発版だけで使用したschema番号、旧実装の内部形状、修正済みバグ専用fixtureは製品互換資産へ持ち込まない。

## 10. `1.0.0` 基準点

製品版 `1.0.0` より前の開発版データは後方互換保証対象外とする。`schemaVersion`がないデータや、開発版独自schema番号を製品版schema `1` と推測して読み替えない。

`1.0.0` 以降に正式保存・出力したschema `1` が、将来Migrationを継続する最初の基準データとなる。
