import type { YtCaptionTrack } from '../lib/messaging/protocol';
import { log } from '../lib/log';

/** Inject the content script into all frames, falling back to the top frame. */
export async function injectContent(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
    return;
  } catch (err) {
    log('warn', 'inject.all_frames_failed', { tabId, error: String(err) });
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (err) {
    log('error', 'inject.top_frame_failed', { tabId, error: String(err) });
    throw err;
  }
}

/**
 * Read YouTube's player response in the MAIN world. Content scripts are
 * isolated and cannot see page globals, so this must run via scripting.
 */
export async function readYouTubeTracks(tabId: number): Promise<YtCaptionTrack[]> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: ytReader,
    });
    const value = results[0]?.result;
    return Array.isArray(value) ? (value as YtCaptionTrack[]) : [];
  } catch (err) {
    log('warn', 'youtube.reader_failed', { tabId, error: String(err) });
    return [];
  }
}

/**
 * Self-contained function serialized into the page. Do not reference imports
 * or outer variables here.
 */
function ytReader(): Array<{
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: string;
}> {
  try {
    const w = window as unknown as {
      ytInitialPlayerResponse?: unknown;
    };
    let response: unknown = w.ytInitialPlayerResponse;
    const player = document.getElementById('movie_player') as
      | { getPlayerResponse?: () => unknown }
      | null;
    if (player?.getPlayerResponse) {
      try {
        response = player.getPlayerResponse() ?? response;
      } catch {
        // ignore
      }
    }
    const tracks =
      (
        response as
          | {
              captions?: {
                playerCaptionsTracklistRenderer?: {
                  captionTracks?: Array<Record<string, unknown>>;
                };
              };
            }
          | undefined
      )?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

    return tracks
      .map((track) => {
        const name = track.name as
          | { simpleText?: string; runs?: Array<{ text?: string }> }
          | undefined;
        return {
          baseUrl: String(track.baseUrl ?? ''),
          languageCode: String(track.languageCode ?? ''),
          kind: typeof track.kind === 'string' ? track.kind : undefined,
          name: name?.simpleText ?? name?.runs?.[0]?.text ?? '',
        };
      })
      .filter((track) => Boolean(track.baseUrl));
  } catch {
    return [];
  }
}
