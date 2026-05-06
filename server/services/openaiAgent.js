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

function normalizeDiagnosis(data, lead) {
  return {
    diagnosis: data.diagnosis || fallbackDiagnosis(lead).diagnosis,
    angle: data.angle || fallbackDiagnosis(lead).angle,
    tone: data.tone || fallbackDiagnosis(lead).tone,
    message: data.message || fallbackDiagnosis(lead).message,
    channel: data.channel || chooseChannel(lead),
    deal: Number.isFinite(Number(data.deal)) ? Number(data.deal) : estimateDeal(lead),
    replyRate: Number.isFinite(Number(data.replyRate)) ? Number(data.replyRate) : 14,
  };
}

function chooseChannel(lead) {
  const niche = String(lead.niche || '').toLowerCase();
  if (niche.includes('салон') || niche.includes('красот')) return 'Instagram DM';
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
