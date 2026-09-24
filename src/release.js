export const CURRENT_RELEASE = Object.freeze({
  id: 'amane-v2.6.3-inactivity-panel-controls',
  version: '2.6.3',
  title: '非アクティブ監視パネルへ期間設定を追加',
  description: '監視パネルから自動退出までの日数と期限前DMの日数を変更できる管理ボタンを追加しました。設定は再起動後も保持され、指定管理者とBotは監視対象から除外されます。',
  target: '非アクティブ監視パネル / 自動退出期間 / 期限前DM / 監視対象',
  verification: '設定の保存・復元、可変期間での警告・退出判定、管理ボタン、指定管理者・Botの除外を含む全13テストに成功しました。',
});
