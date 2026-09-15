import { REST, Routes } from 'discord.js';
import { commands, globalCommands } from './commands.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const rest = new REST({ version: '10' }).setToken(config.discordToken);
await rest.put(Routes.applicationCommands(config.discordClientId), { body: globalCommands });
if (config.discordGuildId) {
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body: [] });
  console.log('全サーバー用コマンドを登録し、重複するAmAサーバー専用コマンドを削除しました。');
} else {
  console.log('全サーバー用コマンドを登録しました。');
}
