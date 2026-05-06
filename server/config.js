import 'dotenv/config';
import { z } from 'zod';

const boolFromEnv = z
  .string()
  .optional()
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase()));

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(8787),
  WEB_ORIGIN: z.string().default('http://127.0.0.1:5173'),
  AUTONOMY_ENABLED: boolFromEnv,
  AUTONOMY_CRON: z.string().default('*/30 * * * *'),
  DATA_DIR: z.string().default('./data'),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().default('gpt-5.4'),
  YANDEX_MAPS_API_KEY: z.string().optional().default(''),
  YANDEX_MAPS_LANG: z.string().default('ru_RU'),
  YANDEX_MAPS_RESULTS: z.coerce.number().default(25),
  SCOUT_CITIES: z.string().default('Москва,Казань,Екатеринбург,Краснодар'),
  SCOUT_NICHES: z.string().default('кровельщики,салон красоты,кондиционеры'),
  MIN_YEARS_ON_MAP: z.coerce.number().default(5),
  MAX_REVIEWS: z.coerce.number().default(50),
  MIN_RATING: z.coerce.number().default(4.4),
  DAILY_MOCKUP_LIMIT: z.coerce.number().default(5),
  DEAL_APPROVAL_USD: z.coerce.number().default(3000),
  MIN_REPLY_RATE: z.coerce.number().default(12),
  A1_API_URL: z.string().default('http://localhost:4000'),
  A1_API_KEY: z.string().optional().default(''),
  A1_MCP_URL: z.string().optional().default(''),
  A1_MCP_API_KEY: z.string().optional().default(''),
  A1_AGENT_ENVIRONMENT: z.string().default('local'),
  LOVABLE_MCP_URL: z.string().optional().default(''),
  LOVABLE_MCP_API_KEY: z.string().optional().default(''),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(''),
  PUBLIC_BASE_URL: z.string().default('https://webstudio.1true.ru'),
  WEB_STUDIO_MCP_TOKEN: z.string().optional().default(''),
  LOVABLE_EMAIL: z.string().optional().default(''),
  LOVABLE_PASSWORD: z.string().optional().default(''),
  LOVABLE_STORAGE_STATE: z.string().default('./data/lovable-storage-state.json'),
  LOVABLE_HEADLESS: boolFromEnv,
});

export const config = envSchema.parse(process.env);

export function csv(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function hasSecret(value) {
  return Boolean(value && value.trim().length > 0);
}
