import { EmbedBuilder, OverwriteType, PermissionFlagsBits } from 'discord.js';

export const PRIVATE_APEX_GUIDE_CHANNEL_ID = '1546599310873862267';
export const PRIVATE_APEX_GUIDE_OWNER_ID = '1030896490379476992';
export const PRIVATE_APEX_GUIDE_MESSAGE_ID = '1547195104152911887';
export const STEAM_CONTROLLER_CONFIG_URI = 'steam://controllerconfig/1172470/3659206135';

export function buildPrivateApexGuidePanel() {
  const overview = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle('🎮 Apex｜Steamコントローラー設定')
    .setDescription('Steamの設定を開き、確認してから適用するための所有者専用ガイドです。上から順番に進めてください。')
    .addFields(
      {
        name: '🔗 導入リンク',
        value: `\`\`\`text\n${STEAM_CONTROLLER_CONFIG_URI}\n\`\`\`\n上のリンクをすべてコピーして使用します。`,
      },
      {
        name: '🧭 全体の流れ',
        value: '**① 準備** → **② リンクを開く** → **③ 内容を確認** → **④ 適用** → **⑤ 射撃訓練場で確認**',
      },
    )
    .setFooter({ text: '所有者専用 • Apex導入パネル 新UI' });

  const installation = new EmbedBuilder()
    .setColor(0x1b2838)
    .setTitle('📥 導入手順')
    .addFields(
      {
        name: '① 準備する',
        value: [
          '• PC版Steamを起動してログインする',
          '• 使用するコントローラーを接続する',
          '• 現在のボタン配置を控え、元に戻せる状態にする',
        ].join('\n'),
      },
      {
        name: '② Steamで設定を開く',
        value: [
          `**1.** 導入リンク \`${STEAM_CONTROLLER_CONFIG_URI}\` をコピー`,
          '**2.** ブラウザのアドレス欄へ貼り付けて開く',
          '**3.** Steamを開く確認が出た場合は、内容を確認してSteamへ移動',
        ].join('\n'),
      },
      {
        name: '③ 内容を確認して適用する',
        value: [
          '**1.** 表示されたコントローラー設定とボタン配置を確認',
          '**2.** 問題がなければ「レイアウトを適用」を選択',
          '**3.** Apexを起動し、射撃訓練場で入力を確認',
        ].join('\n'),
      },
    );

  const checks = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ 適用後の確認')
    .setDescription([
      '□ 移動・視点・射撃・メニュー操作が正しく反応する',
      '□ 意図しない連続入力や操作不能が発生していない',
      '□ 問題がある場合は対戦へ入らず、元のレイアウトへ戻す',
      '□ Steamで画面が開かない場合は、Steamを再起動してからリンクを開き直す',
      '',
      '⚠️ **注意**',
      '入力の自動化や反動操作を目的とする設定は、不正行為と判断される可能性があります。設定内容を確認し、通常のボタン配置として安全に使用してください。',
    ].join('\n'));

  return {
    content: '',
    embeds: [overview, installation, checks],
    components: [],
    allowedMentions: { parse: [] },
  };
}

export async function enforcePrivateApexGuidePermissions(channel, { ownerId = PRIVATE_APEX_GUIDE_OWNER_ID, botId }) {
  if (!channel?.guild || !botId) throw new Error('非公開パネルのチャンネルまたはBot情報が不足しています。');
  const everyoneId = channel.guild.roles.everyone.id;
  const expectedIds = new Set([everyoneId, ownerId, botId]);
  const existing = [...channel.permissionOverwrites.cache.values()];
  const everyone = channel.permissionOverwrites.cache.get(everyoneId);
  const owner = channel.permissionOverwrites.cache.get(ownerId);
  const bot = channel.permissionOverwrites.cache.get(botId);
  const alreadyStrict = existing.every((overwrite) => expectedIds.has(overwrite.id))
    && everyone?.deny.has(PermissionFlagsBits.ViewChannel)
    && owner?.allow.has(PermissionFlagsBits.ViewChannel)
    && owner?.allow.has(PermissionFlagsBits.ReadMessageHistory)
    && bot?.allow.has(PermissionFlagsBits.ViewChannel)
    && bot?.allow.has(PermissionFlagsBits.SendMessages)
    && bot?.allow.has(PermissionFlagsBits.ReadMessageHistory);

  if (alreadyStrict) return false;
  await channel.permissionOverwrites.set([
    { id: everyoneId, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: ownerId, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
    { id: botId, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] },
  ], '所有者専用のApex導入パネルを保護');
  return true;
}

export async function upsertPrivateApexGuidePanel(channel, messageId, botId) {
  let message = null;
  const preferredMessageId = messageId || PRIVATE_APEX_GUIDE_MESSAGE_ID;
  if (preferredMessageId) {
    try {
      message = await channel.messages.fetch(preferredMessageId);
    } catch (error) {
      if (Number(error?.code) !== 10_008) throw error;
    }
  }
  if (message && message.author.id !== botId) throw new Error('登録済みの非公開パネルはBotの投稿ではありません。');
  if (message) return { message: await message.edit(buildPrivateApexGuidePanel()), recreated: false };
  return { message: await channel.send(buildPrivateApexGuidePanel()), recreated: true };
}
