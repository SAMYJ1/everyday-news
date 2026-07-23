# 每日趣味科普站：第一阶段平台可行性

> 调研日期：2026-07-23（Asia/Shanghai）  
> 范围：只采用 Cloudflare、Reddit、Hacker News/Firebase 的官方或第一方资料。配额和政策会变化，上线前应再次复核。本文是产品与工程风险分析，不替代法律意见。

## 结论

技术上可行，但数据源的可行性明显不同：

- **Cloudflare 足以承载整个 MVP**：Pages 提供静态阅读界面；Worker + Cron 每日发现内容；D1 保存索引、处理状态和摘要；Queue 拆分抓取与处理；R2 只在需要保存原始快照或媒体时加入；Workers AI 可做分类与摘要。
- **Hacker News 是更适合第一版的首发来源**：官方 Firebase API 无需认证、当前没有速率限制，能取得榜单、story 和逐层评论。主要成本是评论树必须逐 ID 递归抓取。
- **Reddit 的主要障碍是审批与内容许可，不是 API 能力**：2026 年官方政策要求在通过 API 访问任何 Reddit 数据前取得明确批准；商业使用需书面批准。当前许可原则上只允许复制、展示和为展示而格式化用户内容，AI 摘要属于改写或衍生使用，不能假设已被许可。
- **建议 MVP 先用 Hacker News 跑通闭环，同时提交 Reddit 申请**。在 Reddit 对“抓帖子与评论、生成摘要、公开展示、未来制作可能变现的视频”给出明确许可前，不应把 Reddit 设为上线的关键依赖。

## 推荐的 MVP 架构

```text
每日 Cron
  → Discovery Worker 拉 HN 榜单（Reddit 获批后再加）
  → D1 以 source + external_id 去重，保存候选和处理状态
  → Queue: fetch-item / fetch-comments
  → Consumer 受控抓评论、清洗 HTML、计算规则分
  → R2（可选）保存短期原始 JSON
  → Queue: summarize
  → Workers AI 生成摘要、要点、标签和候选分
  → D1 保存发布内容、模型和 prompt 版本
  → Pages 静态前端通过轻量 Worker/Pages Function 读取
```

Cron 只负责“发现并入队”，不要在一次定时调用中串行展开大量评论树和完成全部 AI 工作。每个队列任务只携带 `source`、`external_id`、`stage` 等小字段；正文放 D1 或 R2。所有任务以唯一键和状态机实现幂等。

## Cloudflare 组件的适用边界

### Pages

- Pages 适合静态 UI、内容列表和阅读页。免费计划每月 500 次构建、同时 1 个构建、单次构建最多 20 分钟；每站最多 20,000 个文件，付费计划最多 100,000 个；单文件上限 25 MiB。[Pages Limits](https://developers.cloudflare.com/pages/platform/limits/)
- 静态资源请求免费且不限量；Pages Functions 按 Workers 请求和计算配额计费。[Pages Functions Pricing](https://developers.cloudflare.com/pages/functions/pricing/)
- 因此不建议“每天把新内容编译进静态站并重新部署”。更稳妥的是固定部署前端，让页面从 Worker API/D1 读取每日内容。未来视频或大媒体文件也不应作为 Pages asset；单文件超过 25 MiB 时应使用 R2。

### Workers 与 Cron Triggers

- Workers Free：100,000 请求/日、每次调用 10 ms CPU、128 MB 内存、每次 50 个外部 subrequests、最多 6 个同时外连；Paid：最低 $5/月，含 1,000 万请求/月和 3,000 万 CPU-ms/月，普通调用默认 30 秒 CPU、最高可配置到 5 分钟，默认 10,000 个 subrequests；静态资源请求免费且不限量。[Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)、[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- 等待外部 `fetch()`、D1、R2 等 I/O 不计 CPU，但 JSON 解析、HTML 清洗、排序和 prompt 拼装会计入 CPU。[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- Cron 通过 `scheduled()` handler 运行，官方明确把“定期调用第三方 API 收集最新数据”列为适用场景；Cron 使用 UTC，配置变更最多约 15 分钟传播。[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- 每账户 Cron 数量为 Free 5 个、Paid 250 个。Free Cron 仍只有 10 ms CPU；Paid 计划中，间隔小于 1 小时的 Cron 有 30 秒 CPU，间隔至少 1 小时的 Cron 可到 15 分钟；Cron wall time 为 15 分钟。[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)

**判断**：每日一次的流量很小，但 Free 的 10 ms CPU 对解析多份 JSON、处理评论和组 prompt 太紧。可先用 Free 做极小原型；要稳定运行，建议从一开始预算 Workers Paid 的最低 $5/月，并让 Cron 只做发现和入队。

### Queues

- Queues 已包含在 Workers Free 中：Free 每日含 10,000 次操作，消息保留固定 24 小时；Paid 每月含 1,000,000 次操作，超出 $0.40/百万，默认保留 4 天、最长 14 天。[Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/)、[Queues Free-plan announcement](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/)
- 一条小于 64 KB 且成功消费的消息通常产生 3 次操作：写、读、删；每次重试再产生读操作。计费按每 64 KB 分段，而单条消息上限为 128 KB。[Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- 单队列 5,000 消息/秒、最大积压 25 GB；consumer batch 最大 100 条，`sendBatch` 最大 100 条且总计不超过 256 KB；consumer wall time 15 分钟，最多重试 100 次。[Queues Limits](https://developers.cloudflare.com/queues/platform/limits/)

**判断**：每天几十到几百条内容时，免费操作量足够。Queue 不是 MVP 的硬性依赖，但它能显著改善失败重试和 Reddit/HN 限流控制。消费者必须幂等，并配置 Dead Letter Queue。

### D1

- D1 是 Cloudflare 托管的 serverless 数据库，使用 SQLite SQL 语义，可直接供 Workers 和 Pages 查询。[D1 Overview](https://developers.cloudflare.com/d1/)
- Free：每天 500 万 rows read、100,000 rows written，总存储 5 GB；Paid：每月含 250 亿 rows read、5,000 万 rows written 和 5 GB，超出分别为 $0.001/百万行读取、$1/百万行写入、$0.75/GB-month；无 D1 数据传输费用。[D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- Free 最多 10 个数据库、单库 500 MB；Paid 最多 50,000 个数据库、单库 10 GB。每次 Worker 调用的 D1 查询数为 Free 50、Paid 1,000；单行/string/BLOB 最大 2 MB；单条 SQL 和整个 batch 最长 30 秒。[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- 单个 D1 数据库本质上单线程、按顺序处理查询；并发过高会先排队，队列满后返回 overloaded。[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)

**判断**：D1 很适合 `sources`、`items`、`comments`、`fetch_runs`、`summaries`、`candidates` 和删除同步状态。使用 `UNIQUE(source, external_id)` 去重，并给 `published_at`、`status`、`score`、`last_checked_at` 建索引。不要把完整大评论树塞进单个 JSON 行。

### R2

- R2 的免费月额度为 10 GB-month、100 万 Class A 操作、1,000 万 Class B 操作；Standard 价格分别为 $0.015/GB-month、$4.50/百万 Class A、$0.36/百万 Class B，互联网出口流量免费。[R2 Pricing](https://developers.cloudflare.com/r2/pricing/)
- 每桶容量和对象数量不限；单对象约 4.995 TiB，同一个 key 每秒最多 1 次写入。`r2.dev` 公共地址只用于测试并存在可变限流，生产需绑定自定义域名。[R2 Limits](https://developers.cloudflare.com/r2/platform/limits/)

**判断**：首版若只保留规范化短文本，D1 即可。需要审计、重跑摘要或保存图片/音频/成片时再加入 R2；原始数据可按 `raw/{source}/{date}/{id}.json` 保存，但 Reddit 数据还必须遵守其删除与保留限制。

### Workers AI

- Free 和 Paid 均可用 Workers AI；每天免费 10,000 Neurons，00:00 UTC 重置。Free 超额后停止服务；Paid 的超额部分为 $0.011/1,000 Neurons。[Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- Neuron 是跨模型的 GPU 计算单位，不同模型的输入与输出 token 换算率不同，不能把“10,000 Neurons”直接换成固定篇数。应在选定模型后用真实语料测算。
- 默认速率上限中，Summarization 为 1,500 请求/分钟，Text Generation 为 300 请求/分钟；每日批处理通常不会先碰到 RPM，实际瓶颈更可能是上下文长度、输出量和内容源合规。[Workers AI Limits](https://developers.cloudflare.com/workers-ai/platform/limits/)

**判断**：先用规则选出高分评论，再把有限上下文送入模型。保存 `model`、`prompt_version`、`input_hash`、用量和结果，避免重复推理。Workers AI 能解决工程上的摘要任务，但不会自动解决 Reddit 对内容改写、衍生用途和第三方处理的许可问题。

## Reddit Data API

### 能取到什么

- 官方接口支持 `GET /r/{subreddit}/new`、`/hot`、`/top`；listing 默认 25 条、最多 100 条，使用 `after`/`before` 分页；`top` 支持 `t=hour|day|week|month|year|all`。[Reddit API documentation](https://www.reddit.com/dev/api/)
- `GET /r/{subreddit}/comments/{article}` 返回指定帖子的评论树，可设置 `sort`、`depth`、`limit`；未展开的分支需继续调用 `/api/morechildren`。[Reddit API documentation](https://www.reddit.com/dev/api/)
- 官方接口没有承诺“按 subreddit 获取全部历史评论”或评论搜索。因此可靠流程是“帖子榜单/列表 → 逐帖抓评论树”，不能把第一阶段描述为完整归档 Reddit。

### 审批、认证与速率

- 2026 年的 Responsible Builder Policy 明确要求：在通过 API 访问任何 Reddit 数据前，必须申请并取得明确批准。[Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
- 当前 Data API Wiki 要求 OAuth；客户端必须发送唯一、描述性的 User-Agent，且不得掩饰 OAuth 身份。无 OAuth 或登录凭据的流量会被阻断。[Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)
- 对无用户上下文的服务端任务，官方仍链接的 OAuth2 文档支持 `client_credentials` 换取 app-only bearer token；token 从 `https://www.reddit.com/api/v1/access_token` 获取，API 请求发往 `https://oauth.reddit.com`。[Reddit OAuth2 documentation](https://github.com/reddit-archive/reddit/wiki/OAuth2)
- 对“符合免费访问资格”的客户端，限制为每个 OAuth client id 100 QPM，目前按 10 分钟窗口平均；应持续读取 `X-Ratelimit-Used`、`X-Ratelimit-Remaining`、`X-Ratelimit-Reset`。[Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)

### 展示、AI 与商业限制

- Data API Terms 只授予为运行 App 而复制、展示用户内容的可撤销许可，且除“为展示而格式化”外不得修改；用户内容权利仍属于用户。未经权利人明确许可，不得将用户内容用于训练 AI/ML。[Reddit Data API Terms](https://redditinc.com/policies/data-api-terms)
- Developer Terms 禁止未经许可使用 Reddit 数据训练 LLM、AI 或其他算法模型或相关服务；同时禁止未获书面批准的企业代用、产品变现，以及从 Reddit 数据或衍生数据直接或间接获利。[Reddit Developer Terms](https://redditinc.com/policies/developer-terms)
- AI 推理式摘要不等同于训练，但摘要会改写原文并形成衍生内容，明显超出“只为展示而格式化”的安全范围。将原始帖子和评论发送给 AI 服务也涉及第三方处理。**因此必须在 Reddit 申请中明确描述摘要流程、模型提供方、存储期、公开展示和未来视频/变现用途，并取得足够明确的批准；不能仅凭 API token 推定获准。**
- 展示时必须逐条链接回 Reddit 原内容、标明适用用户名、清楚说明内容来自 Reddit；不得暗示与 Reddit 存在合作、赞助或背书。[Reddit Developer Terms](https://redditinc.com/policies/developer-terms)

### 删除与同步义务

- 帖子或评论从 Reddit 删除后，必须删除标题、正文、嵌入 URL 等所有相关内容；账号删除后，还必须删除用户 ID、用户名、主页 URL、头像、flair 等作者识别字段。即使去标识或匿名化，也不能继续保留已删除内容。官方强烈建议常规清理存储的用户数据与内容，使其不超过约 48 小时未复核。[Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)
- 如果源内容被删除、设为受保护、停用、隐藏、修改或移除，开发者应尽快同步删除或修改 User Content 及相关 App Content。个人数据删除请求须在 10 天内安全删除，包括衍生物。[Reddit Developer Terms](https://redditinc.com/policies/developer-terms)、[Developer Data Protection Addendum](https://redditinc.com/policies/developer-dpa)
- 授权终止后，必须停止使用并删除缓存或存储的 Reddit 内容和材料。[Reddit Data API Terms](https://redditinc.com/policies/data-api-terms)

**对产品的直接影响**：若摘要和未来视频基于 Reddit 原文/评论生成，删除流程必须能级联删除或下架原文、作者字段、摘要和相关衍生资产。仅保存摘要而删除原文并不能规避义务。

## Hacker News 官方 Firebase API

- 官方 API 基础地址为 `https://hacker-news.firebaseio.com/v0/`，数据接近实时，当前没有速率限制，也没有文档要求的 OAuth。[Official Hacker News API](https://github.com/HackerNews/API)
- `/topstories` 和 `/newstories` 各返回最多 500 个 ID（top 也包含 jobs），另有 `/beststories`；`/askstories`、`/showstories`、`/jobstories` 各返回最多 200 个最新 ID；`/maxitem` 可用于从当前最大 item ID 向后发现内容。[Official Hacker News API](https://github.com/HackerNews/API)
- `/item/{id}.json` 同时承载 story、comment、job、poll 等类型。story 含 `title`、`url`、`score`、`descendants`、`kids`；comment 含 `text`、`parent`、`kids`。`kids` 是按展示顺序排列的子评论 ID。[Official Hacker News API](https://github.com/HackerNews/API)
- API 是底层内存结构的映射。要得到完整评论树或准确评论数，必须逐层读取 ID 并遍历；一个热帖可能产生大量 N+1 请求。[Official Hacker News API](https://github.com/HackerNews/API)
- item 可能带 `deleted=true` 或 `dead=true`，应同步剔除或更新。Firebase 支持订阅单个 item/profile；`/updates` 返回近期变化的 item/profile，但官方没有承诺它是具有完整历史和固定保留期的可靠事件日志。[Official Hacker News API](https://github.com/HackerNews/API)
- v0 会演进，变化并不总是向后兼容；客户端应忽略未知新增字段，并对缺失可选字段和 `null` 做容错。[Official Hacker News API](https://github.com/HackerNews/API)

**MVP 抓取策略**：

1. 每天重拉 `topstories`、`beststories` 和可选的 `askstories`。
2. 先抓 story 元数据，用分数、时间、评论数和主题规则筛选。
3. 只对候选帖递归抓评论，设置总评论数 `N`、最大深度 `D`、并发和超时预算。
4. 优先抓 `kids` 前部及高价值分支；保存抓取游标和失败状态。
5. 每日复查已发布 item 的 `deleted`/`dead` 状态，不把 `/updates` 当唯一同步来源。

官方 API 的“无速率限制”不等于无容量边界，也不是内容版权或视频再利用许可。应礼貌限流、缓存 item，并对从 HN 用户内容生成公开摘要/视频单独评估内容权利。

## 第一阶段实施建议

### 可立即做

- 数据源仅启用 Hacker News。
- 每日采集约 50–100 个榜单 story，规则筛到 10–20 个候选，只对候选抓最多 50–100 条评论、最多 3–5 层。
- Pages + Worker + Cron + D1 为必需组件；Queue 建议加入；R2 暂缓。
- AI 只处理已筛选的有限评论，输出 `一句话事实 / 为什么有趣 / 评论补充与争议 / 来源链接`，并保留人工复核状态。
- 建立来源跳转、纠错/下架入口和删除状态同步。

### Reddit 接入前的硬性门槛

1. 提交并取得 Reddit 对该具体 use case 的明确批准。
2. 明确确认 AI 摘要、第三方模型处理、公开展示和未来短视频/变现是否允许。
3. 完成逐条署名与回链。
4. 建立至多 48 小时一次的源状态复核，以及对原文、作者字段、摘要和衍生资产的级联删除。
5. 发布隐私政策，说明收集、使用、存储、共享和删除方式。

### 费用判断

- 纯 HN 小规模 MVP 可以在 Cloudflare 免费额度内试跑。
- 为避免 Free Worker/Cron 的 10 ms CPU 不稳定，推荐实际运行时采用 Workers Paid，基础成本约 **$5/月**。
- 在每天几十次有限摘要的规模下，D1、Queue、R2 和 Workers AI 很可能仍处于各自免费包含量内；AI 成本必须用选定模型和真实 token/neuron 用量验证，不能仅按“每天几篇”估算。

## 风险排序

| 优先级 | 风险 | 影响 | 缓解 |
|---|---|---|---|
| P0 | Reddit 未审批或摘要/商业用途未获许可 | API 被拒、下架或法律风险 | Reddit 不作为首发依赖；申请中完整披露用途 |
| P0 | Reddit 删除/修改未级联到摘要和视频 | 持续保留被删除内容或衍生物 | 48 小时复查、状态表、级联删除/下架 |
| P1 | HN/Reddit 评论树请求爆炸 | 超时、限流、成本和稳定性问题 | 候选后再抓评论；设置 N/D/并发预算；Queue 重试 |
| P1 | AI 摘要失真或把评论意见写成事实 | 科普质量和声誉风险 | 来源分离、可追溯引用、置信标记、人工发布闸门 |
| P2 | Free Cron 10 ms CPU 不足 | 定时任务偶发失败 | Workers Paid；Cron 只入队；分批处理 |
| P2 | 平台配额/政策变化 | 无预警失败或成本变化 | 配额告警、功能开关、每季度复核官方条款 |

## 专项核查：old Reddit 与 URL 后缀 `.json`

> 测试时间：2026-07-23 14:33–14:36（Asia/Shanghai）。仅做一次读取，不分页、不抓评论、不重试轰炸。

### 本次可用性测试

| 地址 | 观察结果 | HTTP 状态说明 |
|---|---|---|
| `https://old.reddit.com/r/todayilearned/` | 成功取得并渲染完整 HTML 列表 | **200** |
| `https://old.reddit.com/r/todayilearned/.json` | 联网读取通道在发出请求前被自身 URL 安全层拒绝，未取得 Reddit 响应 | **未测得**，不能把客户端拒绝解释为 Reddit 的 4xx/5xx |
| `https://www.reddit.com/r/todayilearned/.json` | 成功取得 `application/json`，内容为 25 条 Listing；加 `?limit=1` 也成功 | **200** |
| `https://www.reddit.com/r/todayilearned/comments/{article}.json` | 以一个公开帖子做最小只读验证，匿名返回评论 Listing | **200** |

另用本地 `curl` 对三个地址各探测一次，均在建立 HTTP 连接前因当前执行环境 DNS 无法解析 Reddit 域名而返回 curl 状态 `000`。`000` 不是服务器 HTTP 状态码，所以不能据此判断 Reddit 是否可用。综合而言，本次只能确认 **old Reddit HTML 和 `www.reddit.com/.../.json` 在某些无登录读取环境中仍可返回内容**；old Reddit 的 `.json` 此次结果不确定。

上述 200 状态由同日的最小只读验证取得。这个瞬时测试说明的是“今天某个读取路径能打开”，不说明 Reddit 承诺它可供自动化、可免 OAuth、可从 Cloudflare IP 稳定使用，亦不改变内容许可。

### 官方是否把 `.json` 或 old Reddit 视为免 OAuth 公共 API

没有找到这样的当前官方承诺。相反：

- 2026 年更新的 Data API Wiki 明确写明 **Reddit requires OAuth for authentication**；无 OAuth 或登录凭据的流量将被阻断。它还说明 `robots.txt` 是给搜索引擎的，不是 Data API 用户的授权依据。[Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)
- Responsible Builder Policy 要求在通过 API 访问任何 Reddit 数据前申请并得到明确批准。[Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
- Reddit 的 live API 文档确实记录了 Listing、评论树和 JSON 响应格式，但没有把在普通网页 URL 后追加 `.json` 定义为绕过 OAuth、审批、速率或条款的例外。[Reddit API documentation](https://www.reddit.com/dev/api/)

所以，`www.reddit.com/r/.../.json` 当前偶尔能匿名返回 JSON，只能视为未保证的站点行为或兼容路径，**不能作为官方授予的免 OAuth 公共 API 合同**。抓取 old Reddit HTML 同理：页面向浏览器公开不等于 Reddit 许可程序化采集、缓存、改写或商业使用。

### 条款是否覆盖“网页/`.json` 绕过 API”

覆盖风险非常明确，不能靠换 hostname 或响应格式规避：

- Data API Terms 开头规定：对通过 Data APIs **或不通过 Data APIs** 从 Reddit Services 取得的 Materials，都只能依照 Data API Terms 使用；并禁止绕过或超过 API 限制。[Reddit Data API Terms](https://redditinc.com/policies/data-api-terms)
- Developer Terms 对 “Reddit Services and Data” 的限制不是只绑定 `oauth.reddit.com`；它禁止通过 API、索引、缓存或抓取等任何方式访问或使用相关数据去规避限制，并禁止掩饰访问方式或目的。[Reddit Developer Terms](https://redditinc.com/policies/developer-terms)
- Reddit User Agreement 适用于网站、API 和其他 Reddit 服务。old Reddit HTML 仍是 Reddit 服务的一部分，不是独立授权的数据集。[Reddit User Agreement](https://redditinc.com/policies/user-agreement)

因此，从 `old.reddit.com` 解析 HTML，或给普通 URL 加 `.json`，不会消除审批、署名、内容改写、商业用途、保留和删除义务；若目的是绕过 OAuth 或速率控制，反而会增加违反“不得规避”的风险。

### Cloudflare/托管 IP 的访问要求

Reddit 2026 年的官方访问说明明确指出：如果请求来自托管服务提供商的 IP netblock，必须具有有效 OAuth token 或已登录；Reddit 可在特定情况下自行作例外。[Developer Platform & Accessing Reddit Data](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data)

Cloudflare Workers 是托管边缘运行环境。把上述规则应用到本项目的合理工程结论是：即使家用浏览器或某个搜索读取器可以匿名访问，来自 Cloudflare 出口的定时抓取仍可能被要求 OAuth，或直接得到 403/429/挑战页面。不能用本地成功结果推断 Worker 生产环境成功；上线前必须在获批 OAuth 客户端下，从实际 Worker 环境做小流量验证。

### 可持续性、速率和封禁判断

- **可持续性低**：old Reddit HTML 结构和匿名 `.json` 行为没有当前官方稳定性承诺，字段、页面结构、访问控制可随时改变。
- **速率不可规划**：官方公布的 100 QPM 是“符合免费资格的 OAuth client id”的限制，不是匿名 `.json` 或 HTML 抓取的免费额度。匿名请求没有可依赖的配额合同，也拿不到可稳定遵循的 OAuth 限流身份。[Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)
- **封禁风险高**：Data API Terms 允许 Reddit 设置和执行限制，并可对规避、超量或滥用访问永久阻断；Developer Terms 也允许 Reddit 暂停或终止访问。[Reddit Data API Terms](https://redditinc.com/policies/data-api-terms)、[Reddit Developer Terms](https://redditinc.com/policies/developer-terms)
- **内容合规不变**：即便技术上取到 JSON，公开展示、AI 摘要、第三方模型处理、视频制作、商业化和删除同步仍受前述限制。

**专项结论**：old Reddit 或 `.json` 可以用于人工验证 Reddit 当前公开页面的形态，但不应成为 MVP 的生产采集方案，也不是对 OAuth、审批或条款的合法技术替代。生产方案仍应是“先获批 → 使用明确身份的 OAuth → 遵守响应限流头 → 小流量、缓存与退避 → 实施删除同步”；若未获批，则继续以 Hacker News 作为首发数据源。

## 专项核查：Cloudflare Worker 的 Reddit OAuth 落地流程

> 核查日期：2026-07-23。目标场景是 Cloudflare Worker 每日读取公开 subreddit 的帖子与评论，不代表终端用户操作，也不需要终端用户登录 Reddit。

### 先区分两层文档

Reddit 当前文档存在明确的层级差异：

1. **2026 当前政策与 Help Center 是准入依据**：必须先申请并取得明确批准；必须用注册的 OAuth token；无 OAuth/登录流量会被阻断；托管服务商 IP 必须 OAuth 或登录。[Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)、[Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)、[Developer Platform & Accessing Reddit Data](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data)
2. **具体 OAuth 报文仍来自 legacy GitHub wiki**：2026 Data API Wiki 当前仍主动链接该 OAuth2 页面作为技术指导，但同一页警告部分 legacy API 文档可能过时，规则和条款应以当前 Developer Terms/Data API Terms 为准。[Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)、[Legacy OAuth2 documentation](https://github.com/reddit-archive/reddit/wiki/OAuth2)

因此，`client_credentials` 是这个“无用户上下文的保密服务端客户端”最匹配的 Reddit 第一方已发布机制，但不能表述为 Reddit 在 2026 年重新确认的、对所有新应用保证开放的推荐流程。**获批邮件或 App Review 给出的 client 类型、grant、scope、费用和访问方式优先于 legacy wiki。**

### 申请、审批和创建 client 的顺序

1. 准备一个状态良好的 Reddit 账号，并阅读 Responsible Builder Policy、Developer Terms、Data API Terms。
2. Reddit 当前优先要求开发者考虑 Devvit；本项目运行在 Cloudflare、需要离站采集和展示，Devvit 不支持时，使用官方 **Request Data Access** 表单申请。[Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)、[Request Data Access form](https://support.reddithelp.com/hc/en-us/requests/new?tf_42139884615700=api_request_type_developer_clone&ticket_form_id=14868593862164)
3. 表单中如实写明：目标 subreddit、每天请求量、帖子和评论字段、Cloudflare 托管、保存期、48 小时删除复核、公开展示、AI 摘要、Workers AI/第三方处理、未来视频和是否变现。表单会询问用途、分发位置、受众、时间线、数据预算、为什么 Devvit 不适用，以及源码/平台链接。
4. 若现在或未来属于商业使用，应走 commercial/enterprise 入口并取得明确书面批准及所需合同。[Commercial data-access form](https://support.reddithelp.com/hc/en-us/requests/new?tf_42139884615700=api_request_type_enterprise_clone&ticket_form_id=14868593862164)、[Developer Platform & Accessing Reddit Data](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data)
5. **等待 explicit approval，不要把提交 ticket、创建 Reddit 账号或能匿名打开 `.json` 当作批准。**
6. 获批后按 Reddit 给出的下一步注册 OAuth client。legacy OAuth 文档把 client 创建位置写为 `https://www.reddit.com/prefs/apps`；对能保管 secret、在自有服务端执行的客户端，`web` 和 `script` 都属于 confidential client，而 `installed` client 不能保管 secret。[Legacy OAuth2 documentation](https://github.com/reddit-archive/reddit/wiki/OAuth2)

对于本项目，不应选择 `installed`，因为 Worker 是受控服务端且没有终端用户设备。`script` 的旧说明是只访问登记为该 App developer 的账号；本项目不代表用户操作，只读取公开内容。最终应在申请中明确询问 Reddit 应创建 `web` 还是 `script`，并以批准回复为准，不能仅根据旧 UI 自行假定。

### App-only `client_credentials` 报文

在 Reddit 当前仍链接的 legacy OAuth 文档中，无用户上下文的 confidential client 使用以下流程：

```http
POST https://www.reddit.com/api/v1/access_token
Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET)
Content-Type: application/x-www-form-urlencoded
User-Agent: cloudflare:<approved-app-id>:<version> (by /u/<reddit-username>)

grant_type=client_credentials
```

- HTTP Basic 的用户名是 `client_id`，密码是 `client_secret`；`grant_type` 必须放在 form body，不是 URL 中。[Legacy OAuth2 documentation](https://github.com/reddit-archive/reddit/wiki/OAuth2)
- legacy 文档没有要求 app-only `client_credentials` 在 token 请求中另传 `scope`；成功响应会返回 `access_token`、`token_type=bearer`、`expires_in` 和 `scope`。不要自行追加未获批 scope；以 Reddit 为获批 client 返回的 scope 为准。[Legacy OAuth2 documentation](https://github.com/reddit-archive/reddit/wiki/OAuth2)
- access token 有效期为 1 小时；app-only token **没有 `refresh_token`**。到期前需要重新执行 `client_credentials` token 请求。[Legacy OAuth2 documentation](https://github.com/reddit-archive/reddit/wiki/OAuth2)
- 调用数据接口时使用：

```http
GET https://oauth.reddit.com/r/todayilearned/top?t=day&limit=100
Authorization: bearer <ACCESS_TOKEN>
User-Agent: cloudflare:<approved-app-id>:<version> (by /u/<reddit-username>)
```

API base URL 应为 `https://oauth.reddit.com`，不是 `www.reddit.com`。帖子列表和评论树端点需要 live API 文档所标示的 `read` 能力；实际 token 是否具有所需 scope/能力必须以获批 client 的响应和 Reddit 配置为准。[Legacy OAuth2 documentation](https://github.com/reddit-archive/reddit/wiki/OAuth2)、[Reddit API documentation](https://www.reddit.com/dev/api/)

### User-Agent 与限流

- 每个 token 和 API 请求都应发送唯一、描述性的 User-Agent，格式为 `<platform>:<app ID>:<version> (by /u/<reddit username>)`。不能使用默认 `Python/urllib`、`Java` 等，也不能伪造身份。[Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)
- 对符合免费访问资格的 OAuth client，当前限制为每个 client id 100 QPM，按 10 分钟窗口平均。每个响应都要读取：
  - `X-Ratelimit-Used`
  - `X-Ratelimit-Remaining`
  - `X-Ratelimit-Reset`
- 当 Remaining 接近 0 时，按 Reset 暂停，不应通过创建多个 client、换 hostname 或匿名 `.json` 绕过。[Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)

### Cloudflare 中的 secret 存储

- `CLIENT_SECRET` 必须放在 Worker secret binding 中，使用 Wrangler 的 secret 命令或 Dashboard Secrets 添加；不要写入源码、`wrangler.toml/jsonc` 明文、Pages 前端、D1、日志或公开仓库。[Cloudflare External Services: Authentication](https://developers.cloudflare.com/workers/configuration/integrations/external-services/)
- `CLIENT_ID` 不是密码，但为减少配置分散，也可作为 secret/config binding；User-Agent 版本可用普通环境变量。
- access token 是短期凭据，同样不得写日志或返回给浏览器。单个每日 Cron 内可获取一次并在内存复用；若 Queue consumer 并发跨多个 invocation，应使用一个受控 token broker/协调层缓存到 `expires_in` 前，并避免每条消息都打 token endpoint。不要把 bearer token 放进 Queue 消息。

### 到期、失败和重试策略

以下是基于 Reddit 官方 token 生命周期和限流头的实现建议：

1. token 缓存保存 `expires_at = now + expires_in`，提前约 60–120 秒视为过期；app-only 无 refresh token，所以重新请求 token。
2. 同一批任务只允许一个刷新动作，其他任务等待结果，避免 refresh stampede。
3. API 返回 `401`：清除缓存 token，重新取得一次 token并只重放一次请求；第二次仍为 401 就停止该批次并报警，检查批准状态、client secret 和 grant。
4. `403`：不要高速重试；通常需要检查 App approval、scope、subreddit 可见性或 Reddit enforcement。
5. `429` 或 `X-Ratelimit-Remaining` 见底：至少等待 `X-Ratelimit-Reset`，再加少量 jitter；不能切换到匿名 `.json` 继续抓。
6. `5xx`、网络超时：指数退避并加 jitter，设置最大次数，交给 Queue/DLQ；避免递归无界重试。
7. token endpoint 自身 `401`：legacy 文档将其归因于 HTTP Basic client credentials 无效；检查 client id/secret 是否正确，不能把同一失败凭据无限重试。[Legacy OAuth2 documentation](https://github.com/reddit-archive/reddit/wiki/OAuth2)
8. Reddit 可撤销 token、暂停 App/账号或改变 API；连续认证失败应触发“暂停 Reddit 数据源”开关，而不是影响 HN 和站点读取服务。[Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)、[Reddit Developer Terms](https://redditinc.com/policies/developer-terms)

### 上线前必须向 Reddit 明确确认的项目

- 批准的 client 类型是 `web` 还是 `script`；
- 是否允许 app-only `client_credentials`，以及是否有替代 grant；
- 公共帖子/评论读取所授予的 scope；
- 免费还是付费、实际 QPM 和其他配额；
- AI 摘要和 Workers AI 作为处理方是否获准；
- 摘要、删除后的衍生内容及未来视频的处理要求。

在这些项目未由 Reddit 明确确认前，可以完成 OAuth 模块和 mock 测试，但不能把“legacy wiki 中存在 `client_credentials`”等同于生产访问已获授权。
