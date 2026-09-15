function shuffle(items, random) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

export function createMathChallenge(random = Math.random) {
  const first = 2 + Math.floor(random() * 8);
  const second = 2 + Math.floor(random() * 8);
  const operation = ['+', '-', '×'][Math.floor(random() * 3)];
  const left = operation === '-' && second > first ? second : first;
  const right = operation === '-' && second > first ? first : second;
  const answer = operation === '+' ? left + right : operation === '-' ? left - right : left * right;
  const candidates = new Set([answer, Math.max(0, answer - 1), answer + 1, answer + 2]);
  while (candidates.size < 4) candidates.add(answer + candidates.size + 2);
  return { answer, choices: shuffle([...candidates], random), question: `${left} ${operation} ${right} = ?` };
}
