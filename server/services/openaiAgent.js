import OpenAI from 'openai';
import { config, hasSecret } from '../config.js';

const client = hasSecret(config.OPENAI_API_KEY) ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : null;

export async function diagnoseLead(lead) {
  if (!client) return fallbackDiagnosis(lead);

  const response = await client.responses.create({
    model: config.OPENAI_MODEL,
    input: [
      {
        role: 'system',
        content:
          'Ты Diagnoser агент российской solo web-agency. Верни строго JSON без markdown: diagnosis, angle, tone, message, channel, deal, replyRate. diagnosis около 50 слов. message меньше 70 слов, персонализированное холодное сообщение на русском без AI-маркеров и buzzwords. Важно: к моменту отправки Web Studio уже подготовит превью сайта, поэтому message не должен обещать "могу прислать превью"; пиши в логике "подготовили один вариант превью, можно обсудить и поменять под ваши идеи". deal оценивай в рублях как потенциальный чек сайта. replyRate оценивай реалистично в процентах. Для автоотправки приоритетный канал всегда Email; телефон, SMS, WhatsApp и звонки только как ручное решение администратора.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          lead,
          market: 'Россия',
          source: lead.source === 'google_places' ? 'Google Places' : 'Яндекс Карты',
          offer: 'готовый сайт/лендинг в Lovable с быстрым запуском',
        }),
      },
    ],
  });

  const text = response.output_text?.trim() || '{}';
  try {
    return normalizeDiagnosis(JSON.parse(text), lead);
  } catch {
    return { ...fallbackDiagnosis(lead), rawModelOutput: text };
  }
}

export async function evaluatePitch(lead) {
  if (!client) return fallbackEval(lead);
  const channel = String(lead.outboundPackage?.channel || lead.channel || 'email').toLowerCase();
  const mode = lead.checkerMode || (channel === 'email' ? 'scout_email' : 'short_message');
  const maxWords = mode === 'scout_email' ? 320 : 70;

  const response = await client.responses.create({
    model: config.OPENAI_MODEL,
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
    return {
      passed: Boolean(parsed.passed),
      score: Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : 0,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      revisedMessage: parsed.revisedMessage || lead.message || '',
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return { ...fallbackEval(lead), rawModelOutput: text };
  }
}

function normalizeDiagnosis(data, lead) {
  const fallback = fallbackDiagnosis(lead);
  return {
    diagnosis: data.diagnosis || fallback.diagnosis,
    angle: data.angle || fallback.angle,
    tone: data.tone || fallback.tone,
    message: data.message || fallback.message,
    channel: chooseChannel(lead),
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

function fallbackDiagnosis(lead) {
  return {
    diagnosis: `${lead.name} уже получает доверие через карты: рейтинг ${lead.rating ?? '4+'}, отзывов ${lead.reviews ?? 'немного'}. Если сайта нет или он слабее карточки, часть людей не видит услуги, цены, примеры работ и удобный первый шаг. Лендинг может забрать этот теплый спрос и вести к заявке.`,
    angle: `${lead.niche}: быстро показать доверие, услуги и заявку с первого экрана.`,
    tone: 'конкретный, спокойный, без давления',
    message: `Здравствуйте. Подготовили первый вариант сайта для ${lead.name}: с упором на услуги, доверие и быстрый запрос. Если направление интересно, можно посмотреть превью и сказать, что заменить под вашу компанию.`,
    channel: chooseChannel(lead),
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
