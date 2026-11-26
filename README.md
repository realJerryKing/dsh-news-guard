# dsh-news-guard

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的常驻 P0 紧急新闻守护插件：
> 45 秒轮询权威快讯源，**只**在「战争升级 / 重大自然灾害 / 金融系统性风险」这类突发命中时，以秒级把告警直推进对话；其余时间完全静默、零 token。

```
┌──────────── DSH Host ────────────┐
│  news-guard (this plugin)        │  ← apply() 起一个 setInterval，45s 一轮
│  快环 45s（3.6 KB/轮）            │
│    ├─ USGS all_hour 地震          │
│    └─ 东方财富指数跌幅            │
│  慢环 5min（ETag 条件请求）        │
│    └─ 中新网 ×2 / CBS / Fox / TASS│
│           ↓ 命中规则 & 去重 & 冷静期 │
│      ctx.schedule.edit(prompt)   │
│      ctx.schedule.run(id)        │   ← 立即投递，不等下次发生时间
└──────────────────────────────────┘
                  ↓
        中转会话：一条新的 P0 消息（手机 / dsh-go / Web 同步可见）
```

## 为什么不是「把定时任务调成一分钟」

| 方案 | 最快响应 | 成本 |
| --- | --- | --- |
| agent 定时任务每 1 分钟 | 60s（`every` 的硬下限），且每次都要唤醒 agent 跑一轮 | 每分钟一次完整对话轮次 |
| agent 定时任务每小时 + 本插件 45s 轮询 | **≤45s**，且只有命中才唤醒 | 常态 0 token，命中才付一次 |

所以两者分工：**常规新闻巡检交给每小时一次的 agent 任务，秒级 P0 交给这个常驻插件。**
插件不做摘要、不写稿、不读全文，只判断「这条要不要吵醒人」。

## P0 判定标准

| 类别 | 触发条件 |
| --- | --- |
| 地震（中国及周边） | USGS 震级 ≥ `minMagChina`（默认 4.5），震中在 15–55°N / 70–140°E 框内 |
| 地震（全球） | USGS 震级 ≥ `minMagGlobal`（默认 6.0），6 小时内 |
| 战争与军事冲突升级 | 宣战 / 开战 / 导弹袭击 / 空袭 / 地面入侵 / 政变 / 全国戒严 / 核打击 / 核试验 / 击落客机 / 战争爆发（含英文 `declares war` / `missile strike` / `martial law` …） |
| 恐怖袭击与重大伤亡 | 恐怖袭击 / 自杀式爆炸 / 大规模伤亡 / 死亡人数升至 / 特大事故 / 重大伤亡 |
| 重大自然灾害 | 海啸预警 / 7.0 级以上地震 / 溃坝 / 核泄漏 / 核电站爆炸 / 化工园区爆炸 / 特大洪水 |
| 金融系统性风险 | 触发熔断 / 暂停交易 / 主权债务违约 / 银行挤兑 / 紧急降息 / 紧急加息 / 货币危机 / 资本管制 / 全球股灾 |
| 行情 | 上证、恒生、道指、纳指单日跌幅 ≥ `marketDropPercent`（默认 5%） |

命中「中国」线索（中国 / 北京 / 上海 / 香港 / 台湾 / 南海 / 台海 / 人民币 / A股 / 解放军 / China / Beijing …）时，正文会额外标注 `｜与中国直接相关`。

规则刻意只用**罕见措辞**：`导弹袭击` 会报，`中东局势紧张` 不会报。宁可漏报也不让插件变成噪音源——真正重要的事件几乎都会落进上面这些词。

## 安装

1. 把这个目录放到任意位置，例如 `~/plugins/dsh-news-guard`。
2. 注册为 DSH bundle（二选一）：

   ```bash
   # 通过 DSH 的 plugin_manager 工具
   plugin_manager({ action: "install_bundle", target: "<上面那个绝对路径>" })
   ```

   安装完成后插件 entryId 是 `include:news-guard`，改配置后**禁用再启用**即可热重载。

3. 造一个「休眠的中转任务」，让告警有地方落：

   ```
   schedule_create
     title:  P0 快讯直推中转
     prompt: （占位，插件每次投递前会覆写）
     target: new_once
     rrule:  DTSTART;TZID=Asia/Shanghai:20990101T090000
             RRULE:FREQ=YEARLY;COUNT=1
   ```

   `COUNT=1` + 2099 年，它永远不会自然触发，只被 `ctx.schedule.run()` 唤醒。

4. 把返回的任务 id 写到下面**任意一处**（优先级从高到低）：

   ```
   config.relayTaskId
   环境变量 NEWS_GUARD_RELAY_TASK
   ~/.dsh/news-guard/relay-task.txt     ← 推荐，机器相关 id 不进版本库
   ```

5. 打开 `selfTest: true` 重载一次，确认收到一条 `插件投递链路自检` 消息，然后把 `selfTest` 关回去。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `relayTaskId` | `''` | 中转任务 id，见上 |
| `intervalSeconds` | `45` | 快环轮询间隔，代码硬下限 20s |
| `newsIntervalSeconds` | `300` | 新闻源轮询间隔（带 ETag 条件请求） |
| `minMagGlobal` / `minMagChina` | `6.0` / `4.5` | 全球 / 中国框内震级阈值 |
| `keywordRules` | `true` | 是否跑关键词规则 |
| `marketRules` | `true` | 是否跑指数跌幅规则 |
| `maxNewsAgeMinutes` | `45` | 条目最大年龄；超过视为旧闻，防止停机后回放历史 |
| `cooldownMinutes` | `30` | 同类别冷静期，避免同一事件刷屏 |
| `marketDropPercent` | `5` | 指数跌幅阈值 |
| `maxAlertsPerHour` | `6` | 每小时投递上限，硬性防抖动 |
| `selfTest` | `false` | 首轮推一条合成告警，仅用于验证链路 |

## 行为细节

- **首轮只学习不告警**：`primed` 之前的条目只登记进 `seen`，避免刚装好就补推一堆历史。
- **无时间戳的源整源跳过**：`parseRss` 对缺 `pubDate` 的条目返回 `time: null`；某源超过 10% 条目无时间戳时整源禁用（见下方实测）。
- **去重**：`sha1(source|title)` 前 16 位；地震用 USGS 的 feature id。
- **中文/英文双规则**：国外通讯社只用中英双语关键词中英并用，避免「英文源看起来永远没有 P0」。

## 数据源实测

详见 [`docs/measurements.md`](docs/measurements.md)。结论：

**在用（快环 45s / 慢环 5min）**：

| 环 | 源 | 单轮体积 |
| --- | --- | --- |
| 快环 | USGS `all_hour` ｜ 东方财富指数 | 3.6 KB |
| 慢环 | 中新网 国际 / 滚动 ｜ CBS 世界 ｜ Fox 世界 ｜ TASS | 245 KB / 24 KB / 48 KB，其中 4 个支持 `ETag`/`Last-Modified`，未变更时 304 → 0 字节 |

`all_day`（144 KB）已从快环移除：它只比 `all_hour` 多报「一小时前已经报过」的事件，放在 45 秒循环里纯属浪费。

**已弃用**（实测不合格）：

| 源 | 问题 |
| --- | --- |
| 新华网 RSS `news_politics.xml` | 300 条里 **0 条有 pubDate**，会把 2022 年旧文当新闻 |
| 新浪滚动 API | 返回 2025-05-26 的旧缓存 |
| WSJ `RSSWorldNews.xml` | 服务端给的是 2025-01-27 的静态快照 |
| BBC / Al Jazeera / Google News RSS / GDELT / 财联社 / 金十 | 超时、429、404、502 |
| 中国地震台网直连 | `ajax/google` 405、`ajax/speedsearch` TLS 失败 → 用 USGS 覆盖中国及周边 |

## 带宽与成本

**带宽**：原来是「每 45 秒把所有源拉一遍」，一轮约 240 KB，一天约 460 MB。现在拆成快环 / 慢环 + 条件请求，实测（`node test/smoke.mjs` 会打印这两行）：

```
conditional GET: round1 337053 B (0/5 not modified) -> round2 47901 B (4/5 not modified)
```

- 慢环首轮 337 KB（含 Fox 的 245 KB），第二轮起 5 源里 4 源返回 `304`，只剩 **47.9 KB**。
- 唯一没法缓存的是 **TASS**（既无 `ETag` 也无 `Last-Modified`，每次都是 200），48 KB × 288 轮/天 ≈ 13.8 MB。
- 快环 3.6 KB × 1920 轮/天 ≈ 6.6 MB。

合计约 **20 MB/天，约为原来的 1/23**；如果愿意砍掉 TASS（最新条目常有 40 分钟以上的时滞），还能再降到 12 MB/天。

**token**：45 秒 tick 本身不唤醒模型、不花 token，只花带宽。一次 P0 投递才会唤醒中转会话跑一轮，实测该轮 `inputTokens ≈ 75k`（受益于 KV 缓存，重复前缀便宜）。

极端情况下 6 条/小时就是 6 轮 ≈ 45 万输入 token，因此 `maxAlertsPerHour` 默认 6；把常态压到「一天几条」才是正确的手感。

## 已知限制

- **手机是否响铃不归插件管**：告警保证进入对话；dsh-go 等客户端是否在后台弹系统通知由 App 自己决定，且需要 Remote 面板处于登录/信任状态。
- 关键词导向的规则会漏掉「没有用这些措辞」的灾难（例如缓慢累积的饥荒、长期冲突中的单次小规模交火）。
- 中国框是一个粗略矩形，跨境的 NEIC/周边海域事件可能落到「全球」阈值上。
- 行情只覆盖四个指数；VIX 在东财接口上无数据。
- 只做了 RSS/JSON 拉取，没有做正文抽取——所以同一事件通常只有一条标题级信息。

## License

MIT
