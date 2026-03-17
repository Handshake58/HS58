import { CronExpressionParser } from 'cron-parser';
import UAParser from 'ua-parser-js';
import * as semverPkg from 'semver';
import type { ToolHandler } from './types.js';

async function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function tryParseJSON(input: string): any {
  try { return JSON.parse(input); } catch { return null; }
}

// ---------- 1. livedata/time-now ----------
const timeNow: ToolHandler = (input) => {
  const parsed = tryParseJSON(input);
  const tz = parsed?.timezone ?? (input.trim() || 'UTC');

  const now = new Date();
  let local: string;
  try {
    local = now.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
  } catch {
    return JSON.stringify({ error: `Invalid timezone: ${tz}` });
  }

  return JSON.stringify({
    utc: now.toISOString(),
    local,
    timezone: tz,
    unix: Math.floor(now.getTime() / 1000),
  });
};

// ---------- 2. livedata/time-between ----------
const timeBetween: ToolHandler = (input) => {
  const parsed = tryParseJSON(input);
  if (!parsed?.from || !parsed?.to) {
    return JSON.stringify({ error: 'Input must be {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}' });
  }

  const from = new Date(parsed.from);
  const to = new Date(parsed.to);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    return JSON.stringify({ error: 'Invalid date format' });
  }

  const diffMs = Math.abs(to.getTime() - from.getTime());
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  return JSON.stringify({ from: parsed.from, to: parsed.to, days, hours, minutes, seconds });
};

// ---------- 3. livedata/npm-info ----------
const npmInfo: ToolHandler = async (input) => {
  const pkg = (tryParseJSON(input)?.name ?? input).trim();
  if (!pkg) return JSON.stringify({ error: 'Package name required' });

  const [metaRes, dlRes] = await Promise.all([
    fetchWithTimeout(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`),
    fetchWithTimeout(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`),
  ]);

  if (!metaRes.ok) return JSON.stringify({ error: `npm registry returned ${metaRes.status}` });
  const meta = await metaRes.json() as any;
  const latest = meta['dist-tags']?.latest;
  const ver = latest ? meta.versions?.[latest] : undefined;

  let downloads: number | null = null;
  if (dlRes.ok) {
    const dlData = await dlRes.json() as any;
    downloads = dlData.downloads ?? null;
  }

  return JSON.stringify({
    name: meta.name,
    version: latest ?? 'unknown',
    description: ver?.description ?? meta.description ?? '',
    license: ver?.license ?? meta.license ?? '',
    homepage: meta.homepage ?? '',
    repository: typeof meta.repository === 'string' ? meta.repository : meta.repository?.url ?? '',
    downloads,
  });
};

// ---------- 4. livedata/pypi-info ----------
const pypiInfo: ToolHandler = async (input) => {
  const pkg = (tryParseJSON(input)?.name ?? input).trim();
  if (!pkg) return JSON.stringify({ error: 'Package name required' });

  const res = await fetchWithTimeout(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, {
    headers: { 'User-Agent': 'HS58-Livedata/0.1 (DRAIN provider)' },
  });
  if (!res.ok) return JSON.stringify({ error: `PyPI returned ${res.status}` });
  const data = await res.json() as any;
  const info = data.info;

  return JSON.stringify({
    name: info.name,
    version: info.version,
    summary: info.summary ?? '',
    license: info.license ?? '',
    homePage: info.home_page ?? info.project_url ?? '',
    requires_python: info.requires_python ?? '',
  });
};

// ---------- 5. livedata/weather (Open-Meteo, 10K/day, no key) ----------
const weather: ToolHandler = async (input) => {
  const parsed = tryParseJSON(input);
  if (!parsed?.lat || !parsed?.lon) {
    return JSON.stringify({ error: 'Input must be {"lat":52.52,"lon":13.41} (coordinates required)' });
  }

  const { lat, lon } = parsed;
  const res = await fetchWithTimeout(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=3`,
  );
  if (!res.ok) return JSON.stringify({ error: `Open-Meteo returned ${res.status}` });
  const data = await res.json() as any;

  return JSON.stringify({
    latitude: data.latitude,
    longitude: data.longitude,
    timezone: data.timezone,
    current: data.current,
    daily: data.daily,
  });
};

// ---------- 6. livedata/country-info (REST Countries, 2K/h, no key) ----------
const countryInfo: ToolHandler = async (input) => {
  const name = (tryParseJSON(input)?.name ?? input).trim();
  if (!name) return JSON.stringify({ error: 'Country name required' });

  const res = await fetchWithTimeout(
    `https://restcountries.com/v3.1/name/${encodeURIComponent(name)}?fields=name,capital,population,region,subregion,languages,currencies,timezones,borders,flags,cca2`,
  );
  if (!res.ok) return JSON.stringify({ error: `REST Countries returned ${res.status}` });
  const data = await res.json() as any[];

  const c = data[0];
  return JSON.stringify({
    name: c.name?.common ?? '',
    officialName: c.name?.official ?? '',
    code: c.cca2 ?? '',
    capital: c.capital ?? [],
    population: c.population ?? 0,
    region: c.region ?? '',
    subregion: c.subregion ?? '',
    languages: c.languages ?? {},
    currencies: c.currencies ?? {},
    timezones: c.timezones ?? [],
    borders: c.borders ?? [],
    flag: c.flags?.svg ?? '',
  });
};

// ---------- 7. livedata/word-define (Free Dictionary, no hard limit) ----------
const wordDefine: ToolHandler = async (input) => {
  const word = (tryParseJSON(input)?.word ?? input).trim();
  if (!word) return JSON.stringify({ error: 'Word required' });

  const res = await fetchWithTimeout(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
  );
  if (!res.ok) return JSON.stringify({ error: res.status === 404 ? `Word "${word}" not found` : `Dictionary API returned ${res.status}` });
  const data = await res.json() as any[];

  const entry = data[0];
  const meanings = (entry.meanings ?? []).slice(0, 3).map((m: any) => ({
    partOfSpeech: m.partOfSpeech,
    definitions: (m.definitions ?? []).slice(0, 3).map((d: any) => ({
      definition: d.definition,
      example: d.example ?? '',
    })),
    synonyms: (m.synonyms ?? []).slice(0, 5),
    antonyms: (m.antonyms ?? []).slice(0, 5),
  }));

  return JSON.stringify({
    word: entry.word,
    phonetic: entry.phonetic ?? '',
    meanings,
  });
};

// ---------- 8. livedata/semver (local, unlimited) ----------
const semver: ToolHandler = (input) => {
  const parsed = tryParseJSON(input);
  if (!parsed) {
    const v = semverPkg.valid(input.trim());
    if (v) return JSON.stringify({ valid: true, version: v, major: semverPkg.major(v), minor: semverPkg.minor(v), patch: semverPkg.patch(v) });
    return JSON.stringify({ valid: false, error: 'Invalid semver. Use JSON for advanced ops: {"action":"satisfies","version":"1.2.3","range":"^1.0.0"}' });
  }

  const action = parsed.action ?? 'validate';

  if (action === 'validate') {
    const v = semverPkg.valid(parsed.version);
    return JSON.stringify({ valid: !!v, version: v });
  }

  if (action === 'satisfies') {
    if (!parsed.version || !parsed.range) return JSON.stringify({ error: 'version and range required' });
    return JSON.stringify({ version: parsed.version, range: parsed.range, satisfies: semverPkg.satisfies(parsed.version, parsed.range) });
  }

  if (action === 'compare') {
    if (!parsed.a || !parsed.b) return JSON.stringify({ error: 'a and b required' });
    const cmp = semverPkg.compare(parsed.a, parsed.b);
    return JSON.stringify({ a: parsed.a, b: parsed.b, result: cmp, aGreater: cmp > 0, equal: cmp === 0, bGreater: cmp < 0 });
  }

  if (action === 'sort') {
    if (!Array.isArray(parsed.versions)) return JSON.stringify({ error: 'versions array required' });
    const sorted = semverPkg.sort([...parsed.versions]);
    return JSON.stringify({ sorted });
  }

  if (action === 'coerce') {
    const c = semverPkg.coerce(parsed.version);
    return JSON.stringify({ input: parsed.version, coerced: c?.version ?? null });
  }

  if (action === 'diff') {
    if (!parsed.a || !parsed.b) return JSON.stringify({ error: 'a and b required' });
    return JSON.stringify({ a: parsed.a, b: parsed.b, diff: semverPkg.diff(parsed.a, parsed.b) });
  }

  return JSON.stringify({ error: `Unknown action: ${action}. Supported: validate, satisfies, compare, sort, coerce, diff` });
};

// ---------- 9. livedata/exchange-rate ----------
const exchangeRate: ToolHandler = async (input) => {
  const parsed = tryParseJSON(input);
  let from: string, to: string;
  if (parsed?.from && parsed?.to) {
    from = parsed.from;
    to = parsed.to;
  } else {
    from = 'USD';
    to = (parsed?.to ?? input).trim().toUpperCase() || 'EUR';
  }

  const res = await fetchWithTimeout(
    `https://api.frankfurter.app/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  if (!res.ok) return JSON.stringify({ error: `Frankfurter returned ${res.status}` });
  return JSON.stringify(await res.json());
};

// ---------- 10. livedata/wikipedia (Wikimedia REST, ~500/h with UA) ----------
const wikipedia: ToolHandler = async (input) => {
  const title = (tryParseJSON(input)?.title ?? input).trim();
  if (!title) return JSON.stringify({ error: 'Article title required' });

  const res = await fetchWithTimeout(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    { headers: { 'User-Agent': 'HS58-Livedata/0.1 (DRAIN provider; contact@handshake58.com)' } },
  );
  if (!res.ok) return JSON.stringify({ error: res.status === 404 ? `Article "${title}" not found` : `Wikipedia returned ${res.status}` });
  const data = await res.json() as any;

  return JSON.stringify({
    title: data.title,
    description: data.description ?? '',
    extract: data.extract ?? '',
    thumbnail: data.thumbnail?.source ?? '',
    url: data.content_urls?.desktop?.page ?? '',
    coordinates: data.coordinates ?? null,
  });
};

// ---------- 11. livedata/public-holiday ----------
const publicHoliday: ToolHandler = async (input) => {
  const parsed = tryParseJSON(input);
  let country: string;
  let year: number;

  if (parsed?.country) {
    country = parsed.country;
    year = parsed.year ?? new Date().getFullYear();
  } else {
    country = input.trim().toUpperCase() || 'US';
    year = new Date().getFullYear();
  }

  const res = await fetchWithTimeout(
    `https://date.nager.at/api/v3/PublicHolidays/${year}/${encodeURIComponent(country)}`,
  );
  if (!res.ok) return JSON.stringify({ error: `Nager.Date returned ${res.status}` });
  const holidays = (await res.json() as any[]).map((h: any) => ({
    date: h.date,
    name: h.name,
    localName: h.localName,
  }));

  return JSON.stringify({ country, year, holidays });
};

// ---------- 12. livedata/cron-next ----------
const cronNext: ToolHandler = (input) => {
  const parsed = tryParseJSON(input);
  const expression = parsed?.expression ?? input.trim();
  const count = Math.min(Math.max(parsed?.count ?? 5, 1), 10);

  if (!expression) return JSON.stringify({ error: 'Cron expression required' });

  try {
    const interval = CronExpressionParser.parse(expression);
    const next: string[] = [];
    for (let i = 0; i < count; i++) {
      next.push(interval.next().toISOString());
    }
    return JSON.stringify({ expression, next });
  } catch (e: any) {
    return JSON.stringify({ error: `Invalid cron expression: ${e.message}` });
  }
};

// ---------- 13. livedata/user-agent ----------
const userAgent: ToolHandler = (input) => {
  const ua = input.trim();
  if (!ua) return JSON.stringify({ error: 'User-Agent string required' });

  const parser = new UAParser(ua);
  const result = parser.getResult();

  return JSON.stringify({
    browser: result.browser,
    os: result.os,
    device: result.device,
    engine: result.engine,
  });
};

// ---------- 14. livedata/docker-tags ----------
const dockerTags: ToolHandler = async (input) => {
  const parsed = tryParseJSON(input);
  let image = (parsed?.image ?? input).trim();
  const limit = Math.min(parsed?.limit ?? 10, 50);

  if (!image) return JSON.stringify({ error: 'Image name required' });
  if (!image.includes('/')) image = `library/${image}`;

  const res = await fetchWithTimeout(
    `https://hub.docker.com/v2/repositories/${encodeURIComponent(image).replace('%2F', '/')}/tags?page_size=${limit}`,
  );
  if (!res.ok) return JSON.stringify({ error: `Docker Hub returned ${res.status}` });
  const data = await res.json() as any;

  const tags = (data.results ?? []).map((t: any) => ({
    name: t.name,
    size: t.full_size ?? t.images?.[0]?.size ?? 0,
    lastUpdated: t.last_updated,
  }));

  return JSON.stringify({ image, tags });
};

// ---------- Registry ----------
export const toolRegistry = new Map<string, ToolHandler>([
  ['livedata/time-now',       timeNow],
  ['livedata/time-between',   timeBetween],
  ['livedata/npm-info',       npmInfo],
  ['livedata/pypi-info',      pypiInfo],
  ['livedata/weather',        weather],
  ['livedata/country-info',   countryInfo],
  ['livedata/word-define',    wordDefine],
  ['livedata/semver',         semver],
  ['livedata/exchange-rate',  exchangeRate],
  ['livedata/wikipedia',      wikipedia],
  ['livedata/public-holiday', publicHoliday],
  ['livedata/cron-next',      cronNext],
  ['livedata/user-agent',     userAgent],
  ['livedata/docker-tags',    dockerTags],
]);
