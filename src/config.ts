import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  PORT: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().positive().default(3000),
  ),
  PGHOST: z.string().trim().optional().default(''),
  PGPORT: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().positive().default(5432),
  ),
  PGDATABASE: z.string().trim().optional().default(''),
  PGUSER: z.string().trim().optional().default(''),
  PGPASSWORD: z.string().optional().default(''),
  DATAFORSEO_LOGIN: z.string().optional().default(''),
  DATAFORSEO_PASSWORD: z.string().optional().default(''),
  GMAIL_USER: z.string().optional().default(''),
  GMAIL_APP_PASSWORD: z.string().optional().default(''),
  ALERT_TO_EMAIL: z.string().optional().default(''),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export function isDatabaseConfigured(): boolean {
  return Boolean(config.PGHOST && config.PGDATABASE && config.PGUSER && config.PGPASSWORD);
}
