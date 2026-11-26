import path from 'node:path';
import os from 'node:os';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

// Bundled packages resolve from the dsh installation, not from this package.
const hostRoot =
  process.env.DSH_INSTALL_DIR ||
  (process.resourcesPath && path.join(process.resourcesPath, 'app.asar', 'dsh'));
const hostRequire = createRequire(hostRoot ? path.join(hostRoot, 'package.json') : import.meta.url);
let Schema;
try {
  const schemaModule = hostRequire('@deepseek-ai/schemastery');
  Schema = schemaModule.default ?? schemaModule;
} catch {
  // Outside the Host (local smoke tests) the bundled resolver is unavailable.
  const chain = () => {
    const node = {default: (value) => value};
    for (const method of ['default', 'min', 'max', 'description']) node[method] = () => node;
    return node;
  };
  Schema = {object: chain, boolean: chain, number: chain, string: chain};
}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DIR = path.join(DSH_HOME, 'news-guard');
const STATE_PATH = path.join(DIR, 'state.json');
const ALERT_LOG = path.join(DIR, 'alerts.jsonl');
const ALERT_DIGEST = path.join(DIR, 'alerts.md');
const PROBE_LOG = path.join(DIR, 'plugin.log');
const RELAY_TASK_FILE = path.join(DIR, 'relay-task.txt');
const CANDIDATE_TASK_FILE = path.join(DIR, 'candidate-task.txt');
const HTTP_CACHE = path.join(DIR, 'http-cache.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BODY_CHARS = 4_000_000;
const MAX_TITLE = 300;
const MAX_LINK = 500;
const FUTURE_SKEW_MS = 15 * 60 * 1000;

/** Strong, deliberately rare wordings. Ordinary market commentary must not match. */
const KEYWORD_RULES = [
  {
    category: '战争与军事冲突升级',
    re: /(宣战|开战|导弹袭击|导弹打击|空袭|地面入侵|政变|全国戒严|军事打击|核打击|核试验|击落客机|战争爆发)/,
    reEn:
      /(\bdeclares? war\b|\bgoes? to war\b|\bmissile (strike|attack)\b|\bair ?strikes?\b|\bground invasion\b|\bmilitary coup\b|\bmartial law\b|\bnuclear (strike|test)\b|\bwar (has )?broken out\b|\bplane shot down\b|\binvades?\b)/i,
  },
  {
    category: '恐怖袭击与重大伤亡',
    re: /(恐怖袭击|自杀式爆炸|大规模伤亡|死亡人数升至|特大事故|重大伤亡)/,
    reEn:
      /(\bterror(ist)? attack\b|\bsuicide bomb\b|\bmass casualties\b|\bdeath toll (rises|climbs|hits)\b|\bmajor disaster\b)/i,
  },
  {
    category: '重大自然灾害',
    re: /(海啸预警|海啸警报|[789]\.[0-9]\s*级地震|溃坝|核泄漏|核电站爆炸|化工园区爆炸|特大洪水)/,
    reEn:
      /(\btsunami (warning|alert)\b|\bmagnitude (7|8|9)(\.\d)? (earthquake|quake)\b|\bM[789]\.\d earthquake\b|\bdam (collapse|burst)\b|\bnuclear leak\b|\bnuclear plant explosion\b|\bflash flood\b)/i,
  },
  {
    category: '金融系统性风险',
    re: /(触发熔断|暂停交易|主权债务违约|银行挤兑|紧急降息|紧急加息|货币危机|资本管制|系统性金融风险|金融系统性风险|全球股灾)/,
    reEn:
      /(\bcircuit breaker\b|\btrading (halted|suspended)\b|\bsovereign default\b|\bbank run\b|\bemergency rate (cut|hike)\b|\bcurrency crisis\b|\bcapital controls\b|\bsystemic (financial|banking) (risk|crisis)\b|\bmarket crash\b)/i,
  },
];

/**
 * Deliberately broader than the P0 rules: these are "worth a human look", not
 * "wake the user". They only ever reach the judge task, which decides whether
 * anything is actually worth broadcasting.
 */
const CANDIDATE_RULES = [
  /(地震|海啸|爆炸|火灾|空难|坠机|沉船|袭击|空袭|导弹|炮击|政变|戒严|宣战|停飞停航|熔断|停牌|主权违约|资本管制|制裁|关税)/,
  /\b(earthquake|tsunami|explosion|plane crash|air ?strike|missile|coup|martial law|circuit breaker|sovereign default|sanction|tariff|invasion)\b/i,
];

const CHINA_HINT =
  /(中国|北京|上海|广州|深圳|香港|台湾|南海|台海|人民币|A股|解放军|中方|China|Beijing|Shanghai|Hong Kong|Taiwan|Chinese)/i;

/** USGS "place" is more precise than a bounding box that also covers Japan and Korea. */
const CHINA_PLACE =
  /(China|Tibet|Xinjiang|Sichuan|Yunnan|Qinghai|Gansu|Shaanxi|Shanxi|Hebei|Shandong|Henan|Hubei|Hunan|Anhui|Jiangsu|Zhejiang|Fujian|Guangdong|Guangxi|Guizhou|Liaoning|Jilin|Heilongjiang|Inner Mongolia|Beijing|Tianjin|Shanghai|Chongqing|Hainan|Hong Kong|Macau|Taiwan|Nepal-India border region)/i;

function matchKeyword(text) {
  for (const rule of KEYWORD_RULES) {
    const match = text.match(rule.re) ?? text.match(rule.reEn);
    if (match) return {category: rule.category, keyword: match[0]};
  }
  return null;
}

function matchCandidate(text) {
  for (const re of CANDIDATE_RULES) {
    const match = text.match(re);
    if (match) return match[0];
  }
  return null;
}

export const inject = ['schedule'];

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  /** Schedule task whose instruction is replaced and whose delivery is triggered per alert. */
  relayTaskId: Schema.string().default(''),
  /** Task woken only when a candidate headline needs a human-level judgement call. */
  candidateTaskId: Schema.string().default(''),
  /** Poll cadence for the fast, machine-checkable signals. The hard floor is 20 seconds. */
  intervalSeconds: Schema.number().default(45),
  /** News feeds change on a minutes scale, so they get their own slower cadence. */
  newsIntervalSeconds: Schema.number().default(300),
  minMagGlobal: Schema.number().default(6.0),
  minMagChina: Schema.number().default(4.5),
  keywordRules: Schema.boolean().default(true),
  marketRules: Schema.boolean().default(true),
  /** Extra candidate scanning: wakes the judge task instead of the user. */
  candidateRules: Schema.boolean().default(true),
  /** Which feeds feed the candidate scanner at all. */
  maxNewsAgeMinutes: Schema.number().default(45),
  /** Deprecated: category-level suppression dropped, it swallowed real events. Kept for compatibility. */
  cooldownMinutes: Schema.number().default(30),
  marketDropPercent: Schema.number().default(5.0),
  /** Alerts per hour (counted per alert, not per batch). */
  maxAlertsPerHour: Schema.number().default(12),
  /** Per message; the remainder is retried on the next tick instead of being dropped. */
  maxAlertsPerMessage: Schema.number().default(10),
  /** Minimum gap between candidate wakes, so a noisy day cannot turn into a chat every 45s. */
  candidateGapMinutes: Schema.number().default(60),
  maxCandidateWakesPerDay: Schema.number().default(6),
  /** Debug switch: push one synthetic P0 the first time a tick runs, to prove delivery works. */
  selfTest: Schema.boolean().default(false),
});

function log(...args) {
  const line = `[news-guard] ${args.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')}`;
  try {
    console.log(line);
  } catch {
    /* ignore */
  }
  void fs
    .mkdir(DIR, {recursive: true})
    .then(() => fs.appendFile(PROBE_LOG, `${new Date().toISOString()} ${line}\n`))
    .catch(() => {});
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (whole, digits) => {
      // An out-of-range code point throws RangeError, which used to abort the
      // whole tick (every source, every alert) on one malformed feed item.
      const code = Number(digits);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/&amp;/g, '&');
}

function stripTags(value) {
  return decodeEntities(String(value).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function tagText(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return '';
  let value = match[1].trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) value = cdata[1];
  return stripTags(value);
}

/** Bytes pulled from the network since the last reset; used to prove the diet works. */
let bytesFetched = 0;

async function readBody(response) {
  const text = await response.text();
  if (text.length > MAX_BODY_CHARS) throw new Error(`body too large (${text.length} chars)`);
  bytesFetched += Buffer.byteLength(text, 'utf8');
  return text;
}

function abandonBody(response) {
  // A non-2xx response still holds a socket until its body is drained/cancelled.
  void response.body?.cancel().catch(() => {});
}

async function getText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {'user-agent': UA, accept: '*/*'},
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      abandonBody(response);
      throw new Error(`HTTP ${response.status}`);
    }
    return await readBody(response);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Conditional GET. Feeds that honour ETag / Last-Modified answer 304 with an
 * empty body, which is the whole point of polling a slow feed every few minutes
 * instead of every 45 seconds.
 */
async function getCached(url, cache, timeoutMs = 12000) {
  const entry = cache[url] ?? {};
  const headers = {'user-agent': UA, accept: '*/*'};
  if (entry.etag) headers['if-none-match'] = entry.etag;
  if (entry.lastModified) headers['if-modified-since'] = entry.lastModified;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {headers, signal: controller.signal, redirect: 'follow'});
    if (response.status === 304) {
      abandonBody(response);
      return {status: 304, text: null};
    }
    if (!response.ok) {
      abandonBody(response);
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await readBody(response);
    const next = {};
    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    if (etag) next.etag = etag;
    if (lastModified) next.lastModified = lastModified;
    cache[url] = next;
    return {status: 200, text};
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(file) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/** Write via a temp file + rename: a crash mid-write must not leave truncated JSON. */
async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value));
  await fs.rename(temp, file);
}

function parseRss(xml, source) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks) {
    const title = tagText(block, 'title').slice(0, MAX_TITLE);
    if (!title) continue;
    const link = (tagText(block, 'link') || tagText(block, 'guid')).slice(0, MAX_LINK);
    const description = tagText(block, 'description');
    const published = tagText(block, 'pubDate') || tagText(block, 'dc:date');
    const time = published ? Date.parse(published) : NaN;
    items.push({
      source,
      title,
      link,
      summary: description.slice(0, 160),
      // A feed without a usable timestamp cannot be age-filtered; null keeps it
      // from ever passing the freshness gate instead of pretending it is new.
      time: Number.isFinite(time) ? time : null,
    });
  }
  return items;
}

function fmtTime(ms) {
  const date = new Date(ms + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCMonth() + 1}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(
    date.getUTCMinutes(),
  )}`;
}

function fingerprint(parts) {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** Same story carried by two feeds must collapse to one key. */
function normalizeTitle(title) {
  return String(title)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：“”‘’（）《》【】…—\-.,!?;:'"()\[\]<>]/g, '');
}

function readState() {
  // Synchronous on purpose: callers mutate and persist the returned object.
  try {
    const raw = JSON.parse(fsSync.readFileSync(STATE_PATH, 'utf8'));
    return {
      seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
      sent: Array.isArray(raw.sent) ? raw.sent : [],
      primed: Boolean(raw.primed),
      relayDelivered: Number(raw.relayDelivered) || 0,
      retryAt: Number(raw.retryAt) || 0,
      lastCandidateAt: Number(raw.lastCandidateAt) || 0,
      candidateDay: raw.candidateDay && typeof raw.candidateDay === 'object' ? raw.candidateDay : {},
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') log('state unreadable, starting fresh', error?.message ?? String(error));
    return {
      seen: {},
      sent: [],
      primed: false,
      relayDelivered: 0,
      retryAt: 0,
      lastCandidateAt: 0,
      candidateDay: {},
    };
  }
}

async function writeState(state) {
  const seen = Object.entries(state.seen)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 800);
  const horizon = Date.now() - 3 * 3600 * 1000;
  const sent = (state.sent ?? []).filter((t) => t > horizon).slice(-200);
  await writeJsonAtomic(STATE_PATH, {
    version: 2,
    primed: state.primed,
    seen: Object.fromEntries(seen),
    sent,
    relayDelivered: Number(state.relayDelivered) || 0,
    retryAt: Number(state.retryAt) || 0,
    lastCandidateAt: Number(state.lastCandidateAt) || 0,
    candidateDay: state.candidateDay ?? {},
  });
}

async function appendAlertLog(record) {
  try {
    await fs.mkdir(DIR, {recursive: true});
    await fs.appendFile(ALERT_LOG, `${JSON.stringify(record)}\n`);
  } catch (error) {
    log('alert log write failed', error?.message ?? String(error));
  }
}

/**
 * Human-readable mirror of alerts.jsonl. The relay conversation is only a pipe:
 * it gets compacted when it grows, so the durable record of "what was sent" has
 * to live on disk, not in that session's context.
 */
async function appendDigest(record) {
  try {
    const lines = (record.alerts ?? []).map((alert) => {
      const flag = record.delivered ? '✅' : '⚠️';
      const cn = alert.china ? '（中国相关）' : '';
      return `- ${flag} ${fmtTime(alert.time)} P0｜${alert.title}${cn}｜${alert.category ?? ''}`;
    });
    if (lines.length === 0) return;
    let kept = [];
    try {
      const existing = await fs.readFile(ALERT_DIGEST, 'utf8');
      kept = existing.split('\n').filter((line) => line.startsWith('- '));
    } catch {
      /* first write */
    }
    kept = [...kept, ...lines].slice(-200);
    const header = [
      '# P0 告警档案',
      '',
      '> 由 dsh-news-guard 自动维护，最近 200 条；机器可读原档见同目录 `alerts.jsonl`。',
      '> ✅ = 已投递到中转会话，⚠️ = 投递失败（仅留档）。',
      '',
      '',
    ].join('\n');
    await fs.mkdir(DIR, {recursive: true});
    const temp = `${ALERT_DIGEST}.tmp`;
    await fs.writeFile(temp, `${header}${kept.join('\n')}\n`);
    await fs.rename(temp, ALERT_DIGEST);
  } catch (error) {
    log('digest write failed', error?.message ?? String(error));
  }
}

async function collectEarthquakes(config) {
  // all_hour is 6 KB; all_day is 144 KB and only adds what all_hour already
  // reported an hour ago, so it has no place in a 45 second loop.
  const feeds = ['https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson'];
  const alerts = [];
  const candidates = [];
  const seenIds = new Set();
  for (const feed of feeds) {
    let payload;
    try {
      payload = JSON.parse(await getText(feed, 10000));
    } catch (error) {
      log('usgs failed', feed, error?.message ?? String(error));
      continue;
    }
    for (const feature of payload.features ?? []) {
      const id = feature.id;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      const props = feature.properties ?? {};
      const [lon, lat] = feature.geometry?.coordinates ?? [];
      const mag = Number(props.mag);
      if (!Number.isFinite(mag)) continue;
      if (Date.now() - Number(props.time) > 6 * 3600 * 1000) continue;
      const place = String(props.place ?? '未知地点');
      const inChina = CHINA_PLACE.test(place);
      const threshold = inChina ? config.minMagChina : config.minMagGlobal;
      const alert = {
        key: `usgs:${id}`,
        category: inChina ? '地震（中国及周边）' : '地震（全球）',
        title: `M${mag.toFixed(1)} 地震 · ${place}`,
        summary: `深度 ${Number(props.depth ?? feature.geometry?.coordinates?.[2] ?? 0).toFixed(0)} 公里`,
        link: String(props.url ?? '').slice(0, MAX_LINK),
        time: Number(props.time) || Date.now(),
        china: inChina,
      };
      if (mag >= threshold) {
        alerts.push(alert);
      } else if (mag >= threshold - 0.7) {
        // Just under the line: hand it to the judge task instead of the user.
        candidates.push({...alert, key: `cand:${alert.key}`});
      }
    }
  }
  return {alerts, candidates};
}

async function collectNews(config, cache = {}) {
  // Only feeds that timestamp their items. Xinhua's category RSS carries no
  // pubDate at all (0 of 300 items), so it can neither be age-filtered nor
  // deduplicated against history without replaying old articles as new.
  const feeds = [
    {name: '中新网 国际', url: 'https://www.chinanews.com.cn/rss/world.xml'},
    {name: '中新网 滚动', url: 'https://www.chinanews.com.cn/rss/scroll-news.xml'},
    {name: 'CBS 世界', url: 'https://www.cbsnews.com/latest/rss/world'},
    {name: 'Fox 世界', url: 'https://moxie.foxnews.com/google-publisher/world.xml'},
    // TASS dropped on purpose: 47.9 KB per poll with no ETag and no
    // Last-Modified, so conditional GET never fires — it alone cost 13.8 MB/day.
  ];
  const alerts = [];
  const candidates = [];
  let notModified = 0;
  const now = Date.now();
  const oldest = now - config.maxNewsAgeMinutes * 60 * 1000;
  // Drop validators of feeds that are no longer polled, so a retired source
  // does not linger in http-cache.json forever.
  const live = new Set(feeds.map((feed) => feed.url));
  for (const url of Object.keys(cache)) {
    if (!live.has(url)) delete cache[url];
  }
  for (const feed of feeds) {
    let text;
    try {
      const response = await getCached(feed.url, cache, 12000);
      if (response.status === 304) {
        notModified += 1;
        continue;
      }
      text = response.text;
    } catch (error) {
      log('feed failed', feed.name, error?.message ?? String(error));
      continue;
    }
    let items;
    try {
      items = parseRss(text, feed.name);
    } catch (error) {
      // One malformed feed must never take the whole tick down with it.
      log('feed unparsable', feed.name, error?.message ?? String(error));
      continue;
    }
    const stamped = items.filter((item) => item.time !== null).length;
    if (items.length > 0 && stamped / items.length < 0.9) {
      log('feed skipped, unreliable timestamps', feed.name, `${stamped}/${items.length}`);
      continue;
    }
    for (const item of items) {
      if (item.time === null || item.time < oldest || item.time > now + FUTURE_SKEW_MS) continue;
      // Match the headline only: descriptions in these feeds are mostly
      // navigation boilerplate, which used to produce alerts whose title had
      // nothing to do with the matched keyword.
      const hit = matchKeyword(item.title);
      const key = fingerprint([normalizeTitle(item.title)]);
      if (hit) {
        alerts.push({
          key,
          category: hit.category,
          keyword: hit.keyword,
          title: item.title,
          summary: item.summary,
          link: item.link,
          source: item.source,
          time: item.time,
          china: CHINA_HINT.test(`${item.title} ${item.summary}`),
        });
        continue;
      }
      if (!config.candidateRules) continue;
      const candidate = matchCandidate(item.title);
      if (!candidate) continue;
      candidates.push({
        key: `cand:${key}`,
        category: `候选（${candidate}）`,
        title: item.title,
        summary: item.summary,
        link: item.link,
        source: item.source,
        time: item.time,
        china: CHINA_HINT.test(`${item.title} ${item.summary}`),
      });
    }
  }
  return {alerts, candidates, notModified, total: feeds.length};
}

async function collectMarket(config) {
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f14&secids=1.000001,100.HSI,100.DJIA,100.NDX';
  try {
    const payload = JSON.parse(await getText(url, 8000));
    const rows = payload?.data?.diff ?? [];
    const alerts = [];
    const candidates = [];
    const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    for (const row of rows) {
      const change = Number(row.f3);
      if (!Number.isFinite(change)) continue;
      // Keyed by trading day, not by minute: the old key changed every minute
      // and flooded the 800-slot dedupe map.
      const alert = {
        key: fingerprint(['market', String(row.f12), day, String(config.marketDropPercent)]),
        category: '金融系统性风险',
        title: `${row.f14 ?? row.f12} 单日下跌 ${Math.abs(change).toFixed(2)}%`,
        summary: `最新 ${row.f2}`,
        link: 'https://quote.eastmoney.com/',
        time: Date.now(),
      };
      if (change <= -config.marketDropPercent) {
        alerts.push(alert);
      } else if (change <= -(config.marketDropPercent * 0.6)) {
        candidates.push({...alert, key: `cand:${alert.key}`, category: `候选（跌 ${Math.abs(change).toFixed(1)}%）`});
      }
    }
    return {alerts, candidates};
  } catch (error) {
    log('market failed', error?.message ?? String(error));
    return {alerts: [], candidates: []};
  }
}

function render(alert) {
  const lines = [`🚨【P0｜${fmtTime(alert.time)} 北京时间】${alert.title}`];
  if (alert.category) lines.push(`类型：${alert.category}${alert.china ? '｜与中国直接相关' : ''}`);
  if (alert.summary) lines.push(alert.summary);
  if (alert.link) lines.push(`来源：${alert.link}`);
  return lines.join('\n');
}

function renderCandidate(candidate) {
  return `· ${fmtTime(candidate.time)}｜${candidate.title}｜${candidate.source ?? ''} ${candidate.link ?? ''}`.trim();
}

/**
 * Pure decision step, so the gate logic is testable without a Host.
 * Returns what to deliver now; anything left over stays unseen and is retried.
 */
export function selectDeliverable(alerts, state, config, now) {
  const cap = Math.max(1, Number(config.maxAlertsPerHour) || 12);
  const perMessage = Math.max(1, Number(config.maxAlertsPerMessage) || 10);
  const recent = (state.sent ?? []).filter((t) => t > now - 3600 * 1000).length;
  const unseen = [];
  const seenKeys = new Set();
  for (const alert of alerts) {
    if (state.seen[alert.key] || seenKeys.has(alert.key)) continue;
    seenKeys.add(alert.key);
    unseen.push(alert);
  }
  unseen.sort((a, b) => b.time - a.time);
  const slots = Math.min(cap - recent, perMessage);
  if (slots <= 0) return {deliver: [], deferred: unseen.length, rateLimited: unseen.length > 0};
  return {deliver: unseen.slice(0, slots), deferred: Math.max(0, unseen.length - slots), rateLimited: false};
}

export const internals = {
  collectEarthquakes,
  collectNews,
  collectMarket,
  parseRss,
  render,
  renderCandidate,
  matchKeyword,
  matchCandidate,
  normalizeTitle,
  selectDeliverable,
  decodeEntities,
  resolveRelayTaskId,
  resolveCandidateTaskId,
  appendDigest,
  KEYWORD_RULES,
  CANDIDATE_RULES,
  /** Bytes counter, so the bandwidth diet is measurable from a test. */
  bytes: {
    get value() {
      return bytesFetched;
    },
    reset() {
      bytesFetched = 0;
    },
  },
};

/**
 * Where alerts are delivered. Config wins, then an environment override, then a
 * local file — the file keeps a machine-specific task id out of version control.
 */
function resolveTaskId(configured, envName, file) {
  const fromConfig = (configured || '').trim();
  if (fromConfig) return fromConfig;
  const fromEnv = (process.env[envName] || '').trim();
  if (fromEnv) return fromEnv;
  try {
    return fsSync.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function resolveRelayTaskId(config) {
  return resolveTaskId(config.relayTaskId, 'NEWS_GUARD_RELAY_TASK', RELAY_TASK_FILE);
}

function resolveCandidateTaskId(config) {
  return resolveTaskId(config.candidateTaskId, 'NEWS_GUARD_CANDIDATE_TASK', CANDIDATE_TASK_FILE);
}

export function apply(ctx, config) {
  if (!config.enabled) {
    log('disabled by config');
    return;
  }
  const interval = Math.max(20, Number(config.intervalSeconds) || 45) * 1000;
  const newsInterval = Math.max(interval, (Number(config.newsIntervalSeconds) || 300) * 1000);
  const candidateGap = Math.max(5, Number(config.candidateGapMinutes) || 60) * 60 * 1000;
  let lastNewsAt = 0;
  let ticks = 0;
  let busy = false;
  let disposed = false;

  /**
   * Deliver through a dormant schedule task. DSH reports refusals as result
   * objects rather than exceptions, so the codes must be checked — the old code
   * counted `schedule_execution_pending` as a successful delivery.
   */
  async function deliverVia(taskId, text) {
    if (!taskId) {
      log('no task configured; not delivered');
      return false;
    }
    const edit = await ctx.schedule.edit({id: taskId, action: 'update', patch: {prompt: text}});
    if (edit?.code) {
      log('delivery rejected at edit', taskId, edit.code);
      return false;
    }
    const run = await ctx.schedule.run({id: taskId});
    if (run?.code) {
      log('delivery rejected at run', taskId, run.code);
      return false;
    }
    return true;
  }

  async function push(text) {
    // The pointer rides along with every alert so that, after the relay session
    // is compacted, whoever reads it still knows where the durable record is.
    const body = `${text}\n\n📁 档案：${ALERT_DIGEST}（最近 200 条）｜原档 ${ALERT_LOG}`;
    return deliverVia(resolveRelayTaskId(config), body);
  }

  async function tick() {
    if (busy || disposed) return;
    busy = true;
    const bytesBefore = bytesFetched;
    let newsNote = 'not due';
    try {
      const state = readState();
      const alerts = [];
      const candidates = [];
      const now = Date.now();

      if (config.marketRules) {
        const market = await collectMarket(config);
        alerts.push(...market.alerts);
        candidates.push(...market.candidates);
      }
      const quakes = await collectEarthquakes(config);
      alerts.push(...quakes.alerts);
      candidates.push(...quakes.candidates);

      // News moves on a minutes scale; asking for it every 45 seconds is pure
      // bandwidth. It gets its own slower cadence plus conditional requests.
      if (config.keywordRules && now - lastNewsAt >= newsInterval) {
        lastNewsAt = now;
        const cache = (await readJson(HTTP_CACHE)) ?? {};
        try {
          const news = await collectNews(config, cache);
          alerts.push(...news.alerts);
          candidates.push(...news.candidates);
          newsNote = `${news.alerts.length} hit(s), ${news.notModified}/${news.total} not modified`;
        } catch (error) {
          log('news collection failed', error?.message ?? String(error));
          newsNote = 'failed';
        } finally {
          // Persist validators even if a later feed threw, so the next round
          // does not pay for the same downloads again.
          await writeJsonAtomic(HTTP_CACHE, cache).catch(() => {});
        }
      }

      if (!state.primed) {
        // First run only learns what already exists: never replay history.
        for (const alert of [...alerts, ...candidates]) state.seen[alert.key] = now;
        state.primed = true;
        await writeState(state);
        log(`primed with ${Object.keys(state.seen).length} existing items`);
        return;
      }

      if (config.selfTest && !state.seen['selftest:sentinel']) {
        state.seen['selftest:sentinel'] = now;
        await writeState(state);
        const sample = {
          category: '自检（合成告警，不是真实新闻）',
          title: '插件投递链路自检',
          summary: `看到这条说明 P0 直推通道已打通。轮询间隔 ${interval / 1000} 秒，监控 ${4} 个快讯源与 USGS。`,
          link: '',
          time: now,
          china: false,
        };
        const ok = await push(render(sample));
        log(ok ? 'selftest delivered' : 'selftest delivery failed');
        return;
      }

      // Do not hammer a dead relay: back off after a failure, then retry.
      if (state.retryAt > now) {
        newsNote = `${newsNote}; delivery backoff`;
      } else {
        const plan = selectDeliverable(alerts, state, config, now);
        if (plan.rateLimited) log('rate limited', `${plan.deferred} alert(s) deferred`);
        if (plan.deliver.length > 0) {
          const text = plan.deliver.map(render).join('\n\n');
          log('P0 alert', plan.deliver.map((a) => a.title).join(' / '));
          const delivered = await push(text);
          await appendAlertLog({at: new Date().toISOString(), delivered, alerts: plan.deliver});
          if (delivered) {
            for (const alert of plan.deliver) state.seen[alert.key] = now;
            state.sent = [...(state.sent ?? []).filter((t) => t > now - 3600 * 1000), ...plan.deliver.map(() => now)];
            state.relayDelivered = (Number(state.relayDelivered) || 0) + 1;
            state.retryAt = 0;
            await writeState(state);
            log('delivered', `${plan.deliver.length} alert(s)`);
          } else {
            state.retryAt = now + 5 * 60 * 1000;
            await writeState(state);
          }
          await appendDigest({at: new Date().toISOString(), alerts: plan.deliver, delivered});
        } else if (plan.deferred > 0) {
          log('alerts waiting for quota', String(plan.deferred));
        }
      }

      if (config.candidateRules) await maybeWakeJudge(candidates, state, now);
    } catch (error) {
      log('tick failed', error?.message ?? String(error));
    } finally {
      busy = false;
      ticks += 1;
      if (ticks % 20 === 0) {
        log(`tick #${ticks}`, `${bytesFetched - bytesBefore} bytes`, newsNote);
      }
    }
  }

  async function maybeWakeJudge(candidates, state, now) {
    const fresh = [];
    const pending = new Set();
    for (const candidate of candidates) {
      if (state.seen[candidate.key] || pending.has(candidate.key)) continue;
      pending.add(candidate.key);
      fresh.push(candidate);
    }
    if (fresh.length === 0) return;
    const day = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const dayState = state.candidateDay?.date === day ? state.candidateDay : {date: day, count: 0};
    // Suppressed candidates stay unseen: they are retried once the gap or the
    // daily budget allows, instead of being burned by a quiet hour.
    if (now - (state.lastCandidateAt || 0) < candidateGap) return;
    if (dayState.count >= Math.max(1, Number(config.maxCandidateWakesPerDay) || 6)) return;
    fresh.sort((a, b) => b.time - a.time);
    const lines = fresh.slice(0, 12).map(renderCandidate);
    const body = [
      '🔎 候选线索（未达标，需判断）',
      '',
      ...lines,
      '',
      fresh.length > lines.length ? `（仅列最新 ${lines.length} 条，共 ${fresh.length} 条候选）` : '',
      '',
      '判断规则：只有确认是重大且影响广泛的新闻才按 📰 格式播报，否则保持静默。',
      '不要为了回应这条消息而勉强找新闻；无达标新闻时不输出任何文字。',
      '播报后按台账格式追加到 ~/.dsh/news-guard/reported.md。',
    ]
      .filter(Boolean)
      .join('\n');
    const ok = await deliverVia(resolveCandidateTaskId(config), body);
    if (ok) {
      for (const candidate of fresh) state.seen[candidate.key] = now;
      state.lastCandidateAt = now;
      dayState.count += 1;
      state.candidateDay = dayState;
      await writeState(state);
    }
    log(ok ? 'judge woken' : 'judge delivery failed', `${fresh.length} candidate(s)`);
  }

  ctx.effect(() => {
    const handle = setInterval(() => {
      void tick();
    }, interval);
    log(
      `started, interval ${interval / 1000}s, news every ${newsInterval / 1000}s, judge gap ${candidateGap / 60000}min`,
    );
    void tick();
    return () => {
      disposed = true;
      clearInterval(handle);
    };
  });
}
