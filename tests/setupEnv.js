// Runs before every test file: configuration for the test environment
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.BCRYPT_ROUNDS = '4'; // fast hashing in tests; production uses 10
// Stage 3: tests only ever use the deterministic mock LLM, even if a real key is set in the environment
process.env.LLM_PROVIDER = 'mock';
delete process.env.ANTHROPIC_API_KEY;
process.env.JOB_RETRY_DELAY_MS = '0'; // a failed job is due again at once, so tests can retry it immediately
process.env.MONGO_URI_TEST = process.env.MONGO_URI_TEST || 'mongodb://127.0.0.1:27017/aimemory_test';
