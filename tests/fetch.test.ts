import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as guardModule from '../src/scraper/guard';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.spyOn(guardModule, 'assertSafeUrl').mockResolvedValue(undefined);
});

function makeResponse(status: number, headers: Record<string, string> = {}, body: string = ''): Response {
  const headerMap = new Headers(headers);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (body) controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headerMap,
    url: '',
    body: stream,
    text: async () => body,
  } as unknown as Response;
}

describe('fetchPage - redirect limits', () => {
  it('follows up to 5 redirects and then resolves', async () => {
    const { fetchPage } = await import('../src/scraper/fetch');
    let callCount = 0;
    const globalFetch = vi.fn(() => {
      callCount++;
      if (callCount <= 5) {
        return Promise.resolve(
          makeResponse(301, { location: `https://example.com/step${callCount + 1}` }),
        );
      }
      return Promise.resolve(
        makeResponse(200, { 'content-type': 'text/html' }, '<html><body>final</body></html>'),
      );
    });
    vi.stubGlobal('fetch', globalFetch);
    const result = await fetchPage('https://example.com/step1');
    expect(result.html).toContain('final');
    expect(callCount).toBe(6);
  });

  it('throws Too many redirects after 5 hops', async () => {
    const { fetchPage } = await import('../src/scraper/fetch');
    let n = 0;
    const globalFetch = vi.fn(() => {
      n++;
      return Promise.resolve(makeResponse(301, { location: `https://example.com/hop${n}` }));
    });
    vi.stubGlobal('fetch', globalFetch);
    await expect(fetchPage('https://example.com/start')).rejects.toThrow('Too many redirects');
    expect(n).toBe(6);
  });
});

describe('fetchPage - redirect loop detection', () => {
  it('throws Redirect loop detected when a URL repeats', async () => {
    const { fetchPage } = await import('../src/scraper/fetch');
    let call = 0;
    const globalFetch = vi.fn(() => {
      call++;
      if (call === 1) {
        return Promise.resolve(makeResponse(301, { location: 'https://example.com/b' }));
      }
      return Promise.resolve(makeResponse(301, { location: 'https://example.com/start' }));
    });
    vi.stubGlobal('fetch', globalFetch);
    await expect(fetchPage('https://example.com/start')).rejects.toThrow('Redirect loop');
  });

  it('validates every redirect destination before requesting it', async () => {
    const { fetchPage } = await import('../src/scraper/fetch');
    const validateUrl = vi.spyOn(guardModule, 'assertSafeUrl').mockImplementation(async (url) => {
      if (url.includes('127.0.0.1')) throw new Error('Target resolves to a prohibited address');
    });
    const globalFetch = vi.fn().mockResolvedValue(
      makeResponse(301, { location: 'http://127.0.0.1/private' }),
    );
    vi.stubGlobal('fetch', globalFetch);
    await expect(fetchPage('https://example.com/start')).rejects.toThrow('prohibited');
    expect(validateUrl).toHaveBeenCalledWith('http://127.0.0.1/private');
    expect(globalFetch).toHaveBeenCalledOnce();
  });
});

describe('fetchPage - request timeout', () => {
  it('keeps the timeout active while reading the response body', async () => {
    const { fetchPage } = await import('../src/scraper/fetch');
    vi.useFakeTimers();
    const globalFetch = vi.fn((_url: string, opts: RequestInit) => {
      const signal = opts.signal as AbortSignal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener('abort', () => {
            const err = new Error('AbortError');
            err.name = 'AbortError';
            controller.error(err);
          });
        },
      });
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        url: 'https://example.com/',
        body: stream,
      } as Response);
    });
    vi.stubGlobal('fetch', globalFetch);
    const result = expect(fetchPage('https://example.com/')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
  });
});

describe('fetchPage - response size limit', () => {
  it('aborts and truncates the response at MAX_RESPONSE_BYTES', async () => {
    const { fetchPage } = await import('../src/scraper/fetch');
    const MAX = 5 * 1024 * 1024;
    const bigChunk = new Uint8Array(MAX + 100).fill(65);
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bigChunk);
      },
      cancel: cancelled,
    });
    let signal: AbortSignal | undefined;
    const response = {
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' }),
      url: 'https://example.com/',
      body: stream,
    } as unknown as Response;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: RequestInit) => {
        signal = options.signal as AbortSignal;
        return Promise.resolve(response);
      }),
    );
    const result = await fetchPage('https://example.com/');
    expect(result.html).toHaveLength(MAX);
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
