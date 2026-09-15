export const MBTI_ROLE_PREFIX = 'MBTI・';

export const MBTI_TYPES = [
  ['INTJ', '建築家', '戦略を練り、長い目で物事を組み立てるタイプ。', 0x5d5fef],
  ['INTP', '論理学者', '好奇心を軸に、仕組みや可能性を考えるタイプ。', 0x6d7cff],
  ['ENTJ', '指揮官', '目標に向かって周囲をまとめ、前へ進めるタイプ。', 0x7a5cff],
  ['ENTP', '討論者', '新しい発想と会話を楽しみ、可能性を広げるタイプ。', 0x9a65ff],
  ['INFJ', '提唱者', '理想と共感を大切に、静かに周囲を支えるタイプ。', 0xb56cff],
  ['INFP', '仲介者', '自分らしい価値観を大切に、想像力を活かすタイプ。', 0xd66eff],
  ['ENFJ', '主人公', '人の可能性を信じ、場をあたためるタイプ。', 0xee6faa],
  ['ENFP', '運動家', '好奇心と情熱で、人やアイデアをつなぐタイプ。', 0xff8cba],
  ['ISTJ', '管理者', '責任感を持ち、着実に物事を進めるタイプ。', 0x3f9a9a],
  ['ISFJ', '擁護者', '気配りを大切に、安心できる場を作るタイプ。', 0x58b9a4],
  ['ESTJ', '幹部', '現実的な判断で、チームを支えるタイプ。', 0x3d8ac9],
  ['ESFJ', '領事', '周囲との調和を大切に、皆を巻き込むタイプ。', 0x5eaee5],
  ['ISTP', '巨匠', '観察と実践を通じて、柔軟に解決策を見つけるタイプ。', 0x57906d],
  ['ISFP', '冒険家', '感性を活かし、自分のペースで楽しむタイプ。', 0x72b85c],
  ['ESTP', '起業家', '変化を楽しみ、まず行動して道を開くタイプ。', 0xd49b45],
  ['ESFP', 'エンターテイナー', '今この瞬間を楽しみ、場を明るくするタイプ。', 0xf2bd50],
].map(([code, title, description, color]) => ({ code, title, description, color }));

const question = (axis, emoji, prompt, left, right) => ({ axis, emoji, prompt, left, right });

// Five questions per axis avoid tied scores while keeping every question simple to answer.
export const MBTI_QUESTIONS = [
  question('EI', '🗣️', '元気を取り戻しやすいのは、どちらですか？', { label: '人と話したり、一緒に過ごしたりする', value: 'E' }, { label: '一人で静かに過ごす', value: 'I' }),
  question('EI', '✨', '初めて会う人が多い場所では、どちらに近いですか？', { label: '自分から話しかけることが多い', value: 'E' }, { label: '様子を見てから話すことが多い', value: 'I' }),
  question('EI', '🎮', 'ゲームや趣味を楽しむとき、より大切なのは？', { label: 'その場の盛り上がりを人と共有すること', value: 'E' }, { label: '自分のペースで集中すること', value: 'I' }),
  question('EI', '💭', '考えをまとめるときは、どちらがしやすいですか？', { label: '人に話しながら考える', value: 'E' }, { label: '一人で考えてから話す', value: 'I' }),
  question('EI', '🌙', '理想の休日は、どちらに近いですか？', { label: '人と会う予定がある', value: 'E' }, { label: '自分だけの時間を多く取る', value: 'I' }),

  question('SN', '🔎', '新しいことを理解するとき、頼りにしやすいのは？', { label: '具体例や、実際にあったこと', value: 'S' }, { label: '全体の意味や、これからの可能性', value: 'N' }),
  question('SN', '🧩', '新しいアイデアで魅力を感じるのは？', { label: 'すぐ使えて役に立ちそうな案', value: 'S' }, { label: '今までにない面白い可能性のある案', value: 'N' }),
  question('SN', '🗺️', '説明を聞くとき、分かりやすいのは？', { label: '例や手順から聞く', value: 'S' }, { label: '目的や全体像から聞く', value: 'N' }),
  question('SN', '🌱', '会話で気になりやすいのは？', { label: '今起きている具体的なこと', value: 'S' }, { label: 'これから起こりそうなこと', value: 'N' }),
  question('SN', '💡', '困ったとき、最初に考えやすいのは？', { label: '前にうまくいった方法', value: 'S' }, { label: '別の新しいやり方', value: 'N' }),

  question('TF', '⚖️', '大切なことを決めるとき、優先しやすいのは？', { label: 'ルールや理由が公平かどうか', value: 'T' }, { label: '関わる人の気持ち', value: 'F' }),
  question('TF', '💬', '相談を受けたとき、最初にしやすいのは？', { label: 'どう解決するかを考える', value: 'T' }, { label: 'まず気持ちを聞く', value: 'F' }),
  question('TF', '🏁', 'チームで意見が分かれたら、どちらに近いですか？', { label: '一番よい案を根拠で選ぶ', value: 'T' }, { label: 'みんなが納得できる案を探す', value: 'F' }),
  question('TF', '🛠️', '改善点を伝えるとき、大切なのは？', { label: 'はっきり分かりやすく伝えること', value: 'T' }, { label: '相手が受け取りやすい言い方', value: 'F' }),
  question('TF', '📖', '作品を見たとき、印象に残りやすいのは？', { label: '設定や話の組み立て', value: 'T' }, { label: '登場人物の気持ちや関係', value: 'F' }),

  question('JP', '📅', '旅行やイベントの前は、どちらが好きですか？', { label: '先に予定を決めておく', value: 'J' }, { label: 'そのときに決められる余地を残す', value: 'P' }),
  question('JP', '✅', 'やることがあるとき、どちらに近いですか？', { label: '早めに終えて安心したい', value: 'J' }, { label: '締切近くまで選べるようにしておきたい', value: 'P' }),
  question('JP', '🧹', '自分の部屋や作業場所は、どちらが落ち着きますか？', { label: '物の場所が決まっていて整っている', value: 'J' }, { label: '使いやすければ少し自由でもよい', value: 'P' }),
  question('JP', '🎯', '急な誘いが来たとき、どちらに近いですか？', { label: '予定を確認してから決める', value: 'J' }, { label: '面白そうならまず参加してみる', value: 'P' }),
  question('JP', '🌈', '満足しやすいのは、どちらですか？', { label: '計画どおりに終わったとき', value: 'J' }, { label: '予定外の楽しい発見があったとき', value: 'P' }),
];

export function mbtiType(code) {
  return MBTI_TYPES.find((entry) => entry.code === code) || null;
}

export function mbtiRoleName(code) {
  const type = mbtiType(code);
  if (!type) throw new Error('MBTIタイプが正しくありません。');
  return `${MBTI_ROLE_PREFIX}${type.code}｜${type.title}`;
}

export function calculateMbti(answers, questions = MBTI_QUESTIONS) {
  if (!Array.isArray(answers) || !Array.isArray(questions) || answers.length !== questions.length || !questions.length) throw new Error('回答数が正しくありません。');
  const totals = { EI: { E: 0, I: 0 }, SN: { S: 0, N: 0 }, TF: { T: 0, F: 0 }, JP: { J: 0, P: 0 } };
  answers.forEach((answer, index) => {
    const selected = Number(answer);
    if (!Number.isInteger(selected) || selected < 1 || selected > 5) throw new Error('回答内容が正しくありません。');
    const item = questions[index];
    const strength = selected - 3;
    if (strength < 0) totals[item.axis][item.left.value] += Math.abs(strength);
    if (strength > 0) totals[item.axis][item.right.value] += strength;
  });
  return `${totals.EI.E > totals.EI.I ? 'E' : 'I'}${totals.SN.S > totals.SN.N ? 'S' : 'N'}${totals.TF.T > totals.TF.F ? 'T' : 'F'}${totals.JP.J > totals.JP.P ? 'J' : 'P'}`;
}
