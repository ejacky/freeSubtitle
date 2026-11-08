import type { VadConfig } from '../lib/messaging/protocol';
import { VadSegmenter, type SpeechSegment } from './vad';
import { encodeWav } from './wav';

export interface CaptureCallbacks {
  onSegment: (wav: ArrayBuffer, segment: SpeechSegment, generation: number) => void;
  onLevel: (rms: number) => void;
  onEnded: () => void;
  onError: (code: string, message: string) => void;
}

/**
 * Captures tab audio, keeps it audible through a separate playback context,
 * and emits VAD-segmented 16 kHz WAV chunks.
 */
export class TabAudioCapture {
  private stream: MediaStream | null = null;
  private playbackCtx: AudioContext | null = null;
  private captureCtx: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private vad: VadSegmenter | null = null;
  private generation = 0;
  private seq = 0;
  private lastLevelAt = 0;
  private active = false;

  constructor(private readonly callbacks: CaptureCallbacks) {}

  get isActive(): boolean {
    return this.active;
  }

  async start(streamId: string, vadConfig: VadConfig): Promise<void> {
    this.stop();
    this.active = true;
    this.generation = 0;
    this.seq = 0;

    try {
      const constraints = {
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      } as unknown as MediaStreamConstraints;

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = this.stream.getAudioTracks()[0];
      if (!track) throw new Error('标签页没有音频轨道');
      track.addEventListener('ended', this.callbacks.onEnded, { once: true });

      // The tab is muted while captured; play the captured stream back so the
      // user continues to hear the original audio.
      this.playbackCtx = new AudioContext({ latencyHint: 'interactive' });
      const playbackSource = this.playbackCtx.createMediaStreamSource(this.stream);
      const playbackGain = this.playbackCtx.createGain();
      playbackGain.gain.value = 1;
      playbackSource.connect(playbackGain).connect(this.playbackCtx.destination);
      await this.playbackCtx.resume().catch(() => undefined);

      this.captureCtx = await this.createCaptureContext();
      const captureSource = this.captureCtx.createMediaStreamSource(this.stream);

      this.vad = new VadSegmenter(vadConfig, (segment) => {
        const wav = encodeWav(segment.samples);
        this.callbacks.onSegment(wav, segment, this.generation);
      });

      let connected = false;
      try {
        await this.captureCtx.audioWorklet.addModule(
          chrome.runtime.getURL('worklet/pcm-tap.js'),
        );
        const node = new AudioWorkletNode(this.captureCtx, 'pcm-tap', {
          processorOptions: { targetRate: 16000 },
        });
        node.port.onmessage = (event: MessageEvent<{ type: string; samples: ArrayBuffer }>) => {
          if (event.data?.type !== 'pcm') return;
          const samples = new Float32Array(event.data.samples);
          this.consume(samples);
        };
        captureSource.connect(node);
        this.worklet = node;
        connected = true;
      } catch {
        // Fallback for environments where AudioWorklet is unavailable.
      }

      if (!connected) {
        this.processor = this.captureCtx.createScriptProcessor(4096, 1, 1);
        this.processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          const samples =
            this.captureCtx && this.captureCtx.sampleRate !== 16000
              ? resampleLinear(input, this.captureCtx.sampleRate, 16000)
              : new Float32Array(input);
          this.consume(samples);
        };
        captureSource.connect(this.processor);
      }

      // A muted sink is required so the graph is pulled, without echoing.
      const silent = this.captureCtx.createGain();
      silent.gain.value = 0;
      const sink = (this.worklet ?? this.processor)!;
      sink.connect(silent).connect(this.captureCtx.destination);

      await this.captureCtx.resume().catch(() => undefined);
    } catch (err) {
      this.stop();
      const message = String(err instanceof Error ? err.message : err);
      const code = /NotAllowed|Permission/i.test(message)
        ? 'capture.permission'
        : /NotFound|Requested device/i.test(message)
          ? 'capture.no_audio'
          : 'capture.failed';
      this.callbacks.onError(code, message);
      throw err;
    }
  }

  stop(): void {
    this.active = false;
    try {
      this.vad?.flush();
    } catch {
      // ignore
    }
    this.vad = null;
    this.worklet?.disconnect();
    this.worklet = null;
    this.processor?.disconnect();
    this.processor = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.playbackCtx?.close().catch(() => undefined);
    void this.captureCtx?.close().catch(() => undefined);
    this.playbackCtx = null;
    this.captureCtx = null;
  }

  setGeneration(generation: number): void {
    this.generation = generation;
    this.vad?.reset();
  }

  private async createCaptureContext(): Promise<AudioContext> {
    try {
      return new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    } catch {
      return new AudioContext({ latencyHint: 'interactive' });
    }
  }

  private consume(samples: Float32Array): void {
    if (!this.active || !this.vad) return;
    this.vad.push(samples);
    const now = performance.now();
    if (now - this.lastLevelAt > 400) {
      this.lastLevelAt = now;
      this.callbacks.onLevel(rms(samples));
    }
  }
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return new Float32Array(input);
  const ratio = from / to;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const index = Math.floor(pos);
    const frac = pos - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    out[i] = a * (1 - frac) + b * frac;
  }
  return out;
}
