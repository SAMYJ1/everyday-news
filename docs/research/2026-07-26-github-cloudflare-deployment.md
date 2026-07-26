# GitHub 驱动 Cloudflare 部署调研

日期：2026-07-26

## 结论

可行。GitHub 可以作为代码托管和部署触发器，但不能绕过 Cloudflare 身份认证与首次资源初始化。

对当前 `everyday-news` monorepo，推荐使用 **GitHub Actions + Cloudflare Wrangler Action** 统一编排 Worker、D1 migration 和 Pages 的部署顺序。Cloudflare 原生 Git 集成也可用，但 Pages 与 Workers 分开构建时，跨服务依赖、数据库迁移和发布后探活更难集中控制。

## 可选方案

### 1. Cloudflare Pages Git integration

Pages 可连接 GitHub 仓库，在提交时构建并部署；可配置生产分支、预览分支、构建命令和 monorepo 根目录。它适合单独托管 `apps/web`。

局限是它只覆盖前端发布，Worker、D1 migration、Queue 初始化仍需另一条部署路径。

官方文档：

- [Git integration · Cloudflare Pages](https://developers.cloudflare.com/pages/configuration/git-integration/)
- [GitHub integration · Cloudflare Pages](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/)
- [Build configuration · Cloudflare Pages](https://developers.cloudflare.com/pages/configuration/build-configuration/)

### 2. Cloudflare Workers Builds

Workers Builds 可连接 Git 仓库，并在推送后构建、部署 Worker；也支持配置生产分支、构建命令、根目录及环境变量。它适合单独部署 `apps/worker`。

与 Pages Git integration 组合后配置较少，但会形成两个独立发布流水线。D1 migration 的执行时机、Worker URL 向前端构建变量的传递，以及跨服务失败回滚，需要额外约定。

官方文档：

- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

### 3. GitHub Actions + Wrangler Action（推荐）

Cloudflare 官方 `cloudflare/wrangler-action` 可在 GitHub Actions 中运行 Wrangler 命令，通过 `apiToken` 和 `accountId` 认证，并支持指定工作目录或自定义命令。因此可以在一个 workflow 中串联验证、迁移、Worker 部署、Web 构建、Pages 部署和探活。

官方资料：

- [cloudflare/wrangler-action](https://github.com/cloudflare/wrangler-action)
- [Deploy with GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

## 推荐发布顺序

仅让受保护的生产分支（例如 `main`）执行生产部署；Pull Request 只运行验证，或发布到明确隔离的预览环境。

1. `npm ci`
2. `npm test`
3. `npm run typecheck`
4. `npm run build`
5. `wrangler d1 migrations apply <DATABASE_NAME> --remote`
6. `wrangler deploy --config apps/worker/wrangler.jsonc`
7. 使用生产 Worker URL 注入 `VITE_API_BASE_URL`，重新构建 `apps/web`
8. `wrangler pages deploy apps/web/dist --project-name everyday-news --branch main`
9. 对 Worker 健康端点和 Pages 首页做只读 smoke test

D1 migration 应在 Worker 发布前执行，并保证迁移向后兼容；否则新 Worker 可能访问尚未升级的 schema。D1 migration 命令与 CI 用法见 [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)。

## 首次 bootstrap 仍需完成

GitHub 自动部署之前，需在 Cloudflare 账户中完成一次性资源创建并把稳定标识写入配置：

- 创建 D1 database，把 Wrangler 返回的精确 `database_id` 加入 `apps/worker/wrangler.jsonc`。
- 创建 `everyday-news-pipeline` Queue 和 `everyday-news-dead-letter` DLQ。
- 创建或确认 Pages 项目 `everyday-news`。
- 设置 Worker secrets：`ADMIN_KEY`、`REDDIT_USER_AGENT`，以及生产配置所需的 `APP_ORIGIN`。
- 创建最小权限 Cloudflare API token，并将 token 与 account ID 放入 GitHub Actions secrets。
- 将本地仓库连接到 GitHub；当前仓库尚未配置 Git remote。

相关官方文档：

- [Create API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [D1 getting started](https://developers.cloudflare.com/d1/get-started/)
- [Queues getting started](https://developers.cloudflare.com/queues/get-started/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Secrets 与安全边界

- GitHub 中只保存部署所需的 Cloudflare API token、account ID，以及前端可公开的构建配置。
- Cloudflare API token 使用最小权限，并通过 GitHub Environment 限制生产部署分支和审批人；不要使用 Global API Key。
- `ADMIN_KEY` 与 `REDDIT_USER_AGENT` 应作为 Worker runtime secrets 直接保存在 Cloudflare，而不是注入 Pages 构建或打包进浏览器代码。
- `VITE_*` 变量会进入前端 bundle，必须视为公开信息；`VITE_API_BASE_URL` 可以公开，但不得放管理员密钥。
- Pull Request（尤其 fork PR）不得获得生产 secrets，也不得运行远程 D1 migration 或生产部署。
- Action 依赖建议固定到明确版本；生产 workflow 应设置最小 GitHub `permissions`。

## 当前仓库差距

1. `.github/workflows/ci.yml` 目前只运行测试、typecheck 和 build，没有 deploy job。
2. `apps/worker/wrangler.jsonc` 已声明 cron、Queue、DLQ 和 Workers AI，但尚无 D1 binding 与精确 `database_id`。
3. 当前本地环境未完成 Cloudflare 认证；迁移和部署尚未对真实账户验证。
4. 仓库没有 Git remote，因此还不能由 GitHub 触发 workflow。
5. 需要确定生产 Worker URL，并在 Web 构建阶段设置 `VITE_API_BASE_URL`。
6. 需要在 Cloudflare 上设置 Worker runtime secrets，并建立生产域名/CORS 的 `APP_ORIGIN`。

建议下一步是在完成一次性 Cloudflare bootstrap 和 GitHub remote 连接后，新增独立的 `deploy.yml`：复用现有 CI 验证，并只允许 `main` 或手动 `workflow_dispatch` 发布生产环境。
