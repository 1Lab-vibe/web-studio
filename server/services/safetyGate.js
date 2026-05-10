const CATEGORY_PATTERNS = {
  gambling: /(\bставк[аи]\b|казино|букмекер|тотализатор|gambling|casino|bookmaker|sportsbook|wager|пари\s+на|онлайн[- ]?казино|игров(ой|ые) автомат|slot\s*machine)/i,
  drugs: /(наркот|закладк|сбыт\s+вещест|меф\b|мдма|амфет|кокаин|героин|синтетик|марихуан|каннабис|psilocyb|lsd|drug\s+deal|narcotic|illicit\s+substance)/i,
  weapons: /(\bоружи|нелег(альн)?(ое|ый|ая|ые) (продаж|покуп|перевозк) (оружи|стволов)|купить\s+ствол|боеприпас|взрывчат|бомб(а|у|ы)\s+(сделать|собрать)|самодельн(ый|ое)\s+взрыв|illegal\s+firearm|untraceable\s+gun|grenade)/i,
  adult_18: /(порн|porn|pornhub|секс[- ]?знаком|секс[- ]?видео|18\+|эротик|нюд|nude\b|hentai|onlyfans|escort\s+service|интим[- ]?услуг|проститу|эскорт|шл(ю|у)х|sex\s+toy|adult\s+content)/i,
  child_safety: /(детск(ое|ая) порн|child\s+porn|cp\b|csam|loli|shota|малолетн[ие]х? в (порн|секс|интим)|sex\s+with\s+minor|underage\s+(sex|porn|nude))/i,
  self_harm: /(суицид|self[- ]?harm|самоубий|повеситьс|покончить\s+с\s+собой|вскрыть\s+вены|вены\s+резать|how\s+to\s+kill\s+myself|способ\s+умереть|kill\s+myself|hang\s+myself|suicide\s+method)/i,
  hate_violence: /(убий\b|убить\s+(всех|их|людей|евреев|русских|кавказцев|чурок)|насил(ие|овать)\s+(детей|жен)|изнасил|hate\s+speech|kill\s+all|жидовск|чурк|нацист\s+пропаганд|nazi\s+propaganda|terror|teroris|террорист)/i,
  fraud: /(скам|scam\b|кардинг|carding|поддельн(ый|ые) (паспорт|документ|водительск)|fake\s+(passport|id|license)|обнал(ить|ичка)|отмыв(ание|ка) денег|money\s+laundering|launder)/i,
  hacking: /(взлом\s+(акк|сайт|почт|инстаграм|телеграм|пароль)|фишинг|phishing|malware|ransomware|stalkerware|шпион(ская|ское) (программа|приложение)|spyware\s+install|hack\s+account|brute[- ]?force|crack\s+password)/i,
  mlm_pyramid: /(финансов(ая|ой)? пирамид|пирамида\s+(дохода|инвест)|hyip\b|млм\b|сетевой маркетинг с гарант|matrix\s+plan|ponzi)/i,
  illegal_finance: /(обнал\s+карт|чёрн(ый|ая)\s+касс|tax\s+evasion|нелег(альн)?(ое|ый) (заработок|доход)|teneb|cash\s+for\s+drugs)/i,
  cult_extremism: /(экстремизм\s+пропаганд|вербовк\s+в\s+(игил|isis|аль[- ]?каид)|propaganda\s+for\s+terrorism|terror\s+recruit)/i,
};

const CATEGORY_LABELS = {
  gambling: 'Азартные игры/ставки',
  drugs: 'Наркотические вещества',
  weapons: 'Оружие, взрывчатка',
  adult_18: 'Контент 18+',
  child_safety: 'Сексуализированный контент с детьми',
  self_harm: 'Суицид/самоповреждение',
  hate_violence: 'Ненависть/насилие',
  fraud: 'Мошенничество/поддельные документы',
  hacking: 'Хакерство/фишинг/spyware',
  mlm_pyramid: 'Финансовая пирамида / MLM',
  illegal_finance: 'Незаконный финансовый оборот',
  cult_extremism: 'Экстремизм/террор-пропаганда',
};

const HARD_BLOCK_CATEGORIES = new Set([
  'child_safety',
  'weapons',
  'drugs',
  'cult_extremism',
  'hate_violence',
  'self_harm',
]);

function normalize(text) {
  return String(text || '').replace(/[\s_*~`]+/g, ' ').toLowerCase().trim();
}

export function classifyContent(text) {
  const normalized = normalize(text);
  if (!normalized) return { allowed: true, hardBlock: false, categories: [], severity: 'none' };
  const matched = [];
  for (const [category, pattern] of Object.entries(CATEGORY_PATTERNS)) {
    if (pattern.test(normalized)) matched.push(category);
  }
  if (!matched.length) return { allowed: true, hardBlock: false, categories: [], severity: 'none' };
  const hardBlock = matched.some((category) => HARD_BLOCK_CATEGORIES.has(category));
  return {
    allowed: false,
    hardBlock,
    categories: matched,
    labels: matched.map((category) => CATEGORY_LABELS[category] || category),
    severity: hardBlock ? 'hard' : 'soft',
  };
}

export function isProhibitedContent(text) {
  return !classifyContent(text).allowed;
}

export function isHardBlocked(text) {
  return classifyContent(text).hardBlock;
}

export function safetyReport(text, { sampleLength = 200 } = {}) {
  const verdict = classifyContent(text);
  if (verdict.allowed) return { allowed: true, summary: '' };
  const sample = String(text || '').replace(/\s+/g, ' ').trim().slice(0, sampleLength);
  return {
    allowed: false,
    hardBlock: verdict.hardBlock,
    categories: verdict.categories,
    labels: verdict.labels,
    severity: verdict.severity,
    summary: `${verdict.labels.join(', ')}${sample ? `: ${sample}` : ''}`,
  };
}
