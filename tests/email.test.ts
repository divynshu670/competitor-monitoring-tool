import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sendNewArticleAlert,
  type EmailCredentials,
  type EmailMessageOptions,
  type EmailTransport,
  type EmailTransportOptions,
} from '../src/email';
import type { NewArticle } from '../src/scraper/types';

const article: NewArticle = {
  title: 'Compiler & <runtime> updates',
  url: 'https://example.com/blog/compiler-runtime',
  publishedAt: '2026-10-25T10:00:00.000Z',
  metaDescription: 'Compiler runtime improvements.',
  firstDiscoveredAt: '2026-10-25T10:05:00.000Z',
  targetKeyword: 'compiler runtime',
  estimatedSearchVolume: 260,
};

const credentials: EmailCredentials = {
  user: 'sender@gmail.com',
  appPassword: 'test-app-password',
  to: 'recipient@example.net',
};

function createMockTransport(
  sendMail: (options: EmailMessageOptions) => Promise<{ accepted: Array<string | { address: string }> }>,
) {
  const close = vi.fn();
  const transport: EmailTransport = { sendMail, close };
  const createTransport = vi.fn((_options: EmailTransportOptions) => transport);
  return { createTransport, close, sendMail };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sendNewArticleAlert', () => {
  it('sends a secure Gmail SMTP digest containing article and keyword details', async () => {
    const sendMail = vi.fn(async () => ({ accepted: [credentials.to] }));
    const { createTransport } = createMockTransport(sendMail);

    const result = await sendNewArticleAlert(
      'https://example.com',
      [article],
      credentials,
      createTransport,
    );

    expect(result).toEqual({ status: 'sent', message: null });
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: credentials.user,
        pass: credentials.appPassword,
      },
    });
    expect(sendMail).toHaveBeenCalledOnce();
    const message = sendMail.mock.calls[0][0];
    expect(message.from).toBe(credentials.user);
    expect(message.to).toBe(credentials.to);
    expect(message.subject).toContain('https://example.com');
    expect(message.text).toContain(article.title);
    expect(message.text).toContain(article.url);
    expect(message.text).toContain(article.publishedAt);
    expect(message.text).toContain(article.targetKeyword);
    expect(message.text).toContain('260');
    expect(message.html).toContain('Compiler &amp; &lt;runtime&gt;');
    expect(message.messageId).toMatch(/^<[a-f\d]{64}@contentninja\.local>$/);
  });

  it('skips delivery for an empty new-article list without creating a transport', async () => {
    const { createTransport } = createMockTransport(async () => ({ accepted: [] }));

    const result = await sendNewArticleAlert(
      'https://example.com',
      [],
      credentials,
      createTransport,
    );

    expect(result.status).toBe('skipped');
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('reports missing Gmail configuration as unavailable', async () => {
    const { createTransport } = createMockTransport(async () => ({ accepted: [] }));

    const result = await sendNewArticleAlert(
      'https://example.com',
      [article],
      { user: '', appPassword: '', to: '' },
      createTransport,
    );

    expect(result.status).toBe('unavailable');
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('reports SMTP errors without claiming delivery', async () => {
    const { createTransport } = createMockTransport(async () => {
      throw new Error('SMTP connection failed');
    });

    const result = await sendNewArticleAlert(
      'https://example.com',
      [article],
      credentials,
      createTransport,
    );

    expect(result).toEqual({
      status: 'failed',
      message: 'Email delivery failed; delivery could not be confirmed.',
    });
  });

  it('reports failed when SMTP does not accept the alert recipient', async () => {
    const { createTransport } = createMockTransport(async () => ({ accepted: [] }));

    const result = await sendNewArticleAlert(
      'https://example.com',
      [article],
      credentials,
      createTransport,
    );

    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/did not confirm acceptance/i);
  });

  it('reports timeouts as failed and closes the SMTP transport', async () => {
    vi.useFakeTimers();
    const sendMail = vi.fn(
      () => new Promise<{ accepted: Array<string | { address: string }> }>(() => {}),
    );
    const { createTransport, close } = createMockTransport(sendMail);

    const resultPromise = sendNewArticleAlert(
      'https://example.com',
      [article],
      credentials,
      createTransport,
    );
    const expectation = expect(resultPromise).resolves.toEqual({
      status: 'failed',
      message: 'Email delivery timed out; delivery could not be confirmed.',
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await expectation;
    expect(close).toHaveBeenCalled();
  });
});
