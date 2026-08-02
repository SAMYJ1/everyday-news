import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyD1Migrations } from "cloudflare:test";
import { applyMigrations, migrations } from "./apply-migrations";

describe("run-attempt migration", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB, "0003_anonymous_failure_days.sql");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO source_items (
          id, source, external_id, title, author, reddit_url, source_url, score,
          upvote_ratio, comment_count, published_at, fetched_at, last_checked_at, deleted_at
        ) VALUES (
          'item-1', 'reddit', 'external-1', 'Title', 'author',
          'https://reddit.test/item-1', 'https://example.test/item-1', 10,
          0.9, 2, '2026-07-23T00:00:00.000Z', '2026-07-23T00:01:00.000Z',
          '2026-07-23T00:01:00.000Z', NULL
        )`,
      ),
      env.DB.prepare(
        `INSERT INTO fetch_runs (
          id, local_date, status, discovered_count, selected_count, summarized_count,
          error_code, error_message, started_at, finished_at
        ) VALUES (
          'run-1', '2026-07-23', 'completed', 1, 1, 1, NULL, NULL,
          '2026-07-23T00:00:00.000Z', '2026-07-23T00:10:00.000Z'
        )`,
      ),
      env.DB.prepare(
        `INSERT INTO candidates (
          id, run_id, item_id, score, reasons, rank, status, selected_at
        ) VALUES (
          'candidate-1', 'run-1', 'item-1', 9.5, '["interesting"]', 1,
          'summarized', '2026-07-23T00:02:00.000Z'
        )`,
      ),
      env.DB.prepare(
        `INSERT INTO summaries (
          id, candidate_id, status, title_zh, one_line_fact, why_interesting,
          comment_insights, caveats, confidence_note, model, prompt_version,
          input_hash, generated_at, reviewed_at
        ) VALUES (
          'summary-1', 'candidate-1', 'draft', '标题', '事实', '有趣',
          '[]', '[]', '高', 'model', 'v1', 'hash',
          '2026-07-23T00:03:00.000Z', '2026-07-23T00:04:00.000Z'
        )`,
      ),
      env.DB.prepare(
        `INSERT INTO review_actions (summary_id, action, created_at)
        VALUES ('summary-1', 'approve', '2026-07-23T00:04:00.000Z')`,
      ),
      env.DB.prepare(
        `INSERT INTO regeneration_requests (
          id, summary_id, candidate_id, run_id, item_id, nonce, created_at, completed_at
        ) VALUES (
          'regen-1', 'summary-1', 'candidate-1', 'run-1', 'item-1', 'nonce-1',
          '2026-07-23T00:05:00.000Z', '2026-07-23T00:06:00.000Z'
        )`,
      ),
    ]);

    await applyD1Migrations(env.DB, migrations.slice(3));
  });

  it("preserves the dependent run graph and foreign keys", async () => {
    const graph = await env.DB.prepare(
      `SELECT
        fetch_runs.id AS run_id,
        candidates.id AS candidate_id,
        summaries.id AS summary_id,
        review_actions.action,
        regeneration_requests.id AS regeneration_id
      FROM fetch_runs
      JOIN candidates ON candidates.run_id = fetch_runs.id
      JOIN summaries ON summaries.candidate_id = candidates.id
      JOIN review_actions ON review_actions.summary_id = summaries.id
      JOIN regeneration_requests ON regeneration_requests.summary_id = summaries.id`,
    ).first();
    expect(graph).toMatchObject({
      run_id: "run-1",
      candidate_id: "candidate-1",
      summary_id: "summary-1",
      action: "approve",
      regeneration_id: "regen-1",
    });

    const foreignKeyErrors = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(foreignKeyErrors.results).toEqual([]);
  });

  it("migrates legacy public drafts to automatic publication without deleting review history", async () => {
    const summary = await env.DB.prepare(
      "SELECT status, publication_reason, reviewed_at FROM summaries WHERE id = 'summary-1'",
    ).first<{ status: string; publication_reason: string; reviewed_at: string | null }>();
    expect(summary).toEqual({
      status: "approved",
      publication_reason: "Legacy public card migrated to automatic publishing",
      reviewed_at: "2026-07-23T00:04:00.000Z",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM review_actions").first()).toEqual({ count: 1 });
  });

  it("allows terminal history but only one active attempt per local date", async () => {
    await env.DB.prepare(
      `INSERT INTO fetch_runs (
        id, local_date, status, started_at
      ) VALUES ('run-2', '2026-07-23', 'queued', '2026-07-23T00:11:00.000Z')`,
    ).run();

    await expect(env.DB.prepare(
      `INSERT INTO fetch_runs (
        id, local_date, status, started_at
      ) VALUES ('run-3', '2026-07-23', 'running', '2026-07-23T00:12:00.000Z')`,
    ).run()).rejects.toThrow();
  });
});
