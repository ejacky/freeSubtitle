/*
 * Captures the tab audio, mixes to mono, resamples to 16 kHz (if needed),
 * and posts 100 ms Float32 frames to the offscreen document.
 *
 * AudioWorklet global scope: `sampleRate` and `registerProcessor` are provided
 * by Chrome. Keep this file dependency-free because it is loaded at runtime.
 */
class PcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.pending = new Float32Array(0);
    this.readPos = 0;
    this.out = [];
    this.frameSize = Math.max(160, Math.round(this.targetRate / 10));
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const left = input[0];
    const right = input[1] || input[0];
    const n = left.length;

    // Mix to mono and append to the resampling buffer.
    const mixed = new Float32Array(n);
    for (let i = 0; i < n; i++) mixed[i] = (left[i] + right[i]) * 0.5;

    const merged = new Float32Array(this.pending.length + n);
    merged.set(this.pending);
    merged.set(mixed, this.pending.length);
    this.pending = merged;

    // Linear resampling. Good enough for speech ASR and cheap on CPU.
    while (this.readPos + 1 < this.pending.length) {
      const i = Math.floor(this.readPos);
      const frac = this.readPos - i;
      const s = this.pending[i] * (1 - frac) + this.pending[i + 1] * frac;
      this.out.push(s);
      this.readPos += this.ratio;
    }

    const consumed = Math.floor(this.readPos);
    if (consumed > 0) {
      this.pending = this.pending.slice(consumed);
      this.readPos -= consumed;
    }

    while (this.out.length >= this.frameSize) {
      const frame = new Float32Array(this.frameSize);
      for (let i = 0; i < this.frameSize; i++) frame[i] = this.out[i];
      this.out = this.out.slice(this.frameSize);
      this.port.postMessage({ type: 'pcm', samples: frame.buffer }, [frame.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-tap', PcmTapProcessor);
