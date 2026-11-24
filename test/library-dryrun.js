// Dry run against a real library with the bundled ffprobe. Proves nothing is written:
// compares a manifest of the library (every path, size, mtime) taken before and after, and checks the output folder was not created.
//   node test/library-dryrun.js <library folder> <output folder>
const fs = require('fs');
const path = require('path');
const E = require('../engine');

const [lib, out] = process.argv.slice(2);
const manifest = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { o.push(p + '\\'); manifest(p, o); } else { const s = fs.statSync(p); o.push(`${p}|${s.size}|${s.mtimeMs}`); } } return o; };

(async () => {
  const before = manifest(lib).sort().join('\n');
  const outExisted = fs.existsSync(out);
  const lines = [];
  const s = await E.runAll([lib], { outDir: out, dryRun: true }, { log: (l, m) => lines.push(`${l.padEnd(5)} ${m}`) });
  const after = manifest(lib).sort().join('\n');
  const by = {};
  for (const r of s.results) { const k = `${r.action}: ${r.reason.replace(/\d+x\d+/g, 'WxH').replace(/cover from .*?(?=;|,|$)/, 'cover from sidecar image')}`; by[k] = (by[k] || 0) + 1; }
  console.log(`ffprobe: ${E.FFPROBE.bin} (${E.FFPROBE.src})`);
  console.log(`Dry run of ${lib} -> ${out}: ${s.total} files in ${s.seconds.toFixed(1)} s`);
  console.log(`  would convert ${s.converted}, retag ${s.retagged}, copy ${s.copied}, skip ${s.skipped}, fail ${s.failed}`);
  Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));
  const dests = s.results.flatMap((r) => r.dests);
  const est = s.results.length;
  console.log(`  output names: ${dests.length}, unique ${new Set(dests.map((d) => d.toLowerCase())).size}, non-ASCII ${dests.filter((d) => /[^\x20-\x7e]/.test(path.relative(out, d))).length}, longest ${Math.max(...dests.map((d) => path.basename(d).length))} chars, split into parts ${s.results.filter((r) => r.dests.length > 1).length} of ${est}`);
  console.log('  sample plan lines:');
  lines.filter((l) => /\] (ENCODE|RETAG|COPY|FAIL)/.test(l)).filter((_, i) => i % 30 === 0).forEach((l) => console.log('   ' + l.slice(5)));
  s.results.filter((r) => r.status === 'failed').forEach((r) => console.log(`  would fail: ${r.rel}: ${r.reason}`));
  console.log(`Library manifest identical before and after (${before.split('\n').length} entries: paths, sizes, mtimes): ${before === after}`);
  console.log(`Output folder existed before: ${outExisted}; exists after: ${fs.existsSync(out)}`);
})();
