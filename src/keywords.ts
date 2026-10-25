import { config } from './config';
import type { Article, KeywordEnrichmentStatus, NewArticle } from './scraper/types';

const DATAFORSEO_ENDPOINT =
  'https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live';
const REQUEST_TIMEOUT_MS = 10_000;
const LOCATION_CODE = 2840;
const STOP_WORDS = new Set([
  'about',
  'after',
  'and',
  'are',
  'best',
  'for',
  'from',
  'how',
  'into',
  'that',
  'the',
  'this',
  'tips',
  'what',
  'when',
  'with',
  'your',
]);

interface KeywordApiSuggestion {
  keyword: string;
  search_volume: number | null;
}

interface KeywordApiResponse {
  status_code: number;
  status_message?: string;
  tasks: Array<{
    status_code: number;
    status_message?: string;
    result: KeywordApiSuggestion[] | null;
  }>;
}

export interface KeywordCredentials {
  login: string;
  password: string;
}

export interface KeywordEnrichmentResult {
  articles: NewArticle[];
  status: KeywordEnrichmentStatus;
  message: string | null;
}

function isKeywordSuggestion(value: unknown): value is KeywordApiSuggestion {
  if (value === null || typeof value !== 'object') return false;
  const suggestion = value as Record<string, unknown>;
  const volume = suggestion.search_volume;
  return (
    typeof suggestion.keyword === 'string' &&
    (volume === null ||
      (typeof volume === 'number' && Number.isSafeInteger(volume) && volume >= 0))
  );
}

function makeResult(
  articles: Article[],
  status: KeywordEnrichmentStatus,
  message: string | null,
): KeywordEnrichmentResult {
  return {
    articles: articles.map((article) => ({
      ...article,
      targetKeyword: null,
      estimatedSearchVolume: null,
    })) as NewArticle[],
    status,
    message,
  };
}

function parseResponse(value: unknown): KeywordApiResponse | null {
  if (value === null || typeof value !== 'object') return null;
  const response = value as Partial<KeywordApiResponse>;
  if (
    typeof response.status_code !== 'number' ||
    !Array.isArray(response.tasks) ||
    response.tasks.length === 0
  ) {
    return null;
  }

  const task = response.tasks[0];
  if (
    task === null ||
    typeof task !== 'object' ||
    typeof task.status_code !== 'number' ||
    (task.result !== null && !Array.isArray(task.result))
  ) {
    return null;
  }

  const suggestions = (task.result ?? []) as unknown[];
  if (suggestions.some((suggestion) => !isKeywordSuggestion(suggestion))) {
    return null;
  }
  return response as KeywordApiResponse;
}

function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((word) => word.length > 1 && !STOP_WORDS.has(word)) ?? [],
  );
}

function relevanceScore(article: Article, suggestion: string): number {
  const articleTerms = terms(`${article.title} ${article.metaDescription ?? ''}`);
  const suggestionTerms = terms(suggestion);
  if (articleTerms.size === 0 || suggestionTerms.size === 0) return 0;

  let shared = 0;
  for (const term of suggestionTerms) {
    if (articleTerms.has(term)) shared++;
  }
  return shared / (articleTerms.size + suggestionTerms.size - shared);
}

function enrichArticle(article: NewArticle, suggestions: KeywordApiSuggestion[]): NewArticle {
  let best: KeywordApiSuggestion | undefined;
  let bestScore = 0;

  for (const suggestion of suggestions) {
    const score = relevanceScore(article, suggestion.keyword);
    if (
      score > bestScore ||
      (score === bestScore &&
        score > 0 &&
        (suggestion.search_volume ?? -1) > (best?.search_volume ?? -1))
    ) {
      best = suggestion;
      bestScore = score;
    }
  }

  return best
    ? {
        ...article,
        targetKeyword: best.keyword,
        estimatedSearchVolume: best.search_volume,
      }
    : article;
}

export async function enrichNewArticles(
  articles: NewArticle[],
  credentials: KeywordCredentials = {
    login: config.DATAFORSEO_LOGIN,
    password: config.DATAFORSEO_PASSWORD,
  },
  fetcher: typeof fetch = fetch,
): Promise<KeywordEnrichmentResult> {
  if (articles.length === 0) return makeResult([], 'completed', null);
  if (!credentials.login || !credentials.password) {
    return makeResult(articles, 'unavailable', 'Keyword API credentials are not configured.');
  }

  const keywords = articles
    .map((article) => article.title.trim().slice(0, 80))
    .filter((keyword) => keyword.length > 0);
  if (keywords.length === 0) {
    return makeResult(articles, 'partial', 'No usable article titles were available as keyword seeds.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetcher(DATAFORSEO_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.login}:${credentials.password}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ location_code: LOCATION_CODE, keywords }]),
      signal: controller.signal,
    });

    if (response.status === 429) {
      return makeResult(articles, 'rate_limited', 'Keyword API rate limit reached.');
    }
    if (!response.ok) {
      return makeResult(articles, 'failed', `Keyword API returned HTTP ${response.status}.`);
    }

    let parsed: KeywordApiResponse | null;
    try {
      parsed = parseResponse(await response.json() as unknown);
    } catch {
      if (controller.signal.aborted) {
        return makeResult(articles, 'timeout', 'Keyword API request timed out.');
      }
      parsed = null;
    }
    if (!parsed) {
      return makeResult(articles, 'failed', 'Keyword API returned an invalid response.');
    }
    if (parsed.status_code !== 20000 || parsed.tasks[0].status_code !== 20000) {
      const errorMessage = `${parsed.status_message ?? ''} ${parsed.tasks[0].status_message ?? ''}`;
      if (/rate limit|too many requests|request limit/i.test(errorMessage)) {
        return makeResult(articles, 'rate_limited', 'Keyword API rate limit reached.');
      }
      return makeResult(articles, 'failed', 'Keyword API reported an unsuccessful request.');
    }

    const suggestions = parsed.tasks[0].result ?? [];
    const enriched = articles.map((article) => enrichArticle(article, suggestions));
    const withKeyword = enriched.filter((article) => article.targetKeyword !== null).length;
    const withVolume = enriched.filter((article) => article.estimatedSearchVolume !== null).length;
    const status = withKeyword === articles.length && withVolume === articles.length ? 'completed' : 'partial';
    const message =
      status === 'completed'
        ? 'Search volumes are API estimates for Google Ads historical search data, not guaranteed traffic.'
        : 'Some articles had no relevant keyword suggestion or search-volume estimate from the API.';
    return { articles: enriched, status, message };
  } catch (error: unknown) {
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return makeResult(articles, 'timeout', 'Keyword API request timed out.');
    }
    return makeResult(articles, 'failed', 'Keyword API request failed.');
  } finally {
    clearTimeout(timer);
  }
}
