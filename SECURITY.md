# Security Policy

## 対象

現在サポートするのは、`v1.0.0`のローカル単一利用版です。公開デプロイ、複数人共有、実会社データを使う本番運用はサポート対象外です。

## 脆弱性の報告

機密性のある内容は公開Issueへ書かず、このリポジトリのGitHub Private Vulnerability Reportingが利用できる場合は、Private security advisoryから報告してください。

報告には、影響する版、再現手順、想定される影響、可能であれば最小限の再現例を含めてください。APIキー、個人情報、会社の機密情報、実在する顧客データは添付しないでください。

## 既知の運用境界

- APIキーは`.env.local`だけに置き、Gitへ含めない
- APIキーを設定した状態でアプリをインターネットへ公開しない
- 実在する個人・顧客・会社の情報を入力しない
- AI出力を自動実行や正式判断として扱わない
- 正式判断とその責任は人間が持つ

詳細は[`docs/security/OPERATING_BOUNDARY.md`](docs/security/OPERATING_BOUNDARY.md)を参照してください。
