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
          'Ты Diagnoser агент российской solo web-agency. Верни строго JSON без markdown: diagnosis, angle, tone, message. diagnosis около 50 слов. message меньше 70 слов, персонализированное холодное сообщение на русском без AI-маркеров и buzzwords.',
      },
      {
        role: 'user',
        content: JSON.stringify({ lead, market: 'Россия', source: 'Яндекс Карты', offer: 'готовый сайт в Lovable' }),
      },
    ],
  });

  const text = response.output_text?.trim() || '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { ...fallbackDiagnosis(lead), rawModelOutput: text };
  }
}

function fallbackDiagnosis(lead) {
  return {
    diagnosis: `${lead.name} выглядит сильнее в Яндекс Картах, чем в собственной упаковке. При рейтинге ${lead.rating ?? '4+'} и ${lead.reviews ?? 'малом числе'} отзывах бизнесу нужна страница, где сразу видны доверие, услуги, доказательства и быстрый первый шаг. Сейчас часть теплого спроса уходит конкурентам с понятным сайтом.`,
    angle: `${lead.niche}: быстро показать доверие, работы и заявку с первого экрана.`,
    tone: 'конкретный, спокойный, без давления',
    message: `Здравствуйте. Нашел ${lead.name} в Яндекс Картах: отзывы хорошие, но сайт выглядит слабее карточки. Я подготовил идею короткой страницы под заявки для ниши «${lead.niche}». Могу прислать превью?`,
  };
}
