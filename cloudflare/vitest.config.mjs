import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: {
    bindings: { AUTH_MODE: 'local', OPENAI_API_KEY: 'test-only', TRIBE_SCORE_URL: 'https://percept.test/predict', MIGRATIONS: await readD1Migrations('./migrations') },
  } })],
  test: { include: ['tests/**/*.test.mjs'], testTimeout: 30000 },
});
