export const CURRENT_RELEASE = Object.freeze({
  id: 'amane-v2.6.4-inactivity-clock-remove-digest',
  version: '2.6.4',
  title: '非アクティブ時間表示を精密化',
  description: '監視パネルの最終活動時間と退出までの残り時間を、総時間によるH:mm:ss形式へ変更しました。運用ダイジェスト機能と専用チャンネルも廃止しました。',
  target: '非アクティブ監視パネル / 運用ダイジェスト',
  verification: 'H:mm:ss変換、監視・退出表示、DM結果、期間設定ボタン、旧ダイジェスト参照の完全除去を確認しました。',
});
