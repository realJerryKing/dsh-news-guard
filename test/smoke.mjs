import {internals} from '../index.js';

const config = {
  minMagGlobal: 6.0,
  minMagChina: 4.5,
  maxNewsAgeMinutes: 45,
  marketDropPercent: 5,
  candidateRules: true,
};

const show = (label, result) => {
  const alerts = result.alerts ?? [];
  const candidates = result.candidates ?? [];
  console.log(`--- ${label}: ${alerts.length} alert(s), ${candidates.length} candidate(s)`);
  for (const row of alerts.slice(0, 4)) console.log(`  [${row.category}] ${row.title}`);
  for (const row of candidates.slice(0, 3)) console.log(`  (candidate) ${row.title}`);
  return result;
};

const started = Date.now();
const quakes = show('earthquakes', await internals.collectEarthquakes(config));
const news = show('news', await internals.collectNews(config, {}));
const market = show('market', await internals.collectMarket(config));
console.log(`elapsed ${Date.now() - started}ms`);
console.log(
  'totals:',
  quakes.alerts.length + news.alerts.length + market.alerts.length,
  'alert(s),',
  quakes.candidates.length + news.candidates.length + market.candidates.length,
  'candidate(s)',
);

// Second round reuses the validators: a well behaved feed answers 304 and
// costs nothing. This is what makes a 5 minute news cadence cheap.
const cache = {};
internals.bytes.reset();
const first = await internals.collectNews(config, cache);
const firstBytes = internals.bytes.value;
internals.bytes.reset();
const second = await internals.collectNews(config, cache);
const secondBytes = internals.bytes.value;
console.log(
  `conditional GET: round1 ${firstBytes} B (${first.notModified}/${first.total} not modified) -> round2 ${secondBytes} B (${second.notModified}/${second.total} not modified)`,
);

const probe = [
  '以色列宣布对黎巴嫩开战',
  '日本东部海域发生7.4级地震 气象厅发布海啸预警',
  '某银行遭挤兑 央行宣布紧急降息',
  '沪指今日小幅调整 成交量萎缩',
  '公司发布季度财报',
  'Russia launches missile strike on Kyiv, power grid damaged',
  'Magnitude 7.2 earthquake strikes off Japan coast, tsunami warning issued',
  'Stocks slip as investors weigh rate outlook',
  'Central bank announces emergency rate cut after bank run',
  'Trading halted as circuit breaker triggers on Wall Street',
];
for (const title of probe) {
  const hit = internals.matchKeyword(title);
  console.log(`rule | ${hit ? `${hit.category} (${hit.keyword})` : '（不触发）'} | ${title}`);
}
