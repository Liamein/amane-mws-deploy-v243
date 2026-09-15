import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DEFAULTS = Object.freeze({ panelChannelId: null, panelMessageId: null, categoryId: null, buttonUses: {}, ticketMessage: 'ご購入ありがとうございます。\n{owner} が確認後、支払い方法と利用権の手順をご案内します。\n\n申請ユーザー: {user}\nプラン: **{plan}**（{price}）' });

function normalize(value) { return { ...DEFAULTS, ...(value || {}), tickets: value?.tickets && typeof value.tickets === 'object' ? value.tickets : {}, buttonUses: value?.buttonUses && typeof value.buttonUses === 'object' ? value.buttonUses : {} }; }

export class PurchaseTicketStore {
  constructor(filePath) { this.filePath = filePath; this.guilds = {}; }
  async load() {
    try { const saved = JSON.parse(await readFile(this.filePath, 'utf8')); this.guilds = Object.fromEntries(Object.entries(saved?.guilds || {}).map(([id, value]) => [id, normalize(value)])); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.guilds = {}; }
  }
  async save() { await mkdir(new URL('.', this.filePath), { recursive: true }); await writeFile(this.filePath, JSON.stringify({ guilds: this.guilds }, null, 2), 'utf8'); }
  get(guildId) { return normalize(this.guilds[guildId]); }
  update(guildId, values) { this.guilds[guildId] = { ...this.get(guildId), ...values }; return this.get(guildId); }
  ticketForUser(guildId, userId, type = 'purchase') { return Object.values(this.get(guildId).tickets).find((ticket) => ticket.userId === userId && ticket.status === 'open' && (ticket.type || 'purchase') === type) || null; }
  addTicket(guildId, ticket) { const settings = this.get(guildId); this.guilds[guildId] = { ...settings, tickets: { ...settings.tickets, [ticket.channelId]: ticket } }; }
}
