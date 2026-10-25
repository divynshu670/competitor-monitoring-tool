import { assertSafeUrl } from './guard';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface FetchResult {
  url: string;
  html: string;
  status: number;
}

function decodeLimitedBytes(chunks: Uint8Array[], byteLimit: number): string {
  const combined = new Uint8Array(byteLimit);
  let offset = 0;

  for (const chunk of chunks) {
    const remaining = byteLimit - offset;
    if (remaining <= 0) break;
    const slice = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
    combined.set(slice, offset);
    offset += slice.byteLength;
  }

  return new TextDecoder().decode(combined.subarray(0, offset));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function fetchPage(url: string): Promise<FetchResult> {
  let currentUrl = url;
  let redirects = 0;
  const visited = new Set<string>();

  while (true) {
    await assertSafeUrl(currentUrl);

    const normalizedUrl = new URL(currentUrl).href;
    if (visited.has(normalizedUrl)) {
      throw new Error('Redirect loop detected');
    }
    visited.add(normalizedUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;

    try {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'CompetitorMonitor/1.0',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
    } catch (error: unknown) {
      clearTimeout(timer);
      if (controller.signal.aborted || isAbortError(error)) {
        throw new Error('Request timed out');
      }
      throw new Error('Network error while fetching page');
    }

    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timer);
      controller.abort();
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect with no Location header');
      if (redirects >= MAX_REDIRECTS) throw new Error('Too many redirects');
      currentUrl = new URL(location, currentUrl).href;
      redirects++;
      continue;
    }

    if (response.status === 429 || response.status === 403) {
      clearTimeout(timer);
      controller.abort();
      throw new Error(`Request blocked (HTTP ${response.status})`);
    }

    if (!response.ok) {
      clearTimeout(timer);
      controller.abort();
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html') && !contentType.includes('xml') && !contentType.includes('text')) {
      clearTimeout(timer);
      controller.abort();
      return { url: response.url || currentUrl, html: '', status: response.status };
    }

    try {
      const reader = response.body?.getReader();
      if (!reader) {
        const text = await response.text();
        const encoded = new TextEncoder().encode(text);
        return {
          url: response.url || currentUrl,
          html: decodeLimitedBytes([encoded], MAX_RESPONSE_BYTES),
          status: response.status,
        };
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (totalBytes + value.byteLength > MAX_RESPONSE_BYTES) {
          const remainingBytes = MAX_RESPONSE_BYTES - totalBytes;
          if (remainingBytes > 0) chunks.push(value.subarray(0, remainingBytes));
          controller.abort();
          void reader.cancel().catch(() => undefined);
          return {
            url: response.url || currentUrl,
            html: decodeLimitedBytes(chunks, MAX_RESPONSE_BYTES),
            status: response.status,
          };
        }
        totalBytes += value.byteLength;
        chunks.push(value);
      }

      return {
        url: response.url || currentUrl,
        html: decodeLimitedBytes(chunks, totalBytes),
        status: response.status,
      };
    } catch (error: unknown) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new Error('Request timed out');
      }
      throw new Error('Network error while fetching page');
    } finally {
      clearTimeout(timer);
    }
  }
}
