import { parse as parseHTML } from 'node-html-parser';
import TurndownService from 'turndown';
import Parser from 'rss-parser';
import type { ToolHandler } from './types.js';

function parseInput(raw: string): any {
  try { return JSON.parse(raw); } catch { return raw.trim(); }
}

async function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractUrl(raw: string): string {
  const input = parseInput(raw);
  return typeof input === 'string' ? input : input.url;
}

function isBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (['localhost', '0.0.0.0'].includes(hostname) || hostname.endsWith('.local')) return true;
    if (hostname === '::1' || hostname.startsWith('fe80:') || hostname.startsWith('fc') || hostname.startsWith('fd')) return true;
    const parts = hostname.split('.').map(Number);
    if (parts.length === 4 && parts.every(n => !isNaN(n))) {
      if (parts[0] === 127) return true;
      if (parts[0] === 10) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
      if (parts[0] === 169 && parts[1] === 254) return true;
      if (parts[0] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function safeFetch(url: string, opts: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  if (isBlockedUrl(url)) throw new Error('URL targets a private/reserved IP range');
  return fetchWithTimeout(url, opts, timeoutMs);
}

// 1. Fetch Clean
const fetchClean: ToolHandler = async (raw) => {
  const url = extractUrl(raw);
  if (!url) return JSON.stringify({ error: 'url required' });

  try {
    const res = await safeFetch(url);
    const html = await res.text();
    const root = parseHTML(html);

    root.querySelectorAll('script, style, nav, footer, header, iframe, noscript').forEach(el => el.remove());
    let text = root.textContent || '';
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > 50_000) text = text.slice(0, 50_000);

    return JSON.stringify({ url, text, length: text.length });
  } catch (e: any) {
    return JSON.stringify({ url, error: e.name === 'AbortError' ? 'timeout' : e.message });
  }
};

// 2. Fetch Markdown
const fetchMarkdown: ToolHandler = async (raw) => {
  const url = extractUrl(raw);
  if (!url) return JSON.stringify({ error: 'url required' });

  try {
    const res = await safeFetch(url);
    const html = await res.text();
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    let markdown = turndown.turndown(html);
    if (markdown.length > 50_000) markdown = markdown.slice(0, 50_000);

    return JSON.stringify({ url, markdown, length: markdown.length });
  } catch (e: any) {
    return JSON.stringify({ url, error: e.name === 'AbortError' ? 'timeout' : e.message });
  }
};

// 3. Fetch HTML
const fetchHtml: ToolHandler = async (raw) => {
  const url = extractUrl(raw);
  if (!url) return JSON.stringify({ error: 'url required' });

  try {
    const res = await safeFetch(url);
    let html = await res.text();
    if (html.length > 100_000) html = html.slice(0, 100_000);

    return JSON.stringify({
      url,
      html,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
    });
  } catch (e: any) {
    return JSON.stringify({ url, error: e.name === 'AbortError' ? 'timeout' : e.message });
  }
};

// 4. URL Meta
const urlMeta: ToolHandler = async (raw) => {
  const url = extractUrl(raw);
  if (!url) return JSON.stringify({ error: 'url required' });

  try {
    const res = await safeFetch(url);
    const html = await res.text();
    const root = parseHTML(html);

    const title = root.querySelector('title')?.textContent?.trim() || '';
    const description = root.querySelector('meta[name="description"]')?.getAttribute('content') || '';

    const og: Record<string, string> = {};
    for (const tag of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) {
      const el = root.querySelector(`meta[property="${tag}"]`);
      if (el) og[tag.replace('og:', '')] = el.getAttribute('content') || '';
    }

    const canonical = root.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';

    return JSON.stringify({ url, title, description, og, canonical });
  } catch (e: any) {
    return JSON.stringify({ url, error: e.name === 'AbortError' ? 'timeout' : e.message });
  }
};

// 5. URL Links
const urlLinks: ToolHandler = async (raw) => {
  const url = extractUrl(raw);
  if (!url) return JSON.stringify({ error: 'url required' });

  try {
    const res = await safeFetch(url);
    const html = await res.text();
    const root = parseHTML(html);

    const links: string[] = [];
    for (const a of root.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!href) continue;
      try {
        links.push(new URL(href, url).href);
      } catch {
        // skip malformed URLs
      }
    }

    const unique = [...new Set(links)];
    return JSON.stringify({ url, links: unique, count: unique.length });
  } catch (e: any) {
    return JSON.stringify({ url, error: e.name === 'AbortError' ? 'timeout' : e.message });
  }
};

// 6. RSS Parse
const rssParse: ToolHandler = async (raw) => {
  const url = extractUrl(raw);
  if (!url) return JSON.stringify({ error: 'url required' });

  try {
    const parser = new Parser();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let feed;
    try {
      if (isBlockedUrl(url)) throw new Error('URL targets a private/reserved IP range');
      const res = await fetch(url, { signal: controller.signal });
      const xml = await res.text();
      feed = await parser.parseString(xml);
    } finally {
      clearTimeout(timer);
    }

    const items = (feed.items || []).slice(0, 20).map(item => ({
      title: item.title || '',
      link: item.link || '',
      pubDate: item.pubDate || '',
      content: (item.contentSnippet || item.content || '').slice(0, 500),
    }));

    return JSON.stringify({ title: feed.title || '', items, count: items.length });
  } catch (e: any) {
    return JSON.stringify({ url, error: e.name === 'AbortError' ? 'timeout' : e.message });
  }
};

// 7. Sitemap Parse
const sitemapParse: ToolHandler = async (raw) => {
  const url = extractUrl(raw);
  if (!url) return JSON.stringify({ error: 'url required' });

  try {
    const res = await safeFetch(url);
    const xml = await res.text();
    const root = parseHTML(xml);

    const urls: string[] = [];
    for (const loc of root.querySelectorAll('loc')) {
      const text = loc.textContent?.trim();
      if (text) urls.push(text);
      if (urls.length >= 500) break;
    }

    return JSON.stringify({ url, urls, count: urls.length });
  } catch (e: any) {
    return JSON.stringify({ url, error: e.name === 'AbortError' ? 'timeout' : e.message });
  }
};

// 8. Robots.txt
const robotsTxt: ToolHandler = async (raw) => {
  let input = extractUrl(raw);
  if (!input) return JSON.stringify({ error: 'domain or url required' });

  let robotsUrl: string;
  try {
    const parsed = new URL(input.startsWith('http') ? input : `https://${input}`);
    robotsUrl = `${parsed.origin}/robots.txt`;
  } catch {
    robotsUrl = `https://${input}/robots.txt`;
  }

  try {
    const res = await safeFetch(robotsUrl);
    const content = await res.text();

    const sitemaps: string[] = [];
    const rules: { userAgent: string; allow: string[]; disallow: string[] }[] = [];
    let currentAgent: { userAgent: string; allow: string[]; disallow: string[] } | null = null;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const [directive, ...rest] = trimmed.split(':');
      const value = rest.join(':').trim();
      const lower = directive.toLowerCase();

      if (lower === 'user-agent') {
        currentAgent = { userAgent: value, allow: [], disallow: [] };
        rules.push(currentAgent);
      } else if (lower === 'allow' && currentAgent) {
        currentAgent.allow.push(value);
      } else if (lower === 'disallow' && currentAgent) {
        currentAgent.disallow.push(value);
      } else if (lower === 'sitemap') {
        sitemaps.push(value);
      }
    }

    return JSON.stringify({ url: robotsUrl, content, sitemaps, rules });
  } catch (e: any) {
    return JSON.stringify({ url: robotsUrl, error: e.name === 'AbortError' ? 'timeout' : e.message });
  }
};

// 9. URL Expand
const urlExpand: ToolHandler = async (raw) => {
  const shortUrl = extractUrl(raw);
  if (!shortUrl) return JSON.stringify({ error: 'url required' });

  const hops: string[] = [shortUrl];
  let current = shortUrl;

  try {
    for (let i = 0; i < 10; i++) {
      const res = await safeFetch(current, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (!location || res.status < 300 || res.status >= 400) break;

      const next = new URL(location, current).href;
      hops.push(next);
      current = next;
    }

    return JSON.stringify({ shortUrl, expandedUrl: current, hops });
  } catch (e: any) {
    return JSON.stringify({ shortUrl, error: e.name === 'AbortError' ? 'timeout' : e.message, hops });
  }
};

// 10. Webhook Send
const webhookSend: ToolHandler = async (raw) => {
  const input = parseInput(raw);
  if (typeof input !== 'object' || !input.url) {
    return JSON.stringify({ error: 'JSON input required: {"url":"...","method":"POST","headers":{},"body":{}}' });
  }

  const { url, method = 'POST', headers = {}, body } = input;

  try {
    const res = await safeFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });

    let responseBody = await res.text();
    if (responseBody.length > 10_000) responseBody = responseBody.slice(0, 10_000);

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => { responseHeaders[key] = value; });

    return JSON.stringify({ status: res.status, headers: responseHeaders, body: responseBody });
  } catch (e: any) {
    return JSON.stringify({ url, error: e.name === 'AbortError' ? 'timeout' : e.message });
  }
};

// 11. HTTP Probe
const httpProbe: ToolHandler = async (raw) => {
  const url = extractUrl(raw);
  if (!url) return JSON.stringify({ error: 'url required' });

  const redirects: string[] = [];
  let current = url;

  try {
    const start = Date.now();

    for (let i = 0; i < 10; i++) {
      const res = await safeFetch(current, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (!location || res.status < 300 || res.status >= 400) {
        const latencyMs = Date.now() - start;
        return JSON.stringify({ url, status: res.status, latencyMs, redirects, finalUrl: current });
      }
      redirects.push(current);
      current = new URL(location, current).href;
    }

    const finalRes = await safeFetch(current);
    const latencyMs = Date.now() - start;
    return JSON.stringify({ url, status: finalRes.status, latencyMs, redirects, finalUrl: current });
  } catch (e: any) {
    return JSON.stringify({ url, error: e.name === 'AbortError' ? 'timeout' : e.message, redirects });
  }
};

// 12. HTTP Headers
const httpHeaders: ToolHandler = async (raw) => {
  const url = extractUrl(raw);
  if (!url) return JSON.stringify({ error: 'url required' });

  try {
    const res = await safeFetch(url, { method: 'HEAD' });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => { headers[key] = value; });

    return JSON.stringify({ url, status: res.status, headers });
  } catch (e: any) {
    return JSON.stringify({ url, error: e.name === 'AbortError' ? 'timeout' : e.message });
  }
};

export const toolRegistry = new Map<string, ToolHandler>([
  ['webtools/fetch-clean', fetchClean],
  ['webtools/fetch-markdown', fetchMarkdown],
  ['webtools/fetch-html', fetchHtml],
  ['webtools/url-meta', urlMeta],
  ['webtools/url-links', urlLinks],
  ['webtools/rss-parse', rssParse],
  ['webtools/sitemap-parse', sitemapParse],
  ['webtools/robots-txt', robotsTxt],
  ['webtools/url-expand', urlExpand],
  ['webtools/webhook-send', webhookSend],
  ['webtools/http-probe', httpProbe],
  ['webtools/http-headers', httpHeaders],
]);
