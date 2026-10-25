import dns from 'dns/promises';
import { isIP } from 'node:net';

const BLOCKED_SCHEMES = new Set(['file:', 'ftp:', 'data:', 'javascript:', 'vbscript:']);

function isProhibitedIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  const [first, second, third] = octets;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseIpv6(address: string): number[] | null {
  let input = address.toLowerCase();
  const ipv4Suffix = input.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Suffix) {
    if (isIP(ipv4Suffix[1]) !== 4) return null;
    const octets = ipv4Suffix[1].split('.').map(Number);
    const ipv4Groups = [
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16),
    ];
    input = `${input.slice(0, -ipv4Suffix[1].length)}${ipv4Groups.join(':')}`;
  }

  const halves = input.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (!part) return [];
    const groups = part.split(':');
    if (groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return null;
    return groups.map((group) => Number.parseInt(group, 16));
  };

  const left = parseGroups(halves[0]);
  const right = parseGroups(halves[1] ?? '');
  if (!left || !right) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 1) return null;
  return [...left, ...Array<number>(zeroCount).fill(0), ...right];
}

function isProhibitedIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  if (!groups) return true;

  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xff00) === 0xff00) return true;
  if ((groups[0] & 0xfe00) === 0xfec0) return true;

  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const mappedIpv4 = [
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ].join('.');
    return isProhibitedIpv4(mappedIpv4);
  }

  return groups.slice(0, 6).every((group) => group === 0);
}

function isProhibitedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isProhibitedIpv4(address);
  if (family === 6) return isProhibitedIpv6(address);
  return true;
}

export async function assertSafeUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (BLOCKED_SCHEMES.has(parsed.protocol)) {
    throw new Error('URL scheme not permitted');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs are permitted');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL credentials are not permitted');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    (isIP(hostname) !== 0 && isProhibitedAddress(hostname))
  ) {
    throw new Error('Target resolves to a prohibited address');
  }

  if (isIP(hostname) !== 0) return;

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error('DNS resolution failed');
  }

  if (addresses.length === 0 || addresses.some(({ address }) => isIP(address) === 0)) {
    throw new Error('DNS resolution failed');
  }
  if (addresses.some(({ address }) => isProhibitedAddress(address))) {
    throw new Error('Target resolves to a prohibited address');
  }
}
