export const CURRENT_RELEASE = Object.freeze({
  id: 'amane-v2.6.1-inactivity-gateway-stability',
  version: '2.6.1',
  title: '非アクティブ監視範囲とGateway復旧を修正',
  description: '非アクティブ監視をサーバーオーナーとBot以外の全ユーザーへ統一しました。Gateway再接続中の重複ログインを廃止し、長時間復旧しない場合だけBotプロセスを安全に再起動します。',
  target: '非アクティブ監視 / Discord Gateway接続 / 自動復旧',
  verification: '全メンバーの定期再同期、オーナー・Bot除外判定、再接続処理をテストし、MWS再起動後のGateway接続と安定稼働を確認しました。',
});
