import type { VadConfig } from '../lib/messaging/protocol';

export interface SpeechSegment {
  samples: Float32Array;
  t0: number;
  t1: number;
  rms: number;
}

const SAMPLE_RATE = 16000;

/**
 * Energy-based VAD with hysteresis, pre-roll and a hard max segment length.
 * It is intentionally simple and cheap; Whisper is robust to a little extra
 * silence, while an overly aggressive VAD loses words.
 */
export class VadSegmenter {
  private config: VadConfig;
  private frameSize: number;
  private leftover = new Float32Array(0);
  private preRoll: Float32Array[] = [];
  private segmentFrames: Float32Array[] = [];
  private active = false;
  private silenceFrames = 0;
  private speechFrames = 0;
  private totalSamples = 0;
  private segmentStartSample = 0;
  private noiseFloor = 0.0025;

  constructor(
    config: VadConfig,
    private readonly onSegment: (segment: SpeechSegment) => void,
  ) {
    this.config = config;
    this.frameSize = Math.max(160, Math.round((SAMPLE_RATE * config.frameMs) / 1000));
  }

  push(chunk: Float32Array): void {
    const merged = new Float32Array(this.leftover.length + chunk.length);
    merged.set(this.leftover);
    merged.set(chunk, this.leftover.length);

    let offset = 0;
    while (offset + this.frameSize <= merged.length) {
      this.processFrame(merged.subarray(offset, offset + this.frameSize));
      offset += this.frameSize;
    }
    this.leftover = merged.slice(offset);
  }

  flush(): void {
    if (this.active && this.segmentFrames.length > 0) this.emit(false);
  }

  reset(): void {
    this.active = false;
    this.segmentFrames = [];
    this.preRoll = [];
    this.silenceFrames = 0;
    this.speechFrames = 0;
    this.leftover = new Float32Array(0);
    this.totalSamples = 0;
  }

  private processFrame(frame: Float32Array): void {
    this.totalSamples += frame.length;
    const rms = rootMeanSquare(frame);
    const threshold = Math.max(0.006, this.noiseFloor * 3);
    const voiced = rms > threshold;

    if (!voiced) {
      this.noiseFloor = Math.max(0.0008, this.noiseFloor * 0.98 + rms * 0.02);
    }

    if (!this.active) {
      this.preRoll.push(frame.slice());
      const maxPreRoll = Math.max(1, Math.round(this.config.preRollMs / this.config.frameMs));
      if (this.preRoll.length > maxPreRoll) this.preRoll.shift();

      if (voiced) {
        this.speechFrames++;
        if (this.speechFrames >= this.config.startFrames) {
          this.active = true;
          this.silenceFrames = 0;
          this.segmentFrames = this.preRoll.slice();
          const preSamples = this.segmentFrames.length * frame.length;
          this.segmentStartSample = Math.max(0, this.totalSamples - preSamples);
          this.preRoll = [];
        }
      } else {
        this.speechFrames = 0;
      }
      return;
    }

    this.segmentFrames.push(frame.slice());
    if (voiced) {
      this.silenceFrames = 0;
    } else {
      this.silenceFrames++;
    }

    const segmentSamples = this.segmentFrames.length * frame.length;
    const maxSamples = (this.config.maxSegmentMs / 1000) * SAMPLE_RATE;

    if (this.silenceFrames * this.config.frameMs >= this.config.silenceMs) {
      this.emit(true);
      return;
    }
    if (segmentSamples >= maxSamples) {
      this.emit(false);
      // Keep a small overlap for the next segment so the first word after a
      // forced cut is not lost.
      const overlapFrames = Math.min(
        this.segmentFrames.length,
        Math.round(300 / this.config.frameMs),
      );
      const overlap = this.segmentFrames.slice(-overlapFrames);
      this.segmentFrames = overlap;
      this.segmentStartSample = Math.max(0, this.totalSamples - overlap.length * frame.length);
      this.active = overlap.length > 0;
      this.silenceFrames = 0;
      this.speechFrames = this.config.startFrames;
    }
  }

  private emit(fromSilence: boolean): void {
    const frames = this.segmentFrames.slice();
    const sampleCount = frames.reduce((sum, frame) => sum + frame.length, 0);
    const durationMs = (sampleCount / SAMPLE_RATE) * 1000;
    const t1 = this.totalSamples / SAMPLE_RATE;

    if (durationMs >= this.config.minSpeechMs && frames.length > 0) {
      const samples = new Float32Array(sampleCount);
      let offset = 0;
      for (const frame of frames) {
        samples.set(frame, offset);
        offset += frame.length;
      }
      const t0 = this.segmentStartSample / SAMPLE_RATE;
      this.onSegment({
        samples,
        t0,
        t1,
        rms: rootMeanSquare(samples),
      });
    }

    this.active = false;
    this.segmentFrames = [];
    this.silenceFrames = 0;
    this.speechFrames = 0;
    this.preRoll = [];
    if (!fromSilence) this.preRoll = [];
  }
}

function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}
