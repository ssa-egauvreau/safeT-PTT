// Client-side cache for custom soundboard tone-outs: the agency's tone-out
// list, decoded 16 kHz PCM ready to key onto a channel, and resolved icon
// image URLs. Decoding and icon fetches are memoized per tone-out id.

import { useEffect, useState } from "react";
import { api, fetchToneOutAudio, fetchToneOutIcon, type ToneOut } from "./api";
import { ToneOutIcon } from "./icons";

const TARGET_RATE = 16000;
/** Hard cap on a clip's length so one tone-out can't flood the channel. */
const MAX_CLIP_SAMPLES = TARGET_RATE * 30;

let cached: ToneOut[] | null = null;
let inflight: Promise<ToneOut[]> | null = null;
const pcmCache = new Map<number, Promise<Int16Array>>();
const iconUrlCache = new Map<number, Promise<string>>();

async function load(): Promise<ToneOut[]> {
  const res = await api.toneOuts();
  cached = res.toneOuts;
  return cached;
}

/** Drops every cached tone-out, decoded clip, and icon URL (after an admin edit). */
export function clearToneOutCache(): void {
  cached = null;
  inflight = null;
  pcmCache.clear();
  for (const url of iconUrlCache.values()) {
    void url.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
  }
  iconUrlCache.clear();
}

/** The agency's soundboard tone-outs — served from cache, refreshed on mount. */
export function useToneOuts(): ToneOut[] {
  const [list, setList] = useState<ToneOut[]>(cached ?? []);
  useEffect(() => {
    let active = true;
    inflight ??= load().finally(() => {
      inflight = null;
    });
    inflight
      .then((loaded) => {
        if (active) {
          setList(loaded);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return list;
}

/** Decodes a tone-out's audio to 16 kHz mono PCM-16, ready to key onto a channel. */
async function decodeToneOut(id: number): Promise<Int16Array> {
  const bytes = await (await fetchToneOutAudio(id)).arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(bytes);
  } finally {
    void decodeCtx.close();
  }
  // Resample to 16 kHz mono through an offline render.
  const frames = Math.max(
    1,
    Math.min(MAX_CLIP_SAMPLES, Math.ceil(decoded.duration * TARGET_RATE)),
  );
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const channel = rendered.getChannelData(0);
  const pcm = new Int16Array(channel.length);
  for (let i = 0; i < channel.length; i++) {
    const s = Math.max(-1, Math.min(1, channel[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

/** Memoized decoded PCM for a tone-out clip. */
export function loadTonePcm(id: number): Promise<Int16Array> {
  let pcm = pcmCache.get(id);
  if (!pcm) {
    pcm = decodeToneOut(id).catch((err) => {
      pcmCache.delete(id);
      throw err;
    });
    pcmCache.set(id, pcm);
  }
  return pcm;
}

/** Memoized object URL for a tone-out's custom icon image. */
function toneOutIconUrl(id: number): Promise<string> {
  let url = iconUrlCache.get(id);
  if (!url) {
    url = fetchToneOutIcon(id)
      .then((blob) => URL.createObjectURL(blob))
      .catch((err) => {
        iconUrlCache.delete(id);
        throw err;
      });
    iconUrlCache.set(id, url);
  }
  return url;
}

/** Renders a tone-out's icon — its custom image when set, else the built-in glyph. */
export function ToneOutBadge({ toneOut, size = 18 }: { toneOut: ToneOut; size?: number }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!toneOut.has_image) {
      setImgUrl(null);
      return;
    }
    let active = true;
    toneOutIconUrl(toneOut.id)
      .then((url) => {
        if (active) {
          setImgUrl(url);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [toneOut.id, toneOut.has_image]);

  if (toneOut.has_image) {
    return (
      <span
        className="tone-out-img"
        style={{
          width: size,
          height: size,
          backgroundImage: imgUrl ? `url(${imgUrl})` : undefined,
        }}
      />
    );
  }
  return <ToneOutIcon kind={toneOut.icon_kind} size={size} style={{ color: toneOut.icon_color }} />;
}
