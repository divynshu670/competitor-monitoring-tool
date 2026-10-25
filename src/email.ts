import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { config } from './config';
import type { EmailDeliveryStatus, NewArticle } from './scraper/types';

const REQUEST_TIMEOUT_MS = 10_000;

export interface EmailCredentials {
  user: string;
  appPassword: string;
  to: string;
}

export interface EmailDeliveryResult {
  status: EmailDeliveryStatus;
  message: string | null;
}

export interface EmailTransportOptions {
  host: 'smtp.gmail.com';
  port: 465;
  secure: true;
  auth: {
    user: string;
    pass: string;
  };
}

export interface EmailMessageOptions {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
}

export interface EmailTransport {
  sendMail(options: EmailMessageOptions): Promise<{
    accepted: Array<string | { address: string }>;
  }>;
  close(): void;
}

export type EmailTransportFactory = (options: EmailTransportOptions) => EmailTransport;

const createGmailTransport: EmailTransportFactory = (options) => nodemailer.createTransport(options);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildMessage(
  competitor: string,
  articles: NewArticle[],
): { subject: string; text: string; html: string } {
  const lines = articles.map((article) => {
    const details = [
      `Title: ${article.title}`,
      `URL: ${article.url}`,
      ...(article.publishedAt ? [`Published: ${article.publishedAt}`] : []),
      ...(article.targetKeyword ? [`Target keyword: ${article.targetKeyword}`] : []),
      ...(article.estimatedSearchVolume !== null
        ? [`Estimated monthly search volume: ${article.estimatedSearchVolume}`]
        : []),
    ];
    return details.join('\n');
  });
  const heading = `New competitor articles: ${competitor}`;
  const text = `${heading}\n\n${lines.join('\n\n')}`;
  const htmlArticles = articles
    .map((article) => {
      const fields = [
        `<p><strong>Title:</strong> ${escapeHtml(article.title)}</p>`,
        `<p><strong>URL:</strong> <a href="${escapeHtml(article.url)}">${escapeHtml(article.url)}</a></p>`,
        ...(article.publishedAt ? [`<p><strong>Published:</strong> ${escapeHtml(article.publishedAt)}</p>`] : []),
        ...(article.targetKeyword
          ? [`<p><strong>Target keyword:</strong> ${escapeHtml(article.targetKeyword)}</p>`]
          : []),
        ...(article.estimatedSearchVolume !== null
          ? [`<p><strong>Estimated monthly search volume:</strong> ${article.estimatedSearchVolume}</p>`]
          : []),
      ];
      return `<article>${fields.join('')}</article>`;
    })
    .join('');

  return {
    subject: `${articles.length} new article${articles.length === 1 ? '' : 's'} from ${competitor}`,
    text,
    html: `<h1>${escapeHtml(heading)}</h1>${htmlArticles}`,
  };
}

export async function sendNewArticleAlert(
  competitor: string,
  articles: NewArticle[],
  credentials: EmailCredentials = {
    user: config.GMAIL_USER,
    appPassword: config.GMAIL_APP_PASSWORD,
    to: config.ALERT_TO_EMAIL,
  },
  createTransport: EmailTransportFactory = createGmailTransport,
): Promise<EmailDeliveryResult> {
  if (articles.length === 0) return { status: 'skipped', message: 'No new articles to alert on.' };
  if (!credentials.user || !credentials.appPassword || !credentials.to) {
    return { status: 'unavailable', message: 'Email delivery is not configured.' };
  }

  const message = buildMessage(competitor, articles);
  const idempotencyKey = createHash('sha256')
    .update(`${competitor}\n${articles.map((article) => article.url).sort().join('\n')}`)
    .digest('hex');
  const transporter = createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: credentials.user,
      pass: credentials.appPassword,
    },
  });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error('Email delivery timed out.'));
        transporter.close();
      }, REQUEST_TIMEOUT_MS);
    });
    const info = await Promise.race([
      transporter.sendMail({
        from: credentials.user,
        to: credentials.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: `<${idempotencyKey}@contentninja.local>`,
      }),
      timeout,
    ]);
    const accepted = info.accepted.some((recipient) =>
      (typeof recipient === 'string' ? recipient : recipient.address).toLowerCase() ===
      credentials.to.toLowerCase(),
    );
    if (!accepted) {
      return { status: 'failed', message: 'SMTP server did not confirm acceptance of the alert recipient.' };
    }

    return { status: 'sent', message: null };
  } catch {
    return timedOut
      ? { status: 'failed', message: 'Email delivery timed out; delivery could not be confirmed.' }
      : { status: 'failed', message: 'Email delivery failed; delivery could not be confirmed.' };
  } finally {
    if (timer) clearTimeout(timer);
    transporter.close();
  }
}
