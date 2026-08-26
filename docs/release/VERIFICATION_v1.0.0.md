# Decision Canvas v1.0.0 リリース検証記録

実施日：2026-08-27

対象：ローカル単一利用版 v1.0.0

結果：合格

実行環境：Windows NT 10.0.26200 / Node.js v24.19.0 / pnpm 11.19.0

対象Git ref：`v1.0.0`

## 実行した品質ゲート

```powershell
pnpm install --frozen-lockfile --offline
pnpm run verify
```

## 結果

| 項目 | 結果 | 内容 |
|---|---|---|
| 固定依存関係の準備 | 合格 | `pnpm-lock.yaml`を変更せず、オフラインのfrozen installが完了 |
| Lint | 合格 | ESLintエラー0件 |
| 型検査 | 合格 | `tsc --noEmit`エラー0件 |
| 自動テスト | 合格 | 意思決定エンジン35件、API経路5件、合計40件 |
| 本番ビルド | 合格 | vinext production build完了 |
| APIキー管理 | 合格 | `.env.local`はGit無視対象。APIキーらしい文字列は同ファイル以外から検出されず |
| 公開前データ監査 | 合格 | 実業務由来の標準サンプルを完全な架空事例へ差し替え、実行固有のResponse IDを公開資料と画像から除去 |
| ダミー5ケース | 合格 | [5ケース評価結果](../evaluation/EVALUATION_RESULTS_v1.0.0.md)を参照 |

## API経路のオフライン検証範囲

- 入力不備ではOpenAIを呼び出さない
- 正常な構造化応答を検証してモデル、Response ID、トークン利用量を返す
- JSON Schemaと`store: false`を要求へ含める
- 上流429を利用上限エラーへ変換する
- 不正な構造化出力を採用しない
- 上流500を安全な接続エラーへ変換し、上流本文を利用者へ漏らさない

## 判定の限界

この合格は、ソース、ローカル画面、ダミーデータに対する技術的なリリース判定です。公開環境の認証、共有DB、複数人運用、会社データの安全性、業務改善効果は検証対象外です。[運用境界](../security/OPERATING_BOUNDARY.md)を超えて使用しません。
