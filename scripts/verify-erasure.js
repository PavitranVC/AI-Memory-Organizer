// Stage 7: proves that nothing derived from erased data remains (see services/erasureVerifier.js).
//   npm run erasure:verify                                   every user: no reference to a missing message/version
//   npm run erasure:verify -- --user <userId>                one user
//   npm run erasure:verify -- --messages <id>,<id>           and these erased message ids appear nowhere
//   npm run erasure:verify -- --text "diabetes"              and this phrase is in no memory, suggestion or log snapshot
// Prints one line per check and exits with code 1 if any check fails (so it can gate CI or a demo).
require('dotenv').config();
const mongoose = require('mongoose');
const { verifyErasure } = require('../services/erasureVerifier');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';

function option(args, name) {
  return args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const userId = option(args, '--user') || null;
  const messageIds = (option(args, '--messages') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const text = option(args, '--text') || null;

  await mongoose.connect(MONGO_URI);
  const report = await verifyErasure({ userId, messageIds, text });
  console.log(`Erasure verification (${typeof report.scope === 'string' ? report.scope : `user ${report.scope.userId}`})`);
  for (const c of report.checks) {
    console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.check}${c.ok ? '' : `: ${c.violations} (e.g. ${c.examples.join(', ')})`}`);
  }
  console.log(report.ok ? 'OK: nothing derived from erased data remains.' : 'FAILED: see the checks above.');
  process.exitCode = report.ok ? 0 : 1;
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});
