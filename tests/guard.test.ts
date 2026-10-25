import { describe, it, expect, vi, afterEach } from 'vitest';
import dns from 'dns/promises';
import { assertSafeUrl } from '../src/scraper/guard';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockDns(addresses: string[]) {
  vi.spyOn(dns, 'lookup').mockResolvedValue(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as Awaited<ReturnType<typeof dns.lookup>>,
  );
}

describe('assertSafeUrl - private and loopback rejection', () => {
  it('rejects http://localhost/', async () => {
    mockDns(['127.0.0.1']);
    await expect(assertSafeUrl('http://localhost/')).rejects.toThrow('prohibited');
  });

  it('rejects http://127.0.0.1/', async () => {
    mockDns(['127.0.0.1']);
    await expect(assertSafeUrl('http://127.0.0.1/')).rejects.toThrow('prohibited');
  });

  it('rejects http://0.0.0.0/', async () => {
    mockDns(['0.0.0.0']);
    await expect(assertSafeUrl('http://0.0.0.0/')).rejects.toThrow('prohibited');
  });

  it('rejects http://[::1]/', async () => {
    mockDns(['::1']);
    await expect(assertSafeUrl('http://[::1]/')).rejects.toThrow('prohibited');
  });

  it('rejects http://[::] (unspecified IPv6)', async () => {
    mockDns(['::']);
    await expect(assertSafeUrl('http://[::]/')).rejects.toThrow('prohibited');
  });

  it('rejects a URL that resolves to a private 10.x address', async () => {
    mockDns(['10.0.0.1']);
    await expect(assertSafeUrl('http://internal.example.com/')).rejects.toThrow('prohibited');
  });

  it('rejects a URL that resolves to a private 192.168.x address', async () => {
    mockDns(['192.168.1.1']);
    await expect(assertSafeUrl('http://home.example.com/')).rejects.toThrow('prohibited');
  });

  it('rejects a URL that resolves to a link-local address', async () => {
    mockDns(['169.254.10.1']);
    await expect(assertSafeUrl('http://link.example.com/')).rejects.toThrow('prohibited');
  });

  it('rejects a URL that resolves to a private IPv6 address', async () => {
    mockDns(['fd12:3456:789a::1']);
    await expect(assertSafeUrl('http://private-v6.example.com/')).rejects.toThrow('prohibited');
  });

  it('rejects a URL that resolves to an IPv4-mapped private IPv6 address', async () => {
    mockDns(['::ffff:192.168.1.10']);
    await expect(assertSafeUrl('http://mapped-v6.example.com/')).rejects.toThrow('prohibited');
  });

  it('rejects a host when any resolved address is prohibited', async () => {
    mockDns(['93.184.216.34', '10.0.0.1']);
    await expect(assertSafeUrl('http://mixed.example.com/')).rejects.toThrow('prohibited');
  });

  it('rejects a hostname with no DNS answers', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([]);
    await expect(assertSafeUrl('http://empty.example.com/')).rejects.toThrow('DNS resolution failed');
  });

  it('rejects file:// scheme', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow('scheme not permitted');
  });

  it('rejects ftp:// scheme', async () => {
    await expect(assertSafeUrl('ftp://ftp.example.com/')).rejects.toThrow('scheme not permitted');
  });

  it('throws on DNS resolution failure', async () => {
    vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertSafeUrl('http://does-not-exist.invalid/')).rejects.toThrow('DNS resolution failed');
  });
});

describe('assertSafeUrl - valid public URL acceptance', () => {
  it('accepts https://example.com/', async () => {
    mockDns(['93.184.216.34']);
    await expect(assertSafeUrl('https://example.com/')).resolves.toBeUndefined();
  });

  it('accepts http://example.com/', async () => {
    mockDns(['93.184.216.34']);
    await expect(assertSafeUrl('http://example.com/')).resolves.toBeUndefined();
  });

  it('accepts a public IPv6 address', async () => {
    await expect(assertSafeUrl('http://[2606:4700:4700::1111]/')).resolves.toBeUndefined();
  });
});
