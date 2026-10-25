import { afterEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db';
import { persistDiscoveredArticles, persistKeywordEnrichment } from '../src/articles';
import type { Article } from '../src/scraper/types';

const article: Article = {
  title: 'Persistence Test Article',
  url: 'https://example.com/blog/persistence-test/',
  publishedAt: '2025-04-12T10:00:00.000Z',
  metaDescription: 'An article used to verify persistence.',
};

afterEach(() => {
  vi.restoreAllMocks();
});

function mockDatabase() {
  const records = new Map<string, Article & { firstDiscoveredAt: string }>();
  const query = vi.spyOn(pool, 'query').mockImplementation(async (text: string, values?: unknown[]) => {
    if (text.includes('CREATE TABLE') || text.includes('ALTER TABLE')) {
      return { rows: [], rowCount: 0 } as never;
    }

    const rows: Array<Article & { firstDiscoveredAt: string }> = [];
    for (let index = 0; index < (values?.length ?? 0); index += 5) {
      const competitor = String(values?.[index]);
      const url = String(values?.[index + 1]);
      const key = `${competitor}\n${url}`;
      if (records.has(key)) continue;

      const record = {
        url,
        title: String(values?.[index + 2]),
        publishedAt: values?.[index + 3] as string | null,
        metaDescription: values?.[index + 4] as string | null,
        firstDiscoveredAt: '2025-04-12T10:00:00.000Z',
      };
      records.set(key, record);
      rows.push(record);
    }
    return { rows, rowCount: rows.length } as never;
  });

  return { records, query };
}

describe('persistDiscoveredArticles', () => {
  it('inserts articles on the first scan and returns them as new', async () => {
    const { records, query } = mockDatabase();

    const inserted = await persistDiscoveredArticles('https://example.com', [article]);

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][0]).toContain('ON CONFLICT (competitor, canonical_url) DO NOTHING');
    expect(query.mock.calls[2][0]).toContain('RETURNING');
    expect(query.mock.calls[2][1]).toEqual([
      'https://example.com',
      'https://example.com/blog/persistence-test',
      article.title,
      article.publishedAt,
      article.metaDescription,
    ]);
    expect(inserted).toEqual([
      {
        ...article,
        url: 'https://example.com/blog/persistence-test',
        firstDiscoveredAt: '2025-04-12T10:00:00.000Z',
        targetKeyword: null,
        estimatedSearchVolume: null,
      },
    ]);
    expect(records.size).toBe(1);
  });

  it('reports zero new articles on a subsequent scan of the same URLs', async () => {
    mockDatabase();

    expect(await persistDiscoveredArticles('https://example.com', [article])).toHaveLength(1);
    expect(await persistDiscoveredArticles('https://example.com', [article])).toEqual([]);
  });

  it('does not insert duplicate canonical URLs twice for one competitor', async () => {
    const { records, query } = mockDatabase();
    const duplicate = { ...article, url: 'https://example.com/blog/persistence-test#section' };

    const inserted = await persistDiscoveredArticles('https://example.com', [article, duplicate]);

    expect(inserted).toHaveLength(1);
    expect(records.size).toBe(1);
    expect(query.mock.calls[2][1]).toHaveLength(5);
  });

  it('stores target keywords and nullable estimated search volumes with parameterized SQL', async () => {
    const query = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 1 } as never);
    await expect(
      persistDiscoveredArticles('https://example.com', [article]),
    ).resolves.toHaveLength(0);
    query.mockClear();

    await persistKeywordEnrichment('https://example.com', [
      {
        ...article,
        url: 'https://example.com/blog/persistence-test',
        firstDiscoveredAt: '2025-04-12T10:00:00.000Z',
        targetKeyword: 'compiler construction',
        estimatedSearchVolume: 320,
      },
      {
        ...article,
        url: 'https://example.com/blog/without-volume',
        firstDiscoveredAt: '2025-04-12T10:00:00.000Z',
        targetKeyword: 'compiler design',
        estimatedSearchVolume: null,
      },
    ]);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain('UPDATE discovered_articles');
    expect(query.mock.calls[0][0]).toContain('$4::bigint');
    expect(query.mock.calls[0][1]).toEqual([
      'https://example.com',
      'https://example.com/blog/persistence-test',
      'compiler construction',
      320,
      'https://example.com',
      'https://example.com/blog/without-volume',
      'compiler design',
      null,
    ]);
  });

  it('allows the same article URL to be tracked by different competitors', async () => {
    const { records } = mockDatabase();

    const firstCompetitor = await persistDiscoveredArticles('https://example.com', [article]);
    const secondCompetitor = await persistDiscoveredArticles('https://another.example', [article]);

    expect(firstCompetitor).toHaveLength(1);
    expect(secondCompetitor).toHaveLength(1);
    expect(records.size).toBe(2);
  });

  it('propagates database errors instead of returning a successful persistence result', async () => {
    vi.spyOn(pool, 'query').mockRejectedValue(new Error('database unavailable'));

    await expect(persistDiscoveredArticles('https://example.com', [article])).rejects.toThrow(
      'database unavailable',
    );
  });
});
