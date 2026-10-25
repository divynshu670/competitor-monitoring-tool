import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { readFileSync } from 'fs';
import { join } from 'path';
import { extractArticle, parseSitemapUrls } from '../src/scraper/extract';

function loadFixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

describe('article vs category-page classification', () => {
  it('classifies a real article page as an article', () => {
    const html = loadFixture('article.html');
    const $ = cheerio.load(html);
    const result = extractArticle($, 'https://example.com/blog/how-to-build-compiler');
    expect(result).not.toBeNull();
    expect(result?.title).toBe('How to Build a Compiler in 2024');
  });

  it('does not classify a category/listing page as an article', () => {
    const html = loadFixture('category.html');
    const $ = cheerio.load(html);
    const result = extractArticle($, 'https://example.com/blog/');
    expect(result).toBeNull();
  });

  it('does not classify category page as article even with a blog-like URL', () => {
    const html = loadFixture('category.html');
    const $ = cheerio.load(html);
    const result = extractArticle($, 'https://example.com/blog/all-posts');
    expect(result).toBeNull();
  });
});

describe('metadata extraction and missing publication dates', () => {
  it('extracts publication date from article:published_time meta', () => {
    const html = loadFixture('article.html');
    const $ = cheerio.load(html);
    const result = extractArticle($, 'https://example.com/blog/post');
    expect(result?.publishedAt).toBe('2024-06-15T09:00:00.000Z');
  });

  it('returns null publishedAt when no date metadata is present', () => {
    const html = loadFixture('article_no_date.html');
    const $ = cheerio.load(html);
    const result = extractArticle($, 'https://example.com/blog/no-date');
    expect(result).not.toBeNull();
    expect(result?.publishedAt).toBeNull();
  });

  it('extracts dateCreated when datePublished is invalid', () => {
    const html = `<!DOCTYPE html><html><head>
      <script type="application/ld+json">
      {
        "@type": "BlogPosting",
        "datePublished": "not-a-date",
        "dateCreated": "2024-10-03T08:30:00Z"
      }
      </script>
      </head><body><article><h1>Created Date Article</h1></article></body></html>`;
    const result = extractArticle(cheerio.load(html), 'https://example.com/blog/date-created');
    expect(result?.publishedAt).toBe('2024-10-03T08:30:00.000Z');
  });

  it('returns null for an invalid calendar date', () => {
    const html = `<!DOCTYPE html><html><head>
      <meta property="article:published_time" content="2024-02-31">
      </head><body><article><h1>Invalid Date Article</h1></article></body></html>`;
    const result = extractArticle(cheerio.load(html), 'https://example.com/blog/invalid-date');
    expect(result?.publishedAt).toBeNull();
  });

  it('extracts meta description', () => {
    const html = loadFixture('article.html');
    const $ = cheerio.load(html);
    const result = extractArticle($, 'https://example.com/blog/post');
    expect(result?.metaDescription).toBe('A deep dive into compiler construction.');
  });
});

describe('JSON-LD @graph date extraction', () => {
  it('extracts datePublished from a top-level @graph array', () => {
    const html = `<!DOCTYPE html><html><head>
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "BlogPosting",
            "headline": "Graph Article",
            "datePublished": "2024-08-20T12:00:00Z"
          }
        ]
      }
      </script>
      </head><body>
      <article><h1>Graph Article</h1><p class="byline">By Author</p></article>
      </body></html>`;
    const $ = cheerio.load(html);
    const result = extractArticle($, 'https://example.com/blog/graph-article');
    expect(result).not.toBeNull();
    expect(result?.publishedAt).toBe('2024-08-20T12:00:00.000Z');
  });

  it('extracts datePublished from a top-level JSON-LD array', () => {
    const html = `<!DOCTYPE html><html><head>
      <script type="application/ld+json">
      [
        { "@type": "WebPage", "name": "Home" },
        { "@type": "Article", "headline": "Array Article", "datePublished": "2024-09-01T00:00:00Z" }
      ]
      </script>
      <meta property="article:published_time" content="2024-09-01T00:00:00Z">
      </head><body>
      <article><h1>Array Article</h1></article>
      </body></html>`;
    const $ = cheerio.load(html);
    const result = extractArticle($, 'https://example.com/blog/array-article');
    expect(result).not.toBeNull();
    expect(result?.publishedAt).toBe('2024-09-01T00:00:00.000Z');
  });
});

describe('regular sitemap parsing', () => {
  it('returns leaf URLs from a regular sitemap', () => {
    const xml = loadFixture('sitemap.xml');
    const { urls, childSitemaps } = parseSitemapUrls(xml, 'https://example.com');
    expect(urls).toHaveLength(3);
    expect(urls).toContain('https://example.com/blog/post-alpha');
    expect(childSitemaps).toHaveLength(0);
  });

  it('filters out URLs from a different origin', () => {
    const xml = `<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/blog/local</loc></url>
      <url><loc>https://other.com/blog/foreign</loc></url>
    </urlset>`;
    const { urls } = parseSitemapUrls(xml, 'https://example.com');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('https://example.com/blog/local');
  });
});

describe('sitemap-index child discovery', () => {
  it('returns child sitemap URLs from a sitemap index', () => {
    const xml = loadFixture('sitemap_index.xml');
    const { urls, childSitemaps } = parseSitemapUrls(xml, 'https://example.com');
    expect(urls).toHaveLength(0);
    expect(childSitemaps).toHaveLength(2);
    expect(childSitemaps).toContain('https://example.com/sitemap-posts.xml');
    expect(childSitemaps).toContain('https://example.com/sitemap-pages.xml');
  });

  it('handles a malformed sitemap index gracefully', () => {
    const xml = '<?xml version="1.0"?><sitemapindex><sitemap><loc>:::invalid</loc></sitemap></sitemapindex>';
    const { urls, childSitemaps } = parseSitemapUrls(xml, 'https://example.com');
    expect(urls).toHaveLength(0);
    expect(childSitemaps).toHaveLength(0);
  });
});
