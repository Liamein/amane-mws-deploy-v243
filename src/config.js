import 'dotenv/config';

function required(name, env = process.env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} が設定されていません。.env を作成して値を設定してください。`);
  return value;
}

function requiredDiscordUserIds(name, env = process.env) {
  const values = required(name, env).split(',').map((value) => value.trim()).filter(Boolean);
  if (!values.length || values.some((value) => !/^\d{17,20}$/.test(value))) throw new Error(`${name} にはDiscordユーザーIDをカンマ区切りで設定してください。`);
  return new Set(values);
}

export function loadConfig(env = process.env) {
  return {
    discordToken: required('DISCORD_TOKEN', env),
    discordClientId: required('DISCORD_CLIENT_ID', env),
    commandOwnerIds: requiredDiscordUserIds('COMMAND_OWNER_IDS', env),
    botInstallLogChannelId: env.BOT_INSTALL_LOG_CHANNEL_ID?.trim() || null,
    dmLogChannelId: env.BOT_DM_LOG_CHANNEL_ID?.trim() || env.BOT_INSTALL_LOG_CHANNEL_ID?.trim() || null,
    mbtiWelcomeChannelId: env.MBTI_WELCOME_CHANNEL_ID?.trim() || null,
    discordGuildId: env.DISCORD_GUILD_ID?.trim() || null,
    inactivityAutomationEnabled: env.INACTIVITY_AUTOMATION_ENABLED?.trim().toLowerCase() !== 'false',
    inactivityExemptRoleIds: new Set((env.INACTIVITY_EXEMPT_ROLE_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)),
  };
}
