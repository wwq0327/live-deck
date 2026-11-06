// 把麦克风的 16k 单声道 PCM 攒成 2048 帧一块，postMessage 给主线程
class PCMTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(this.buf.length - this.n, ch.length - i);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf);
        this.buf = new Float32Array(2048);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PCMTap);
