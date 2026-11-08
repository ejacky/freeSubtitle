#!/usr/bin/env node
/**
 * Tiny OpenAI-compatible ASR bridge around whisper.cpp's whisper-server.
 *
 *   node server.mjs [--model base] [--port 8787] [--threads 4]
 *
 * The extension sends raw 16 kHz mono WAV (no multipart parsing needed here);
 * this process forwards it to whisper-server as multipart and adds CORS.
 */
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function arg(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

const model = arg('model', 'base');
const port = Number(arg('port', '8787'));
const whisperPort = Number(arg('whisper-port', '8788'));
const threads = Number(arg('threads', '4'));
const modelPath = path.resolve(
  arg('model-path', path.join(here, 'models', `ggml-${model}.bin`)),
);
const whisperBin = path.resolve(
  arg('whisper-bin', path.join(here, 'vendor', 'whisper.cpp', 'build', 'bin', 'whisper-server')),
);
const whisperUrl = `http://127.0.0.1:${whisperPort}`;
const MAX_BODY = 25 * 1024 * 1024;

if (!existsSync(whisperBin)) {
  console.error(`\n找不到 whisper-server：${whisperBin}`);
  console.error('先运行 ./setup.sh 构建 whisper.cpp，或用 --whisper-bin 指定路径。\n');
  process.exit(1);
}
if (!existsSync(modelPath)) {
  console.error(`\n找不到模型：${modelPath}`);
  console.error('先运行 ./setup.sh base（或 small），或用 --model-path 指定。\n');
  process.exit(1);
}

let child = null;
let ready = false;

function startWhisper() {
  console.log(`[asr] starting whisper-server (${model}, ${threads} threads)`);
  child = spawn(
    whisperBin,
    ['-m', modelPath, '--host', '127.0.0.1', '--port', String(whisperPort), '-t', String(threads)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => process.stdout.write(`[whisper] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[whisper] ${chunk}`));
  child.on('exit', (code, signal) => {
    ready = false;
    child = null;
    console.error(`[asr] whisper-server exited code=${code} signal=${signal}`);
  });
}

function waitForPort(targetPort, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect({ host: '127.0.0.1', port: targetPort });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`whisper-server 未在 ${timeoutMs}ms 内监听 ${targetPort}`));
        } else {
          setTimeout(tryConnect, 300);
        }
      });
    };
    tryConnect();
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  cors(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('音频超过 25MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function transcribe(req, res) {
  if (!ready) return json(res, 503, { error: 'whisper-server 未就绪' });
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readBody(req);
    console.log(`[asr] POST bytes=${body.length} model=${url.searchParams.get('model')} lang=${url.searchParams.get('language')}`);
    if (body.length < 100) return json(res, 400, { error: `音频为空 (${body.length} bytes)` });
    const form = new FormData();
    form.append('file', new Blob([body], { type: 'audio/wav' }), 'segment.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const language = url.searchParams.get('language');
    if (language && language !== 'auto') form.append('language', language);
    const prompt = url.searchParams.get('prompt');
    if (prompt) form.append('prompt', prompt.slice(0, 800));

    const started = Date.now();
    const upstream = await fetch(`${whisperUrl}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return json(res, 502, { error: `whisper-server ${upstream.status}: ${text.slice(0, 500)}` });
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text: text.trim() };
    }
    json(res, 200, {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      language: parsed.language,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    json(res, 500, { error: String(err instanceof Error ? err.message : err) });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: ready, model, ready, pid: child?.pid ?? null });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    json(res, 200, {
      object: 'list',
      data: [{ id: model, object: 'model', owned_by: 'local-whisper' }],
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
    void transcribe(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/') {
    json(res, 200, { name: 'freeSubtitle local-asr', model, ready });
    return;
  }
  json(res, 404, { error: 'not found' });
});

async function main() {
  const size = statSync(modelPath).size;
  console.log(`[asr] model: ${modelPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  startWhisper();
  await waitForPort(whisperPort).catch((err) => {
    console.error(`[asr] ${err.message}`);
    child?.kill('SIGTERM');
    process.exit(1);
  });
  ready = true;
  server.listen(port, '127.0.0.1', () => {
    console.log(`[asr] ready at http://127.0.0.1:${port} (upstream ${whisperUrl})`);
  });
}

function shutdown() {
  ready = false;
  server.close(() => process.exit(0));
  child?.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
