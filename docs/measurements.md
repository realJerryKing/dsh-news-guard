# 数据源与运行实测

所有数字都是在本机（Windows 11，中国大陆网络，无代理）用 12 秒超时实测得到的，仅代表该时刻的可达性。网络环境不同结果会变，插件在源失败时只记一行日志并继续跑其他源。

## 一、候选源探测

| 源 | 采样 | 结论 |
| --- | --- | --- |
| `earthquake.usgs.gov/.../summary/all_hour.geojson` | 759 ms | ✅ 采用 |
| `earthquake.usgs.gov/.../summary/all_day.geojson` | ✅ | ✅ 采用（补漏） |
| 中新网 `rss/world.xml` | 214 ms | ✅ 采用 |
| 中新网 `rss/scroll-news.xml` | 189 ms | ✅ 采用（最新条目仅 11–18 分钟前） |
| `feeds.a.dj.com/rss/RSSWorldNews.xml` (WSJ) | 921 ms | ❌ 服务端返回 2025-01-27 静态快照 |
| `xinhuanet.com/politics/news_politics.xml` | 277 ms / 174 KB | ❌ 300 条中 0 条有 `pubDate` |
| `feed.mix.sina.com.cn/api/roll/get?...lid=2510` | 92 ms | ❌ `ctime` 全是 2025-05-26 的缓存 |
| `push2.eastmoney.com/api/qt/ulist.np/get` | 115 ms | ✅ 采用（VIX 无数据，指数正常） |
| `cbsnews.com/latest/rss/world` | 770 ms | ✅ 采用 |
| `moxie.foxnews.com/google-publisher/world.xml` | 474 ms | ✅ 采用 |
| `tass.com/rss/v2.xml` | 1227 ms | ✅ 采用 |
| `feeds.npr.org/1004/rss.xml` | 475 ms | ⏸ 可用但未启用（与 CBS/Fox 高度重叠） |
| `feeds.bbci.co.uk` / Al Jazeera | 超时 | ❌ |
| Google News RSS / NYT / Guardian / NHK / 自由时报 | 超时 | ❌ |
| GDELT | HTTP 429 | ❌ |
| `api-one.wallstcn.com` | DNS 解析失败 | ❌ |
| `flash-api.jin10.com` | HTTP 502 | ❌ |
| `www.cls.cn/nodeapi/telegraphList` | HTTP 404 | ❌ |
| 中国地震台网 `news.ceic.ac.cn/ajax/google` | 405（GET 与 POST 皆 405） | ❌ |
| 中国地震台网 `news.ceic.ac.cn/ajax/speedsearch` | TLS 证书不被信任 | ❌ |
| `zaobao.com` RSS | 200 但 0 条 item | ❌ |

> 中国地震台网的速报是「4 级以上、分钟级」的最佳源，但两条公开接口都拿不到，因此改用 USGS：它同样分钟级更新，中国境内 4.5 级以上基本都会收录，代价是境外事件默认阈值要更高（6.0）才不会吵。

## 二、被「时间戳」坑到的两次事故

第一版只按关键词匹配、按 `Date.now()` 兜底无时间戳的条目，结果：

1. 新华网 2022 年的旧文《水利部：2022 年全国水库实现"零溃坝"》被当成新 P0，因为它的 RSS 条目没有 `pubDate`，兜底成"刚刚发布"。
2. 新浪滚动接口返回 2025-05 的缓存，同样通过了时效门。

修法（现在的代码）：

```js
// 没有可信时间就是不新鲜，绝不假装它是刚刚发生的
time: Number.isFinite(time) ? time : null
...
if (items.length > 0 && stamped / items.length < 0.9) {
  log('feed skipped, unreliable timestamps', feed.name, `${stamped}/${items.length}`);
  continue;
}
if (item.time === null || item.time < oldest) continue;
```

## 三、运行期证据

| 现象 | 证据 |
| --- | --- |
| 插件加载 | `plugin.log`: `started, interval 45s` |
| 首轮只登记不告警 | `primed with 0 existing items`，`state.json` 里 `primed: true` |
| 投递链路通 | `selftest delivered`，中转会话出现 `【P0｜11-26 10:55 北京时间】插件投递链路自检` |
| 轮询真的在跑 | `state.json` mtime 45 秒一跳（10:58:25 → 10:59:10） |
| 投递成本 | 中转会话该轮 `inputTokens = 75534` |

`~/.dsh/news-guard/` 下四个文件：

```
state.json        去重集合 / 冷静期 / 近 3 小时投递时间戳 / primed 标记
alerts.jsonl      每次真实告警的原文留档
plugin.log        每轮的失败与投递记录（源失败、限流、投递成功）
relay-task.txt    中转任务 id（不进版本库）
```

## 四、调参经验

- `intervalSeconds: 45` 是「秒级」和「别把源打疼」的折中。20s 更快，但对 TASS 这种 1.2s 才响应的源意义不大。
- `maxNewsAgeMinutes: 45` 决定了停机恢复后最多回放多久的旧闻；调小会更安静。
- `cooldownMinutes: 30` 针对的是同一类别：一次海啸预警之后 30 分钟内不再重复报同类的第二条，避免一个地震把一小时的额度吃光。
- 若发现某类总是误报，先看 `alerts.jsonl` 里的 `keyword` 字段，再决定是删词还是收窄成更长的短语——不要直接关掉整类。
