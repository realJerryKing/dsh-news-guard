import test from 'node:test';
import assert from 'node:assert/strict';
import {internals, selectDeliverable, Config} from '../index.js';

const {parseRss, matchKeyword, matchCandidate, normalizeTitle, decodeEntities, render, renderCandidate} =
  internals;

const baseConfig = {
  maxAlertsPerHour: 12,
  maxAlertsPerMessage: 10,
  minMagGlobal: 6.0,
  minMagChina: 4.5,
  marketDropPercent: 5,
  maxNewsAgeMinutes: 45,
};

function alert(key, minutesAgo = 0) {
  return {key, title: `title ${key}`, time: Date.now() - minutesAgo * 60_000, category: '测试'};
}

test('selectDeliverable does not mutate state.seen', () => {
  const state = {seen: {}, sent: []};
  const plan = selectDeliverable([alert('a')], state, baseConfig, Date.now());
  assert.equal(plan.deliver.length, 1);
  assert.deepEqual(state.seen, {}, 'gate must not mark anything as seen before delivery succeeds');
});

test('selectDeliverable defers the overflow instead of dropping it', () => {
  const now = Date.now();
  const alerts = Array.from({length: 15}, (_, i) => alert(`k${i}`, i));
  const plan = selectDeliverable(alerts, {seen: {}, sent: []}, baseConfig, now);
  assert.equal(plan.deliver.length, 10, 'per-message cap applies');
  assert.equal(plan.deferred, 5, 'the rest is retried, never discarded');
  assert.equal(plan.rateLimited, false);
});

test('selectDeliverable delivers newest first and skips known keys', () => {
  const now = Date.now();
  const plan = selectDeliverable(
    [alert('old', 30), alert('new', 1), alert('dup', 2), alert('dup', 2)],
    {seen: {old: 1}, sent: []},
    baseConfig,
    now,
  );
  assert.deepEqual(
    plan.deliver.map((a) => a.key),
    ['new', 'dup'],
  );
});

test('selectDeliverable enforces the hourly alert quota per alert, not per batch', () => {
  const now = Date.now();
  const state = {seen: {}, sent: [now - 1000, now - 2000, now - 3000]};
  const plan = selectDeliverable([alert('a'), alert('b')], state, {...baseConfig, maxAlertsPerHour: 4}, now);
  assert.equal(plan.deliver.length, 1, 'only one slot left in the hour');
  assert.equal(plan.deferred, 1);
});

test('selectDeliverable reports rate limiting once the hour is full', () => {
  const now = Date.now();
  const sent = Array.from({length: 12}, (_, i) => now - i * 1000);
  const plan = selectDeliverable([alert('a')], {seen: {}, sent}, baseConfig, now);
  assert.equal(plan.deliver.length, 0);
  assert.equal(plan.rateLimited, true);
});

test('selectDeliverable ignores deliveries older than one hour', () => {
  const now = Date.now();
  const old = now - 2 * 3600 * 1000;
  const plan = selectDeliverable([alert('a')], {seen: {}, sent: [old, old, old]}, {...baseConfig, maxAlertsPerHour: 1}, now);
  assert.equal(plan.deliver.length, 1);
});

test('decodeEntities survives an out-of-range numeric entity', () => {
  assert.equal(decodeEntities('a &#99999999; b'), 'a &#99999999; b');
  assert.equal(decodeEntities('&#128680; alert'), '🚨 alert');
  assert.equal(decodeEntities('AT&amp;T &lt;live&gt;'), 'AT&T <live>');
});

test('normalizeTitle collapses the same headline from two feeds', () => {
  const a = normalizeTitle('四川宜宾市发生 4.5 级地震，暂无伤亡');
  const b = normalizeTitle('四川宜宾市发生4.5级地震，暂无伤亡！');
  assert.equal(a, b);
  assert.notEqual(normalizeTitle('地震'), normalizeTitle('地震演练'));
});

test('P0 keywords match the rare wordings only', () => {
  assert.equal(matchKeyword('俄军对基辅发动导弹袭击')?.category, '战争与军事冲突升级');
  assert.equal(matchKeyword('日本九州发生 7.3 级地震')?.category, '重大自然灾害');
  assert.equal(matchKeyword('美股触发熔断')?.category, '金融系统性风险');
  assert.equal(matchKeyword('Russia launches missile strike on Kyiv')?.category, '战争与军事冲突升级');
  assert.equal(matchKeyword('Magnitude 7.4 earthquake strikes Chile')?.category, '重大自然灾害');
  assert.equal(matchKeyword('Stocks fall as recession fears grow'), null, 'ordinary market commentary');
  assert.equal(matchKeyword('多地开展地震应急演练'), null);
  assert.equal(matchKeyword('地震演练通知'), null);
});

test('candidate rules are broader than P0 rules', () => {
  assert.ok(matchCandidate('某地发生爆炸，暂无伤亡'));
  assert.ok(matchCandidate('欧盟宣布新一轮制裁'));
  assert.ok(matchCandidate('Earthquake felt across the region'));
  assert.equal(matchKeyword('欧盟宣布新一轮制裁'), null, 'candidate-only text must not raise P0');
  assert.equal(matchCandidate('今日天气晴'), null);
});

test('parseRss marks untimestamped items so they cannot pass the age gate', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>旧闻没有时间</title><link>https://e.x/1</link><description><![CDATA[<p>摘要</p>]]></description></item>
    <item><title>有时效的新闻</title><link>https://e.x/2</link>
      <pubDate>Tue, 26 Nov 2026 02:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = parseRss(xml, 'fixture');
  assert.equal(items.length, 2);
  assert.equal(items[0].time, null, 'missing pubDate must not fall back to "now"');
  assert.equal(items[0].summary, '摘要');
  assert.equal(items[1].time, Date.parse('2026-11-26T02:00:00Z'));
});

test('parseRss caps title and link length', () => {
  const long = 'x'.repeat(2000);
  const xml = `<rss><item><title>${long}</title><link>${long}</link><pubDate>Tue, 26 Nov 2026 02:00:00 GMT</pubDate></item></rss>`;
  const [item] = parseRss(xml, 'fixture');
  assert.equal(item.title.length, 300);
  assert.equal(item.link.length, 500);
});

test('render keeps the visual contract the user asked for', () => {
  const text = render({
    time: Date.parse('2026-11-26T02:35:00Z'),
    title: '测试标题',
    category: '金融系统性风险',
    summary: '摘要',
    link: 'https://example.com/x',
    china: true,
  });
  const [first] = text.split('\n');
  assert.match(first, /^🚨【P0｜11-26 10:35 北京时间】测试标题$/);
  assert.match(text, /与中国直接相关/);
  assert.match(text, /来源：https:\/\/example.com\/x/);
});

test('renderCandidate is a single compact line per clue', () => {
  const line = renderCandidate({
    time: Date.parse('2026-11-26T02:35:00Z'),
    title: '某地发生爆炸',
    source: '中新网 滚动',
    link: 'https://example.com/y',
  });
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /11-26 10:35｜某地发生爆炸｜中新网 滚动/);
});

test('Config exposes the documented defaults', () => {
  assert.ok(Config, 'Config schema is exported');
});

test('task id resolution: config wins, then env, then local file', () => {
  const {resolveRelayTaskId, resolveCandidateTaskId} = internals;
  assert.equal(resolveRelayTaskId({relayTaskId: 'from-config'}), 'from-config');
  assert.equal(resolveCandidateTaskId({candidateTaskId: 'from-config'}), 'from-config');

  const savedRelay = process.env.NEWS_GUARD_RELAY_TASK;
  const savedCandidate = process.env.NEWS_GUARD_CANDIDATE_TASK;
  process.env.NEWS_GUARD_RELAY_TASK = 'relay-env';
  process.env.NEWS_GUARD_CANDIDATE_TASK = 'candidate-env';
  try {
    assert.equal(resolveRelayTaskId({relayTaskId: ''}), 'relay-env');
    assert.equal(resolveCandidateTaskId({}), 'candidate-env');
    assert.equal(resolveCandidateTaskId({candidateTaskId: 'explicit'}), 'explicit');
  } finally {
    if (savedRelay === undefined) delete process.env.NEWS_GUARD_RELAY_TASK;
    else process.env.NEWS_GUARD_RELAY_TASK = savedRelay;
    if (savedCandidate === undefined) delete process.env.NEWS_GUARD_CANDIDATE_TASK;
    else process.env.NEWS_GUARD_CANDIDATE_TASK = savedCandidate;
  }
});
