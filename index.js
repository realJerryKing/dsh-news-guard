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
const STATE_PATH = path.join(DSH_HOME, 'news-guard', 'state.json');
const ALERT_LOG = path.join(DSH_HOME, 'news-guard', 'alerts.jsonl');
const PROBE_LOG_DIR = path.join(DSH_HOME, 'news-guard');
const PROBE_LOG = path.join(DSH_HOME, 'news-guard', 'plugin.log');
const RELAY_TASK_FILE = path.join(DSH_HOME, 'news-guard', 'relay-task.txt');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Strong, deliberately rare wordings. Ordinary market commentary must not match. */
const KEYWORD_RULES = [
  {
    category: '战争与军事冲突升级',
    re: /(宣战|开战|导弹袭击|导弹打击|空袭|地面入侵|政变|全国戒严|军事打击|核打击|核试验|击落客机|战争爆发)/,
    reEn:
      /(declares? war|goes? to war|missile (strike|attack)|air ?strikes?|ground invasion|military coup|martial law|nuclear (strike|test)|war (has )?broken out|plane shot down|invades?)/i,
  },
  {
    category: '恐怖袭击与重大伤亡',
    re: /(恐怖袭击|自杀式爆炸|大规模伤亡|死亡人数升至|特大事故|重大伤亡)/,
    reEn:
      /(terror(ist)? attack|suicide bomb|mass casualties|death toll (rises|climbs|hits)|major disaster)/i,
  },
  {
    category: '重大自然灾害',
    re: /(海啸预警|海啸警报|7\.[0-9]级地震|8\.[0-9]级地震|9\.[0-9]级地震|溃坝|核泄漏|核电站爆炸|化工园区爆炸|特大洪水)/,
    reEn:
      /(tsunami (warning|alert)|magnitude (7|8|9)(\.\d)? (earthquake|quake)|M[789]\.\d earthquake|dam (collapse|burst)|nuclear leak|nuclear plant explosion|flash flood)/i,
  },
  {
    category: '金融系统性风险',
    re: /(触发熔断|暂停交易|主权债务违约|银行挤兑|紧急降息|紧急加息|货币危机|资本管制|金融系统|全球股灾)/,
    reEn:
      /(circuit breaker|trading (halted|suspended)|sovereign default|bank run|emergency rate (cut|hike)|currency crisis|capital controls|systemic (financial|banking) (risk|crisis)|market crash)/i,
  },
];

const CHINA_HINT = /(中国|北京|上海|广州|深圳|香港|台湾|南海|台海|人民币|A股|解放军|中方|China|Beijing|Shanghai|Hong Kong|Taiwan|Chinese)/i;

function matchKeyword(text) {
  for (const rule of KEYWORD_RULES) {
    const match = text.match(rule.re) ?? text.match(rule.reEn);
    if (match) return {category: rule.category, keyword: match[0]};
  }
  return null;
}

export const inject = ['schedule'];

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  /** Schedule task whose instruction is replaced and whose delivery is triggered per alert. */
  relayTaskId: Schema.string().default(''),
  /** Poll cadence. The hard floor is 20 seconds. */
  intervalSeconds: Schema.number().default(45),
  minMagGlobal: Schema.number().default(6.0),
  minMagChina: Schema.number().default(4.5),
  keywordRules: Schema.boolean().default(true),
  marketRules: Schema.boolean().default(true),
  /** A feed item must be at most this old to qualify; prevents replaying history after downtime. */
  maxNewsAgeMinutes: Schema.number().default(45),
  /** Same topic stays quiet this long after it alerted once. */
  cooldownMinutes: Schema.number().default(30),
  marketDropPercent: Schema.number().default(5.0),
  /** Hard ceiling so a noisy rule can never turn into an alert storm. */
  maxAlertsPerHour: Schema.number().default(6),
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
    .mkdir(PROBE_LOG_DIR, {recursive: true})
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
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function stripTags(value) {
  return decodeEntities(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tagText(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return '';
  let value = match[1].trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) value = cdata[1];
  return stripTags(value);
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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseRss(xml, source) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks) {
    const title = tagText(block, 'title');
    if (!title) continue;
    const link = tagText(block, 'link') || tagText(block, 'guid');
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

function chinaBox(lat, lon) {
  return lat >= 15 && lat <= 55 && lon >= 70 && lon <= 140;
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

async function readState() {
  try {
    const raw = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
    return {
      seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
      cooldown: raw.cooldown && typeof raw.cooldown === 'object' ? raw.cooldown : {},
      sent: Array.isArray(raw.sent) ? raw.sent : [],
      primed: Boolean(raw.primed),
    };
  } catch {
    return {seen: {}, cooldown: {}, sent: [], primed: false};
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), {recursive: true});
  const seen = Object.entries(state.seen)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 800);
  const horizon = Date.now() - 3 * 3600 * 1000;
  const sent = (state.sent ?? []).filter((t) => t > horizon).slice(-200);
  await fs.writeFile(
    STATE_PATH,
    JSON.stringify({
      version: 1,
      primed: state.primed,
      seen: Object.fromEntries(seen),
      cooldown: state.cooldown,
      sent,
    }),
  );
}

async function appendAlertLog(record) {
  try {
    await fs.mkdir(path.dirname(ALERT_LOG), {recursive: true});
    await fs.appendFile(ALERT_LOG, `${JSON.stringify(record)}\n`);
  } catch {
    /* ignore */
  }
}

/** Feed collectors. Each returns candidate alerts; failures are isolated. */
async function collectEarthquakes(config) {
  const feeds = [
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
  ];
  const alerts = [];
  const seenIds = new Set();
  for (const feed of feeds) {
    let payload;
    try {
      payload = JSON.parse(await getText(feed, 10000));
    } catch (error) {
      log('usgs failed', feed, error.message);
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
      const inChina = chinaBox(Number(lat), Number(lon));
      const threshold = inChina ? config.minMagChina : config.minMagGlobal;
      if (mag < threshold) continue;
      if (Date.now() - Number(props.time) > 6 * 3600 * 1000) continue;
      alerts.push({
        key: `usgs:${id}`,
        category: inChina ? '地震（中国及周边）' : '地震（全球）',
        title: `M${mag.toFixed(1)} 地震 · ${props.place ?? '未知地点'}`,
        summary: `深度 ${Number(props.depth ?? feature.geometry?.coordinates?.[2] ?? 0).toFixed(0)} 公里`,
        link: props.url ?? '',
        time: Number(props.time) || Date.now(),
      });
    }
  }
  return alerts;
}

async function collectNews(config) {
  // Only feeds that timestamp their items. Xinhua's category RSS carries no
  // pubDate at all (0 of 300 items), so it can neither be age-filtered nor
  // deduplicated against history without replaying old articles as new.
  const feeds = [
    {name: '中新网 国际', url: 'https://www.chinanews.com.cn/rss/world.xml'},
    {name: '中新网 滚动', url: 'https://www.chinanews.com.cn/rss/scroll-news.xml'},
    {name: 'CBS 世界', url: 'https://www.cbsnews.com/latest/rss/world'},
    {name: 'Fox 世界', url: 'https://moxie.foxnews.com/google-publisher/world.xml'},
    {name: 'TASS', url: 'https://tass.com/rss/v2.xml'},
  ];
  const alerts = [];
  const oldest = Date.now() - config.maxNewsAgeMinutes * 60 * 1000;
  for (const feed of feeds) {
    let xml;
    try {
      xml = await getText(feed.url, 12000);
    } catch (error) {
      log('feed failed', feed.name, error.message);
      continue;
    }
    const items = parseRss(xml, feed.name);
    const stamped = items.filter((item) => item.time !== null).length;
    if (items.length > 0 && stamped / items.length < 0.9) {
      log('feed skipped, unreliable timestamps', feed.name, `${stamped}/${items.length}`);
      continue;
    }
    for (const item of items) {
      if (item.time === null || item.time < oldest) continue;
      const haystack = `${item.title} ${item.summary}`;
      const hit = matchKeyword(haystack);
      if (!hit) continue;
      alerts.push({
        key: fingerprint([item.source, item.title]),
        category: hit.category,
        keyword: hit.keyword,
        title: item.title,
        summary: item.summary,
        link: item.link,
        source: item.source,
        time: item.time,
        china: CHINA_HINT.test(haystack),
      });
    }
  }
  return alerts;
}

async function collectMarket(config) {
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f14&secids=1.000001,100.HSI,100.DJIA,100.NDX';
  try {
    const payload = JSON.parse(await getText(url, 8000));
    const rows = payload?.data?.diff ?? [];
    const alerts = [];
    for (const row of rows) {
      const change = Number(row.f3);
      if (!Number.isFinite(change)) continue;
      if (change > -config.marketDropPercent) continue;
      alerts.push({
        key: fingerprint(['market', row.f12, fmtTime(Date.now())]),
        category: '金融系统性风险',
        title: `${row.f14 ?? row.f12} 单日下跌 ${Math.abs(change).toFixed(2)}%`,
        summary: `最新 ${row.f2}`,
        link: 'https://quote.eastmoney.com/',
        time: Date.now(),
      });
    }
    return alerts;
  } catch (error) {
    log('market failed', error.message);
    return [];
  }
}

function render(alert) {
  const lines = [`【P0｜${fmtTime(alert.time)} 北京时间】${alert.title}`];
  if (alert.category) lines.push(`类型：${alert.category}${alert.china ? '｜与中国直接相关' : ''}`);
  if (alert.summary) lines.push(alert.summary);
  if (alert.link) lines.push(`来源：${alert.link}`);
  return lines.join('\n');
}

export const internals = {
  collectEarthquakes,
  collectNews,
  collectMarket,
  parseRss,
  render,
  matchKeyword,
  resolveRelayTaskId,
  KEYWORD_RULES,
};

/**
 * Where alerts are delivered. Config wins, then an environment override, then a
 * local file — the file keeps a machine-specific task id out of version control.
 */
function resolveRelayTaskId(config) {
  const fromConfig = (config.relayTaskId || '').trim();
  if (fromConfig) return fromConfig;
  const fromEnv = (process.env.NEWS_GUARD_RELAY_TASK || '').trim();
  if (fromEnv) return fromEnv;
  try {
    return fsSync.readFileSync(RELAY_TASK_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

export function apply(ctx, config) {
  if (!config.enabled) {
    log('disabled by config');
    return;
  }
  const interval = Math.max(20, Number(config.intervalSeconds) || 45) * 1000;
  let busy = false;
  let disposed = false;

  async function push(text) {
    const taskId = resolveRelayTaskId(config);
    if (!taskId) {
      log('no relay task configured; alert written to log only');
      return false;
    }
    await ctx.schedule.edit({id: taskId, action: 'update', patch: {prompt: text}});
    await ctx.schedule.run({id: taskId});
    return true;
  }

  async function tick() {
    if (busy || disposed) return;
    busy = true;
    try {
      const state = await readState();
      const alerts = [];

      if (config.marketRules) alerts.push(...(await collectMarket(config)));
      alerts.push(...(await collectEarthquakes(config)));

      if (config.keywordRules) alerts.push(...(await collectNews(config)));

      const now = Date.now();
      const cooldownMs = Math.max(1, config.cooldownMinutes) * 60 * 1000;
      const fresh = [];
      for (const alert of alerts) {
        if (state.seen[alert.key]) continue;
        state.seen[alert.key] = now;
        if (!state.primed) continue; // first run only learns what already exists
        const cooldownKey = alert.category;
        if ((state.cooldown[cooldownKey] ?? 0) + cooldownMs > now) continue;
        state.cooldown[cooldownKey] = now;
        fresh.push(alert);
      }

      const wasPrimed = state.primed;
      state.primed = true;
      await writeState(state);

      if (!wasPrimed) {
        log(`primed with ${Object.keys(state.seen).length} existing items`);
        return;
      }

      if (config.selfTest && !state.seen['selftest:sentinel']) {
        state.seen['selftest:sentinel'] = now;
        await writeState(state);
        const sample = {
          category: '自检（合成告警，不是真实新闻）',
          title: '插件投递链路自检',
          summary: `看到这条说明 P0 直推通道已打通。轮询间隔 ${interval / 1000} 秒，监控 5 个快讯源与 USGS。`,
          link: '',
          time: now,
          china: false,
        };
        try {
          await push(render(sample));
          log('selftest delivered');
        } catch (error) {
          log('selftest delivery failed', error?.message ?? String(error));
        }
        return;
      }

      if (fresh.length === 0) return;

      const hourAgo = now - 3600 * 1000;
      const recent = (state.sent ?? []).filter((t) => t > hourAgo);
      if (recent.length >= Math.max(1, config.maxAlertsPerHour)) {
        log('rate limited', `${recent.length}/${config.maxAlertsPerHour} in the last hour`);
        return;
      }

      fresh.sort((a, b) => b.time - a.time);
      const text = fresh.slice(0, 3).map(render).join('\n\n');
      log('P0 alert', fresh.map((a) => a.title).join(' / '));
      await appendAlertLog({at: new Date().toISOString(), alerts: fresh});
      try {
        await push(text);
        state.sent = [...recent, now];
        await writeState(state);
        log('delivered');
      } catch (error) {
        log('delivery failed', error?.message ?? String(error));
      }
    } catch (error) {
      log('tick failed', error?.message ?? String(error));
    } finally {
      busy = false;
    }
  }

  ctx.effect(() => {
    const handle = setInterval(() => {
      void tick();
    }, interval);
    void tick();
    return () => {
      disposed = true;
      clearInterval(handle);
    };
  });
  log(`started, interval ${interval / 1000}s`);
}
