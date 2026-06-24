# Knowledge Base

このディレクトリは、Bedrock Knowledge Baseへ投入するデータの管理方針を示す場所です。

実際の投入データは `knowledge-base/source/` に置きます。作者のみのるんが実際に運用しているデータはこのリポジトリには直接入れていないため、利用する人は自分のイベントや用途に合わせてデータを用意してください。

ローカルでは次のような構成を想定します。

```text
knowledge-base/source/
  official/
  sessions/
  expo/
  community/
  raw-pdf/
```

`knowledge-base/source/` と `knowledge-base/manifests/` は `.gitignore` 済みです。データ投入の手順は [docs/data-management.md](../docs/data-management.md) を参照してください。
