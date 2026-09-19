import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('help').setDescription('コマンド一覧を表示します'),
  new SlashCommandBuilder().setName('command-access').setDescription('Botコマンドを使えるユーザーを管理します（所有者専用）')
    .addSubcommand((subcommand) => subcommand.setName('register').setDescription('ユーザーへ利用権を付与・更新します').addUserOption((option) => option.setName('user').setDescription('付与するユーザー').setRequired(true)).addStringOption((option) => option.setName('plan').setDescription('利用権の期間（未指定は期限なしの手動登録）').addChoices(
      { name: '1か月', value: 'monthly' }, { name: '3か月', value: 'quarterly' }, { name: '6か月', value: 'halfyear' }, { name: '永久', value: 'lifetime' }, { name: '期限なし（手動）', value: 'manual' },
    )))
    .addSubcommand((subcommand) => subcommand.setName('unregister').setDescription('ユーザーのコマンド利用登録を解除します').addUserOption((option) => option.setName('user').setDescription('登録解除するユーザー').setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('登録済みユーザーを一覧表示します')),
  new SlashCommandBuilder().setName('ping').setDescription('Botの応答速度を確認します'),
  new SlashCommandBuilder().setName('uptime').setDescription('Botの稼働時間を表示します'),
  new SlashCommandBuilder().setName('user').setDescription('ユーザー情報を表示します').addUserOption((option) => option.setName('member').setDescription('対象ユーザー')),
  new SlashCommandBuilder().setName('poll').setDescription('ボタン式の投票を作成します')
    .addStringOption((option) => option.setName('question').setDescription('投票の質問').setRequired(true).setMaxLength(200))
    .addStringOption((option) => option.setName('options').setDescription('選択肢を | で区切る（2〜5件）').setRequired(true).setMaxLength(400)),
  new SlashCommandBuilder().setName('clear').setDescription('直近のメッセージを削除します（メッセージ管理権限が必要）').addIntegerOption((option) => option.setName('count').setDescription('削除数（1〜100）').setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName('verification-panel').setDescription('認証パネルと入室時DMを設定します（所有者専用）')
    .addSubcommand((subcommand) => subcommand.setName('create').setDescription('指定チャンネルへ認証パネルを投稿します')
      .addRoleOption((option) => option.setName('role').setDescription('認証完了後に付与するロール').setRequired(true))
      .addChannelOption((option) => option.setName('panel-channel').setDescription('認証パネルの投稿先').setRequired(true))
      .addChannelOption((option) => option.setName('access-channel').setDescription('認証後に閲覧可能にするチャンネル（任意）').setRequired(false))
      .addBooleanOption((option) => option.setName('dm-enabled').setDescription('入室時の認証DMを送る（既定: オン）').setRequired(false)))
    .addSubcommand((subcommand) => subcommand.setName('dm-settings').setDescription('入室時に送る認証DMを編集します')
      .addBooleanOption((option) => option.setName('enabled').setDescription('入室時に認証DMを送るか').setRequired(true))
      .addStringOption((option) => option.setName('message').setDescription('{server} と {role} を使えるDM本文（任意）').setRequired(false).setMaxLength(1_500)))
    .addSubcommand((subcommand) => subcommand.setName('test-dm').setDescription('現在の認証DMを自分にテスト送信します'))
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('認証とDM送信の設定を確認します')),
  new SlashCommandBuilder().setName('mbti-panel').setDescription('MBTIタイプチェック用パネルを作成・更新・編集します（サーバー管理権限が必要）')
    .addSubcommand((subcommand) => subcommand.setName('create').setDescription('指定チャンネルにMBTI診断パネルを投稿します')
      .addChannelOption((option) => option.setName('channel').setDescription('パネルの投稿先チャンネル').setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('update').setDescription('投稿済みのMBTI診断パネルを最新デザインへ更新します'))
    .addSubcommand((subcommand) => subcommand.setName('edit').setDescription('診断パネルの見出し・説明を編集します')
      .addStringOption((option) => option.setName('title').setDescription('見出し（任意）').setRequired(false).setMaxLength(100))
      .addStringOption((option) => option.setName('description').setDescription('説明文（任意）').setRequired(false).setMaxLength(1_500))),
  new SlashCommandBuilder().setName('利用権購入').setDescription('Bot利用権の購入パネルと案内文を管理します（所有者専用）')
    .addSubcommand((subcommand) => subcommand.setName('設置').setDescription('利用権購入チャンネルとチケットパネルを作成・更新します'))
    .addSubcommand((subcommand) => subcommand.setName('案内文').setDescription('個別チケットでBotが送る案内文を編集します')
      .addStringOption((option) => option.setName('内容').setDescription('{user} {userId} {plan} {price} {owner} を使用できます').setRequired(true).setMaxLength(1_800)))
    .addSubcommand((subcommand) => subcommand.setName('状態').setDescription('利用権購入パネルの設定と開設中チケットを確認します')),
  new SlashCommandBuilder().setName('announce').setDescription('指定チャンネルにお知らせを送信します（サーバー管理権限が必要）')
    .addChannelOption((option) => option.setName('channel').setDescription('送信先チャンネル').setRequired(true))
    .addStringOption((option) => option.setName('text').setDescription('お知らせ本文').setRequired(true).setMaxLength(2_000)),
  new SlashCommandBuilder().setName('send-dm').setDescription('指定ユーザーにDMを送信します（所有者専用）')
    .addUserOption((option) => option.setName('user').setDescription('送信先ユーザー').setRequired(true))
    .addStringOption((option) => option.setName('text').setDescription('DM本文').setRequired(true).setMaxLength(2_000))
    .addStringOption((option) => option.setName('url').setDescription('添付するURL（任意）').setRequired(false).setMaxLength(1_000))
    .addAttachmentOption((option) => option.setName('file').setDescription('添付するファイル（任意）').setRequired(false)),
  new SlashCommandBuilder().setName('server-log-config').setDescription('入退室ログの送信先を設定します（サーバー管理権限が必要）')
    .addChannelOption((option) => option.setName('channel').setDescription('入退室ログの送信先').setRequired(true)),
  new SlashCommandBuilder().setName('bot-update-config').setDescription('Bot更新告知の送信先を設定します（所有者専用）')
    .addChannelOption((option) => option.setName('channel').setDescription('Bot更新告知の送信先').setRequired(true)),
  new SlashCommandBuilder().setName('inactivity-status').setDescription('最終アクティブ日時を確認します（サーバー管理権限が必要）')
    .addUserOption((option) => option.setName('member').setDescription('確認するメンバー').setRequired(true)),
  new SlashCommandBuilder().setName('mod-config').setDescription('荒らし対策の設定を変更・確認します（サーバー管理権限が必要）')
    .addSubcommand((subcommand) => subcommand.setName('log').setDescription('モデレーションログの送信先を指定します').addChannelOption((option) => option.setName('channel').setDescription('ログを記録するチャンネル').setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('ng-add').setDescription('NGワードを追加します').addStringOption((option) => option.setName('word').setDescription('削除対象にする語句').setRequired(true).setMaxLength(100)))
    .addSubcommand((subcommand) => subcommand.setName('ng-remove').setDescription('NGワードを削除します').addStringOption((option) => option.setName('word').setDescription('削除対象から外す語句').setRequired(true).setMaxLength(100)))
    .addSubcommand((subcommand) => subcommand.setName('ng-list').setDescription('NGワード一覧を表示します'))
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('現在の荒らし対策設定を表示します')),
  new SlashCommandBuilder().setName('機能要望').setDescription('あまねへの機能要望を所有者へ送信します（利用権保持者限定）')
    .addStringOption((option) => option.setName('内容').setDescription('追加・改善してほしい機能を具体的に入力してください').setRequired(true).setMinLength(5).setMaxLength(1_500)),
].map((command) => command.toJSON());

// 実行可否はBot側で、登録済みユーザーIDを必ず照合する。
// /利用権は案内専用だが、ユーザーの指定により実行は所有者に限定する。
export const publicCommands = [
  new SlashCommandBuilder().setName('利用権').setDescription('あまねの利用権購入方法を案内します'),
].map((command) => command.toJSON());

export const globalCommands = [...commands, ...publicCommands];
