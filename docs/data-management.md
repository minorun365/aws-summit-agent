# データ管理

このアプリはKnowledge Base用のデータをローカルで加工してS3へ同期します。作者のみのるんが実際に運用しているデータは、このリポジトリには直接入れていません。

## ローカルで管理するもの

- アプリに投入するMarkdown、PDF、JSONなどのKnowledge Base用データ
- イベントや用途に合わせて手元で加工したファイル
- ユーザー提供画像、PDF、会場マップなどの追加資料
- E2Eテストのスクリーンショット
- AWSアカウントID、Cognito User Pool ID、Amplify appIdなどの環境固有値
- 一時的なzip、ネットワークレスポンス、ブラウザ取得ログ

これらは `.local/`、`data/`、`tmp/`、`knowledge-base/source/`、`knowledge-base/manifests/` に置きます。リポジトリを使う人は、この構成に沿って自分のデータを配置してください。

## KBコーパスの置き場

ローカルでは以下の構成を想定します。

```text
knowledge-base/source/
  official/
  sessions/
  expo/
  community/
  raw-pdf/
```

1ファイル1トピックに寄せると、Bedrock Knowledge Baseの階層型チャンキングでも必要な情報がまとまって返りやすくなります。

## S3への同期

Amplify outputsで出力されるsource bucketとprefixを使って同期します。

```sh
aws s3 sync knowledge-base/source \
  s3://<source-bucket>/<source-prefix>/ \
  --profile <your-profile> \
  --region us-east-1 \
  --delete
```

同期後にBedrock Knowledge Baseのingestion jobを実行します。

```sh
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id <knowledge-base-id> \
  --data-source-id <data-source-id> \
  --profile <your-profile> \
  --region us-east-1
```

## リポジトリに残す情報

このリポジトリには、再利用可能なアプリ本体、IaC、データ投入の方針を残します。Knowledge Baseの中身は利用者ごとに差し替えられる前提です。
