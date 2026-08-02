import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Repository } from "../src/db/repository";
import type { Candidate, KnowledgeCardRecord, SourceComment, SourceItem } from "../src/domain";
import { createWorker } from "../src/index";
import { applyMigrations } from "./apply-migrations";

const now = new Date("2026-08-01T00:30:00.000Z");
const adminKey = "test-admin-key";
const appOrigin = "https://app.example.test";

function environment(pipeline = { send: vi.fn(async () => undefined) }) {
  return { ...env, PIPELINE: pipeline, ADMIN_KEY: adminKey, APP_ORIGIN: appOrigin, REDDIT_USER_AGENT: "everyday-news-test" };
}

function source(id: string, date: string): SourceItem {
  return {
    id, source: "reddit", externalId: id, title: `Source ${id}`, author: "author",
    redditUrl: `https://reddit.com/r/todayilearned/comments/${id.slice(3)}`,
    sourceUrl: `https://example.test/${id}`, score: 100, upvoteRatio: 0.9, commentCount: 2,
    publishedAt: date, fetchedAt: date, lastCheckedAt: date, deletedAt: null,
  };
}

function comment(itemId: string, index: number): SourceComment {
  return {
    id: `t1_${itemId}_${index}`, itemId, externalId: `t1_${itemId}_${index}`,
    parentExternalId: itemId, author: "commenter", body: `Useful comment ${index}`,
    score: 20 - index, depth: 0, redditUrl: `https://reddit.com/comments/${itemId}/${index}`,
    publishedAt: now.toISOString(), fetchedAt: now.toISOString(), deletedAt: null, deleted: false,
  };
}

async function seedPublished(repository: Repository, input: { runId: string; itemId: string; date: string; generatedAt: string }) {
  await repository.createRun({ id: input.runId, localDate: input.date.slice(0, 10), startedAt: input.generatedAt });
  const item = source(input.itemId, input.generatedAt);
  const selected: Candidate = {
    id: `${input.runId}:${input.itemId}`, runId: input.runId, itemId: input.itemId,
    score: 100, reasons: ["popular"], rank: 1, status: "summarized", selectedAt: input.generatedAt,
  };
  await repository.upsertSourceItem(item);
  await repository.replaceComments(item.id, [comment(item.id, 0), comment(item.id, 1)]);
  await repository.saveCandidate(selected);
  const summary: KnowledgeCardRecord = {
    id: `summary-${input.itemId}`, candidateId: selected.id, status: "approved",
    titleZh: `中文标题${input.itemId}`, oneLineFact: "原帖声称一件值得了解的事情。",
    whyInteresting: "这件事提供了一个值得阅读的具体视角。",
    commentInsights: [
      { text: "第一条评论补充了具体背景。", commentIndex: 0 },
      { text: "第二条评论提出了另一种解释。", commentIndex: 1 },
    ],
    caveats: ["尚未进行外部事实核查。"], confidenceNote: "内容仅基于原帖和评论。",
    publicationReason: "内容具体且评论提供了信息增量。", model: "test-model",
    promptVersion: "v3", inputHash: `hash-${input.itemId}`, generatedAt: input.generatedAt, reviewedAt: null,
  };
  await repository.saveSummary(summary);
}

async function clearDatabase() {
  await env.DB.batch(
    ["review_actions", "regeneration_requests", "summaries", "candidates", "source_comments", "source_items", "fetch_runs", "settings"]
      .map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
}

describe("HTTP API", () => {
  let repository: Repository;
  let worker: ReturnType<typeof createWorker>;

  beforeEach(async () => {
    await applyMigrations();
    await clearDatabase();
    repository = new Repository(env.DB);
    worker = createWorker({ now: () => now });
  });

  function request(path: string, init: RequestInit = {}) {
    return worker.fetch(new Request(`https://api.example.test${path}`, init), environment() as never, {} as ExecutionContext);
  }

  it("keeps public reads open and operations routes protected", async () => {
    expect((await request("/api/health")).status).toBe(200);
    expect((await request("/api/public/cards")).status).toBe(200);
    for (const path of ["/api/runs/latest", "/api/runs", "/api/cards?status=approved"]) {
      expect((await request(path)).status, path).toBe(401);
    }
  });

  it("serves approved cards as a cursor-paginated feed with linked insights", async () => {
    await seedPublished(repository, { runId: "run-new", itemId: "t3_new", date: "2026-08-01T00:00:00.000Z", generatedAt: "2026-08-01T00:03:00.000Z" });
    await seedPublished(repository, { runId: "run-old", itemId: "t3_old", date: "2026-07-31T00:00:00.000Z", generatedAt: "2026-07-31T00:03:00.000Z" });

    const first = await request("/api/public/cards?limit=1");
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { cards: Array<Record<string, unknown>>; nextCursor: string };
    expect(firstBody.cards).toEqual([expect.objectContaining({ id: "summary-t3_new", status: "approved" })]);
    expect(firstBody.cards[0]).not.toHaveProperty("publicationReason");
    expect(firstBody.cards[0]?.commentInsights).toEqual([
      { text: "第一条评论补充了具体背景。", redditUrl: "https://reddit.com/comments/t3_new/0" },
      { text: "第二条评论提出了另一种解释。", redditUrl: "https://reddit.com/comments/t3_new/1" },
    ]);

    const second = await request(`/api/public/cards?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`);
    expect(await second.json()).toEqual({
      cards: [expect.objectContaining({ id: "summary-t3_old" })],
      nextCursor: null,
    });
  });

  it("validates feed pagination inputs", async () => {
    expect((await request("/api/public/cards?limit=0")).status).toBe(400);
    expect((await request("/api/public/cards?cursor=broken")).status).toBe(400);
  });

  it("closes manual review and regeneration routes", async () => {
    const headers = { Authorization: `Bearer ${adminKey}`, Origin: appOrigin, "Content-Type": "application/json" };
    for (const action of ["approve", "reject", "regenerate"]) {
      const response = await request(`/api/cards/summary-1/${action}`, { method: "POST", headers, body: "{}" });
      expect(response.status, action).toBe(404);
    }
  });

  it("returns run history and starts a manual run from the operations API", async () => {
    const headers = { Authorization: `Bearer ${adminKey}`, Origin: appOrigin };
    expect((await request("/api/runs", { headers })).status).toBe(200);
    const started = await request("/api/runs", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(started.status).toBe(202);
  });
});
