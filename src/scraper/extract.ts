import * as cheerio from 'cheerio';
import type { Article } from './types';

function extractJsonLdEntries($: cheerio.CheerioAPI): unknown[] {
  const entries: unknown[] = [];
  const collectEntries = (data: unknown): void => {
    if (Array.isArray(data)) {
      data.forEach(collectEntries);
    } else if (data !== null && typeof data === 'object') {
      const object = data as Record<string, unknown>;
      if (Array.isArray(object['@graph'])) {
        object['@graph'].forEach(collectEntries);
      } else {
        entries.push(data);
      }
    }
  };

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html() ?? '';
      collectEntries(JSON.parse(raw) as unknown);
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  });
  return entries;
}

function extractDate($: cheerio.CheerioAPI): string | null {
  const ogDate = $('meta[property="article:published_time"]').attr('content');
  if (ogDate) {
    const normalized = normalizeDate(ogDate);
    if (normalized) return normalized;
  }

  for (const entry of extractJsonLdEntries($)) {
    if (entry !== null && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      for (const date of [obj['datePublished'], obj['dateCreated']]) {
        if (typeof date !== 'string') continue;
        const normalized = normalizeDate(date);
        if (normalized) return normalized;
      }
    }
  }

  const dateCandidates = [
    $('time[datetime]').first().attr('datetime'),
    $('meta[name="date"]').attr('content'),
    $('meta[name="publishdate"]').attr('content'),
    $('meta[name="DC.date"]').attr('content'),
  ];
  for (const date of dateCandidates) {
    if (!date) continue;
    const normalized = normalizeDate(date);
    if (normalized) return normalized;
  }

  return null;
}

function normalizeDate(raw: string): string | null {
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/i);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  if (dateOnly) {
    const [year, month, day] = dateOnly.slice(1).map(Number);
    const calendarDate = new Date(0);
    calendarDate.setUTCFullYear(year, month - 1, day);
    if (
      calendarDate.getUTCFullYear() !== year ||
      calendarDate.getUTCMonth() + 1 !== month ||
      calendarDate.getUTCDate() !== day
    ) {
      return null;
    }
  }
  return d.toISOString();
}

function extractTitle($: cheerio.CheerioAPI): string {
  const og = $('meta[property="og:title"]').attr('content');
  if (og?.trim()) return og.trim();

  const h1 = $('h1').first().text().trim();
  if (h1) return h1;

  const titleTag = $('title').text().trim();
  return titleTag || 'Untitled';
}

function extractDescription($: cheerio.CheerioAPI): string | null {
  const og = $('meta[property="og:description"]').attr('content');
  if (og?.trim()) return og.trim();

  const meta = $('meta[name="description"]').attr('content');
  if (meta?.trim()) return meta.trim();

  return null;
}

function hasArticleJsonLd($: cheerio.CheerioAPI): boolean {
  const ARTICLE_TYPES = new Set(['Article', 'BlogPosting', 'NewsArticle', 'TechArticle', 'ScholarlyArticle']);
  for (const entry of extractJsonLdEntries($)) {
    if (entry !== null && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const type = obj['@type'];
      if (typeof type === 'string' && ARTICLE_TYPES.has(type)) return true;
      if (Array.isArray(type) && type.some((t) => typeof t === 'string' && ARTICLE_TYPES.has(t))) return true;
    }
  }
  return false;
}

function isLikelyArticlePage($: cheerio.CheerioAPI): boolean {
  const hasPublishedTimeMeta = $('meta[property="article:published_time"]').length > 0;
  if (hasPublishedTimeMeta) return true;

  if (hasArticleJsonLd($)) return true;

  return $('article').toArray().some((element) => {
    const article = $(element);
    const hasArticleMetadata =
      article.find('time[datetime], [rel="author"], .author, .byline').length > 0;
    const hasArticleContent =
      article.find('h1, h2').length > 0 && article.find('p').text().trim().length >= 120;
    return hasArticleMetadata || hasArticleContent;
  });
}

export function extractArticle($: cheerio.CheerioAPI, url: string): Article | null {
  if (!isLikelyArticlePage($)) return null;

  return {
    title: extractTitle($),
    url,
    publishedAt: extractDate($),
    metaDescription: extractDescription($),
  };
}

export function parseHomepageLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const origin = new URL(baseUrl).origin;
  const hrefs: string[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const resolved = new URL(href, baseUrl).href;
      if (new URL(resolved).origin === origin) hrefs.push(resolved);
    } catch {
    }
  });

  return hrefs;
}

export interface ParsedSitemap {
  urls: string[];
  childSitemaps: string[];
}

export function parseSitemapUrls(xml: string, origin: string): ParsedSitemap {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls: string[] = [];
  const childSitemaps: string[] = [];

  const isIndex = $('sitemapindex').length > 0;

  if (isIndex) {
    $('sitemap > loc').each((_, el) => {
      const loc = $(el).text().trim();
      try {
        const parsed = new URL(loc);
        if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === origin) {
          childSitemaps.push(loc);
        }
      } catch {
      }
    });
  } else {
    $('url > loc').each((_, el) => {
      const loc = $(el).text().trim();
      try {
        if (new URL(loc).origin === origin) urls.push(loc);
      } catch {
      }
    });
  }

  return { urls, childSitemaps };
}
