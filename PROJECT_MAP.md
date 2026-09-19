# Project map

| 役割 | ファイル |
| --- | --- |
| Bot entry / Discord client | `src/bot.js` |
| コマンド定義 | `src/commands.js`, `src/deploy-commands.js` |
| 設定 | `src/config.js` |
| Health / process restart | `src/koyeb-start.js` |
| エラー処理・自動復旧・retry・scheduler | `src/bot.js`, `src/self-healing.js` |
| 更新記録 | `src/update-monitor.js` |
| 永続データ同期 | `src/state-sync.js`, `data/` |
| あまね固有機能 | `src/asset-storage.js`, `src/verification-settings.js`, `src/purchase-tickets.js` |
| 共通候補 | `src/self-healing.js`, `src/update-monitor.js`, `src/state-sync.js` |
| りあめ | このチェックアウトにソースはありません |
