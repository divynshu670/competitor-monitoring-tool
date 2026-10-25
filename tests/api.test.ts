import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import dns from 'dns/promises';
import { pool } from '../src/db';
import * as configModule from '../src/config';
import * as emailModule from '../src/email';
import * as keywordModule from '../src/keywords';
import app from '../src/server';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GET /health', () => {
  it('returns HTTP 200 with the server status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.message).toBe('Server is running');
  });

  it('works when database configuration is unavailable', async () => {
    vi.spyOn(configModule, 'isDatabaseConfigured').mockReturnValue(false);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('POST /scrape - database setup is required', () => {
  it('returns HTTP 503 before scanning or querying the database', async () => {
    vi.spyOn(configModule, 'isDatabaseConfigured').mockReturnValue(false);
    const query = vi.spyOn(pool, 'query');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    const res = await request(app).post('/scrape').send({ domain: 'example.com' });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'Database setup required',
      message: 'Configure PGHOST, PGDATABASE, PGUSER, and PGPASSWORD before scanning.',
    });
    expect(query).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('POST /scrape - invalid request body returns HTTP 400', () => {
  it('returns 400 when body is empty', async () => {
    const res = await request(app).post('/scrape').send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when domain is missing', async () => {
    const res = await request(app).post('/scrape').send({ url: 'https://example.com' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when domain is an empty string', async () => {
    const res = await request(app).post('/scrape').send({ domain: '' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is not JSON (missing content-type)', async () => {
    const res = await request(app)
      .post('/scrape')
      .set('Content-Type', 'text/plain')
      .send('not json');
    expect(res.status).toBe(400);
  });
});

describe('POST /scrape - unreachable website error handling', () => {
  it('returns 400 when domain resolves to a private address', async () => {
    const res = await request(app)
      .post('/scrape')
      .send({ domain: 'localhost' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prohibited/i);
  });

  it('returns 400 when URL scheme is invalid', async () => {
    const res = await request(app)
      .post('/scrape')
      .send({ domain: 'file:///etc/passwd' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the domain cannot be reached (DNS failure)', async () => {
    vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
    const res = await request(app)
      .post('/scrape')
      .send({ domain: 'this-domain-absolutely-does-not-exist.invalid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/DNS resolution failed/i);
  });
});

describe('POST /scrape - successful zero-article scan returns HTTP 200 with empty array', () => {
  it('returns 200 with an empty articles array when no pages contain articles', async () => {
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as never);
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as Awaited<ReturnType<typeof dns.lookup>>);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const path = new URL(input.toString()).pathname;
        if (path === '/') {
          return new Response('<html><body><h1>Example</h1></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        return new Response('', { status: 404 });
      }),
    );

    const res = await request(app).post('/scrape').send({ domain: 'example.com' });
    expect(res.status).toBe(200);
    expect(res.body.articles).toEqual([]);
    expect(res.body.status).toBe('No articles discovered');
    expect(res.body.articlesDiscovered).toBe(0);
    expect(res.body.newArticlesCount).toBe(0);
    expect(res.body.newArticles).toEqual([]);
  });

  it('returns HTTP 500 when article persistence fails', async () => {
    vi.spyOn(pool, 'query').mockRejectedValue(new Error('database unavailable'));
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as Awaited<ReturnType<typeof dns.lookup>>);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<html><body><h1>Example</h1></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    const res = await request(app).post('/scrape').send({ domain: 'example.com' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Scan failed' });
  });
});

describe('POST /scrape - persists and reports newly discovered articles', () => {
  it('includes the new article details and scan counts in its response', async () => {
    const scraperModule = await import('../src/scraper/index');
    vi.spyOn(scraperModule, 'scanDomain').mockResolvedValue({
      domain: 'https://example.com',
      articles: [
        {
          title: 'New Article',
          url: 'https://example.com/blog/new-article',
          publishedAt: '2025-04-12T10:00:00.000Z',
          metaDescription: 'New article description',
        },
      ],
      pagesScanned: 2,
      status: 'Discovered 1 article',
    });
    vi.spyOn(pool, 'query').mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE') || text.includes('ALTER TABLE') || text.includes('UPDATE')) {
        return { rows: [], rowCount: 1 } as never;
      }
      return {
        rows: [
          {
            url: 'https://example.com/blog/new-article',
            title: 'New Article',
            publishedAt: new Date('2025-04-12T10:00:00.000Z'),
            metaDescription: 'New article description',
            firstDiscoveredAt: new Date('2025-04-13T10:00:00.000Z'),
          },
        ],
        rowCount: 1,
      } as never;
    });
    vi.spyOn(keywordModule, 'enrichNewArticles').mockResolvedValue({
      status: 'completed',
      message: 'Search volumes are API estimates for Google Ads historical search data, not guaranteed traffic.',
      articles: [
        {
          title: 'New Article',
          url: 'https://example.com/blog/new-article',
          publishedAt: '2025-04-12T10:00:00.000Z',
          metaDescription: 'New article description',
          firstDiscoveredAt: '2025-04-13T10:00:00.000Z',
          targetKeyword: 'new article',
          estimatedSearchVolume: 210,
        },
      ],
    });
    vi.spyOn(emailModule, 'sendNewArticleAlert').mockResolvedValue({
      status: 'sent',
      message: null,
    });

    const res = await request(app).post('/scrape').send({ domain: 'example.com' });

    expect(res.status).toBe(200);
    expect(res.body.articlesDiscovered).toBe(1);
    expect(res.body.newArticlesCount).toBe(1);
    expect(res.body.newArticles).toEqual([
      {
        title: 'New Article',
        url: 'https://example.com/blog/new-article',
        publishedAt: '2025-04-12T10:00:00.000Z',
        metaDescription: 'New article description',
        firstDiscoveredAt: '2025-04-13T10:00:00.000Z',
        targetKeyword: 'new article',
        estimatedSearchVolume: 210,
      },
    ]);
    expect(res.body.keywordEnrichment.status).toBe('completed');
    expect(emailModule.sendNewArticleAlert).toHaveBeenCalledOnce();
    expect(res.body.emailDelivery).toEqual({ status: 'sent', message: null });
  });

  it('keeps discovered articles persisted when keyword enrichment fails', async () => {
    const scraperModule = await import('../src/scraper/index');
    vi.spyOn(scraperModule, 'scanDomain').mockResolvedValue({
      domain: 'https://example.com',
      articles: [
        {
          title: 'New Article',
          url: 'https://example.com/blog/new-article',
          publishedAt: null,
          metaDescription: null,
        },
      ],
      pagesScanned: 2,
      status: 'Discovered 1 article',
    });
    const query = vi.spyOn(pool, 'query').mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE') || text.includes('ALTER TABLE') || text.includes('UPDATE')) {
        return { rows: [], rowCount: 1 } as never;
      }
      return {
        rows: [
          {
            url: 'https://example.com/blog/new-article',
            title: 'New Article',
            publishedAt: null,
            metaDescription: null,
            firstDiscoveredAt: new Date('2025-04-13T10:00:00.000Z'),
          },
        ],
        rowCount: 1,
      } as never;
    });
    vi.spyOn(keywordModule, 'enrichNewArticles').mockResolvedValue({
      status: 'failed',
      message: 'Keyword API request failed.',
      articles: [
        {
          title: 'New Article',
          url: 'https://example.com/blog/new-article',
          publishedAt: null,
          metaDescription: null,
          firstDiscoveredAt: '2025-04-13T10:00:00.000Z',
          targetKeyword: null,
          estimatedSearchVolume: null,
        },
      ],
    });
    vi.spyOn(emailModule, 'sendNewArticleAlert').mockResolvedValue({
      status: 'unavailable',
      message: 'Email delivery is not configured.',
    });

    const res = await request(app).post('/scrape').send({ domain: 'example.com' });

    expect(res.status).toBe(200);
    expect(res.body.newArticlesCount).toBe(1);
    expect(res.body.newArticles[0].targetKeyword).toBeNull();
    expect(res.body.keywordEnrichment.status).toBe('failed');
    expect(res.body.emailDelivery.status).toBe('unavailable');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE discovered_articles'), [
      'https://example.com',
      'https://example.com/blog/new-article',
      null,
      null,
    ]);
  });

  it('keeps article and keyword persistence when email delivery reports failure', async () => {
    const scraperModule = await import('../src/scraper/index');
    vi.spyOn(scraperModule, 'scanDomain').mockResolvedValue({
      domain: 'https://example.com',
      articles: [
        {
          title: 'Persisted Article',
          url: 'https://example.com/blog/persisted',
          publishedAt: '2025-04-12T10:00:00.000Z',
          metaDescription: 'Article description',
        },
      ],
      pagesScanned: 2,
      status: 'Discovered 1 article',
    });
    const query = vi.spyOn(pool, 'query').mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE') || text.includes('ALTER TABLE') || text.includes('UPDATE')) {
        return { rows: [], rowCount: 1 } as never;
      }
      return {
        rows: [
          {
            url: 'https://example.com/blog/persisted',
            title: 'Persisted Article',
            publishedAt: new Date('2025-04-12T10:00:00.000Z'),
            metaDescription: 'Article description',
            firstDiscoveredAt: new Date('2025-04-13T10:00:00.000Z'),
          },
        ],
        rowCount: 1,
      } as never;
    });
    vi.spyOn(keywordModule, 'enrichNewArticles').mockResolvedValue({
      status: 'completed',
      message: 'Search volume is an estimate.',
      articles: [
        {
          title: 'Persisted Article',
          url: 'https://example.com/blog/persisted',
          publishedAt: '2025-04-12T10:00:00.000Z',
          metaDescription: 'Article description',
          firstDiscoveredAt: '2025-04-13T10:00:00.000Z',
          targetKeyword: 'persisted article',
          estimatedSearchVolume: 150,
        },
      ],
    });
    vi.spyOn(emailModule, 'sendNewArticleAlert').mockResolvedValue({
      status: 'failed',
      message: 'Email provider rejected the alert (HTTP 500).',
    });

    const res = await request(app).post('/scrape').send({ domain: 'example.com' });

    expect(res.status).toBe(200);
    expect(res.body.newArticlesCount).toBe(1);
    expect(res.body.newArticles[0]).toMatchObject({
      targetKeyword: 'persisted article',
      estimatedSearchVolume: 150,
    });
    expect(res.body.keywordEnrichment.status).toBe('completed');
    expect(res.body.emailDelivery.status).toBe('failed');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO discovered_articles'),
      expect.any(Array),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE discovered_articles'),
      expect.arrayContaining(['persisted article', 150]),
    );
  });

  it('skips email delivery for repeat scans with no newly inserted articles', async () => {
    const scraperModule = await import('../src/scraper/index');
    vi.spyOn(scraperModule, 'scanDomain').mockResolvedValue({
      domain: 'https://example.com',
      articles: [
        {
          title: 'Existing Article',
          url: 'https://example.com/blog/existing',
          publishedAt: null,
          metaDescription: null,
        },
      ],
      pagesScanned: 2,
      status: 'Discovered 1 article',
    });
    vi.spyOn(pool, 'query').mockImplementation(async (text: string) => {
      if (text.includes('CREATE TABLE') || text.includes('ALTER TABLE')) {
        return { rows: [], rowCount: 0 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    });
    const sendAlert = vi.spyOn(emailModule, 'sendNewArticleAlert');

    const res = await request(app).post('/scrape').send({ domain: 'example.com' });

    expect(res.status).toBe(200);
    expect(res.body.newArticlesCount).toBe(0);
    expect(res.body.emailDelivery).toEqual({
      status: 'skipped',
      message: 'No new articles to alert on.',
    });
    expect(sendAlert).not.toHaveBeenCalled();
  });
});
