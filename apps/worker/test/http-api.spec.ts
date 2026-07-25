import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Repository } from "../src/db/repository";
import type { Candidate, KnowledgeCardRecord, SourceItem } from "../src/domain";
import { createWorker } from "../src/index";
import { applyMigrations } from "./apply-migrations";

const now = new Date("2026-07-24T00:30:00.000Z");
const adminKey = "test-admin-key";
const appOrigin = "https://app.example.test";

function queue() {
  return { send: vi.fn(async () => undefined) };
}

function environment(pipeline: ReturnType<typeof queue>) {
  return { ...env, PIPELINE: pipeline, ADMIN_KEY: adminKey, APP_ORIGIN: appOrigin };
}

function item(id = "t3_post1"): SourceItem {
  return {
    id,
    source: "reddit",
    externalId: id,
    title: "Useful source item",
    author: "author",
    redditUrl: `https://reddit.com/r/todayilearned/comments/${id.slice(3)}`,
    sourceUrl: `https://example.test/source/${id}`,
    score: 100,
    upvoteRatio: 0.9,
    commentCount: 10,
    publishedAt: now.toISOString(),
    fetchedAt: now.toISOString(),
    lastCheckedAt: now.toISOString(),
    deletedAt: null,
  };
}

function candidate(runId: string, itemId: string): Candidate {
  return {
    id: `${runId}:${itemId}`,
    runId,
    itemId,
    score: 100,
    reasons: ["popular"],
    rank: 1,
    status: "summarized",
    selectedAt: now.toISOString(),
  };
}

function card(candidateId: string): KnowledgeCardRecord {
  return {
    id: "summary-1",
    candidateId,
    status: "draft",
    titleZh: "中文标题",
    oneLineFact: "原帖声称一件值得了解的事。",
    whyInteresting: "这件事提供了一个有趣的视角。",
    commentInsights: ["评论补充了背景。"],
    caveats: ["尚未进行外部事实核查。"],
    confidenceNote: "内容仅基于原帖和评论。",
    model: "test-model",
    promptVersion: "v1",
    inputHash: "input-hash",
    generatedAt: now.toISOString(),
    reviewedAt: null,
  };
}

async function clearDatabase(): Promise<void> {
  await env.DB.batch(
    ["review_actions", "summaries", "candidates", "source_comments", "source_items", "fetch_runs", "settings"]
      .map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
}

async function seedCard(repository: Repository): Promise<{ runId: string; candidateId: string; cardId: string }> {
  const runId = "run-1";
  await repository.createRun({ id: runId, localDate: "2026-07-24", startedAt: now.toISOString() });
  const sourceItem = item();
  const selected = candidate(runId, sourceItem.id);
  await repository.upsertSourceItem(sourceItem);
  await repository.saveCandidate(selected);
  const summary = card(selected.id);
  await repository.saveSummary(summary);
  return { runId, candidateId: selected.id, cardId: summary.id };
}

function authorizedHeaders(extra: HeadersInit = {}): Headers {
  return new Headers({ Authorization: `Bearer ${adminKey}`, Origin: appOrigin, ...extra });
}

describe("protected HTTP API", () => {
  let repository: Repository;
  let pipeline: ReturnType<typeof queue>;
  let worker: ReturnType<typeof createWorker>;

  beforeEach(async () => {
    await applyMigrations();
    await clearDatabase();
    repository = new Repository(env.DB);
    pipeline = queue();
    worker = createWorker({ now: () => now });
  });

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    return worker.fetch(
      new Request(`https://api.example.test${path}`, init),
      environment(pipeline) as never,
      {} as ExecutionContext,
    );
  }

  it("keeps health public while every private route rejects a missing bearer key", async () => {
    expect((await request("/api/health")).status).toBe(200);

    for (const [path, init] of [
      ["/api/runs/latest", {}],
      ["/api/cards?status=draft", {}],
      ["/api/cards/summary-1", {}],
      ["/api/cards/summary-1/approve", { method: "POST" }],
      ["/api/cards/summary-1/reject", { method: "POST" }],
      ["/api/cards/summary-1/regenerate", { method: "POST" }],
      ["/api/runs", { method: "POST" }],
      ["/api/settings/anonymous-collection", { method: "POST" }],
    ] as const) {
      const response = await request(path, init);
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
    }
  });

  it("returns JSON and only echoes the configured origin for authenticated requests and preflight", async () => {
    const response = await request("/api/runs/latest", { headers: authorizedHeaders() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect(await response.json()).toEqual({ run: null });

    const preflight = await request("/api/cards/summary-1/approve", {
      method: "OPTIONS",
      headers: { Origin: appOrigin, "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(appOrigin);

    const foreignPreflight = await request("/api/cards/summary-1/approve", {
      method: "OPTIONS",
      headers: { Origin: "https://foreign.example.test", "Access-Control-Request-Method": "POST" },
    });
    expect(foreignPreflight.status).toBe(403);
    expect(await foreignPreflight.json()).toEqual({ error: { code: "forbidden_origin", message: "Forbidden origin" } });
  });

  it("approves a card once and leaves a repeated approval idempotent", async () => {
    const { cardId } = await seedCard(repository);
    const init = { method: "POST", headers: authorizedHeaders({ "Content-Type": "application/json" }) };

    expect((await request(`/api/cards/${cardId}/approve`, init)).status).toBe(200);
    expect((await request(`/api/cards/${cardId}/approve`, init)).status).toBe(200);
    expect((await repository.listCards("approved")).map((saved) => saved.id)).toEqual([cardId]);
    const actions = await env.DB.prepare("SELECT action FROM review_actions WHERE summary_id = ?").bind(cardId).all<{ action: string }>();
    expect(actions.results).toEqual([{ action: "approve" }]);
  });

  it("regenerates a card by queueing only one summarize message", async () => {
    const { cardId, runId, candidateId } = await seedCard(repository);
    const init = { method: "POST", headers: authorizedHeaders({ "Content-Type": "application/json" }) };

    expect((await request(`/api/cards/${cardId}/regenerate`, init)).status).toBe(202);
    expect((await request(`/api/cards/${cardId}/regenerate`, init)).status).toBe(202);
    expect(pipeline.send).toHaveBeenCalledTimes(1);
    expect(pipeline.send).toHaveBeenCalledWith({ stage: "summarize", runId, itemId: "t3_post1" });
    expect(await repository.getCandidate(runId, "t3_post1")).toMatchObject({ id: candidateId, status: "comments_ready" });
  });

  it("returns an existing Shanghai-local run for a duplicate manual start", async () => {
    const headers = authorizedHeaders({ "Content-Type": "application/json" });
    const first = await request("/api/runs", { method: "POST", headers });
    const second = await request("/api/runs", { method: "POST", headers });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((await first.json()).run.id).toBe((await second.json()).run.id);
    expect(pipeline.send).toHaveBeenCalledTimes(1);
  });

  it("uses one clock instant for a manual run's Shanghai date and start timestamp", async () => {
    const instants = [
      new Date("2026-07-24T15:00:00.000Z"),
      new Date("2026-07-24T15:59:59.000Z"),
      new Date("2026-07-24T16:00:00.000Z"),
    ];
    const clock = vi.fn(() => instants.shift() ?? now);
    worker = createWorker({ now: clock });

    const response = await request("/api/runs", {
      method: "POST",
      headers: authorizedHeaders({ "Content-Type": "application/json" }),
    });
    const { run } = await response.json() as { run: { localDate: string; startedAt: string } };

    expect(run).toMatchObject({
      localDate: "2026-07-24",
      startedAt: "2026-07-24T15:59:59.000Z",
    });
  });

  it("only accepts an explicit enabled true body when re-enabling anonymous collection", async () => {
    await repository.setAnonymousEnabled(false, now.toISOString());
    const headers = authorizedHeaders({ "Content-Type": "application/json" });

    for (const body of [undefined, "{}", '{"enabled":false}', '{"enabled":"true"}']) {
      const response = await request("/api/settings/anonymous-collection", { method: "POST", headers, body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "Expected body { enabled: true }" } });
      expect(await repository.getAnonymousCollection()).toEqual({ enabled: false, consecutiveFailures: 0 });
    }

    const response = await request("/api/settings/anonymous-collection", {
      method: "POST",
      headers,
      body: '{"enabled":true}',
    });
    expect(response.status).toBe(200);
    expect(await repository.getAnonymousCollection()).toEqual({ enabled: true, consecutiveFailures: 0 });
  });
});
