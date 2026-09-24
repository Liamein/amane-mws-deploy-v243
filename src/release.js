export const CURRENT_RELEASE = Object.freeze({
  id: 'amane-v2.6.2-clear-inactivity-panel',
  version: '2.6.2',
  title: 'メッセージ削除と非アクティブ監視を更新',
  description: '/clearが14日を超えたメッセージを含めて指定件数を削除するよう修正しました。個別確認コマンドを廃止し、監視中・15日超過・DM送信結果・再参加後の監視復帰を常時更新パネルへ統合しました。',
  target: '/clear / 非アクティブ監視パネル / 再参加時の監視復帰',
  verification: '新旧メッセージ混在時の指定件数削除、旧データ移行、パネル表示、DM結果、再参加復帰、コマンド削除を自動テストしました。',
});
