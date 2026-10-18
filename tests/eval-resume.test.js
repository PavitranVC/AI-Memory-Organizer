const fs = require('fs');
const os = require('os');
const path = require('path');
const { connect, disconnect, clear, models } = require('./helpers');
const { Ledger, replay, FILE } = require('../eval/checkpoint');
const { evaluateSample } = require('../eval/harness');
const miniLocomo = require('./fixtures/locomo-mini');

const { User } = models;

const FINGERPRINT = { samples: ['test-1'], questionsPerSample: 0, k: 5, seed: 1, systems: ['full_context'], provider: 'mock' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
const lines = (dir) => fs.readFileSync(path.join(dir, FILE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const row = (system, qa, extra = {}) => ({ sample: 'test-1', qa_index: qa, system, answer: 'a', recall_at_k: null, ...extra });

describe('checkpoint ledger (no database)', () => {
  test('a row is on disk when addRow returns, and a new process reads it back', () => {
    const dir = tmp();
    const ledger = Ledger.open(dir, FINGERPRINT);
    ledger.addRow(row('ours', 3));
    const again = Ledger.open(dir, FINGERPRINT);
    expect(again.resumed).toBe(true);
    expect([...again.rowsFor('test-1').keys()]).toEqual(['ours|3']);
    expect(lines(dir).map((e) => e.type)).toEqual(['run', 'row', 'resume']);
  });

  test('undefined values are written as null, so a row keeps all its columns', () => {
    const dir = tmp();
    const ledger = Ledger.open(dir, FINGERPRINT);
    ledger.addRow(row('ours', 0, { answer_cost_usd: undefined }));
    const stored = Ledger.open(dir, FINGERPRINT).rowsFor('test-1').get('ours|0');
    expect(Object.keys(stored)).toContain('answer_cost_usd');
    expect(stored.answer_cost_usd).toBeNull();
  });

  test('a last line cut off by a crash is skipped, and the next write starts on a clean line', () => {
    const dir = tmp();
    const ledger = Ledger.open(dir, FINGERPRINT);
    ledger.addRow(row('ours', 0));
    fs.appendFileSync(path.join(dir, FILE), '{"type":"row","row":{"sample":"test-1","sys');
    expect(replay(path.join(dir, FILE)).badLines).toBe(1);
    const again = Ledger.open(dir, FINGERPRINT);
    again.addRow(row('ours', 1));
    const state = replay(path.join(dir, FILE));
    expect(state.samples.get('test-1').rows.size).toBe(2);
    // only the damaged fragment is lost; every line after it parses
    expect(state.badLines).toBe(1);
  });

  test('a checkpoint from another experiment is refused, naming what differs', () => {
    const dir = tmp();
    Ledger.open(dir, FINGERPRINT);
    expect(() => Ledger.open(dir, { ...FINGERPRINT, provider: 'ollama', k: 10 })).toThrow(/k, provider/);
  });

  test('--restart sets the old checkpoint aside instead of deleting it', () => {
    const dir = tmp();
    Ledger.open(dir, FINGERPRINT).addRow(row('ours', 0));
    const fresh = Ledger.open(dir, { ...FINGERPRINT, k: 10 }, { restart: true });
    expect(fresh.resumed).toBe(false);
    expect(fresh.rowsFor('test-1').size).toBe(0);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl.bak'))).toHaveLength(1);
  });

  test('a discard removes the rows and builds of a group, also when the ledger is read again', () => {
    const dir = tmp();
    const ledger = Ledger.open(dir, FINGERPRINT);
    ledger.addRow(row('ours', 0));
    ledger.addRow(row('overwrite_memory', 0));
    ledger.addBuild('test-1', { store: 'bitemporal' });
    ledger.discard('test-1', { systems: ['ours'], builds: ['bitemporal'] });
    const state = replay(path.join(dir, FILE)).samples.get('test-1');
    expect([...state.rows.keys()]).toEqual(['overwrite_memory|0']);
    expect(state.builds.size).toBe(0);
  });

  test('the extraction cache gets back what it held, without writing it again', () => {
    const dir = tmp();
    const ledger = Ledger.open(dir, FINGERPRINT);
    const cache = ledger.cacheFor('test-1');
    cache.set('D1:1|t', { facts: [1] });
    cache.set('D1:1|t', { facts: [1] });
    const again = Ledger.open(dir, FINGERPRINT).cacheFor('test-1');
    expect(again.get('D1:1|t')).toEqual({ facts: [1] });
    again.set('D1:1|t', { facts: [2] });
    expect(lines(dir).filter((e) => e.type === 'cache')).toHaveLength(1);
  });

  test('a new data record means the earlier memory store is gone', () => {
    const dir = tmp();
    const ledger = Ledger.open(dir, FINGERPRINT);
    ledger.setData('test-1', ['a', 'b']);
    ledger.storeBuilt('test-1', 'bitemporal', 5);
    expect(replay(path.join(dir, FILE)).samples.get('test-1').lastStore).toEqual({ store: 'bitemporal', built: true, versions: 5 });
    ledger.setData('test-1', ['c', 'd']);
    expect(replay(path.join(dir, FILE)).samples.get('test-1').lastStore).toBeNull();
  });
});

describe('interrupting and resuming an evaluation (real MongoDB, mock model)', () => {
  beforeAll(connect);
  afterAll(disconnect);
  beforeEach(clear);

  const SYSTEMS = ['full_context', 'rag_messages', 'ours', 'ours_no_temporal', 'overwrite_memory'];
  const [sample] = miniLocomo();
  const TIMING = ['retrieval_ms', 'answer_ms', 'judge_ms', 'build_seconds'];
  const strip = (items) => items.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !TIMING.includes(k))));

  // The "kill" throws just before the nth call, like a process that dies before it can write that line
  function killBefore(ledger, method, nth) {
    const original = ledger[method].bind(ledger);
    let calls = 0;
    ledger[method] = (...args) => {
      calls += 1;
      if (calls >= nth) throw new Error('KILLED');
      return original(...args);
    };
  }

  function attempt(dir, { kill = null } = {}) {
    const ledger = Ledger.open(dir, { ...FINGERPRINT, systems: SYSTEMS });
    if (kill) killBefore(ledger, kill.method, kill.nth);
    let resets = 0;
    const resetDb = async () => {
      resets += 1;
      await clear();
    };
    const result = evaluateSample(sample, { questions: 0, k: 5, systems: SYSTEMS, ledger, resetDb });
    return { result, resets: () => resets, ledger };
  }

  async function reference() {
    await clear();
    const { result } = attempt(tmp());
    return result;
  }

  const rowsPerSystem = sample.qa.length;
  const killPoints = [
    ['in the middle of the full-context answers', { method: 'addRow', nth: 3 }],
    ['in the middle of the first memory system', { method: 'addRow', nth: rowsPerSystem * 2 + 3 }],
    ['in the middle of the second memory system of the same store', { method: 'addRow', nth: rowsPerSystem * 3 + 4 }],
    ['in the middle of the overwrite store answers', { method: 'addRow', nth: rowsPerSystem * 4 + 2 }],
    ['after a store was built but before it was recorded as built', { method: 'storeBuilt', nth: 1 }],
    ['when the overwrite store starts building', { method: 'storeStart', nth: 2 }],
  ];

  test.each(killPoints)('stopped %s, the second start gives the same results as an uninterrupted run', async (name, kill) => {
    const expected = await reference();
    await clear();
    const dir = tmp();
    await expect(attempt(dir, { kill }).result).rejects.toThrow('KILLED');
    const second = attempt(dir);
    const resumed = await second.result;
    expect(strip(resumed.rows)).toEqual(strip(expected.rows));
    expect(resumed.rows).toHaveLength(SYSTEMS.length * rowsPerSystem);
    expect(strip(resumed.builds.map((b) => ({ ...b })))).toEqual(strip(expected.builds.map((b) => ({ ...b }))));
    // The sample was still in MongoDB, so the second start did not empty the database again
    expect(second.resets()).toBe(0);
    expect(await User.countDocuments()).toBe(2);
  });

  test('a store that is still in MongoDB is reused, not built again', async () => {
    await clear();
    const dir = tmp();
    await expect(attempt(dir, { kill: { method: 'addRow', nth: rowsPerSystem * 3 + 4 } }).result).rejects.toThrow('KILLED');
    const before = lines(dir).filter((e) => e.type === 'store_start').length;
    await attempt(dir).result;
    const starts = lines(dir).filter((e) => e.type === 'store_start').map((e) => e.store);
    // bitemporal once (before the kill), overwrite once (after it): the bitemporal store was not rebuilt
    expect(before).toBe(1);
    expect(starts).toEqual(['bitemporal', 'overwrite']);
  });

  test('when MongoDB lost the store, a half-answered group is redone from one new build', async () => {
    const expected = await reference();
    await clear();
    const dir = tmp();
    await expect(attempt(dir, { kill: { method: 'addRow', nth: rowsPerSystem * 3 + 4 } }).result).rejects.toThrow('KILLED');
    await clear(); // the database was wiped while the run was stopped
    const second = attempt(dir);
    const resumed = await second.result;
    expect(second.resets()).toBe(1);
    const events = lines(dir);
    const discard = events.find((e) => e.type === 'discard');
    expect(discard.systems).toEqual(['ours', 'ours_no_temporal']);
    expect(discard.builds).toEqual(['bitemporal']);
    // full_context and rag_messages do not depend on the store: their rows were kept, not asked again
    expect(events.filter((e) => e.type === 'row' && e.row.system === 'full_context')).toHaveLength(rowsPerSystem);
    expect(strip(resumed.rows)).toEqual(strip(expected.rows));
  });

  test('a finished run is not run again: the second start only reads the checkpoint', async () => {
    await clear();
    const dir = tmp();
    const first = await attempt(dir).result;
    const second = attempt(dir);
    const again = await second.result;
    expect(strip(again.rows)).toEqual(strip(first.rows));
    expect(second.resets()).toBe(0);
    expect(lines(dir).filter((e) => e.type === 'row')).toHaveLength(SYSTEMS.length * rowsPerSystem);
    expect(lines(dir).filter((e) => e.type === 'sample_done')).toHaveLength(1);
  });
});
