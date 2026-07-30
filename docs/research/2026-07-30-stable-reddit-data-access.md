# 稳定访问 Reddit 数据的可行路径

日期：2026-07-30

## 结论

本地、VPS 和 Cloudflare Worker 都收到 403，主要原因不是 VPS 地域或 Cloudflare 出口，而是 Reddit 已关闭未认证的 `.json` 访问，并明确表示未使用 OAuth 或登录凭据的请求会被阻断。更换 IP、增加 VPS、Cloudflare Mesh 或代理不能形成稳定方案，也可能被视为规避访问控制。

长期可用的主路径是：

1. 向 Reddit 提交 Data API 用例并取得明确批准。
2. 注册 Reddit OAuth 应用。
3. 后端取得 OAuth access token。
4. 使用 `https://oauth.reddit.com` 读取帖子和评论。
5. 遵守限流、User-Agent、删除同步和数据使用要求。

RSS 尚未被官方正式宣告关闭，但没有稳定性或配额承诺，实测也会触发 429。除 subreddit feed 外，帖子地址追加 `/.rss` 可以返回原帖及评论条目，因此足以支持低频、尽力而为的 MVP；但 feed 不提供可靠的点赞排序和回复层级，不能把结果描述为“最高赞评论”或完整评论树。

## 为什么匿名 JSON 现在返回 403

Reddit 在 2026 年宣布关闭未认证 `.json` 端点；登录和认证请求不受该变更影响。现行 Data API Wiki 同时写明，不使用 OAuth 或登录凭据的流量会被阻断。托管服务商网段还被特别要求必须带有效 OAuth token 或登录状态。

因此：

- `www.reddit.com/r/.../.json`、`api.reddit.com/...` 和无 token 的 `oauth.reddit.com/...` 都不再是可靠接口。
- 浏览器里能打开 Reddit，不代表匿名服务端请求能访问；浏览器可能带有登录 cookie 和其他会话信息。
- VPS、本地和 Cloudflare 都返回 403，与 Reddit 当前策略一致。

## 推荐 OAuth 流程

对每日读取公开 subreddit、无需代表具体用户操作的服务端任务，最匹配的是 application-only OAuth。Reddit 当前链接的 OAuth 技术资料仍记录了 confidential client 的 `client_credentials` 流程，但该资料属于 legacy 文档，因此实际使用仍必须以 Reddit 对本项目的审批结果为准。

### 获取 token

向以下地址发送表单请求：

```http
POST https://www.reddit.com/api/v1/access_token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded
User-Agent: cloudflare-worker:<app-id>:<version> (by /u/<reddit-username>)

grant_type=client_credentials
```

app-only token 不提供 refresh token；过期前重新请求 access token。

### 读取数据

```http
GET https://oauth.reddit.com/r/todayilearned/top?t=day&limit=20&raw_json=1
Authorization: Bearer <access_token>
User-Agent: cloudflare-worker:<app-id>:<version> (by /u/<reddit-username>)
```

评论示例：

```http
GET https://oauth.reddit.com/r/todayilearned/comments/<post-id>?sort=top&limit=20&depth=2&raw_json=1
Authorization: Bearer <access_token>
User-Agent: cloudflare-worker:<app-id>:<version> (by /u/<reddit-username>)
```

Worker 应缓存 token 至临近过期；遇到 401 时刷新一次，429 按响应头退避，403 视为权限或策略错误而不是持续重试。

## 当前项目的部署建议

- 将 `REDDIT_CLIENT_ID`、`REDDIT_CLIENT_SECRET` 设为 Cloudflare Worker secrets。
- 保留可识别的 `REDDIT_USER_AGENT`，不要使用浏览器 UA 或伪造身份。
- 监控 `X-Ratelimit-Used`、`X-Ratelimit-Remaining`、`X-Ratelimit-Reset`。
- 免费合资格 OAuth client 的公开默认限制为每分钟 100 次查询，按 10 分钟窗口平均；当前每日采集规模应远低于此值。
- 保存 Reddit 原帖链接和来源标注。
- 定期同步帖子、评论及作者删除状态，尽量缩短原始用户内容的本地留存时间。
- 在申请中明确用途是“读取公开帖子和评论，生成带来源链接的摘要”，使用 AI 做推理式摘要，不用于训练模型。

## 不推荐的路径

- 轮换 VPS、代理或 IP：不能解决认证要求，并有规避限制风险。
- Cloudflare Mesh：它解决私网组网，不会提供 Reddit API 身份。
- 浏览器 cookie 或自动化登录：脆弱、难维护，也不适合作为生产数据接口。
- 把 RSS 描述为精确的热门评论接口：评论 feed 可提供评论正文，但没有可靠点赞数和回复层级，也无正式稳定性或配额承诺，且可能触发 429。
- 继续依赖匿名 `.json`：Reddit 已明确弃用。

若 Reddit 审批尚未完成，可以用 subreddit RSS 做帖子发现、帖子 `/.rss` 做评论补充，并把 Hacker News 作为失败时的主降级源。抓取频率应保持很低、缓存已获取的 feed、避免针对 429 做秒级重试。也可评估与 Reddit 有合法授权的数据供应商。

## 官方来源

- [Reddit：Protecting communities from scrapers and platform abuse](https://www.reddit.com/r/modnews/comments/1tq9vxo/protecting_communities_from_scrapers_and_platform/)
- [Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)
- [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
- [Developer Platform & Accessing Reddit Data](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data)
- [Data API request form](https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164)
- [Reddit OAuth2 technical reference (legacy)](https://github.com/reddit-archive/reddit/wiki/OAuth2)
