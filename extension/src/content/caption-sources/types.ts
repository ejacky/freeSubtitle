import type { CaptionInfo, Cue } from '../../types';

export interface CaptionSink {
  cues(cues: Cue[], source: CaptionInfo['source']): void;
  info(info: CaptionInfo): void;
  notice(message: string): void;
}

export interface CaptionSource {
  start(): Promise<void>;
  stop(): void;
}

export function isYouTubeHost(): boolean {
  return /(^|\.)youtube\.com$/i.test(location.hostname);
}
