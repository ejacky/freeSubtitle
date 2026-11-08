import type { CaptionInfo } from '../../types';
import type { Settings } from '../../lib/settings/schema';
import { TrackCaptionSource } from './html5-track';
import { isYouTubeHost, type CaptionSink, type CaptionSource } from './types';
import { YouTubeCaptionSource } from './youtube';

/** Chooses YouTube / TextTrack and forwards cues to the content shell. */
export class CaptionController {
  private source: CaptionSource | null = null;
  private info: CaptionInfo = { source: 'none', ready: false };

  constructor(
    private readonly sink: CaptionSink,
    private readonly settings: Settings,
  ) {}

  get captionInfo(): CaptionInfo {
    return this.info;
  }

  async start(video: HTMLVideoElement): Promise<void> {
    await this.stop();
    const source = isYouTubeHost()
      ? new YouTubeCaptionSource(video, this.settings, {
          cues: (cues, kind) => this.sink.cues(cues, kind),
          info: (info) => this.setInfo(info),
          notice: (message) => this.sink.notice(message),
        })
      : new TrackCaptionSource(video, this.settings, {
          cues: (cues, kind) => this.sink.cues(cues, kind),
          info: (info) => this.setInfo(info),
          notice: (message) => this.sink.notice(message),
        });

    this.source = source;
    try {
      await source.start();
    } catch {
      this.setInfo({ source: 'none', ready: true });
    }
  }

  async stop(): Promise<void> {
    this.source?.stop();
    this.source = null;
    this.info = { source: 'none', ready: false };
  }

  private setInfo(info: CaptionInfo): void {
    this.info = info;
    this.sink.info(info);
  }
}
