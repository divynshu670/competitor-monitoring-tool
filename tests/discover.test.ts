import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as fetchModule from '../src/scraper/fetch';
import { discoverCandidateUrls } from '../src/scraper/discover';

function loadFixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sitemap child discovery', () => {
  it('fetches child sitemaps and deduplicates discovered article URLs', async () => {
    const index = loadFixture('sitemap_index.xml');
    const child = loadFixture('child_sitemap.xml');
    const fetchPage = vi.spyOn(fetchModule, 'fetchPage').mockImplementation(async (url) => ({
      url,
      html: new URL(url).pathname === '/sitemap.xml' ? index : child,
      status: 200,
    }));

    const urls = await discoverCandidateUrls('https://example.com', '<html></html>');

    expect(urls).toEqual([
      'https://example.com/blog/child-post-one',
      'https://example.com/blog/child-post-two',
    ]);
    expect(fetchPage.mock.calls.map(([url]) => url)).toContain('https://example.com/sitemap-posts.xml');
    expect(fetchPage.mock.calls.map(([url]) => url)).toContain('https://example.com/sitemap-pages.xml');
  });

  it('fetches no more than five child sitemaps from an index', async () => {
    const children = Array.from(
      { length: 7 },
      (_, index) => `<sitemap><loc>https://example.com/sitemap-${index + 1}.xml</loc></sitemap>`,
    ).join('');
    const index = `<sitemapindex>${children}</sitemapindex>`;
    const fetchPage = vi.spyOn(fetchModule, 'fetchPage').mockImplementation(async (url) => {
      const pathname = new URL(url).pathname;
      const html =
        pathname === '/sitemap.xml'
          ? index
          : `<urlset><url><loc>https://example.com/blog/post-${pathname.match(/\d+/)?.[0]}</loc></url></urlset>`;
      return { url, html, status: 200 };
    });

    const urls = await discoverCandidateUrls('https://example.com', '<html></html>');

    const fetchedChildren = fetchPage.mock.calls.filter(([url]) => /\/sitemap-\d+\.xml$/.test(url));
    expect(fetchedChildren).toHaveLength(5);
    expect(urls).toHaveLength(5);
  });
});
