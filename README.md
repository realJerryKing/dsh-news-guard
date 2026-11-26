# dsh-news-guard

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的常驻 P0 紧急新闻守护插件：
> 快环 45 秒轮询，**只**在「战争升级 / 重大自然灾害 / 金融系统性风险」这类突发命中时把告警秒级直推进对话；
> 其余时间完全静默、零 token。够不上 P0、但值得人看一眼的线索，走另一条「唤醒研判」通道。

```
┌──────────────── DSH Host ────────────────┐
│  news-guard (this plugin)                │  ← apply() 起一个 setInterval，45s 一轮
│  快环 45s（≈3.5 KB/轮）                   │
│    ├─ USGS all_hour 地震                  │
│    └─ 东方财富指数跌幅                     │
│  慢环 5min（ETag 条件请求）                │
│    └─ 中新网 ×2 / CBS / Fox               │
│           ↓                               │
│   ∌ 已知 & 配额 & 投递成功                  │
│      ├─ 命中 P0 规则 → ctx.schedule.edit   │
│      │                 ctx.schedule.run   │  → 中转会话：🚨 P0 即时消息
│      └─ 命中候选规则 → 另一个 schedule 任务  │  → 研判会话：🔎 候选线索（限速）
└──────────────────────────────────────────┘
```

## 三条车道

| 车道 | 触发 | 谁来判断 | 频率上限 |
| --- | --- | --- | --- |
| **P0 直推** | 罕见关键词 / 震级阈值 / 指数跌幅阈值 | 插件（规则） | `maxAlertsPerHour`（默认 12 条/小时） |
| **候选研判** | 更宽的「值得一看」词表，或震级/跌幅略低于阈值 | agent（LLM） | `candidateGapMinutes`（60 分钟）+ `maxCandidateWakesPerDay`（6 次/天） |
| **6 小时扫尾** | agent 侧定时任务 | agent（LLM） | 每 6 小时 |

为什么不全交给 agent：agent 定时任务的最短周期是 60 秒，且每次都要唤醒模型跑一轮（实测单轮 `inputTokens ≈ 75k`）。
为什么不全靠关键词：关键词漏掉的（缓慢累积的危机、没有用那些措辞的灾难）正需要 LLM 的判断力。
所以分工是——**秒级的交给插件，判断力交给 agent，中间的灰色地带用限速的候选唤醒兜住。**

## 一条 P0 长这样

`🚨` 前缀与 `【P0｜…】` 标记是刻意保留的视觉签名，方便和日常对话、`📰 ━━━` 新闻播报区分开：

```
🚨【P0｜11-26 13:42 北京时间】两艘油轮在霍尔木兹海峡触雷爆炸
类型：金融系统性风险｜与中国直接相关
伊朗革命卫队称两艘油轮在海峡南部与东部沿岸触雷起火，布伦特原油盘中跳涨 3%。
来源：https://example.com/news/xxx

📁 档案：C:\Users\<you>\.dsh\news-guard\alerts.md（最近 200 条）｜原档 .../alerts.jsonl
```

## P0 判定标准

| 类别 | 触发条件 |
| --- | --- |
| 地震（中国及周边） | USGS 震级 ≥ `minMagChina`（默认 4.5），且 `place` 含 China / 省名 / Taiwan / Hong Kong 等 |
| 地震（全球） | USGS 震级 ≥ `minMagGlobal`（默认 6.0），6 小时内 |
| 战争与军事冲突升级 | 宣战 / 开战 / 导弹袭击 / 空袭 / 地面入侵 / 政变 / 全国戒严 / 核打击 / 核试验 / 击落客机 / 战争爆发（英文 `declares war` / `missile strike` / `martial law` …） |
| 恐怖袭击与重大伤亡 | 恐怖袭击 / 自杀式爆炸 / 大规模伤亡 / 死亡人数升至 / 特大事故 / 重大伤亡 |
| 重大自然灾害 | 海啸预警 / 7.0 级以上地震 / 溃坝 / 核泄漏 / 核电站爆炸 / 化工园区爆炸 / 特大洪水 |
| 金融系统性风险 | 触发熔断 / 暂停交易 / 主权债务违约 / 银行挤兑 / 紧急降息 / 紧急加息 / 货币危机 / 资本管制 / 系统性金融风险 / 全球股灾 |
| 行情 | 上证、恒生、道指、纳指单日跌幅 ≥ `marketDropPercent`（默认 5%） |

规则刻意只用**罕见措辞**：`导弹袭击` 会报，`中东局势紧张` 不会报；**英文规则带词边界**，避免 `invasion` 之类误伤。
命中中国线索（中国 / 北京 / 上海 / 香港 / 台湾 / 南海 / 台海 / 人民币 / A股 / 解放军 / China / Beijing …）时，正文额外标注 `｜与中国直接相关`。

关键词只匹配**标题**：这些 feed 的 description 大多是导航样板，把摘要拼进去只会让「标题和命中词毫无关系」的告警变多。

## 安装

1. 把这个目录放到任意位置，例如 `~/plugins/dsh-news-guard`。
2. 注册为 DSH bundle：

   ```bash
   plugin_manager({ action: "install_bundle", target: "<上面那个绝对路径>" })
   ```

   安装后插件 entryId 是 `include:news-guard`；改代码后把任意带 patchId 的 bundle 关→开即可触发 recomposition 热重载。

3. 造两个「休眠任务」（`COUNT=1` + 2099 年，永不自然触发，只被 `ctx.schedule.run()` 唤醒）：

   | 任务 | target | 作用 |
   | --- | --- | --- |
   | `P0 快讯直推中转` | `new_once`（独立会话） | 收 P0 告警；独立会话的上下文比主会话便宜 |
   | `候选新闻研判唤醒` | `this_session`（主会话） | 收候选线索，由 agent 判断是否播报 |

   ```
   schedule_create
     title:  P0 快讯直推中转
     prompt: （占位，插件每次投递前会覆写）
     target: new_once
     rrule:  DTSTART;TZID=Asia/Shanghai:20990101T090000
             RRULE:FREQ=YEARLY;COUNT=1
   ```

4. 把返回的两个任务 id 写到下面**任意一处**（优先级从高到低）：

   ```
   config.relayTaskId / config.candidateTaskId
   环境变量 NEWS_GUARD_RELAY_TASK / NEWS_GUARD_CANDIDATE_TASK
   ~/.dsh/news-guard/relay-task.txt
   ~/.dsh/news-guard/candidate-task.txt     ← 推荐，机器相关 id 不进版本库
   ```

5. 打开 `selfTest: true` 重载一次，确认收到 `插件投递链路自检`，然后把 `selfTest` 关回去。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `relayTaskId` / `candidateTaskId` | `''` | 两个投递目标，见上 |
| `intervalSeconds` | `45` | 快环轮询间隔，代码硬下限 20s |
| `newsIntervalSeconds` | `300` | 新闻源轮询间隔（带 ETag 条件请求） |
| `minMagGlobal` / `minMagChina` | `6.0` / `4.5` | 全球 / 中国震级阈值 |
| `keywordRules` / `marketRules` / `candidateRules` | `true` | 三条规则开关 |
| `maxNewsAgeMinutes` | `45` | 条目最大年龄；超过视为旧闻，防止停机后回放历史 |
| `marketDropPercent` | `5` | 指数跌幅阈值 |
| `maxAlertsPerHour` | `12` | 每小时投递上限，**按条计**（不是按批次） |
| `maxAlertsPerMessage` | `10` | 单条消息最多几条；超出的留到下一轮，不丢 |
| `candidateGapMinutes` | `60` | 两次候选唤醒的最小间隔 |
| `maxCandidateWakesPerDay` | `6` | 每天候选唤醒上限 |
| `cooldownMinutes` | `30` | **已废弃**：类别级冷静期会吞掉同类第二起事件，现按标题去重 |
| `selfTest` | `false` | 首轮推一条合成告警，仅用于验证链路 |

## 行为细节

- **首轮只学习不告警**：`primed` 之前的条目只登记进 `seen`，避免刚装好就补推一堆历史。
- **投递成功才记账**：`seen` / 配额 / 冷却只在 `edit` + `run` 都返回正常结果后才写入；被 `schedule_not_found`、`schedule_execution_pending` 拒绝时按失败处理（DSH 用返回码而不是异常表达拒绝），5 分钟后重试。
- **配额按条计**：一小时 12 条是 12 条告警，不是 12 批；`maxAlertsPerMessage` 只是分条，超出部分下一轮继续投。
- **无时间戳的源整源跳过**：缺 `pubDate` 的条目 `time: null`（绝不回落成「现在」）；某源超过 10% 条目无时间戳时整源禁用。未来时间戳（>15 分钟）也直接跳过。
- **去重按归一化标题**：`sha1(规范化标题)` 前 16 位——`四川宜宾发生 4.5 级地震！` 与 `四川宜宾发生4.5级地震` 同一条；中新网两个 feed 的同题也不会重复报警。地震用 USGS feature id，行情按「指数 + 交易日」。
- **原子写**：`state.json` / `http-cache.json` / `alerts.md` 都走临时文件 + rename，进程崩溃不会留半截 JSON。
- **候选被限速时不丢弃**：候选在限速期内保持「未读」，等间隔到点或配额恢复再唤醒，不会被安静的一小时吞掉。

## 数据源实测

详见 [`docs/measurements.md`](docs/measurements.md)。

**在用（快环 45s / 慢环 5min）**：

| 环 | 源 | 单轮体积 |
| --- | --- | --- |
| 快环 | USGS `all_hour` ｜ 东方财富指数 | ≈3.5 KB |
| 慢环 | 中新网 国际 / 滚动 ｜ CBS 世界 ｜ Fox 世界 | 245 KB / 24 KB / 10 KB / 9 KB，**全部**支持 `ETag`/`Last-Modified`，未变更时 304 → 0 字节 |

`all_day`（144 KB）已从快环移除：它只比 `all_hour` 多报「一小时前已经报过」的事件。

**已弃用**（实测不合格）：

| 源 | 问题 |
| --- | --- |
| 新华网 RSS `news_politics.xml` | 300 条里 **0 条有 pubDate**，会把 2022 年旧文当新闻 |
| 新浪滚动 API | 返回 2025-05-26 的旧缓存 |
| WSJ `RSSWorldNews.xml` | 服务端给的是 2025-01-27 的静态快照 |
| TASS `tass.com/rss/v2.xml` | 无 `ETag`/`Last-Modified`，47.9 KB 每轮全量 → 13.8 MB/天；最新条目常滞后 40 分钟以上 |
| BBC / Al Jazeera / Google News RSS / GDELT / 财联社 / 金十 | 超时、429、404、502 |
| 中国地震台网直连 | `ajax/google` 405、`ajax/speedsearch` TLS 失败 → 用 USGS 覆盖中国及周边 |

## 档案：为什么不能靠对话记忆

投递目标是一条会话，而会话会被压缩——压缩后「发过什么」的细节可能只剩摘要。所以插件的记忆全部落在磁盘：

| 文件 | 内容 | 谁会读 |
| --- | --- | --- |
| `state.json` | 去重指纹、配额、候选节流、投递计数 | 插件自己 |
| `http-cache.json` | `ETag` / `Last-Modified` 校验器 | 插件自己 |
| `http-cache.json` 里退役源 | 自动清理（按当前 feed 列表收敛） | 插件自己 |
| `alerts.jsonl` | **机器可读权威档案**，每次尝试一行（含 `delivered`） | 需要复盘/统计时 |
| `alerts.md` | **人类可读摘要**，最近 200 条，✅/⚠️ 区分是否真投递成功 | 你和 agent |
| `reported.md` | 小时/扫尾播报的去重台账（由 agent 任务读写） | agent 开工前 |

每条 P0 消息末尾都会带一行 `📁 档案：…`，让「压缩后的会话」也知道去哪找真实记录。

## 带宽与成本

原设计「每 45 秒把所有源拉一遍」，一轮约 240 KB、一天约 460 MB。现在：

```
conditional GET: round1 302074 B (0/4 not modified) -> round2 0 B (4/4 not modified)
```

- 慢环首轮 302 KB（含 Fox 的 245 KB），第二轮起 4 个源全部 `304`，**0 字节**。
- 快环 3.5 KB × 1920 轮/天 ≈ 6.6 MB。
- 合计约 **7–10 MB/天**（慢环只在内容真的变了时才下载）。

**token**：45 秒 tick 不唤醒模型、不花 token，只花带宽。花钱的只有三处：P0 投递（约 75k 输入 token/轮）、候选唤醒（同样一轮，但每天上限 6 次）、6 小时扫尾。

## 已知限制

- **手机是否响铃不归插件管**：告警保证进入对话；dsh-go 等客户端是否在后台弹系统通知由 App 自己决定，且需要 Remote 面板处于登录/信任状态。
- 关键词导向的规则会漏掉「没有用这些措辞」的灾难；这类漏报靠候选车道与 6 小时扫尾兜。
- 中国判定用 USGS 的 `place` 字符串，个别跨境事件的归属可能不符合直觉。
- 行情只覆盖四个指数；VIX 在东财接口上无数据。
- 只做 RSS/JSON 拉取，没有正文抽取——同一事件通常只有标题级信息。
- feed 标题会被写进投递消息、由 agent 当输入读。标题来自第三方，理论上可被注入恶意指令；agent 侧的正确姿势是把它当**数据**而不是**指令**。

## 测试

```bash
node --test test/          # 15 条断言：闸门、配额、去重、解析、渲染契约
node test/smoke.mjs        # 真实网络：四个采集器 + 条件请求两轮
node test/probe-feeds.mjs  # 逐源打印条目数/新鲜度/命中情况，排查"为什么没报"
```

## License

MIT
