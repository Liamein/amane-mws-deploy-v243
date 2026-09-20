const GUEST_BUTTON_ID = 'invite-tools:guest';

export function hasCurrentInvitePanel(message, { botUserId, guestEnabled }) {
  const guestButton = message?.components?.flatMap((row) => row.components || []).find((component) => component.customId === GUEST_BUTTON_ID);
  return message?.author?.id === botUserId
    && message.embeds?.[0]?.title === '🔗 サーバー参加・一時ゲスト'
    && guestButton?.disabled === !guestEnabled;
}
