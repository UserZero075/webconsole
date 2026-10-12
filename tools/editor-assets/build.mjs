import {build} from 'esbuild';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const output = path.join(root, 'static/js/lib/editor');
await mkdir(output, {recursive: true});
const bundledInputs = new Set();

for (const [entry, outfile] of [
  ['src/editor-entry.js', 'editor.js'],
  ['src/markdown-entry.js', 'markdown.js'],
  ['src/merge-entry.js', 'merge.js'],
]) {
  const result = await build({
    entryPoints: [path.join(here, entry)],
    outfile: path.join(output, outfile),
    bundle: true,
    minify: true,
    sourcemap: false,
    legalComments: 'eof',
    format: 'iife',
    target: ['es2022'],
    platform: 'browser',
    charset: 'utf8',
    metafile: true,
  });
  Object.keys(result.metafile.inputs).forEach(input => bundledInputs.add(input));
}

const bundledPackages = new Map();
for (const input of bundledInputs) {
  const normalized = input.replaceAll('\\', '/');
  const marker = 'node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) continue;
  const remainder = normalized.slice(markerIndex + marker.length);
  const parts = remainder.split('/');
  const packagePath = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const packageRoot = path.resolve(here, 'node_modules', packagePath);
  if (!bundledPackages.has(packagePath)) {
    try {
      bundledPackages.set(packagePath, {
        root: packageRoot,
        data: JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')),
      });
    } catch (_) {}
  }
}

const notices = [];
for (const [name, pkg] of [...bundledPackages].sort(([left], [right]) => left.localeCompare(right))) {
  let licenseText = '';
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'NOTICE']) {
    try { licenseText = await readFile(path.join(pkg.root, file), 'utf8'); break; }
    catch (_) {}
  }
  notices.push(`## ${name} ${pkg.data.version}\n\nLicense: ${pkg.data.license || 'see package metadata'}\n`
    + (licenseText ? `\n${licenseText.trim()}\n` : ''));
}
await writeFile(path.join(output, 'THIRD-PARTY-NOTICES.md'),
  `# Third-party notices\n\nBundled runtime packages and their license texts.\n\n${notices.join('\n---\n\n')}\n`);

const lock = await readFile(path.join(here, 'package-lock.json'));
const manifest = {
  lock_sha256: createHash('sha256').update(lock).digest('hex'),
  assets: ['editor.js', 'markdown.js', 'merge.js'],
  third_party_notices: 'THIRD-PARTY-NOTICES.md',
  generated_by: 'tools/editor-assets/build.mjs',
};
await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
