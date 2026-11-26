import {internals} from '../index.js';

const config = {
  minMagGlobal: 6.0,
  minMagChina: 4.5,
  maxNewsAgeMinutes: 45,
  marketDropPercent: 5,
};

const budget = (label, promise) =>
  promise.then(
    (rows) => {
      console.log(`--- ${label}: ${rows.length} candidate(s)`);
      for (const row of rows.slice(0, 4)) {
        console.log(`    [${row.category ?? row.source}] ${row.title}`);
      }
      return rows;
    },
    (error) => {
      console.log(`--- ${label}: FAILED ${error.message}`);
      return [];
    },
  );

const started = Date.now();
const [quakes, news, market] = await Promise.all([
  budget('earthquakes', internals.collectEarthquakes(config)),
  budget('news', internals.collectNews(config, {}).then((r) => r.alerts)),
  budget('market', internals.collectMarket(config)),
]);
console.log(`elapsed ${Date.now() - started}ms`);
console.log('total candidates:', quakes.length + news.length + market.length);

// Second round reuses the validators: a well behaved feed answers 304 and
// costs nothing. This is what makes a 5 minute news cadence cheap.
internals.bytes.reset();
const cache = {};
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
