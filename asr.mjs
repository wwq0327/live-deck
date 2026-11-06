// 本地转写常驻进程的管理器：一次加载，之后每句只做推理。
// ASR_BACKEND=sensevoice（默认，sherpa-onnx + SenseVoice int8）| whisper（openai-whisper）
// 优先级：final（整句）先于 partial（边说边猜）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = process.env.ASR_BACKEND || 'sensevoice';
const MODEL = BACKEND === 'whisper' ? process.env.ASR_MODEL || 'small' : 'sensevoice-int8';
const VENV_PY = path.join(ROOT, '.venv', 'bin', 'python');

let child = null;
let ready = false;
let loading = false;
let lastError = '';
let fatalError = '';
let seq = 0;
let busy = false;

const pending = new Map(); // id -> {resolve, reject, timer}
const finals = [];
const partials = [];
const stats = { finals: 0, partials: 0, lastMs: 0, lastText: '' };

export function asrStatus() {
  return {
    ready,
    loading,
    backend: BACKEND,
    model: MODEL,
    error: lastError,
    queued: finals.length + partials.length,
    ...stats,
  };
}

function spawnWorker() {
  if (child || loading) return;
  loading = true;
  lastError = '';
  fatalError = '';
  const env = { ...process.env, ASR_MODEL: process.env.ASR_MODEL || 'small', ASR_BACKEND: BACKEND };
  const py = process.env.ASR_PYTHON || (BACKEND === 'whisper' ? 'python3' : (existsSync(VENV_PY) ? VENV_PY : 'python3'));
  const proc = spawn(py, [path.join(ROOT, 'asr_worker.py')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child = proc;

  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    if (child !== proc) return;
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.ready) {
        ready = true;
        loading = false;
        fatalError = '';
        console.log(`[asr] 后端就绪 ${msg.model}，加载 ${msg.load_ms}ms`);
        pump();
        continue;
      }
      if (msg.error && msg.id == null) {
        // worker 加载失败时只发一条没有 id 的 error，随后退出。
        // 这条消息必须留给 health / 下一次请求，不能丢。
        fatalError = msg.error;
        lastError = msg.error;
        loading = false;
        continue;
      }
      const job = msg.id != null ? pending.get(msg.id) : null;
      if (job) {
        clearTimeout(job.timer);
        pending.delete(msg.id);
        busy = false;
        if (msg.error) job.reject(new Error(msg.error));
        else job.resolve(msg);
        pump();
      } else {
        busy = false;
        pump();
      }
    }
  });

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => {
    if (child !== proc) return;
    const s = String(d).trim();
    if (s && !/Warning|warn\(/.test(s)) lastError = s.slice(-400);
  });

  const die = (why) => {
    if (child !== proc) return;
    child = null;
    ready = false;
    loading = false;
    busy = false;
    lastError = fatalError || why;
    for (const [, job] of pending) {
      clearTimeout(job.timer);
      job.reject(new Error(lastError));
    }
    pending.clear();
    for (const job of finals.splice(0)) job.reject(new Error(lastError));
    for (const job of partials.splice(0)) job.reject(new Error(lastError));
  };
  proc.on('exit', (code) => die(`worker exited (${code})`));
  proc.on('error', (e) => die(`spawn failed: ${e.message}`));
}

function pump() {
  if (!ready || busy) return;
  const job = finals.shift() || partials.shift();
  if (!job) return;
  if (!child || !child.stdin || !child.stdin.writable) {
    job.reject(new Error(lastError || 'asr worker not running'));
    pump();
    return;
  }
  busy = true;
  pending.set(job.id, job);
  job.timer = setTimeout(() => {
    pending.delete(job.id);
    busy = false;
    job.reject(new Error('transcribe timeout'));
    pump();
  }, 45_000);
  try {
    child.stdin.write(JSON.stringify({ id: job.id, wav: job.wav }) + '\n');
  } catch (err) {
    clearTimeout(job.timer);
    pending.delete(job.id);
    busy = false;
    job.reject(new Error('write to asr worker failed: ' + err.message));
    pump();
  }
}

export async function transcribe(wavBuffer, { priority = 'final' } = {}) {
  if (!wavBuffer?.length) return { text: '', ms: 0 };
  if (!ready) {
    spawnWorker();
    if (!ready) {
      // 模型加载中：给一点等待时间，别直接失败；worker 已经退出则立刻返回。
      const t0 = Date.now();
      while (!ready && loading && child && Date.now() - t0 < 20_000) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!ready) throw new Error(lastError || 'asr not ready');
    }
  }
  const id = ++seq;
  const file = path.join(os.tmpdir(), `deck-${process.pid}-${id}.wav`);
  await writeFile(file, wavBuffer);

  // final 一到，排队中的 partial 已经过期，直接丢掉；否则 worker 会先跑完它们。
  if (priority !== 'partial') {
    for (const job of partials.splice(0)) {
      clearTimeout(job.timer);
      job.reject(new Error('superseded by final'));
    }
  }

  const reply = await new Promise((resolve, reject) => {
    const job = { id, wav: file, resolve, reject, timer: null };
    (priority === 'partial' ? partials : finals).push(job);
    pump();
  }).finally(() => unlink(file).catch(() => {}));

  if (priority === 'partial') stats.partials++;
  else stats.finals++;
  stats.lastMs = reply.ms;
  stats.lastText = reply.text || '';
  return reply;
}

export function warmAsr() {
  spawnWorker();
}
