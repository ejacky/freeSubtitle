import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const repo = path.resolve(root, '..');
const dist = path.join(root, 'dist');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

if (!existsSync(dist)) {
  console.error('dist/ 不存在，先运行 npm run build');
  process.exit(1);
}

const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
if (dirty) {
  console.error('工作区不干净；发布压缩包只允许在干净的 tag 上创建。');
  console.error(dirty.split('\n').slice(0, 10).join('\n'));
  process.exit(1);
}

let tag = '';
try {
  tag = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  tag = '';
}
if (tag !== `v${version}`) {
  console.error(`当前 HEAD 不是 v${version} tag（实际：${tag || '无 tag'}）。`);
  console.error('按项目规则：提交后打 tag，再运行 npm run zip。');
  process.exit(1);
}

const out = path.join(repo, `freeSubtitle-${version}.zip`);
execFileSync('zip', ['-r', '-q', out, '.'], { cwd: dist, stdio: 'inherit' });
console.log(`zip → ${out}`);
