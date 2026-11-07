import fs from 'node:fs';
import os from 'node:os';
import { asrStatus, transcribe, warmAsr } from '../../asr.mjs';

const t0 = Date.now();
warmAsr();
while (!asrStatus().ready && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 40));
const out = { ready: asrStatus().ready, dual: asrStatus().dual, first: null, second: null };
for (const key of ['first', 'second']) {
  try {
    const r = await transcribe(Buffer.from('RIFFfake'), { priority: 'final' });
    out[key] = r;
  } catch (e) {
    out[key] = { error: e.message };
  }
}
await new Promise((r) => setTimeout(r, 150));
out.leftover = fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith(`deck-${process.pid}-`) && x.endsWith('.wav')).length;
console.log(JSON.stringify(out));
process.exit(0);
