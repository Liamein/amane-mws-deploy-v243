export const CURRENT_RELEASE = Object.freeze({
  id: 'amane-v2.6.0-startup-single-flight',
  version: '2.6.0',
  title: '起動処理の多重実行と更新記録の重複送信を修正',
  description: '招待パネルの初期化を単一実行にし、権限制御を起動処理から分離しました。更新記録は明示的なリリース実行時だけ送信します。',
  target: '招待パネル、自己復旧、エラー通知、アップデート記録',
  verification: '単一実行・重複通知・リリース重複防止のテストとクラウド起動確認を実施しました。',
});
