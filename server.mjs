// Live Deck — 本地服务：静态舞台 + 导演接口
// 启动：node server.mjs    打开：http://127.0.0.1:4400
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callDirector, loadKey } from './director.mjs';
import { transcribe, asrStatus, warmAsr } from './asr.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4400);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const LOCAL_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function assertLocalRequest(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host && !LOCAL_HOSTS.has(host)) throw new HttpError(403, 'host not allowed');
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = String(req.headers.origin || '').toLowerCase();
  if (origin && !LOCAL_ORIGINS.has(origin)) throw new HttpError(403, 'origin not allowed');
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
    throw new HttpError(403, 'cross-site request blocked');
  }
}

function requireType(req, re) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!re.test(type)) throw new HttpError(415, 'unsupported content-type');
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(res.req && res.req.method === 'HEAD' ? undefined : body);
}

function readBinary(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, 'body too large'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

function readBody(req, limit = 256 * 1024) {
  return readBinary(req, limit).then((buf) => buf.toString('utf8'));
}

const server = createServer(async (req, res) => {
  try {
    assertLocalRequest(req);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/health') {
      return send(
        res,
        200,
        JSON.stringify({
          ok: true,
          hasKey: Boolean(loadKey()),
          model: process.env.DIRECTOR_MODEL || 'deepseek-flash',
          asr: asrStatus(),
        })
      );
    }

    if (url.pathname === '/api/asr' && req.method === 'POST') {
      requireType(req, /^audio\/|^application\/octet-stream/);
      const wav = await readBinary(req);
      const mode = url.searchParams.get('mode') === 'partial' ? 'partial' : 'final';
      const out = await transcribe(wav, { priority: mode });
      console.log(`[asr] ${mode.padEnd(7)} ${String(out.ms).padStart(5)}ms ${String(out.duration).padStart(5)}s ${out.text}`);
      return send(res, 200, JSON.stringify({ ...out, mode }));
    }

    if ((url.pathname === '/api/direct' || url.pathname === '/api/direct/stream') && req.method === 'POST') {
      requireType(req, /^application\/json/);
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, 'invalid JSON');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'JSON body must be an object');
      }
      const args = {
        transcript: typeof body.transcript === 'string' ? body.transcript : '',
        current: body.current && typeof body.current === 'object' ? body.current : null,
        mode: body.mode === 'predict' ? 'predict' : 'decide',
      };
      if (url.pathname.endsWith('/stream')) {
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.flushHeaders();
        let closed = false;
        res.on('close', () => { if (!res.writableEnded) closed = true; });
        try {
          const out = await callDirector({
            ...args,
            onTitle: (ev) => {
              if (!closed) res.write(JSON.stringify({ type: 'partial', title: ev.title }) + '\n');
            },
          });
          console.log(
            `[direct] ${(body.purpose || out.source).padEnd(8)} ${String(out.ms).padStart(4)}ms ${out.action.padEnd(9)} ${out.layout.padEnd(8)} ${out.title || ''}`
          );
          if (!closed) {
            res.write(JSON.stringify({ type: 'done', result: out }) + '\n');
            res.end();
          }
        } catch (err) {
          if (!closed) {
            res.write(JSON.stringify({ type: 'error', error: String(err.message || err) }) + '\n');
            res.end();
          }
        }
        return;
      }
      const out = await callDirector(args);
      console.log(
        `[direct] ${(body.purpose || out.source).padEnd(8)} ${String(out.ms).padStart(4)}ms ${out.action.padEnd(9)} ${out.layout.padEnd(8)} ${out.title || ''}`
      );
      return send(res, 200, JSON.stringify(out));
    }

    if (req.method === 'OPTIONS') return send(res, 405, '{"error":"method"}');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '{"error":"method"}');

    let rel;
    try {
      rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      throw new HttpError(400, 'bad path');
    }
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, '{"error":"forbidden"}');
    const data = await readFile(file);
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  } catch (err) {
    const code = err.status || (err.code === 'ENOENT' ? 404 : 500);
    if (code >= 500) console.error(`[http] ${req.method} ${req.url}:`, err.message);
    send(res, code, JSON.stringify({ error: String(err.message || err) }));
  }
});

server.listen(PORT, HOST, () => {
  const hasKey = Boolean(loadKey());
  console.log(`\n  Live Deck\n  → http://${HOST}:${PORT}\n  导演模型：${hasKey ? process.env.DIRECTOR_MODEL || 'deepseek-flash' : '未找到 Key，走本地规则兜底'}\n  语音模型：${asrStatus().model}（本地，加载中…）\n  打开后点麦克风，或把 wav 拖进页面\n`);
  warmAsr();
});
