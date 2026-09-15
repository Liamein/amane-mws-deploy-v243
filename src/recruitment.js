import { mkdir, readFile, writeFile } from 'node:fs/promises';

const PANEL_DEFAULTS = Object.freeze({
  applyLabel: '応募する',
  detailsLabel: '内容を確認',
  applyInstruction: '「応募する」から一言を送ってください。管理者へ非公開で通知されます。',
  detailsText: '応募すると管理者へ非公開で通知されます。',
  successMessage: '✅ 応募を受け付けました。管理者に非公開で通知しました。',
  messageLabel: '応募メッセージ',
  messagePlaceholder: '自己紹介・希望・質問など',
  messageId: null,
});

function withDefaults(panel) {
  return { ...PANEL_DEFAULTS, ...panel };
}

export class RecruitmentStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.panels = new Map();
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.panels = new Map(Array.isArray(saved?.panels) ? saved.panels.map((panel) => [panel.id, withDefaults(panel)]) : []);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.panels = new Map();
    }
  }

  async save() {
    await mkdir(new URL('.', this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ panels: [...this.panels.values()] }, null, 2), 'utf8');
  }

  create({ guildId, sourceChannelId, notifyChannelId, title, description, ...copy }) {
    const panel = withDefaults({ id: crypto.randomUUID().slice(0, 12), guildId, sourceChannelId, notifyChannelId, title, description, ...copy, createdAt: Date.now() });
    this.panels.set(panel.id, panel);
    return panel;
  }

  get(id) { return this.panels.get(id) || null; }

  update(id, patch) {
    const panel = this.get(id);
    if (!panel) return null;
    const updated = withDefaults({ ...panel, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== null)) });
    this.panels.set(id, updated);
    return updated;
  }
}
