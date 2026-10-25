import type { QueryResultRow } from 'pg';
import { pool } from './db';
import type { Article, NewArticle } from './scraper/types';

interface InsertedArticleRow extends QueryResultRow {
  url: string;
  title: string;
  publishedAt: Date | string | null;
  metaDescription: string | null;
  firstDiscoveredAt: Date | string;
}

function canonicalizeArticleUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = '';
  if (url.pathname !== '/') {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.href;
}

function uniqueArticles(articles: Article[]): Array<Article & { url: string }> {
  const seen = new Set<string>();
  const unique: Array<Article & { url: string }> = [];

  for (const article of articles) {
    const url = canonicalizeArticleUrl(article.url);
    if (seen.has(url)) continue;
    seen.add(url);
    unique.push({ ...article, url });
  }

  return unique;
}

export async function persistDiscoveredArticles(
  competitor: string,
  articles: Article[],
): Promise<NewArticle[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discovered_articles (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      competitor TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      title TEXT NOT NULL,
      published_at TIMESTAMPTZ,
      meta_description TEXT,
      target_keyword TEXT,
      estimated_search_volume BIGINT,
      first_discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT discovered_articles_competitor_url_unique UNIQUE (competitor, canonical_url)
    )
  `);
  await pool.query(`
    ALTER TABLE discovered_articles
      ADD COLUMN IF NOT EXISTS target_keyword TEXT,
      ADD COLUMN IF NOT EXISTS estimated_search_volume BIGINT
  `);

  const unique = uniqueArticles(articles);
  if (unique.length === 0) return [];

  const values: Array<string | null> = [];
  const rows = unique.map((article, index) => {
    const offset = index * 5;
    values.push(
      competitor,
      article.url,
      article.title,
      article.publishedAt,
      article.metaDescription,
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
  });

  const result = await pool.query<InsertedArticleRow>(
    `
      INSERT INTO discovered_articles
        (competitor, canonical_url, title, published_at, meta_description)
      VALUES ${rows.join(', ')}
      ON CONFLICT (competitor, canonical_url) DO NOTHING
      RETURNING
        canonical_url AS url,
        title,
        published_at AS "publishedAt",
        meta_description AS "metaDescription",
        first_discovered_at AS "firstDiscoveredAt"
    `,
    values,
  );

  return result.rows.map((row) => ({
    url: row.url,
    title: row.title,
    publishedAt: row.publishedAt instanceof Date ? row.publishedAt.toISOString() : row.publishedAt,
    metaDescription: row.metaDescription,
    firstDiscoveredAt:
      row.firstDiscoveredAt instanceof Date
        ? row.firstDiscoveredAt.toISOString()
        : new Date(row.firstDiscoveredAt).toISOString(),
    targetKeyword: null,
    estimatedSearchVolume: null,
  }));
}

export async function persistKeywordEnrichment(
  competitor: string,
  articles: NewArticle[],
): Promise<void> {
  if (articles.length === 0) return;

  const values: Array<string | number | null> = [];
  const rows = articles.map((article, index) => {
    const offset = index * 4;
    values.push(competitor, canonicalizeArticleUrl(article.url), article.targetKeyword, article.estimatedSearchVolume);
    return `($${offset + 1}::text, $${offset + 2}::text, $${offset + 3}::text, $${offset + 4}::bigint)`;
  });

  await pool.query(
    `
      UPDATE discovered_articles AS stored
      SET target_keyword = enrichment.target_keyword,
          estimated_search_volume = enrichment.estimated_search_volume
      FROM (VALUES ${rows.join(', ')}) AS enrichment(competitor, canonical_url, target_keyword, estimated_search_volume)
      WHERE stored.competitor = enrichment.competitor
        AND stored.canonical_url = enrichment.canonical_url
    `,
    values,
  );
}
