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
  '.woff2': 'font/woff2',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function readBinary(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
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
      const wav = await readBinary(req);
      const mode = url.searchParams.get('mode') === 'partial' ? 'partial' : 'final';
      const out = await transcribe(wav, { priority: mode });
      console.log(`[asr] ${mode.padEnd(7)} ${String(out.ms).padStart(5)}ms ${String(out.duration).padStart(5)}s ${out.text}`);
      return send(res, 200, JSON.stringify({ ...out, mode }));
    }

    if (url.pathname === '/api/direct' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const out = await callDirector({
        transcript: body.transcript || '',
        current: body.current || null,
        mode: body.mode === 'predict' ? 'predict' : 'decide',
      });
      console.log(
        `[direct] ${(body.purpose || out.source).padEnd(8)} ${String(out.ms).padStart(4)}ms ${out.action.padEnd(9)} ${out.layout.padEnd(8)} ${out.title || ''}`
      );
      return send(res, 200, JSON.stringify(out));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '{"error":"method"}');

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, '{"error":"forbidden"}');
    const data = await readFile(file);
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    const code = err.code === 'ENOENT' ? 404 : 500;
    send(res, code, JSON.stringify({ error: String(err.message || err) }));
  }
});

server.listen(PORT, HOST, () => {
  const hasKey = Boolean(loadKey());
  console.log(`\n  Live Deck\n  → http://${HOST}:${PORT}\n  导演模型：${hasKey ? process.env.DIRECTOR_MODEL || 'deepseek-flash' : '未找到 Key，走本地规则兜底'}\n  语音模型：${asrStatus().model}（本地，加载中…）\n  打开后点麦克风，或把 wav 拖进页面\n`);
  warmAsr();
});
