// 本地转写常驻进程的管理器：一次加载，之后每句只做推理。
// ASR_BACKEND=sensevoice（默认，sherpa-onnx + SenseVoice int8）| whisper（openai-whisper）
// 优先级：final（整句）先于 partial（边说边猜）。
// ASR_FINAL_WORKER=1 时再起一个只接 final 的 worker：partial 还在推理时，final 不用排队。
// 代价是多加载一份模型（内存翻倍），所以默认关闭。
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
const DUAL = process.env.ASR_FINAL_WORKER === '1';

let seq = 0;

const stats = { finals: 0, partials: 0, lastMs: 0, lastText: '' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AsrWorker {
  constructor(role) {
    this.role = role;
    this.child = null;
    this.ready = false;
    this.loading = false;
    this.lastError = '';
    this.fatalError = '';
    this.busy = false;
    this.pending = new Map();
    this.finals = [];
    this.partials = [];
  }

  get queued() {
    return this.finals.length + this.partials.length;
  }

  spawn() {
    if (this.child || this.loading) return;
    this.loading = true;
    this.lastError = '';
    this.fatalError = '';
    const env = {
      ...process.env,
      ASR_MODEL: process.env.ASR_MODEL || 'small',
      ASR_BACKEND: BACKEND,
      ASR_ROLE: this.role,
    };
    const py = process.env.ASR_PYTHON || (BACKEND === 'whisper' ? 'python3' : (existsSync(VENV_PY) ? VENV_PY : 'python3'));
    const proc = spawn(py, [path.join(ROOT, 'asr_worker.py')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = proc;

    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      if (this.child !== proc) return;
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
        this.handle(msg);
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      if (this.child !== proc) return;
      const s = String(d).trim();
      if (s && !/Warning|warn\(/.test(s)) this.lastError = s.slice(-400);
    });

    const die = (why) => {
      if (this.child !== proc) return;
      this.child = null;
      this.ready = false;
      this.loading = false;
      this.busy = false;
      this.lastError = this.fatalError || why;
      for (const [, job] of this.pending) {
        clearTimeout(job.timer);
        job.reject(new Error(this.lastError));
      }
      this.pending.clear();
      for (const job of this.finals.splice(0)) job.reject(new Error(this.lastError));
      for (const job of this.partials.splice(0)) job.reject(new Error(this.lastError));
    };
    proc.on('exit', (code) => die(`worker exited (${code})`));
    proc.on('error', (e) => die(`spawn failed: ${e.message}`));
  }

  handle(msg) {
    if (msg.ready) {
      this.ready = true;
      this.loading = false;
      this.fatalError = '';
      console.log(`[asr:${this.role}] 后端就绪 ${msg.model}，加载 ${msg.load_ms}ms`);
      this.pump();
      return;
    }
    if (msg.error && msg.id == null) {
      // worker 加载失败时只发一条没有 id 的 error，随后退出。
      // 这条消息必须留给 health / 下一次请求，不能丢。
      this.fatalError = msg.error;
      this.lastError = msg.error;
      this.loading = false;
      return;
    }
    const job = msg.id != null ? this.pending.get(msg.id) : null;
    if (job) {
      clearTimeout(job.timer);
      this.pending.delete(msg.id);
      this.busy = false;
      if (msg.error) job.reject(new Error(msg.error));
      else job.resolve(msg);
      this.pump();
    } else {
      this.busy = false;
      this.pump();
    }
  }

  pump() {
    if (!this.ready || this.busy) return;
    const job = this.finals.shift() || this.partials.shift();
    if (!job) return;
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      job.reject(new Error(this.lastError || 'asr worker not running'));
      this.pump();
      return;
    }
    this.busy = true;
    this.pending.set(job.id, job);
    job.timer = setTimeout(() => {
      this.pending.delete(job.id);
      this.busy = false;
      job.reject(new Error('transcribe timeout'));
      this.pump();
    }, 45_000);
    try {
      this.child.stdin.write(JSON.stringify({ id: job.id, wav: job.wav }) + '\n');
    } catch (err) {
      clearTimeout(job.timer);
      this.pending.delete(job.id);
      this.busy = false;
      job.reject(new Error('write to asr worker failed: ' + err.message));
      this.pump();
    }
  }

  dropPartials() {
    for (const job of this.partials.splice(0)) {
      clearTimeout(job.timer);
      job.reject(new Error('superseded by final'));
    }
  }

  run(file, priority) {
    return new Promise((resolve, reject) => {
      if (!this.ready) {
        reject(new Error(this.lastError || 'asr worker not ready'));
        return;
      }
      const job = { id: ++seq, wav: file, resolve, reject, timer: null };
      (priority === 'partial' ? this.partials : this.finals).push(job);
      this.pump();
    });
  }
}

const main = new AsrWorker('main');
const fast = DUAL ? new AsrWorker('fast') : null;

async function waitReady(w, timeout = 20_000) {
  w.spawn();
  const t0 = Date.now();
  while (!w.ready && w.loading && w.child && Date.now() - t0 < timeout) await sleep(200);
  if (!w.ready) throw new Error(w.lastError || 'asr not ready');
}

async function chooseWorker(priority) {
  if (priority === 'partial') {
    await waitReady(main);
    return main;
  }
  if (fast?.ready) return fast;
  if (main.ready) return main;
  // 两个都还在加载：先等，谁先好就用谁；都不要等到天荒地老。
  const t0 = Date.now();
  while (!fast?.ready && !main.ready && Date.now() - t0 < 20_000) {
    if (!main.loading && !main.child && !fast?.loading) break;
    await sleep(200);
  }
  if (fast?.ready) return fast;
  if (main.ready) return main;
  throw new Error(main.lastError || fast?.lastError || 'asr not ready');
}

export function asrStatus() {
  return {
    ready: main.ready,
    loading: main.loading,
    backend: BACKEND,
    model: MODEL,
    error: main.lastError,
    queued: main.queued + (fast?.queued || 0),
    dual: Boolean(fast),
    fastReady: Boolean(fast?.ready),
    fastError: fast?.lastError || '',
    ...stats,
  };
}

export async function transcribe(wavBuffer, { priority = 'final' } = {}) {
  if (!wavBuffer?.length) return { text: '', ms: 0 };
  const worker = await chooseWorker(priority);
  // final 一到，所有排队中的 partial 都过期了，直接丢掉。
  // 正在跑的 partial 不在这里取消（final 走 fast 时也不需要取消它）。
  if (priority !== 'partial') main.dropPartials();

  const id = ++seq;
  const file = path.join(os.tmpdir(), `deck-${process.pid}-${id}.wav`);
  await writeFile(file, wavBuffer);

  let reply;
  try {
    reply = await worker.run(file, priority);
  } catch (err) {
    // fast worker 挂了就退回 main；main 还忙的话 final 仍会排在 partial 后面，但至少不丢请求。
    if (worker === fast && priority !== 'partial' && main.ready) {
      main.dropPartials();
      reply = await main.run(file, priority);
    } else {
      throw err;
    }
  } finally {
    unlink(file).catch(() => {});
  }

  if (priority === 'partial') stats.partials++;
  else stats.finals++;
  stats.lastMs = reply.ms;
  stats.lastText = reply.text || '';
  return reply;
}

export function warmAsr() {
  main.spawn();
  fast?.spawn();
}
