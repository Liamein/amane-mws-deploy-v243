export function chooseRandom(items, random = Math.random) {
  if (!items.length) throw new Error('候補がありません。');
  return items[Math.floor(random() * items.length)];
}

export function parseChoices(text, { min = 2, max = 5 } = {}) {
  const choices = text.split('|').map((item) => item.trim()).filter(Boolean);
  if (choices.length < min || choices.length > max) throw new Error(`選択肢は${min}〜${max}件にしてください。`);
  if (new Set(choices.map((item) => item.toLocaleLowerCase())).size !== choices.length) throw new Error('同じ選択肢を重複して設定することはできません。');
  return choices;
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return `${days}日 ${hours}時間 ${minutes}分 ${totalSeconds % 60}秒`;
}
