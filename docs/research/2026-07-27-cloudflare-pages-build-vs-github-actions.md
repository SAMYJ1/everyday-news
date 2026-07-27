# Cloudflare Pages 原生构建与 GitHub Actions 对比

日期：2026-07-27

## 结论

Cloudflare Pages 可以直接连接当前 GitHub 仓库并自动构建 `apps/web`。但 Pages 的原生构建只适合负责前端；它没有为 Pages、Worker、D1 migration 提供跨项目的依赖编排或原子发布机制。

对于当前项目（Vite 前端 + 独立 Worker + D1 + Queues + Workers AI + Cron），推荐继续使用**单一 GitHub Actions 部署流水线**。原因是现有流水线已经按顺序执行测试、D1 migration、Worker 部署、Worker 探测、前端构建、Pages 部署和 Pages 探测。Pages Git integration 的主要额外收益是零配置的分支/PR 预览，而代价是把一次发布拆成两个独立系统。

如果更看重前端 PR 预览、能接受 Worker 与前端不保证先后顺序，可以采用“Pages Git integration 部署前端 + GitHub Actions 部署 Worker/D1”的混合模式。不要让 Pages build command 顺带部署 Worker 或执行生产 D1 migration。

## Pages Git integration 的可行配置

在 Cloudflare Dashboard 中选择 **Workers & Pages → Create application → Pages → Connect to Git**，连接 `SAMYJ1/everyday-news`。

建议设置：

| 设置 | 值 |
|---|---|
| Production branch | `main` |
| Root directory | 仓库根目录（留空或 `/`） |
| Build command | `npm run build -w @everyday-news/web` |
| Build output directory | `apps/web/dist` |
| Production env | `NODE_VERSION=22` |
| Production env | `VITE_API_BASE_URL=https://<worker>.workers.dev` |
| Preview env | `NODE_VERSION=22` |
| Preview env | `VITE_API_BASE_URL=https://<worker>.workers.dev` |

保留仓库根目录是因为 `package-lock.json` 和 npm workspaces 配置位于根目录。Cloudflare Pages 支持 monorepo 的自定义 root/build/output 设置，也会自动安装依赖；Pages build image 可以通过 `NODE_VERSION` 或 `.nvmrc`/`.node-version` 固定 Node 版本。

`VITE_API_BASE_URL` 是前端构建变量，会进入浏览器产物，不应视为 secret。Pages 支持分别设置 production 和 preview 环境变量。

可将 Build watch paths 的 include 限制为：

- `apps/web/*`
- `package.json`
- `package-lock.json`

这样仅修改 Worker 时不会触发无意义的前端构建。Cloudflare 文档说明默认任意文件变化都会触发 Pages build，watch paths 可用于 monorepo 过滤。

## 原生 Pages 的优点

- 推送 `main` 自动发布生产环境。
- 仓库内分支和 PR 自动产生 preview URL、GitHub check run 和 PR 状态；来自 fork 的 PR 不会生成 preview URL。
- Cloudflare Dashboard 内直接查看构建日志和历史部署。
- 前端发布不需要在 GitHub 保存 Pages API Token/Account ID。
- monorepo 可以配置 root、build command、output directory 和 watch paths。

来源：

- [Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)
- [Pages GitHub integration](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/)
- [Preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)
- [Monorepos](https://developers.cloudflare.com/pages/configuration/monorepos/)
- [Build watch paths](https://developers.cloudflare.com/pages/configuration/build-watch-paths/)
- [Build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/)
- [Build image](https://developers.cloudflare.com/pages/configuration/build-image/)

## 原生 Pages 的缺点

- Pages 与 Worker 是两个独立构建。Cloudflare 没有声明两者之间的依赖顺序；同一个 push 可能并行发布。
- Pages 不会替 Worker 执行 D1 migrations、部署 Queue consumer、Cron 或 Worker。虽然 Pages build command 是用户命令，技术上可以调用 Wrangler，但这样必须把高权限 Cloudflare 凭据放入 Pages build 环境，而且 preview build 也需额外防护，职责和失败恢复都会混在前端构建中。
- Pages Git project 一旦创建，不能转换成 Direct Upload project；可以关闭 Git 自动部署后用 Wrangler 手动上传，但项目类型不会改变。反方向也一样：Direct Upload project 不能改成 Git integration，必须创建新项目。
- 若仍保留 GitHub Actions 部署 Worker/D1，发布状态与日志分散在 GitHub 和 Cloudflare 两处。

Cloudflare 对 Pages 的官方描述是构建并部署站点；对 Worker 则提供独立的 Workers Builds，包含可配置的 build command、production deploy command 和 non-production preview deploy command。官方没有提供 Pages/Workers Builds 之间的跨项目依赖图。

来源：

- [Pages build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/)
- [Pages Git integration：项目类型和关闭自动部署](https://developers.cloudflare.com/pages/configuration/git-integration/)
- [Pages Direct Upload：不可转换为 Git integration](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

## GitHub Actions 的优缺点

当前 `.github/workflows/deploy.yml` 可以在同一 job 中保证：

1. 完整测试、类型检查和构建成功；
2. D1 migration 成功；
3. Worker 部署并通过健康检查；
4. 使用确定的 Worker URL 构建前端；
5. Pages 上传并通过健康检查。

这使错误在发布链上有一个明确位置，也可利用 GitHub Environment 审批、并发锁和 secrets。Cloudflare 官方支持通过 Wrangler 与 GitHub Actions向 Direct Upload Pages project 发布。

缺点是初始配置更多，需要 GitHub Cloudflare API Token、Account ID 和项目相关 secrets；当前工作流只在 `main` 部署，没有自动 PR preview（可以后续增加）；构建日志主要位于 GitHub。

来源：

- [Use Direct Upload with continuous integration](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
- [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Cloudflare Wrangler Action](https://github.com/cloudflare/wrangler-action)

## 三种方案比较

| 方案 | 前端预览 | D1/Worker 顺序 | 运维面 | 建议 |
|---|---|---:|---|---|
| 单一 GitHub Actions | 当前无，可补 | 有明确顺序 | GitHub 为主 | **推荐** |
| Pages Git + Actions Worker | 原生最好 | 前后端无跨系统顺序 | GitHub + Cloudflare | 重视预览时可选 |
| Pages Git + Workers Builds | 两边均有 Git 预览能力 | 无跨项目顺序；migration 需自定义 deploy command | Cloudflare 为主 | MVP 后再评估 |

Workers Builds 支持 monorepo root directory、自定义生产 deploy command 和非生产 preview deploy command，因此可以把生产 Worker deploy command 定制为先执行 D1 migration 再 `wrangler deploy`。但需为 build token 配置 D1 权限，并确保 migration 只存在于 production deploy command；该方案依然不能保证 Pages build 等待 Worker build。

## 现在做选择的影响

用户尚未执行 Pages 创建/首次上传，因此现在是选择项目类型的最佳时点：

- 继续现有设计：执行 `wrangler pages project create`，创建 **Direct Upload** project，之后由 GitHub Actions发布。
- 改用 Pages 原生构建：在 Dashboard 通过 **Connect to Git** 创建 Pages project，不要先运行 Direct Upload 的 `wrangler pages project create`。

项目类型选择后不能原地切换；若未来改变方案，需要创建新的 Pages project（或对 Git-integrated project关闭自动部署后继续用 Wrangler上传，但仍不是 Direct Upload 类型）。
