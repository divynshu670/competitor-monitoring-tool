import * as cheerio from 'cheerio';
import { assertSafeUrl } from './guard';
import { fetchPage } from './fetch';
import { extractArticle } from './extract';
import { discoverCandidateUrls, MAX_ARTICLE_PAGES } from './discover';
import type { Article, ScanResult } from './types';

function normalizeInputUrl(input: string): string {
  const trimmed = input.trim();
  const hasExplicitScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed);
  const isBareHostnameWithPort = /^[^/:?#]+:\d+(?:[/?#]|$)/.test(trimmed);
  if (hasExplicitScheme && !/^https?:\/\//i.test(trimmed) && !isBareHostnameWithPort) {
    throw new Error('Invalid domain or URL');
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withScheme);
  return parsed.origin;
}

export async function scanDomain(input: string): Promise<ScanResult> {
  let origin: string;
  try {
    origin = normalizeInputUrl(input);
  } catch {
    throw new Error('Invalid domain or URL');
  }

  await assertSafeUrl(origin);

  const homepageResult = await fetchPage(origin);
  const candidates = await discoverCandidateUrls(origin, homepageResult.html);

  const articles: Article[] = [];
  const seenUrls = new Set<string>([origin, `${origin}/`]);
  let pagesScanned = 1;

  for (const candidateUrl of candidates) {
    if (articles.length >= MAX_ARTICLE_PAGES) break;

    const normalizedCandidate = candidateUrl.replace(/\/$/, '');
    if (seenUrls.has(normalizedCandidate) || seenUrls.has(`${normalizedCandidate}/`)) continue;
    seenUrls.add(normalizedCandidate);

    try {
      const result = await fetchPage(candidateUrl);
      pagesScanned++;
      if (!result.html) continue;

      const $page = cheerio.load(result.html);
      const article = extractArticle($page, result.url);
      if (article) {
        const normalizedArticleUrl = article.url.replace(/\/$/, '');
        const duplicate = articles.some((a) => a.url.replace(/\/$/, '') === normalizedArticleUrl);
        if (!duplicate) articles.push(article);
      }
    } catch {
    }
  }

  let status: string;
  if (articles.length === 0) {
    status = 'No articles discovered';
  } else {
    status = `Discovered ${articles.length} article${articles.length === 1 ? '' : 's'}`;
  }

  return { domain: origin, articles, pagesScanned, status };
}
