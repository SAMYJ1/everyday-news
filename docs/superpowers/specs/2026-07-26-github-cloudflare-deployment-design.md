# GitHub 与 Cloudflare 自动部署设计

日期：2026-07-26

## 目标

为 `everyday-news` 建立一个私有 GitHub 仓库，并让 GitHub Actions 成为 Cloudflare 生产发布的唯一编排入口。发布必须保留现有提交历史、经过 CI 验证，并避免把运行时密钥打包进前端。

## 仓库与分支

- GitHub 仓库：`SAMYJ1/everyday-news`
- 可见性：private
- 默认和生产分支：`main`
- 当前开发分支：`feature/reddit-mvp`
- 首次发布时推送 `main` 与 `feature/reddit-mvp`，再从功能分支向 `main` 创建 draft PR。
- 功能分支和 Pull Request 只运行验证，不接触生产 Cloudflare 资源。

## 工作流

保留 `.github/workflows/ci.yml` 作为所有 push 与 Pull Request 的验证工作流，新增 `.github/workflows/deploy.yml` 负责生产部署。

`deploy.yml` 通过以下两种方式触发：

1. `main` 分支 push。
2. `workflow_dispatch` 手动触发。

同一时刻只允许一个生产部署运行，后来的部署不取消正在执行的生产部署。工作流设置最小 GitHub 权限，只读取仓库内容。

部署步骤固定为：

1. checkout、安装 Node.js 22 和依赖。
2. 运行测试、类型检查和完整构建。
3. 对生产 D1 数据库执行尚未应用的 migration。
4. 部署 Cloudflare Worker。
5. 使用生产 Worker URL 作为 `VITE_API_BASE_URL` 构建 Web。
6. 使用 Wrangler 把 Web 构建产物部署到 Cloudflare Pages 的生产分支。
7. 对 Worker 健康端点与 Pages URL 执行只读 smoke test。

如果任一步失败，后续步骤不执行，GitHub deployment job 标记为失败。

## Cloudflare 初始化边界

日常部署工作流不负责创建或删除 Cloudflare 资源。首次部署前由操作者完成一次性 bootstrap：

- 创建 D1 database，并把准确的 `database_id` 写入 `apps/worker/wrangler.jsonc`。
- 创建 pipeline Queue 和 dead-letter Queue。
- 创建 Pages 项目。
- 在 Cloudflare 保存 Worker runtime secrets。
- 在 GitHub repository secrets 保存部署凭据和公开部署配置。

这一区分避免日常发布意外创建重复资源，也避免 CI 获得不必要的账户管理权限。

## 配置与 Secrets

GitHub Actions 使用：

- `CLOUDFLARE_API_TOKEN`：最小权限的 Cloudflare token。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare account ID。
- `CLOUDFLARE_D1_DATABASE_NAME`：生产 D1 database 名称。
- `CLOUDFLARE_PAGES_PROJECT`：Pages 项目名。
- `WORKER_BASE_URL`：已部署 Worker 的公开基地址。
- `PAGES_BASE_URL`：Pages 生产站点基地址，用于 smoke test。

`ADMIN_KEY` 与 `REDDIT_USER_AGENT` 只保存在 Cloudflare Worker secrets 中，不进入 GitHub Actions Web 构建环境。所有 `VITE_*` 变量都视为公开信息，不能包含密钥。

API token 只授予目标账户所需的 Workers Scripts、D1 和 Pages 写权限。Queue 由一次性 bootstrap 创建，因此日常 token 不需要 Queue 管理权限。

## Pages 发布模式

Pages 使用 Direct Upload，由 GitHub Actions 中的 Wrangler 命令部署。该项目不再同时启用 Pages Git integration，避免一次提交产生两次 Pages 部署。

生产部署显式传入 `--branch=main`。Web 构建目录由项目现有构建脚本产生，工作流在部署前验证目录存在。

## 验证与失败处理

提交前必须在本地重新运行：

- `npm test`
- `npm run typecheck`
- `npm run build`
- Worker 的 Wrangler dry run
- GitHub Actions YAML 静态检查（如果仓库已有可用检查工具）

远端创建后检查：

- 两个分支都已推送。
- GitHub 默认分支为 `main`。
- draft PR 指向 `main`。
- CI workflow 已被 GitHub 识别。

Cloudflare Secrets 和资源未就绪时，不尝试伪造一次成功生产部署；工作流保留手动触发入口，待 bootstrap 完成后再进行首次线上验证。

## 不在本次范围

- 不自动创建、覆盖或删除 D1、Queue、Pages 项目。
- 不自动写入 Worker runtime secrets。
- 不配置自定义域名或 DNS。
- 不自动合并 draft PR。
- 不把 Reddit OAuth 流程加入部署工作流。
