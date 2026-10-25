import * as cheerio from 'cheerio';
import { fetchPage } from './fetch';
import { parseHomepageLinks, parseSitemapUrls } from './extract';

const CONTENT_PATHS = ['/blog', '/news', '/articles', '/insights', '/resources', '/posts'];
const MAX_CANDIDATE_URLS = 50;
const MAX_ARTICLE_PAGES = 20;
const MAX_CHILD_SITEMAPS = 5;

const SKIP_PATH_PATTERNS = [
  /\/tag\//,
  /\/tags\//,
  /\/category\//,
  /\/categories\//,
  /\/author\//,
  /\/page\/\d+/,
  /\/feed\//,
  /\.(rss|xml|json|pdf|zip|png|jpg|jpeg|gif|svg|css|js|woff|woff2|ttf)$/i,
];

function isSkippablePath(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return SKIP_PATH_PATTERNS.some((r) => r.test(path));
  } catch {
    return true;
  }
}

function looksLikeArticleUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return (
      /\/(blog|news|articles?|insights?|resources?|posts?)\/[^/]+/.test(path) ||
      /\/\d{4}\/\d{2}\/[^/]+/.test(path)
    );
  } catch {
    return false;
  }
}

function dedup(urls: string[]): string[] {
  const seen = new Set<string>();
  return urls.filter((u) => {
    try {
      const normalized = new URL(u).href.replace(/\/$/, '');
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    } catch {
      return false;
    }
  });
}

async function trySitemap(origin: string): Promise<string[]> {
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  for (const sitemapUrl of candidates) {
    try {
      const result = await fetchPage(sitemapUrl);
      if (!result.html) continue;
      const { urls, childSitemaps } = parseSitemapUrls(result.html, origin);
      if (urls.length === 0 && childSitemaps.length === 0) continue;

      const allUrls = [...urls];
      const toFetch = dedup(childSitemaps).slice(0, MAX_CHILD_SITEMAPS);
      for (const childUrl of toFetch) {
        try {
          const childResult = await fetchPage(childUrl);
          if (!childResult.html) continue;
          const { urls: childLeafs } = parseSitemapUrls(childResult.html, origin);
          allUrls.push(...childLeafs);
        } catch {
        }
      }
      return dedup(allUrls);
    } catch {
    }
  }
  return [];
}

async function tryContentSections(origin: string): Promise<string[]> {
  const discovered: string[] = [];
  for (const path of CONTENT_PATHS) {
    try {
      const result = await fetchPage(`${origin}${path}`);
      if (!result.html) continue;
      const $ = cheerio.load(result.html);
      const links = parseHomepageLinks($, `${origin}${path}`);
      discovered.push(...links);
    } catch {
    }
  }
  return discovered;
}

export async function discoverCandidateUrls(origin: string, homepageHtml: string): Promise<string[]> {
  const $ = cheerio.load(homepageHtml);
  const homepageLinks = parseHomepageLinks($, origin);

  const contentSectionLinks = await tryContentSections(origin);
  const sitemapLinks = await trySitemap(origin);

  const all = dedup([...sitemapLinks, ...contentSectionLinks, ...homepageLinks]);

  const articleLike = all.filter((u) => !isSkippablePath(u) && looksLikeArticleUrl(u));
  const fallback = all.filter((u) => !isSkippablePath(u) && !looksLikeArticleUrl(u));

  const candidates = dedup([...articleLike, ...fallback]);

  return candidates
    .filter((u) => u !== `${origin}/` && u !== origin)
    .slice(0, MAX_CANDIDATE_URLS);
}

export { MAX_ARTICLE_PAGES };
