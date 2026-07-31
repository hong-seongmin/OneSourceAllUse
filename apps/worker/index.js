import { createPostgresDatabase } from '../shared/db.js';
import { processNextEvent } from './worker.js';

const db = createPostgresDatabase(process.env.DATABASE_URL);
const config = {
  environment: process.env.NODE_ENV || 'development',
  testMode: process.env.OSAU_TEST_MODE === '1',
  secretKey: process.env.SECRET_ENCRYPTION_KEY,
  modelMaxTokens: Number(process.env.OSAU_MODEL_MAX_TOKENS) || 4096,
  modelTimeoutMs: Number(process.env.OSAU_MODEL_TIMEOUT_MS) || 120000,
  modelReasoningEffort: process.env.OSAU_MODEL_REASONING_EFFORT || 'none',
  plannerSuggestionBatchSize: Number(process.env.OSAU_PLANNER_CORPUS_BATCH_SIZE) || 10,
  plannerSuggestionSourceCharBudget: Number(process.env.OSAU_PLANNER_SOURCE_CHAR_BUDGET) || 4_000,
  plannerSuggestionMaxSupplementalSources: Number(process.env.OSAU_PLANNER_MAX_SUPPLEMENTAL_SOURCES) || 8,
  youtubeOembedBaseUrl: process.env.NODE_ENV === 'test' ? process.env.OSAU_YOUTUBE_OEMBED_BASE_URL : null,
  network: { allowPrivateNetworks: process.env.OSAU_ALLOW_PRIVATE_NETWORKS === '1' }
};
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });

while (!stopping) {
  const result = await processNextEvent(db, config);
  if (!result) await new Promise((resolve) => setTimeout(resolve, 750));
  if (result?.error) console.error(JSON.stringify({ worker: 'job_failed', eventType: result.eventType, code: result.error.code, message: result.error.message }));
}
await db.close();
