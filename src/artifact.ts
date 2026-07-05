import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";

const EXT_BY_TYPE: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
};

function guessExt(url: string, contentType: string | null): string {
  if (url.startsWith("http")) {
    const fromPath = extname(new URL(url).pathname);
    if (fromPath) {
      return fromPath;
    }
  }
  if (contentType) {
    for (const [type, ext] of Object.entries(EXT_BY_TYPE)) {
      if (contentType.includes(type)) {
        return ext;
      }
    }
  }
  return "";
}

export type SavedArtifact = {
  path: string | null;
  contentType: string | null;
};

const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,(.*)$/s;

/**
 * Persist a provider output locally. http(s) urls are downloaded; data: urls
 * are decoded; anything else (provider-internal schemes) is left as url-only.
 */
export async function saveArtifact(
  url: string,
  dir: string,
  stepId: number,
  knownContentType?: string
): Promise<SavedArtifact> {
  if (url.startsWith("data:")) {
    const match = url.match(DATA_URL_RE);
    if (!match) {
      return { contentType: knownContentType ?? null, path: null };
    }
    const contentType = match[1] ?? knownContentType ?? null;
    const raw = match[3] ?? "";
    const bytes = match[2]
      ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(raw));
    const path = join(dir, `step-${stepId}${guessExt(url, contentType)}`);
    mkdirSync(dir, { recursive: true });
    await Bun.write(path, bytes);
    return { contentType, path };
  }

  if (!(url.startsWith("http://") || url.startsWith("https://"))) {
    return { contentType: knownContentType ?? null, path: null };
  }

  // CDN downloads stall in the wild (observed: fal media, socket hangs with
  // no bytes). The step is already settled by the time we're here, so a
  // failed download costs nothing — timeout each attempt, retry, and buffer
  // the body instead of streaming so a mid-body stall can't wedge the write.
  const downloaded = await downloadWithRetry(url);
  const contentType = downloaded.contentType ?? knownContentType ?? null;
  const path = join(dir, `step-${stepId}${guessExt(url, contentType)}`);
  mkdirSync(dir, { recursive: true });
  await Bun.write(path, downloaded.body);
  return { contentType, path };
}

const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 60_000;

async function downloadWithRetry(
  url: string
): Promise<{ body: ArrayBuffer; contentType: string | null }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) {
        // an HTTP error status won't improve on retry
        throw new Error(`artifact download failed: ${res.status} for ${url}`);
      }
      // body read inside the attempt: a mid-body stall aborts + retries too
      return {
        body: await res.arrayBuffer(),
        contentType: res.headers.get("content-type"),
      };
    } catch (err) {
      lastErr = err;
      if (String(err).includes("artifact download failed")) {
        throw err;
      }
    }
  }
  throw new Error(
    `artifact download failed after ${DOWNLOAD_ATTEMPTS} attempts for ${url}: ${String(lastErr)}`
  );
}
