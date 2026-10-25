import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { persistDiscoveredArticles, persistKeywordEnrichment } from '../articles';
import { isDatabaseConfigured } from '../config';
import { sendNewArticleAlert } from '../email';
import { enrichNewArticles } from '../keywords';
import { scanDomain } from '../scraper';
import type { ScrapeResponse } from '../scraper/types';

const router = Router();

const scrapeBodySchema = z.object({
  domain: z.string().min(1, 'domain is required'),
});

router.post('/scrape', async (req: Request, res: Response) => {
  const parsed = scrapeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors });
    return;
  }

  if (!isDatabaseConfigured()) {
    res.status(503).json({
      error: 'Database setup required',
      message: 'Configure PGHOST, PGDATABASE, PGUSER, and PGPASSWORD before scanning.',
    });
    return;
  }

  try {
    const result = await scanDomain(parsed.data.domain);
    const newArticles = await persistDiscoveredArticles(result.domain, result.articles);
    const keywordResult = await enrichNewArticles(newArticles);
    let keywordEnrichment = {
      status: keywordResult.status,
      message: keywordResult.message,
    };
    if (newArticles.length > 0) {
      try {
        await persistKeywordEnrichment(result.domain, keywordResult.articles);
      } catch {
        keywordEnrichment = {
          status: 'persistence_failed',
          message: 'Keyword results could not be saved; article discovery remains persisted.',
        };
      }
    }
    const emailDelivery =
      newArticles.length === 0
        ? { status: 'skipped' as const, message: 'No new articles to alert on.' }
        : await sendNewArticleAlert(result.domain, keywordResult.articles);
    const response: ScrapeResponse = {
      ...result,
      articlesDiscovered: result.articles.length,
      newArticlesCount: newArticles.length,
      newArticles: keywordResult.articles,
      keywordEnrichment,
      emailDelivery,
    };
    res.status(200).json(response);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Scan failed';

    const clientErrors = [
      'Invalid domain or URL',
      'Invalid URL',
      'URL scheme not permitted',
      'Only HTTP and HTTPS URLs are permitted',
      'Target resolves to a prohibited address',
      'DNS resolution failed',
    ];

    if (clientErrors.some((e) => message.startsWith(e))) {
      res.status(400).json({ error: message });
      return;
    }

    if (message.includes('timed out') || message.includes('blocked') || message.includes('Network error')) {
      res.status(502).json({ error: message });
      return;
    }

    res.status(500).json({ error: 'Scan failed' });
  }
});

export default router;
