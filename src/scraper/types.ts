export interface Article {
  title: string;
  url: string;
  publishedAt: string | null;
  metaDescription: string | null;
}

export interface NewArticle extends Article {
  firstDiscoveredAt: string;
  targetKeyword: string | null;
  estimatedSearchVolume: number | null;
}

export type KeywordEnrichmentStatus =
  | 'completed'
  | 'partial'
  | 'unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'failed'
  | 'persistence_failed';

export interface KeywordEnrichmentSummary {
  status: KeywordEnrichmentStatus;
  message: string | null;
}

export type EmailDeliveryStatus = 'sent' | 'skipped' | 'unavailable' | 'failed';

export interface EmailDeliverySummary {
  status: EmailDeliveryStatus;
  message: string | null;
}

export interface ScanResult {
  domain: string;
  articles: Article[];
  pagesScanned: number;
  status: string;
}

export interface ScrapeResponse extends ScanResult {
  articlesDiscovered: number;
  newArticlesCount: number;
  newArticles: NewArticle[];
  keywordEnrichment: KeywordEnrichmentSummary;
  emailDelivery: EmailDeliverySummary;
}
