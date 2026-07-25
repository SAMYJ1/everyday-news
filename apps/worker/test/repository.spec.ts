import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("returns metadata selected within the inclusive rolling window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const recentAt = "2026-07-22T12:00:00.000Z";
    const boundaryAt = "2026-06-23T00:00:00.000Z";
    const expiredAt = "2026-06-22T23:59:59.000Z";

    await repository.createRun({ id: "run-1", localDate: "2026-07-23", startedAt: now });
    await repository.upsertSourceItem(
      sourceItem({
        id: "recent-item",
        externalId: "t3_recent",
        title: "A recent interesting thing",
        sourceUrl: "https://example.test/recent",
        publishedAt: "2020-01-01T00:00:00.000Z"
      })
    );
    await repository.upsertSourceItem(
      sourceItem({
        id: "boundary-item",
        externalId: "t3_boundary",
        title: "A boundary interesting thing",
        sourceUrl: "https://example.test/boundary"
      })
    );
    await repository.upsertSourceItem(
      sourceItem({
        id: "expired-item",
        externalId: "t3_expired",
        title: "An expired interesting thing",
        sourceUrl: "https://example.test/expired"
      })
    );
    await repository.upsertSourceItem(
      sourceItem({
        id: "unselected-item",
        externalId: "t3_unselected",
        title: "A discovered but unselected thing",
        sourceUrl: "https://example.test/unselected"
      })
    );
    await repository.saveCandidate(
      candidate({
        id: "candidate-recent",
        itemId: "recent-item",
        rank: 1,
        selectedAt: recentAt
      })
    );
    await repository.saveCandidate(
      candidate({
        id: "candidate-boundary",
        itemId: "boundary-item",
        rank: 2,
        selectedAt: boundaryAt
      })
    );
    await repository.saveCandidate(
      candidate({
        id: "candidate-expired",
        itemId: "expired-item",
        rank: 3,
        selectedAt: expiredAt
      })
    );

    expect(await repository.getRecentSourceUrls(30)).toEqual(
      new Set(["https://example.test/recent", "https://example.test/boundary"])
    );
    expect(await repository.getRecentTitles(30)).toEqual([
      "A recent interesting thing",
      "A boundary interesting thing"
    ]);
    vi.useRealTimers();
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

  it("loads summary input and finds only successful matching summaries", async () => {
    await repository.createRun({ id: "run-1", localDate: "2026-07-23", startedAt: now });
    await repository.upsertSourceItem(sourceItem());
    await repository.replaceComments("item-1", [
      {
        id: "comment-1",
        itemId: "item-1",
        externalId: "t1_comment1",
        parentExternalId: "t3_abc",
        author: "commenter",
        body: "A useful comment.",
        score: 3,
        depth: 0,
        redditUrl: "https://reddit.com/comment-1",
        publishedAt: now,
        fetchedAt: now,
        deletedAt: null,
        deleted: false
      }
    ]);
    await repository.saveCandidate(candidate());
    await repository.saveSummary(summary());
    await repository.saveSummary(summary({
      id: "failed-summary",
      status: "failed",
      inputHash: "sha256:failed"
    }));

    expect(await repository.getCandidate("run-1", "item-1")).toEqual(candidate());
    expect(await repository.getSourceItem("item-1")).toMatchObject(sourceItem());
    expect(await repository.listComments("item-1")).toMatchObject([{ id: "comment-1", body: "A useful comment." }]);
    expect(await repository.getSuccessfulSummary("candidate-1", "v1", "sha256:test")).toMatchObject(summary());
    expect(await repository.getSuccessfulSummary("candidate-1", "v1", "sha256:failed")).toBeNull();
  });

  it("atomically grants only one summary claim and never downgrades a successful card", async () => {
    await repository.createRun({ id: "run-1", localDate: "2026-07-23", startedAt: now });
    await repository.upsertSourceItem(sourceItem());
    await repository.saveCandidate(candidate());

    const claims = await Promise.all([
      repository.claimCandidateForSummary(
        "candidate-1",
        "claim-a",
        "2026-07-23T00:00:00.000Z",
        "2026-07-22T23:50:00.000Z",
      ),
      repository.claimCandidateForSummary(
        "candidate-1",
        "claim-b",
        "2026-07-23T00:00:00.000Z",
        "2026-07-22T23:50:00.000Z",
      ),
    ]);
    expect(claims.sort()).toEqual([false, true]);

    expect(
      await repository.claimCandidateForSummary(
        "candidate-1",
        "claim-c",
        "2026-07-23T00:20:00.000Z",
        "2026-07-23T00:10:00.000Z",
      ),
    ).toBe(true);
    await repository.setCandidateStatus("candidate-1", "summarized");
    expect(
      await repository.claimCandidateForSummary(
        "candidate-1",
        "claim-d",
        "2026-07-23T00:21:00.000Z",
        "2026-07-23T00:11:00.000Z",
      ),
    ).toBe(true);

    await repository.saveSummary(summary());
    await repository.saveSummary(
      summary({
        status: "failed",
        titleZh: "",
        oneLineFact: "",
        whyInteresting: "",
        commentInsights: [],
        caveats: [],
        confidenceNote: "",
      }),
    );

    expect(
      await repository.getSuccessfulSummary("candidate-1", "v1", "sha256:test"),
    ).toMatchObject({
      status: "draft",
      titleZh: "有趣的事实",
      oneLineFact: "一条简短的事实。",
    });
  });

  it("fences a stale summary owner after a newer owner reclaims the lease", async () => {
    await repository.createRun({ id: "run-1", localDate: "2026-07-23", startedAt: now });
    await repository.upsertSourceItem(sourceItem());
    await repository.saveCandidate(candidate());

    expect(
      await repository.claimCandidateForSummary(
        "candidate-1",
        "claim-a",
        "2026-07-23T00:00:00.000Z",
        "2026-07-22T23:50:00.000Z",
      ),
    ).toBe(true);
    expect(
      await repository.claimCandidateForSummary(
        "candidate-1",
        "claim-b",
        "2026-07-23T00:20:00.000Z",
        "2026-07-23T00:10:00.000Z",
      ),
    ).toBe(true);

    expect(
      await repository.saveSummaryForClaim(
        summary({ titleZh: "过期结果" }),
        "claim-a",
      ),
    ).toBe(false);
    expect(
      await repository.releaseSummaryClaim(
        "candidate-1",
        "claim-a",
        "comments_ready",
      ),
    ).toBe(false);

    expect(
      await repository.saveSummaryForClaim(
        summary({ titleZh: "最新结果" }),
        "claim-b",
      ),
    ).toBe(true);
    expect(
      await repository.saveSummaryForClaim(
        summary({
          status: "failed",
          titleZh: "",
          oneLineFact: "",
          whyInteresting: "",
          commentInsights: [],
          caveats: [],
          confidenceNote: "",
        }),
        "claim-b",
      ),
    ).toBe(false);
    expect(
      await repository.completeSummaryClaim(
        "candidate-1",
        "claim-b",
        "summarized",
      ),
    ).toBe(true);
    expect(
      await repository.completeSummaryClaim(
        "candidate-1",
        "claim-a",
        "failed",
      ),
    ).toBe(false);

    expect(
      await repository.getSuccessfulSummary("candidate-1", "v1", "sha256:test"),
    ).toMatchObject({ status: "draft", titleZh: "最新结果" });
    expect(await repository.getCandidate("run-1", "item-1")).toMatchObject({
      status: "summarized",
    });
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
