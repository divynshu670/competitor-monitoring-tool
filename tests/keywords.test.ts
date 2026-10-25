import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichNewArticles } from '../src/keywords';
import type { NewArticle } from '../src/scraper/types';

const articles: NewArticle[] = [
  {
    title: 'Practical compiler construction techniques',
    url: 'https://example.com/blog/compiler-construction',
    publishedAt: null,
    metaDescription: 'A guide to compiler design and optimization.',
    firstDiscoveredAt: '2026-10-25T10:00:00.000Z',
    targetKeyword: null,
    estimatedSearchVolume: null,
  },
];

afterEach(() => {
  vi.useRealTimers();
});

function apiResponse(
  result: Array<{ keyword: string; search_volume: number | null }> = [],
): Response {
  return new Response(
    JSON.stringify({
      status_code: 20000,
      tasks: [{ status_code: 20000, result }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('enrichNewArticles', () => {
  it('uses DataForSEO suggestions and preserves the API volume estimate', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      apiResponse([
        { keyword: 'compiler construction', search_volume: 320 },
        { keyword: 'compiler design basics', search_volume: 90 },
        { keyword: 'unrelated cooking recipes', search_volume: 9000 },
      ]),
    );

    const result = await enrichNewArticles(
      articles,
      { login: 'test-login', password: 'test-password' },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('test-login:test-password').toString('base64')}`,
        }),
        body: JSON.stringify([
          { location_code: 2840, keywords: ['Practical compiler construction techniques'] },
        ]),
      }),
    );
    expect(result).toMatchObject({
      status: 'completed',
      articles: [{ targetKeyword: 'compiler construction', estimatedSearchVolume: 320 }],
    });
    expect(result.message).toMatch(/estimates/i);
  });

  it('does not call the API without credentials and leaves keyword data null', async () => {
    const fetcher = vi.fn();

    const result = await enrichNewArticles(articles, { login: '', password: '' }, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.status).toBe('unavailable');
    expect(result.articles[0]).toMatchObject({
      targetKeyword: null,
      estimatedSearchVolume: null,
    });
  });

  it('handles rate limits without failing article discovery', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 429 }));

    const result = await enrichNewArticles(
      articles,
      { login: 'test-login', password: 'test-password' },
      fetcher,
    );

    expect(result.status).toBe('rate_limited');
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].estimatedSearchVolume).toBeNull();
  });

  it('recognizes a rate limit reported in the API task response', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status_code: 20000,
          tasks: [{ status_code: 40200, status_message: 'Rate limit exceeded.', result: null }],
        }),
        { status: 200 },
      ),
    );

    const result = await enrichNewArticles(
      articles,
      { login: 'test-login', password: 'test-password' },
      fetcher,
    );

    expect(result.status).toBe('rate_limited');
    expect(result.articles[0].targetKeyword).toBeNull();
  });

  it('handles API errors and invalid JSON without inventing enrichment data', async () => {
    const failedResponse = await enrichNewArticles(
      articles,
      { login: 'test-login', password: 'test-password' },
      vi.fn().mockResolvedValue(new Response('', { status: 503 })),
    );
    const malformedResponse = await enrichNewArticles(
      articles,
      { login: 'test-login', password: 'test-password' },
      vi.fn().mockResolvedValue(new Response('{', { status: 200 })),
    );
    const invalidVolumeResponse = await enrichNewArticles(
      articles,
      { login: 'test-login', password: 'test-password' },
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status_code: 20000,
            tasks: [{ status_code: 20000, result: [{ keyword: 'compiler', search_volume: -1 }] }],
          }),
          { status: 200 },
        ),
      ),
    );

    expect(failedResponse.status).toBe('failed');
    expect(malformedResponse.status).toBe('failed');
    expect(invalidVolumeResponse.status).toBe('failed');
    expect(failedResponse.articles[0].targetKeyword).toBeNull();
    expect(malformedResponse.articles[0].estimatedSearchVolume).toBeNull();
  });

  it('stores null when the API suggests a keyword without a volume estimate', async () => {
    const result = await enrichNewArticles(
      articles,
      { login: 'test-login', password: 'test-password' },
      vi.fn().mockResolvedValue(apiResponse([{ keyword: 'compiler construction', search_volume: null }])),
    );

    expect(result.status).toBe('partial');
    expect(result.articles[0]).toMatchObject({
      targetKeyword: 'compiler construction',
      estimatedSearchVolume: null,
    });
  });

  it('does not make a request for articles that were not newly inserted', async () => {
    const fetcher = vi.fn();

    await enrichNewArticles([], { login: 'test-login', password: 'test-password' }, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports a timeout without rejecting the scan', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, options: RequestInit) => {
      const signal = options.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('AbortError');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    const resultPromise = enrichNewArticles(
      articles,
      { login: 'test-login', password: 'test-password' },
      fetcher,
    );
    const resultExpectation = expect(resultPromise).resolves.toMatchObject({ status: 'timeout' });

    await vi.advanceTimersByTimeAsync(10_000);
    await resultExpectation;
  });
});
