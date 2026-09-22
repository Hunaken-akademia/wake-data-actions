# WAKE Data Actions

WAKEのうち、公開しても予想ロジックの再現につながらないデータ取得・定期処理だけを実行するPublic Actionsリポジトリです。

## Public側に置くもの

- 公式K票の取得・パース
- 3連単払戻の取得
- 展示履歴の補完
- 確定オッズ履歴の補完
- Supabase上のRPCを呼ぶだけの補正テーブル更新
- WAKE LAB展示キャッシュ更新
- 障害時の当日データ取得フォールバック

## Private側に残すもの

- WAKE本体
- Google認証・会員権限
- 予想/買い目生成ロジック
- 1〜3着適性・スコアリング
- バックテスト/モデル検証コード
- AI予想保存の認証セッションや内部キャプチャ手順
- 管理用処理

## Secrets

自動実行を有効化する前に、Repository Actions Secretsへ以下を登録する必要があります。

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `CAPTURE_TOKEN`

必要なWorkflowだけ追加で `APP_BASE_URL` を使います。

Secretsの値はソースコード・ログ・Artifactsへ出力しません。

## Migration state

Public側のコードはWAKE本番版を基準に同期し、必要なSecretsの実通信確認も完了しています。

定期処理は以下をPublic側が担当します。

- 07:00 JST: daily-ingest
- 07:30 JST: backfill-race-odds
- 08:00 JST: build-corrections
- 08:20 JST: refresh-wake-lab-exhibition-cache

対応するPrivate側Workflowは手動フォールバックのみ残し、自動scheduleは停止済みです。
`migration-readiness` Workflowは手動確認専用で、Secretの値は表示しません。
