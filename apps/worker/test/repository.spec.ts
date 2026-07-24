import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Candidate, KnowledgeCardRecord, SourceItem } from "../src/domain";
import { Repository } from "../src/db/repository";
import { applyMigrations } from "./apply-migrations";

const now = "2026-07-23T00:00:00.000Z";

function sourceItem(overrides: Partial<SourceItem> = {}): SourceItem {
  return {
    id: "item-1",
    source: "reddit",
    externalId: "t3_abc",
    title: "An interesting thing",
    author: "alice",
    redditUrl: "https://reddit.com/r/todayilearned/comments/abc",
    sourceUrl: "https://example.test/source",
    score: 10,
    upvoteRatio: 0.95,
    commentCount: 4,
    publishedAt: now,
    fetchedAt: now,
    lastCheckedAt: now,
    deletedAt: null,
    ...overrides
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "candidate-1",
    runId: "run-1",
    itemId: "item-1",
    score: 99,
    reasons: ["popular"],
    rank: 1,
    status: "selected",
    selectedAt: now,
    ...overrides
  };
}

function summary(overrides: Partial<KnowledgeCardRecord> = {}): KnowledgeCardRecord {
  return {
    id: "summary-1",
    candidateId: "candidate-1",
    status: "draft",
    titleZh: "有趣的事实",
    oneLineFact: "一条简短的事实。",
    whyInteresting: "它很有意思。",
    commentInsights: ["评论补充"],
    caveats: ["仍需验证"],
    confidenceNote: "基于原帖和有限评论。",
    model: "@cf/test/model",
    promptVersion: "v1",
    inputHash: "sha256:test",
    generatedAt: now,
    ...overrides
  };
}

async function clearDatabase(): Promise<void> {
  await env.DB.batch(
    [
      "review_actions",
      "summaries",
      "candidates",
      "source_comments",
      "source_items",
      "fetch_runs",
      "settings"
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`))
  );
}

describe("Repository", () => {
  let repository: Repository;

  beforeEach(async () => {
    await applyMigrations();
    await clearDatabase();
    repository = new Repository(env.DB);
  });

  it("deduplicates by source and external id", async () => {
    await repository.upsertSourceItem(sourceItem());
    await repository.upsertSourceItem(sourceItem({ id: "item-2", score: 42 }));

    const result = await env.DB
      .prepare("SELECT id, score FROM source_items WHERE source = ? AND external_id = ?")
      .bind("reddit", "t3_abc")
      .all<{ id: string; score: number }>();

    expect(result.results).toEqual([{ id: "item-1", score: 42 }]);
  });

  it("prevents two runs for the same local date", async () => {
    await repository.createRun({ id: "run-1", localDate: "2026-07-23", startedAt: now });

    await expect(
      repository.createRun({ id: "run-2", localDate: "2026-07-23", startedAt: now })
    ).rejects.toThrow();
  });

  it("moves a summary through draft, approved, and rejected states", async () => {
    await repository.createRun({ id: "run-1", localDate: "2026-07-23", startedAt: now });
    await repository.upsertSourceItem(sourceItem());
    await repository.saveCandidate(candidate());
    await repository.saveSummary(summary());

    expect(await repository.listCards("draft")).toHaveLength(1);

    await repository.recordReview("summary-1", "approve", "2026-07-23T01:00:00.000Z");
    expect(await repository.listCards("approved")).toHaveLength(1);

    await repository.recordReview("summary-1", "reject", "2026-07-23T02:00:00.000Z");
    expect(await repository.listCards("rejected")).toHaveLength(1);
  });

  it("lists cards with their original title and source links", async () => {
    await repository.createRun({ id: "run-1", localDate: "2026-07-23", startedAt: now });
    await repository.upsertSourceItem(sourceItem());
    await repository.saveCandidate(candidate());
    await repository.saveSummary(summary());

    const [card] = await repository.listCards("draft");

    expect(card).toMatchObject({
      titleEn: "An interesting thing",
      redditUrl: "https://reddit.com/r/todayilearned/comments/abc",
      sourceUrl: "https://example.test/source"
    });
  });

  it("stores prompt version and input hash", async () => {
    await repository.createRun({ id: "run-1", localDate: "2026-07-23", startedAt: now });
    await repository.upsertSourceItem(sourceItem());
    await repository.saveCandidate(candidate());
    await repository.saveSummary(summary({ promptVersion: "prompt-v7", inputHash: "sha256:abc123" }));

    const stored = await env.DB
      .prepare("SELECT prompt_version, input_hash FROM summaries WHERE id = ?")
      .bind("summary-1")
      .first<{ prompt_version: string; input_hash: string }>();

    expect(stored).toEqual({ prompt_version: "prompt-v7", input_hash: "sha256:abc123" });
  });

  it("disables anonymous collection after the persisted failure threshold", async () => {
    await repository.recordAnonymousFailure("2026-07-23T00:00:00.000Z");
    await repository.recordAnonymousFailure("2026-07-24T00:00:00.000Z");
    const afterTwo = await repository.getAnonymousCollection();
    await repository.recordAnonymousFailure("2026-07-25T00:00:00.000Z");

    expect(afterTwo).toEqual({ enabled: true, consecutiveFailures: 2 });
    expect(await repository.getAnonymousCollection()).toEqual({ enabled: false, consecutiveFailures: 3 });
  });
});
