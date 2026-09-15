import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const GAME_STATUS_INTERVAL_MS = 5 * 60_000;

const STATUS_LABELS = Object.freeze({
  operational: '正常',
  degraded: '一部障害',
  major: '大規模障害',
  maintenance: 'メンテナンス',
  unknown: '未確認',
});

function asText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function statusLabel(state) { return STATUS_LABELS[state] || STATUS_LABELS.unknown; }

export function summarizeStatuspage(game, summary, sourceUrl) {
  const indicator = summary?.status?.indicator;
  const state = indicator === 'none' ? 'operational'
    : indicator === 'minor' ? 'degraded'
      : indicator === 'major' || indicator === 'critical' ? 'major'
        : indicator === 'maintenance' ? 'maintenance' : 'unknown';
  const incidentText = Array.isArray(summary?.incidents) && summary.incidents.length
    ? summary.incidents.slice(0, 2).map((incident) => incident.name).filter(Boolean).join(' / ')
    : null;
  return {
    id: game.id,
    name: game.name,
    state,
    detail: incidentText || asText(summary?.status?.description, state === 'operational' ? 'すべて正常に稼働中です。' : '公式ステータスを確認してください。'),
    sourceUrl,
  };
}

export function unavailableGameStatus(game, detail, sourceUrl = null) {
  return { id: game.id, name: game.name, state: 'unknown', detail, sourceUrl };
}

export function summarizeOfficialText(game, text, sourceUrl, { gameName = game.name, healthyPattern, maintenancePattern, outagePattern } = {}) {
  const normalized = String(text || '').replaceAll(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  const index = lower.indexOf(gameName.toLowerCase());
  const context = index >= 0 ? lower.slice(index, index + 500) : lower;
  const matches = [
    { state: 'maintenance', detail: '公式情報でメンテナンスまたは一時停止が案内されています。', pattern: maintenancePattern },
    { state: 'major', detail: '公式情報で障害または接続問題が案内されています。', pattern: outagePattern },
    { state: 'operational', detail: '公式情報では正常稼働と表示されています。', pattern: healthyPattern },
  ].map((candidate) => ({ ...candidate, index: candidate.pattern ? context.search(candidate.pattern) : -1 })).filter((candidate) => candidate.index >= 0).sort((left, right) => left.index - right.index);
  if (matches.length) return { id: game.id, name: game.name, state: matches[0].state, detail: matches[0].detail, sourceUrl };
  return unavailableGameStatus(game, '公式情報から現在の状態を確定できませんでした。公式ページを確認してください。', sourceUrl);
}

export function isAlertableChange(previous, next) {
  return Boolean(previous && previous.state !== next.state && next.state !== 'unknown');
}

export class GameStatusStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.statuses = {};
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.statuses = saved?.statuses && typeof saved.statuses === 'object' ? saved.statuses : {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.statuses = {};
    }
  }

  async save() {
    await mkdir(new URL('.', this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ statuses: this.statuses }, null, 2), 'utf8');
  }

  get(id) { return this.statuses[id] || null; }
  set(status) { this.statuses[status.id] = { ...status, checkedAt: Date.now() }; }
}
