import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Repository } from "../src/db/repository";
import { InvalidCardResponse } from "../src/ai/workers-ai";
import type { Candidate, KnowledgeCardRecord, SourceItem } from "../src/domain";
import { createWorker, RUN_STALE_AFTER_MS } from "../src/index";
import { applyMigrations } from "./apply-migrations";

const now = new Date("2026-07-24T00:30:00.000Z");
const adminKey = "test-admin-key";
const appOrigin = "https://app.example.test";

function queue(sendImplementation: (message: unknown) => Promise<void> = async () => undefined) {
  return { send: vi.fn(sendImplementation) };
}

function environment(pipeline: ReturnType<typeof queue>) {
  return { ...env, PIPELINE: pipeline, ADMIN_KEY: adminKey, APP_ORIGIN: appOrigin, REDDIT_USER_AGENT: "everyday-news-test" };
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
    ["review_actions", "regeneration_requests", "summaries", "candidates", "source_comments", "source_items", "fetch_runs", "settings"]
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
      ["/api/runs", {}],
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

  it("serves a narrow public card feed without authorization", async () => {
    await seedCard(repository);

    const datesResponse = await request("/api/public/dates");
    expect(datesResponse.status).toBe(200);
    expect(await datesResponse.json()).toEqual({ dates: ["2026-07-24"] });

    const cardsResponse = await request("/api/public/cards");
    expect(cardsResponse.status).toBe(200);
    const body = await cardsResponse.json() as {
      date: string | null;
      cards: Array<Record<string, unknown>>;
    };
    expect(body.date).toBe("2026-07-24");
    expect(body.cards).toEqual([
      expect.objectContaining({
        id: "summary-1",
        status: "draft",
        titleZh: "中文标题",
        runLocalDate: "2026-07-24",
      }),
    ]);
    for (const privateField of [
      "candidateId",
      "model",
      "promptVersion",
      "inputHash",
      "reviewedAt",
      "candidateScore",
      "selectionReasons",
      "warnings",
    ]) {
      expect(body.cards[0]).not.toHaveProperty(privateField);
    }
  });

  it("returns an empty public feed and validates public date filters", async () => {
    expect(await (await request("/api/public/cards")).json()).toEqual({
      date: null,
      cards: [],
    });

    const invalid = await request("/api/public/cards?date=2026-02-30");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: {
        code: "invalid_date",
        message: "Date must be a valid YYYY-MM-DD",
      },
    });
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

  it("reconciles stale active runs before returning the latest run", async () => {
    await repository.createRun({
      id: "stale-run",
      localDate: "2026-07-23",
      startedAt: new Date(now.getTime() - RUN_STALE_AFTER_MS - 60_000).toISOString(),
    });
    await repository.markRunRunning("stale-run");
    await repository.createRun({
      id: "fresh-run",
      localDate: "2026-07-24",
      startedAt: new Date(now.getTime() - RUN_STALE_AFTER_MS + 60_000).toISOString(),
    });

    const response = await request("/api/runs/latest", {
      headers: authorizedHeaders(),
    });

    expect(response.status).toBe(200);
    expect(await repository.getRunStatus("stale-run")).toBe("failed");
    expect(await repository.getRunStatus("fresh-run")).toBe("queued");
  });

  it("lists runs and cards for an exact Shanghai local date", async () => {
    const first = await seedCard(repository);
    await repository.createRun({
      id: "run-2",
      localDate: "2026-07-25",
      startedAt: "2026-07-25T00:00:00.000Z",
    });
    const secondItem = item("t3_post2");
    const secondCandidate = candidate("run-2", secondItem.id);
    await repository.upsertSourceItem(secondItem);
    await repository.saveCandidate(secondCandidate);
    await repository.saveSummary(card(secondCandidate.id));
    await repository.setCandidateStatus(first.candidateId, "failed");

    const runResponse = await request("/api/runs?date=2026-07-24", {
      headers: authorizedHeaders(),
    });
    expect(runResponse.status).toBe(200);
    expect(await runResponse.json()).toEqual({
      runs: [expect.objectContaining({
        id: "run-1",
        localDate: "2026-07-24",
        failedCount: 1,
      })],
    });

    const cardResponse = await request("/api/cards?status=draft&date=2026-07-25", {
      headers: authorizedHeaders(),
    });
    expect(cardResponse.status).toBe(200);
    expect(await cardResponse.json()).toEqual({
      cards: [expect.objectContaining({
        candidateId: secondCandidate.id,
        candidateScore: 100,
        selectionReasons: ["popular"],
        runLocalDate: "2026-07-25",
      })],
    });
  });

  it("returns the newest 30 runs when no date is supplied", async () => {
    for (let day = 1; day <= 31; day += 1) {
      const localDate = `2026-07-${String(day).padStart(2, "0")}`;
      await repository.createRun({
        id: `run-${day}`,
        localDate,
        startedAt: `${localDate}T00:00:00.000Z`,
      });
    }

    const response = await request("/api/runs", { headers: authorizedHeaders() });
    const body = await response.json() as { runs: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.runs).toHaveLength(30);
    expect(body.runs[0].id).toBe("run-31");
    expect(body.runs.at(-1)?.id).toBe("run-2");
  });

  it("rejects malformed or impossible date filters with the JSON error envelope", async () => {
    for (const path of [
      "/api/runs?date=2026-7-24",
      "/api/runs?date=2026-02-30",
      "/api/cards?status=draft&date=2026-07-24T00%3A00%3A00Z",
    ]) {
      const response = await request(path, { headers: authorizedHeaders() });
      expect(response.status, path).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "invalid_date",
          message: "Date must be a valid YYYY-MM-DD",
        },
      });
    }
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
    expect(pipeline.send).toHaveBeenCalledWith(expect.objectContaining({ stage: "summarize", runId, itemId: "t3_post1", regeneration: expect.any(Object) }));
    expect(await repository.getCandidate(runId, "t3_post1")).toMatchObject({ id: candidateId, status: "summarized" });
  });

  it("regenerates through AI with a unique request nonce and replaces the requested card", async () => {
    const generated = {
      titleZh: "重新生成的标题",
      oneLineFact: "重新生成的事实。",
      whyInteresting: "重新生成的原因。",
      commentInsights: ["新的评论洞察。"],
      caveats: ["新的注意事项。"],
      confidenceNote: "新的置信说明。",
    };
    const generate = vi.fn(async () => generated);
    worker = createWorker({ now: () => now, generator: { generate } });
    const { cardId } = await seedCard(repository);
    const init = { method: "POST", headers: authorizedHeaders({ "Content-Type": "application/json" }) };

    expect((await request(`/api/cards/${cardId}/regenerate`, init)).status).toBe(202);
    const message = pipeline.send.mock.calls[0][0];
    expect(message).toMatchObject({ regeneration: { id: expect.any(String), nonce: expect.any(String) } });
    const regeneration = (message as { regeneration: { id: string; nonce: string } }).regeneration;
    expect(await repository.getPendingCardRegeneration(regeneration.id, regeneration.nonce, "run-1:t3_post1")).toEqual({ summaryId: cardId });
    const queued = { body: message, ack: vi.fn(), retry: vi.fn() };
    await worker.queue?.({ messages: [queued] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);

    expect(queued.retry).not.toHaveBeenCalled();
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(await repository.getCandidate("run-1", "t3_post1")).toMatchObject({ status: "summarized" });
    expect(generate).toHaveBeenCalledOnce();
    expect(await repository.getCard(cardId)).toMatchObject({ id: cardId, status: "draft", ...generated });
  });

  it("releases a failed regeneration delivery so the next request can enqueue it", async () => {
    let failSend = true;
    pipeline = queue(async () => {
      if (failSend) throw new Error("queue unavailable");
    });
    const { cardId, runId } = await seedCard(repository);
    const init = { method: "POST", headers: authorizedHeaders({ "Content-Type": "application/json" }) };

    expect((await request(`/api/cards/${cardId}/regenerate`, init)).status).toBe(500);
    expect(await repository.getCandidate(runId, "t3_post1")).toMatchObject({ status: "summarized" });
    failSend = false;
    expect((await request(`/api/cards/${cardId}/regenerate`, init)).status).toBe(202);
    expect(pipeline.send).toHaveBeenCalledTimes(2);
  });

  it("makes concurrent regenerate requests share one durable request and delivery", async () => {
    const { cardId } = await seedCard(repository);
    const init = { method: "POST", headers: authorizedHeaders({ "Content-Type": "application/json" }) };

    const responses = await Promise.all([
      request(`/api/cards/${cardId}/regenerate`, init),
      request(`/api/cards/${cardId}/regenerate`, init),
    ]);

    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(pipeline.send).toHaveBeenCalledTimes(1);
  });

  it("rearms an invalid regeneration so a later request can generate a replacement", async () => {
    const generated = {
      titleZh: "重试后的标题", oneLineFact: "重试后的事实。", whyInteresting: "重试后的原因。",
      commentInsights: ["重试后的评论。"], caveats: ["重试后的注意事项。"], confidenceNote: "重试后的置信说明。",
    };
    let invalid = true;
    const generate = vi.fn(async () => {
      if (invalid) throw new InvalidCardResponse("Malformed card");
      return generated;
    });
    worker = createWorker({ now: () => now, generator: { generate } });
    const { cardId } = await seedCard(repository);
    const init = { method: "POST", headers: authorizedHeaders({ "Content-Type": "application/json" }) };

    await request(`/api/cards/${cardId}/regenerate`, init);
    const first = pipeline.send.mock.calls[0][0];
    await worker.queue?.({ messages: [{ body: first, ack: vi.fn(), retry: vi.fn() }] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);
    expect(await repository.getCard(cardId)).toMatchObject({ titleZh: "中文标题", status: "draft" });

    invalid = false;
    expect((await request(`/api/cards/${cardId}/regenerate`, init)).status).toBe(202);
    const second = pipeline.send.mock.calls[1][0];
    await worker.queue?.({ messages: [{ body: second, ack: vi.fn(), retry: vi.fn() }] } as MessageBatch<never>, environment(pipeline) as never, {} as ExecutionContext);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(await repository.getCard(cardId)).toMatchObject(generated);
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
