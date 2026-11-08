import { build, context } from 'esbuild';
import { cp, copyFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const out = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  target: 'chrome116',
  platform: 'browser',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const configs = [
  {
    ...common,
    entryPoints: [path.join(root, 'src/background/index.ts')],
    outfile: path.join(out, 'background.js'),
    format: 'esm',
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/content/index.ts')],
    outfile: path.join(out, 'content.js'),
    // Content scripts cannot be ES modules; bundle as IIFE.
    format: 'iife',
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/offscreen/index.ts')],
    outfile: path.join(out, 'offscreen.js'),
    format: 'esm',
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/ui/popup/main.ts')],
    outfile: path.join(out, 'ui/popup.js'),
    format: 'esm',
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/ui/options/main.ts')],
    outfile: path.join(out, 'ui/options.js'),
    format: 'esm',
  },
];

async function copyStatic() {
  await mkdir(path.join(out, 'ui'), { recursive: true });
  await mkdir(path.join(out, 'icons'), { recursive: true });
  await copyFile(path.join(root, 'src/ui/popup/index.html'), path.join(out, 'popup.html'));
  await copyFile(path.join(root, 'src/ui/popup/style.css'), path.join(out, 'ui/popup.css'));
  await copyFile(path.join(root, 'src/ui/options/index.html'), path.join(out, 'options.html'));
  await copyFile(path.join(root, 'src/ui/options/style.css'), path.join(out, 'ui/options.css'));
  await copyFile(path.join(root, 'src/offscreen/index.html'), path.join(out, 'offscreen.html'));
  await cp(path.join(root, 'public/worklet'), path.join(out, 'worklet'), { recursive: true });
  if (existsSync(path.join(root, 'public/icons'))) {
    await cp(path.join(root, 'public/icons'), path.join(out, 'icons'), { recursive: true });
  }
  await copyFile(path.join(root, 'manifest.json'), path.join(out, 'manifest.json'));
}

async function main() {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await copyStatic();

  if (watch) {
    const ctxs = await Promise.all(configs.map((cfg) => context(cfg)));
    await Promise.all(ctxs.map((ctx) => ctx.watch()));
    console.log('watching extension sources...');
    return;
  }

  await Promise.all(configs.map((cfg) => build(cfg)));
  console.log(`built extension → ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
