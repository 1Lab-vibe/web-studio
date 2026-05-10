import OpenAI from 'openai';
import { config, hasSecret } from '../config.js';
import { loadNicheConfig } from './niches.js';
import { analyzeLeadSite } from './siteAnalyzer.js';

const client = hasSecret(config.OPENAI_API_KEY) ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : null;

function diagnoserModel() {
  return config.OPENAI_DIAGNOSER_MODEL || config.OPENAI_MODEL;
}

function checkerModel() {
  return config.OPENAI_CHECKER_MODEL || config.OPENAI_MODEL;
}

export async function diagnoseLead(lead) {
  const niche = await loadNicheConfig(lead);
  const siteAnalysis = lead?.url ? await analyzeLeadSite(lead).catch(() => null) : null;
  if (!client) {
    const fallback = fallbackDiagnosis(lead, niche);
    if (siteAnalysis) fallback.siteAnalysis = compactSiteAnalysisForLead(siteAnalysis);
    return fallback;
  }

  const response = await client.responses.create({
    model: diagnoserModel(),
    input: [
      {
        role: 'system',
        content: [
          'Ты Diagnoser агент российской solo web-agency.',
          'Верни строго JSON без markdown с полями: diagnosis, angle, tone, message, channel, deal, replyRate, subject, subjectVariants, bodyParagraphs, ctaText, postscript.',
          'diagnosis около 50 слов — конкретно про этот бизнес, без воды. Если есть siteAnalysis, обязательно сошлись на одну конкретную деталь их сайта (заголовок, услугу, год копирайта, платформа), а не общими словами.',
          'angle одно предложение — главный угол сайта под нишу клиента.',
          'tone короткое описание тональности.',
          'message короткое холодное сообщение менее 70 слов на случай SMS/Telegram (резерв).',
          'subject — основная тема email до 60 символов, без капса, без спам-маркеров, желательно с упоминанием названия бизнеса или конкретной выгоды (без шаблона "Сделали превью сайта для X").',
          'subjectVariants — массив 3 объектов вида { angle: "вопрос|выгода|город|отзыв", text: "..." } с разными углами темы (вопросительная; конкретная выгода; локальная привязка к городу/району; отсылка к конкретному отзыву или рейтингу). Темы должны быть разными по структуре, не пересказывать друг друга. Длина каждой ≤60 символов.',
          'bodyParagraphs — массив 3–4 коротких абзацев на русском, под нишу. Каждый абзац максимум 2–3 предложения. Структура: 1) персональный крюк под бизнес и нишу — если есть siteAnalysis, упомяни конкретную деталь их текущего сайта; иначе — карточку в Яндексе (рейтинг, отзывы, годы); 2) что именно слабого/упускаемого на текущем этапе и что превью предлагает иначе (используй данные nicheConfig.heroAngle, sections, trustSignals); 3) конкретное соц-доказательство или risk-of-inaction под нишу; 4) опционально — мягкий CTA-абзац перед кнопкой.',
          'ctaText — текст для CTA-строки, что-то вроде «Посмотреть превью» или из nicheConfig.ctaPrimary.',
          'postscript — короткий P.S. с альтернативой или мягким опт-аутом ("если не актуально, просто ответьте: не интересно").',
          'deal оценивай в рублях как потенциальный чек сайта.',
          'replyRate оценивай реалистично в процентах.',
          'Письмо НЕ шаблонное. Не пиши «Здравствуйте! Меня зовут…», не используй «уникальное предложение», «революционный», «AI-powered», «мы команда профессионалов».',
          'К моменту отправки превью уже подготовлено — пиши в логике "подготовили один вариант превью под вас, можно обсудить и поменять".',
          'Для автоотправки приоритетный канал всегда Email; телефон, SMS, WhatsApp и звонки только как ручное решение администратора.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          lead: {
            name: lead.name,
            city: lead.city,
            niche: lead.niche,
            rating: lead.rating,
            reviews: lead.reviews,
            yearsOnMap: lead.years,
            currentSite: lead.site,
            address: lead.address,
            phone: lead.phone,
          },
          nicheConfig: {
            slug: niche.slug,
            label: niche.label,
            heroAngle: niche.heroAngle,
            sections: niche.sections,
            ctaPrimary: niche.ctaPrimary,
            ctaSecondary: niche.ctaSecondary,
            trustSignals: niche.trustSignals,
            emailHook: niche.emailHook,
            emailProofIdea: niche.emailProofIdea,
            emailRiskIfIgnored: niche.emailRiskIfIgnored,
          },
          siteAnalysis: compactSiteAnalysisForPrompt(siteAnalysis),
          market: 'Россия',
          source: lead.source === 'google_places' ? 'Google Places' : 'Яндекс Карты',
          offer: 'готовый сайт/лендинг в Lovable с быстрым запуском',
        }),
      },
    ],
  });

  const text = response.output_text?.trim() || '{}';
  try {
    const result = normalizeDiagnosis(JSON.parse(text), lead, niche);
    if (siteAnalysis) result.siteAnalysis = compactSiteAnalysisForLead(siteAnalysis);
    return result;
  } catch {
    const fallback = fallbackDiagnosis(lead, niche);
    if (siteAnalysis) fallback.siteAnalysis = compactSiteAnalysisForLead(siteAnalysis);
    return { ...fallback, rawModelOutput: text };
  }
}

function compactSiteAnalysisForPrompt(analysis) {
  if (!analysis || !analysis.ok) {
    return analysis ? { ok: false, reason: analysis.reason || analysis.error || 'unknown' } : null;
  }
  return {
    ok: true,
    finalUrl: analysis.finalUrl,
    title: analysis.title,
    description: analysis.description,
    headings: (analysis.headings || []).slice(0, 6),
    services: (analysis.services || []).slice(0, 8),
    keywords: (analysis.keywords || []).slice(0, 8),
    addresses: (analysis.addresses || []).slice(0, 2),
    phones: (analysis.phones || []).slice(0, 3),
    emails: (analysis.emails || []).slice(0, 3),
    platform: analysis.platform,
    lastCopyrightYear: analysis.lastCopyrightYear,
    looksOutdated: analysis.looksOutdated,
  };
}

function compactSiteAnalysisForLead(analysis) {
  if (!analysis || !analysis.ok) {
    return {
      ok: false,
      reason: analysis?.reason || analysis?.error || 'unknown',
      url: analysis?.url || '',
      updatedAt: analysis?.updatedAt || new Date().toISOString(),
    };
  }
  return {
    ok: true,
    url: analysis.url,
    finalUrl: analysis.finalUrl,
    status: analysis.status,
    title: analysis.title,
    description: analysis.description,
    headings: (analysis.headings || []).slice(0, 8),
    services: (analysis.services || []).slice(0, 10),
    keywords: (analysis.keywords || []).slice(0, 10),
    phones: (analysis.phones || []).slice(0, 3),
    emails: (analysis.emails || []).slice(0, 3),
    addresses: (analysis.addresses || []).slice(0, 2),
    platform: analysis.platform,
    lastCopyrightYear: analysis.lastCopyrightYear,
    looksOutdated: analysis.looksOutdated,
    updatedAt: analysis.updatedAt,
  };
}

export async function evaluatePitch(lead) {
  if (!client) return fallbackEval(lead);
  const channel = String(lead.outboundPackage?.channel || lead.channel || 'email').toLowerCase();
  const mode = lead.checkerMode || (channel === 'email' ? 'scout_email' : 'short_message');
  const maxWords = mode === 'scout_email' ? 320 : 70;

  const response = await client.responses.create({
    model: checkerModel(),
    input: [
      {
        role: 'system',
        content: [
          'Ты Checker агент Web Studio. Верни строго JSON: passed boolean, score 0-100, issues array, revisedMessage.',
          `Режим: ${mode}. Канал: ${channel}. Лимит слов для body: ${maxWords}.`,
          'Если channel=email, проверяй письмо, а не SMS или телефонный скрипт.',
          'Для email ссылки на превью, видео и Telegram-бота допустимы и не считаются перегрузом, если есть один понятный следующий шаг.',
          'Критерии email: персонализация под компанию/ситуацию, ясная польза, нет AI/шаблонных маркеров, нет buzzwords, нет давления, есть простой следующий шаг.',
          'Критерии short_message: до 70 слов, без нескольких ссылок, один простой следующий шаг.',
          'Не ругай email за то, что он длиннее телефонного сообщения. Не требуй лимит 70 слов для email.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          mode,
          channel,
          subject: lead.outboundPackage?.subject || lead.subject || '',
          previewUrl: lead.outboundPackage?.previewUrl || '',
          videoUrl: lead.outboundPackage?.videoUrl || '',
          botLink: lead.outboundPackage?.botLink || '',
          lead: {
            name: lead.name,
            city: lead.city,
            niche: lead.niche,
            rating: lead.rating,
            reviews: lead.reviews,
            channel,
            message: lead.message,
            diagnosis: lead.diagnosis,
          },
        }),
      },
    ],
  });

  const text = response.output_text?.trim() || '{}';
  try {
    const parsed = JSON.parse(text);
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const hardFail = issues.some((issue) =>
      /нет превью|missing preview|preview_quality|качество превью|нет ссылки|нет telegram|нет бота|запрещ|нелегал|спам|обман|нет персонализа/i.test(String(issue || '')),
    );
    const score = Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : 0;
    return {
      passed: mode === 'scout_email' && !hardFail && score >= 60 ? true : Boolean(parsed.passed),
      score,
      issues,
      revisedMessage: parsed.revisedMessage || lead.message || '',
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return { ...fallbackEval(lead), rawModelOutput: text };
  }
}

function normalizeDiagnosis(data, lead, niche) {
  const fallback = fallbackDiagnosis(lead, niche);
  const bodyParagraphs = Array.isArray(data.bodyParagraphs)
    ? data.bodyParagraphs.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5)
    : [];
  const variantsRaw = Array.isArray(data.subjectVariants) ? data.subjectVariants : [];
  const subjectVariants = variantsRaw
    .map((variant) => {
      if (typeof variant === 'string') return { text: variant.trim().slice(0, 120), angle: '' };
      if (variant && typeof variant === 'object') {
        return { text: String(variant.text || '').trim().slice(0, 120), angle: String(variant.angle || '').trim().slice(0, 40) };
      }
      return null;
    })
    .filter((variant) => variant && variant.text)
    .slice(0, 4);
  const subject = data.subject || fallback.subject;
  if (subject && !subjectVariants.some((variant) => variant.text === subject)) {
    subjectVariants.unshift({ text: subject, angle: 'primary' });
  }
  return {
    diagnosis: data.diagnosis || fallback.diagnosis,
    angle: data.angle || fallback.angle,
    tone: data.tone || fallback.tone,
    message: data.message || fallback.message,
    subject,
    subjectVariants: subjectVariants.length ? subjectVariants : fallback.subjectVariants,
    bodyParagraphs: bodyParagraphs.length ? bodyParagraphs : fallback.bodyParagraphs,
    ctaText: data.ctaText || niche.ctaPrimary || fallback.ctaText,
    postscript: data.postscript || fallback.postscript,
    nicheSlug: niche.slug,
    channel: chooseChannel(),
    deal: Number.isFinite(Number(data.deal)) ? Number(data.deal) : estimateDeal(lead),
    replyRate: Number.isFinite(Number(data.replyRate)) ? Number(data.replyRate) : 14,
  };
}

function chooseChannel() {
  return 'Email';
}

function estimateDeal(lead) {
  const niche = String(lead.niche || '').toLowerCase();
  if (niche.includes('стомат') || niche.includes('недвиж')) return 320000;
  if (niche.includes('кров') || niche.includes('кондиционер')) return 180000;
  return 140000;
}

function fallbackDiagnosis(lead, niche = {}) {
  const subject = lead.name
    ? `${lead.name}: ${niche.heroAngle || 'короткое превью под вашу нишу'}`.slice(0, 60)
    : `Сделали превью сайта под ${niche.label || 'вашу нишу'}`.slice(0, 60);
  const businessShort = (lead.name || 'компании').slice(0, 30);
  const cityShort = (lead.city || '').slice(0, 20);
  const subjectVariants = [
    { angle: 'primary', text: subject },
    { angle: 'question', text: `${businessShort}: ${niche.ctaPrimary?.toLowerCase() || 'оставить заявку'} прямо с первого экрана?`.slice(0, 60) },
    { angle: 'benefit', text: `Превью сайта под ${niche.label?.toLowerCase() || 'вашу нишу'} для ${businessShort}`.slice(0, 60) },
    cityShort
      ? { angle: 'city', text: `${businessShort} в ${cityShort}: один вариант сайта на пробу`.slice(0, 60) }
      : { angle: 'rating', text: lead.rating ? `${businessShort}: ${lead.rating}★ и сайт под этот уровень`.slice(0, 60) : `${businessShort}: вариант сайта под вашу нишу`.slice(0, 60) },
  ];
  return {
    diagnosis: `${lead.name || 'Компания'} уже получает доверие через карты: рейтинг ${lead.rating ?? '4+'}, отзывов ${lead.reviews ?? 'немного'}. Если сайта нет или он слабее карточки, часть клиентов не видит услуги, цены и понятный первый шаг — лендинг под нишу может забрать этот теплый спрос.`,
    angle: niche.heroAngle || `${lead.niche || 'ваш бизнес'}: быстро показать доверие и ясную заявку с первого экрана.`,
    tone: niche.typography?.mood || 'конкретный, спокойный, без давления',
    message: `Здравствуйте. Подготовили первый вариант сайта для ${lead.name || 'вашей компании'} под ${niche.label || 'вашу нишу'}: ${niche.ctaPrimary?.toLowerCase() || 'оставить заявку'} с первого экрана. Если направление интересно — посмотрите превью и скажите, что заменить.`,
    subject,
    subjectVariants,
    bodyParagraphs: [
      `${lead.name ? `${lead.name},` : 'Здравствуйте.'} мы из 1Lab. У вас уже сильная карточка ${lead.city ? `в ${lead.city}` : 'в картах'}${lead.rating ? `, рейтинг ${lead.rating}` : ''}${lead.reviews ? `, ${lead.reviews} отзывов` : ''}. Этот теплый спрос можно превращать в заявки через сайт.`,
      `${niche.emailHook || 'Карточка в картах уже даёт доверие, но без сильного сайта поток заявок тонет.'} ${niche.emailProofIdea || 'Превью покажет оффер, услуги и быстрый шаг к заявке.'}`,
      niche.emailRiskIfIgnored || 'Без современного сайта клиенты уходят к компаниям, которые показали оффер и цены сразу.',
      'Подготовили один рабочий вариант превью под вас. Можно посмотреть и сказать, что поменять — мы доведем под ваши тексты, фото и контакты.',
    ],
    ctaText: niche.ctaPrimary || 'Посмотреть превью',
    postscript: 'Если сейчас не актуально, просто ответьте «не интересно».',
    nicheSlug: niche.slug || '_default',
    channel: chooseChannel(),
    deal: estimateDeal(lead),
    replyRate: 14,
  };
}

function fallbackEval(lead) {
  const words = String(lead.message || '').trim().split(/\s+/).filter(Boolean);
  const channel = String(lead.outboundPackage?.channel || lead.channel || 'email').toLowerCase();
  const maxWords = channel === 'email' ? 320 : 70;
  const issues = [];
  if (!lead.message) issues.push('Нет сообщения');
  if (words.length > maxWords) issues.push(`Сообщение длиннее ${maxWords} слов`);
  if (lead.name && !String(lead.message || '').includes(lead.name)) issues.push('Слабая персонализация');
  return {
    passed: issues.length === 0,
    score: issues.length === 0 ? 86 : 58,
    issues,
    revisedMessage: lead.message || '',
    checkedAt: new Date().toISOString(),
  };
}
