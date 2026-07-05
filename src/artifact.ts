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

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`artifact download failed: ${res.status} for ${url}`);
  }
  const contentType =
    res.headers.get("content-type") ?? knownContentType ?? null;
  const path = join(dir, `step-${stepId}${guessExt(url, contentType)}`);
  mkdirSync(dir, { recursive: true });
  await Bun.write(path, res);
  return { contentType, path };
}
