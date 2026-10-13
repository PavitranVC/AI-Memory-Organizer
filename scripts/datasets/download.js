// Downloads the datasets into data/ (gitignored: the files are large and are not ours to redistribute).
//   npm run data:download                      LoCoMo (the default)
//   npm run data:download -- locomo longmemeval  several
//   npm run data:download -- locomo --from C:\Downloads\locomo10.json   use a file you downloaded yourself
// A blocked host is reported by name and the other datasets still download. Every file is checked against
// the SHA-256 recorded below, so a changed upstream file is noticed instead of silently changing results.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

const DATASETS = {
  locomo: {
    label: 'benchmark',
    files: [
      {
        url: 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json',
        out: 'locomo/locomo10.json',
        // Measured on the file downloaded on 2026-10-12 (2,805,274 bytes)
        sha256: '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4',
      },
    ],
  },
  // NOT RUN: huggingface.co is blocked in the cloud session, so this URL has never been fetched here.
  // TODO: verify the repository and file name on Hugging Face before relying on it.
  longmemeval: {
    label: 'benchmark',
    files: [{ url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s', out: 'longmemeval/longmemeval_s.json', sha256: null }],
  },
  // Not implemented: WildChat is gated (accept the terms on Hugging Face, HF_TOKEN), ships as Parquet and
  // needs PII scrubbing before anything is stored. See docs/DATASETS.md.
  wildchat: { label: 'real', files: [], notImplemented: 'WildChat download is not implemented yet (gated, Parquet, needs PII scrubbing first).' },
};

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function fetchFile(url) {
  const headers = {};
  // Hugging Face needs a token for gated datasets; it is only ever sent to huggingface.co
  if (process.env.HF_TOKEN && new URL(url).hostname === 'huggingface.co') headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  let res;
  try {
    res = await fetch(url, { headers, redirect: 'follow' });
  } catch (err) {
    const code = err.cause && (err.cause.code || err.cause.message);
    throw new Error(`cannot reach ${new URL(url).hostname} (${code || err.message}); the host may be blocked by the network policy`);
  }
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadFile(file, { from, allowHashChange }) {
  const buffer = from ? fs.readFileSync(from) : await fetchFile(file.url);
  const hash = sha256(buffer);
  if (file.sha256 && hash !== file.sha256 && !allowHashChange) {
    throw new Error(`SHA-256 mismatch for ${file.out}: expected ${file.sha256}, got ${hash}. The upstream file changed; ` +
      'check it, then re-run with --allow-hash-change and update the hash in this script and docs/DATASETS.md.');
  }
  const target = path.join(DATA_DIR, file.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  // A small record of exactly what was downloaded, kept next to the file
  const meta = { url: from ? null : file.url, from: from || null, bytes: buffer.length, sha256: hash, downloadedAt: new Date().toISOString() };
  fs.writeFileSync(`${target}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  return { file: path.relative(process.cwd(), target), bytes: buffer.length, sha256: hash, hashChecked: Boolean(file.sha256) };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const from = option('--from');
  const allowHashChange = args.includes('--allow-hash-change');
  const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--from');
  const wanted = names.length ? names : ['locomo'];
  if (from && wanted.length !== 1) throw new Error('--from works with exactly one dataset name');

  let failed = 0;
  for (const name of wanted) {
    const dataset = DATASETS[name];
    if (!dataset) {
      console.error(`${name}: unknown dataset (known: ${Object.keys(DATASETS).join(', ')})`);
      failed += 1;
      continue;
    }
    if (dataset.notImplemented) {
      console.log(`${name}: skipped. ${dataset.notImplemented}`);
      continue;
    }
    for (const file of dataset.files) {
      try {
        const done = await downloadFile(file, { from, allowHashChange });
        console.log(`${name}: saved ${done.file} (${done.bytes} bytes, sha256 ${done.sha256.slice(0, 12)}..., ${done.hashChecked ? 'hash verified' : 'no recorded hash to verify'})`);
      } catch (err) {
        // Report and carry on with the other datasets
        console.error(`${name}: FAILED, ${err.message}`);
        failed += 1;
      }
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
