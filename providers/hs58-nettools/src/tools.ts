import * as dns from 'dns';
import * as net from 'net';
import * as tls from 'tls';
import * as crypto from 'crypto';
import type { ToolHandler } from './types.js';

function parseInput(raw: string): any {
  try { return JSON.parse(raw); } catch { return raw.trim(); }
}

async function fetchWithTimeout(url: string, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function tcpConnect(host: string, port: number, timeoutMs = 5000): Promise<{ open: boolean; latencyMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      const latencyMs = Date.now() - start;
      socket.destroy();
      resolve({ open: true, latencyMs });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ open: false, latencyMs: timeoutMs }); });
    socket.on('error', () => { socket.destroy(); resolve({ open: false, latencyMs: Date.now() - start }); });
  });
}

// 1. DNS Lookup
const dnsLookup: ToolHandler = async (raw) => {
  const input = parseInput(raw);
  const domain = typeof input === 'string' ? input : input.domain;
  const types = (typeof input === 'object' && input.types) || ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME'];
  if (!domain) return JSON.stringify({ error: 'domain required' });

  const resolver = new dns.promises.Resolver();
  const results: Record<string, any> = { domain };

  for (const type of types) {
    try {
      results[type] = await resolver.resolve(domain, type);
    } catch (e: any) {
      results[type] = e.code === 'ENODATA' ? [] : { error: e.code };
    }
  }
  return JSON.stringify(results);
};

// 2. DNS Propagation
const dnsPropagation: ToolHandler = async (raw) => {
  const input = parseInput(raw);
  const domain = typeof input === 'string' ? input : input.domain;
  const type = (typeof input === 'object' && input.type) || 'A';
  if (!domain) return JSON.stringify({ error: 'domain required' });

  const servers: Record<string, string> = {
    google: '8.8.8.8',
    cloudflare: '1.1.1.1',
    quad9: '9.9.9.9',
    opendns: '208.67.222.222',
  };

  const results: Record<string, any> = { domain, type };
  for (const [name, ip] of Object.entries(servers)) {
    const resolver = new dns.promises.Resolver();
    resolver.setServers([ip]);
    try {
      results[name] = await resolver.resolve(domain, type);
    } catch (e: any) {
      results[name] = { error: e.code };
    }
  }
  return JSON.stringify(results);
};

// 3. Reverse DNS
const reverseDns: ToolHandler = async (raw) => {
  const ip = (typeof parseInput(raw) === 'string') ? parseInput(raw) : parseInput(raw).ip;
  if (!ip) return JSON.stringify({ error: 'ip required' });
  try {
    const hostnames = await dns.promises.reverse(ip);
    return JSON.stringify({ ip, hostnames });
  } catch (e: any) {
    return JSON.stringify({ ip, error: e.code });
  }
};

// 4. SSL Check
const sslCheck: ToolHandler = async (raw) => {
  const input = parseInput(raw);
  const host = typeof input === 'string' ? input : input.host || input.domain;
  const port = (typeof input === 'object' && input.port) || 443;
  if (!host) return JSON.stringify({ error: 'host required' });

  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      socket.destroy();

      const validFrom = new Date(cert.valid_from);
      const validTo = new Date(cert.valid_to);
      const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86400000);

      resolve(JSON.stringify({
        host, port,
        subject: cert.subject,
        issuer: cert.issuer,
        validFrom: validFrom.toISOString(),
        validTo: validTo.toISOString(),
        daysLeft,
        serialNumber: cert.serialNumber,
        fingerprint: cert.fingerprint256,
        sans: cert.subjectaltname?.split(', ') ?? [],
        authorized,
      }));
    });
    socket.setTimeout(5000);
    socket.on('timeout', () => { socket.destroy(); resolve(JSON.stringify({ host, error: 'timeout' })); });
    socket.on('error', (e) => { socket.destroy(); resolve(JSON.stringify({ host, error: e.message })); });
  });
};

// 5. WHOIS
const whoisLookup: ToolHandler = async (raw) => {
  const input = parseInput(raw);
  const domain = typeof input === 'string' ? input : input.domain;
  if (!domain) return JSON.stringify({ error: 'domain required' });

  try {
    const whois = await import('whois-json');
    const result = await whois.default(domain);
    return JSON.stringify({ domain, ...result });
  } catch (e: any) {
    return JSON.stringify({ domain, error: e.message });
  }
};

// 6. Port Check
const portCheck: ToolHandler = async (raw) => {
  const input = parseInput(raw);
  let host: string, port: number;
  if (typeof input === 'string') {
    const parts = input.split(':');
    host = parts[0];
    port = parseInt(parts[1] || '80');
  } else {
    host = input.host;
    port = input.port || 80;
  }
  if (!host) return JSON.stringify({ error: 'host required (e.g. "example.com:443")' });

  const result = await tcpConnect(host, port);
  return JSON.stringify({ host, port, ...result });
};

// 7. Ping (TCP latency)
const ping: ToolHandler = async (raw) => {
  const input = parseInput(raw);
  const host = typeof input === 'string' ? input : input.host;
  const port = (typeof input === 'object' && input.port) || 443;
  const count = Math.min((typeof input === 'object' && input.count) || 3, 5);
  if (!host) return JSON.stringify({ error: 'host required' });

  const latencies: number[] = [];
  for (let i = 0; i < count; i++) {
    const result = await tcpConnect(host, port, 5000);
    if (result.open) latencies.push(result.latencyMs);
  }

  if (latencies.length === 0) return JSON.stringify({ host, port, error: 'all pings failed' });

  return JSON.stringify({
    host, port,
    count: latencies.length,
    min: Math.min(...latencies),
    max: Math.max(...latencies),
    avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    latencies,
  });
};

// 8. MX Check
const mxCheck: ToolHandler = async (raw) => {
  const input = parseInput(raw);
  const domain = typeof input === 'string' ? input : input.domain;
  if (!domain) return JSON.stringify({ error: 'domain required' });

  const resolver = new dns.promises.Resolver();
  try {
    const records = await resolver.resolveMx(domain);
    records.sort((a, b) => a.priority - b.priority);

    const results = [];
    for (const mx of records.slice(0, 5)) {
      let banner = '';
      try {
        const { open } = await tcpConnect(mx.exchange, 25, 3000);
        banner = open ? 'reachable' : 'unreachable';
      } catch {
        banner = 'error';
      }
      results.push({ priority: mx.priority, exchange: mx.exchange, smtp: banner });
    }

    return JSON.stringify({ domain, mx: results });
  } catch (e: any) {
    return JSON.stringify({ domain, error: e.code });
  }
};

// 9. IP Info
const ipInfo: ToolHandler = (raw) => {
  const input = parseInput(raw);
  const ip = typeof input === 'string' ? input : input.ip;
  if (!ip) return JSON.stringify({ error: 'ip required' });

  const isV4 = net.isIPv4(ip);
  const isV6 = net.isIPv6(ip);
  if (!isV4 && !isV6) return JSON.stringify({ ip, valid: false });

  let isPrivate = false;
  if (isV4) {
    isPrivate = ip.startsWith('10.') ||
      ip.startsWith('172.16.') || ip.startsWith('172.17.') || ip.startsWith('172.18.') ||
      ip.startsWith('172.19.') || ip.startsWith('172.2') || ip.startsWith('172.30.') || ip.startsWith('172.31.') ||
      ip.startsWith('192.168.') || ip.startsWith('127.') || ip === '0.0.0.0';
  } else {
    isPrivate = ip.startsWith('::1') || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd');
  }

  return JSON.stringify({ ip, valid: true, version: isV4 ? 4 : 6, isPrivate, isPublic: !isPrivate });
};

// 10. IP Geo
const ipGeo: ToolHandler = async (raw) => {
  const input = parseInput(raw);
  const ip = typeof input === 'string' ? input : input.ip;
  if (!ip) return JSON.stringify({ error: 'ip required' });

  try {
    const res = await fetchWithTimeout(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as`);
    const data = await res.json();
    return JSON.stringify(data);
  } catch (e: any) {
    return JSON.stringify({ ip, error: e.name === 'AbortError' ? 'timeout' : e.message });
  }
};

// 11. My IP
const myIp: ToolHandler = async () => {
  try {
    const res = await fetchWithTimeout('https://api.ipify.org?format=json');
    const data = await res.json();
    return JSON.stringify(data);
  } catch (e: any) {
    return JSON.stringify({ error: e.name === 'AbortError' ? 'timeout' : e.message });
  }
};

// 12. Cert Decode
const certDecode: ToolHandler = (raw) => {
  const input = parseInput(raw);
  const pem = typeof input === 'string' ? input : input.pem || input.cert;
  if (!pem || !pem.includes('BEGIN CERTIFICATE')) {
    return JSON.stringify({ error: 'PEM certificate required (must include BEGIN CERTIFICATE)' });
  }

  try {
    const cert = new crypto.X509Certificate(pem);
    return JSON.stringify({
      subject: cert.subject,
      issuer: cert.issuer,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      serialNumber: cert.serialNumber,
      fingerprint256: cert.fingerprint256,
      subjectAltName: cert.subjectAltName,
      keyUsage: cert.keyUsage,
      isCA: cert.ca,
    });
  } catch (e: any) {
    return JSON.stringify({ error: e.message });
  }
};

export const toolRegistry = new Map<string, ToolHandler>([
  ['nettools/dns-lookup', dnsLookup],
  ['nettools/dns-propagation', dnsPropagation],
  ['nettools/reverse-dns', reverseDns],
  ['nettools/ssl-check', sslCheck],
  ['nettools/whois', whoisLookup],
  ['nettools/port-check', portCheck],
  ['nettools/ping', ping],
  ['nettools/mx-check', mxCheck],
  ['nettools/ip-info', ipInfo],
  ['nettools/ip-geo', ipGeo],
  ['nettools/my-ip', myIp],
  ['nettools/cert-decode', certDecode],
]);
