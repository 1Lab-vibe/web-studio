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
          'Ты Diagnoser агент российской solo web-agency. Верни строго JSON без markdown: diagnosis, angle, tone, message, channel, deal, replyRate. diagnosis около 50 слов. message меньше 70 слов, персонализированное холодное сообщение на русском без AI-маркеров и buzzwords. deal оценивай в рублях как потенциальный чек сайта. replyRate оценивай реалистично в процентах.',
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

  const response = await client.responses.create({
    model: config.OPENAI_MODEL,
    input: [
      {
        role: 'system',
        content:
          'Ты Checker агент. Проверь холодное сообщение перед отправкой. Верни строго JSON: passed boolean, score 0-100, issues array, revisedMessage. Критерии: персонализация, нет AI-маркеров, нет buzzwords, меньше 70 слов, понятный следующий шаг, канал подходит нише.',
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
            channel: lead.channel,
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
    channel: data.channel || chooseChannel(lead),
    deal: Number.isFinite(Number(data.deal)) ? Number(data.deal) : estimateDeal(lead),
    replyRate: Number.isFinite(Number(data.replyRate)) ? Number(data.replyRate) : 14,
  };
}

function chooseChannel(lead) {
  const niche = String(lead.niche || '').toLowerCase();
  if (niche.includes('салон') || niche.includes('красот') || niche.includes('beauty')) return 'Instagram DM';
  if (niche.includes('риел') || niche.includes('недвиж')) return 'LinkedIn';
  if (lead.phone) return 'SMS';
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
    diagnosis: `${lead.name} выглядит сильнее в карточке на картах, чем в собственной упаковке. При рейтинге ${lead.rating ?? '4+'} и ${lead.reviews ?? 'небольшом числе'} отзывах бизнесу нужна страница, где сразу видны доверие, услуги, доказательства и быстрый первый шаг. Сейчас часть теплого спроса уходит конкурентам с понятным сайтом.`,
    angle: `${lead.niche}: быстро показать доверие, работы и заявку с первого экрана.`,
    tone: 'конкретный, спокойный, без давления',
    message: `Здравствуйте. Нашел ${lead.name} в картах: отзывы хорошие, но сайт выглядит слабее карточки или не найден. Я подготовил идею короткой страницы под заявки для ниши «${lead.niche}». Могу прислать превью?`,
    channel: chooseChannel(lead),
    deal: estimateDeal(lead),
    replyRate: 14,
  };
}

function fallbackEval(lead) {
  const words = String(lead.message || '').trim().split(/\s+/).filter(Boolean);
  const issues = [];
  if (!lead.message) issues.push('Нет сообщения');
  if (words.length > 70) issues.push('Сообщение длиннее 70 слов');
  if (!String(lead.message || '').includes(lead.name)) issues.push('Слабая персонализация');
  return {
    passed: issues.length === 0,
    score: issues.length === 0 ? 86 : 58,
    issues,
    revisedMessage: lead.message || '',
    checkedAt: new Date().toISOString(),
  };
}
