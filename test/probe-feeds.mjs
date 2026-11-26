import {internals} from '../index.js';

const feeds = [
  ['中新网 国际', 'https://www.chinanews.com.cn/rss/world.xml'],
  ['中新网 滚动', 'https://www.chinanews.com.cn/rss/scroll-news.xml'],
  ['CBS', 'https://www.cbsnews.com/latest/rss/world'],
  ['Fox', 'https://moxie.foxnews.com/google-publisher/world.xml'],
];

const now = Date.now();
for (const [name, url] of feeds) {
  const response = await fetch(url, {headers: {accept: '*/*'}});
  const text = await response.text();
  const items = internals.parseRss(text, name);
  const stamped = items.filter((i) => i.time !== null).length;
  const fresh = items.filter((i) => i.time !== null && i.time >= now - 45 * 60_000 && i.time <= now + 15 * 60_000);
  const newest = items.map((i) => i.time).filter(Boolean).sort((a, b) => b - a)[0];
  console.log(
    `${name}: items=${items.length} stamped=${stamped} fresh=${fresh.length} newest=${newest ? new Date(newest).toISOString() : 'n/a'} (now=${new Date(now).toISOString()})`,
  );
  for (const item of fresh.slice(0, 4)) {
    console.log(`   +${Math.round((now - item.time) / 60000)}min | ${item.title}`);
    console.log(`      candidate=${internals.matchCandidate(item.title)} p0=${internals.matchKeyword(item.title)?.category ?? '-'}`);
  }
}
