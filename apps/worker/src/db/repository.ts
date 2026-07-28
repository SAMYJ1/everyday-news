import type {
  AnonymousCollection,
  Candidate,
  FetchRun,
  KnowledgeCard,
  KnowledgeCardRecord,
  PublicKnowledgeCard,
  SourceComment,
  SourceItem,
  SummaryStatus
} from "../domain";

const ANONYMOUS_COLLECTION_KEY = "anonymous_collection";
const ANONYMOUS_FAILURE_THRESHOLD = 3;
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

interface FetchRunRow {
  id: string;
  local_date: string;
  status: FetchRun["status"];
  discovered_count: number;
  selected_count: number;
  summarized_count: number;
  failed_count: number;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

interface SummaryRow {
  id: string;
  candidate_id: string;
  status: SummaryStatus;
  title_zh: string;
  one_line_fact: string;
  why_interesting: string;
  comment_insights: string;
  caveats: string;
  confidence_note: string;
  model: string;
  prompt_version: string;
  input_hash: string;
  generated_at: string;
  reviewed_at: string | null;
  title_en: string | null;
  reddit_url: string;
  source_url: string | null;
  candidate_score: number;
  selection_reasons: string;
  comment_links: string;
  warnings: string;
  run_local_date: string;
}

interface PublicSummaryRow {
  id: string;
  status: PublicKnowledgeCard["status"];
  title_zh: string;
  one_line_fact: string;
  why_interesting: string;
  comment_insights: string;
  caveats: string;
  confidence_note: string;
  generated_at: string;
  title_en: string | null;
  reddit_url: string;
  source_url: string | null;
  run_local_date: string;
}

interface AnonymousCollectionRow {
  enabled: number;
  consecutive_failures: number;
}

interface CandidateRow {
  id: string;
  run_id: string;
  item_id: string;
  score: number;
  reasons: string;
  rank: number;
  status: Candidate["status"];
  selected_at: string;
}

function shanghaiLocalDate(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid anonymous failure timestamp: ${at}`);
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function toFetchRun(row: FetchRunRow): FetchRun {
  return {
    id: row.id,
    localDate: row.local_date,
    status: row.status,
    discoveredCount: row.discovered_count,
    selectedCount: row.selected_count,
    summarizedCount: row.summarized_count,
    failedCount: row.failed_count,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function toSummary(row: SummaryRow): KnowledgeCard {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    status: row.status,
    titleZh: row.title_zh,
    oneLineFact: row.one_line_fact,
    whyInteresting: row.why_interesting,
    commentInsights: JSON.parse(row.comment_insights) as string[],
    caveats: JSON.parse(row.caveats) as string[],
    confidenceNote: row.confidence_note,
    model: row.model,
    promptVersion: row.prompt_version,
    inputHash: row.input_hash,
    generatedAt: row.generated_at,
    reviewedAt: row.reviewed_at,
    titleEn: row.title_en,
    redditUrl: row.reddit_url,
    sourceUrl: row.source_url,
    candidateScore: row.candidate_score,
    selectionReasons: JSON.parse(row.selection_reasons) as string[],
    commentLinks: JSON.parse(row.comment_links) as string[],
    warnings: JSON.parse(row.warnings) as Array<{ code: string; message: string }>,
    runLocalDate: row.run_local_date,
  };
}

function toCandidate(row: CandidateRow): Candidate {
  return {
    id: row.id,
    runId: row.run_id,
    itemId: row.item_id,
    score: row.score,
    reasons: JSON.parse(row.reasons) as string[],
    rank: row.rank,
    status: row.status,
    selectedAt: row.selected_at
  };
}

function toSummaryRecord(row: Omit<SummaryRow, "title_en" | "reddit_url" | "source_url">): KnowledgeCardRecord {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    status: row.status,
    titleZh: row.title_zh,
    oneLineFact: row.one_line_fact,
    whyInteresting: row.why_interesting,
    commentInsights: JSON.parse(row.comment_insights) as string[],
    caveats: JSON.parse(row.caveats) as string[],
    confidenceNote: row.confidence_note,
    model: row.model,
    promptVersion: row.prompt_version,
    inputHash: row.input_hash,
    generatedAt: row.generated_at,
    reviewedAt: row.reviewed_at
  };
}

function toPublicSummary(row: PublicSummaryRow): PublicKnowledgeCard {
  return {
    id: row.id,
    status: row.status,
    titleZh: row.title_zh,
    oneLineFact: row.one_line_fact,
    whyInteresting: row.why_interesting,
    commentInsights: JSON.parse(row.comment_insights) as string[],
    caveats: JSON.parse(row.caveats) as string[],
    confidenceNote: row.confidence_note,
    generatedAt: row.generated_at,
    titleEn: row.title_en,
    redditUrl: row.reddit_url,
    sourceUrl: row.source_url,
    runLocalDate: row.run_local_date,
  };
}

export class Repository {
  constructor(private readonly db: D1Database) {}

  async getRunByLocalDate(localDate: string): Promise<FetchRun | null> {
    const row = await this.db
      .prepare(
        `SELECT id, local_date, status, discovered_count, selected_count, summarized_count,
          (SELECT COUNT(*) FROM candidates
            WHERE candidates.run_id = fetch_runs.id AND candidates.status = 'failed'
          ) AS failed_count,
          error_code, error_message, started_at, finished_at
        FROM fetch_runs
        WHERE local_date = ?
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
      )
      .bind(localDate)
      .first<FetchRunRow>();
    return row === null ? null : toFetchRun(row);
  }

  async createOrGetRun(input: { localDate: string; startedAt: string }): Promise<{
    run: FetchRun;
    created: boolean;
  }> {
    const id = crypto.randomUUID();
    const result = await this.db
      .prepare(
        `INSERT INTO fetch_runs (
          id, local_date, status, discovered_count, selected_count, summarized_count,
          error_code, error_message, started_at, finished_at
        ) VALUES (?, ?, 'queued', 0, 0, 0, NULL, NULL, ?, NULL)
        ON CONFLICT DO NOTHING`,
      )
      .bind(id, input.localDate, input.startedAt)
      .run();
    const row = await this.db
      .prepare(
        `SELECT id, local_date, status, discovered_count, selected_count, summarized_count,
          (SELECT COUNT(*) FROM candidates
            WHERE candidates.run_id = fetch_runs.id AND candidates.status = 'failed'
          ) AS failed_count,
          error_code, error_message, started_at, finished_at
        FROM fetch_runs
        WHERE id = ? OR (
          local_date = ? AND status IN ('queued', 'running')
        )
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, started_at DESC, id DESC
        LIMIT 1`,
      )
      .bind(id, input.localDate, id)
      .first<FetchRunRow>();
    const run = row === null ? null : toFetchRun(row);
    if (run === null) throw new Error(`Unable to create or load run for ${input.localDate}`);
    return { run, created: (result.meta.changes ?? 0) === 1 };
  }

  async createRun(input: { id: string; localDate: string; startedAt: string }): Promise<FetchRun> {
    const run: FetchRun = {
      id: input.id,
      localDate: input.localDate,
      status: "queued",
      discoveredCount: 0,
      selectedCount: 0,
      summarizedCount: 0,
      failedCount: 0,
      errorCode: null,
      errorMessage: null,
      startedAt: input.startedAt,
      finishedAt: null
    };

    await this.db
      .prepare(
        `INSERT INTO fetch_runs (
          id, local_date, status, discovered_count, selected_count, summarized_count,
          error_code, error_message, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        run.id,
        run.localDate,
        run.status,
        run.discoveredCount,
        run.selectedCount,
        run.summarizedCount,
        run.errorCode,
        run.errorMessage,
        run.startedAt,
        run.finishedAt
      )
      .run();

    return run;
  }

  async markRunRunning(runId: string): Promise<void> {
    await this.db
      .prepare("UPDATE fetch_runs SET status = 'running' WHERE id = ? AND status = 'queued'")
      .bind(runId)
      .run();
  }

  async getRunStatus(runId: string): Promise<FetchRun["status"] | null> {
    const row = await this.db
      .prepare("SELECT status FROM fetch_runs WHERE id = ?")
      .bind(runId)
      .first<{ status: FetchRun["status"] }>();
    return row?.status ?? null;
  }

  async claimRunDiscoveryDelivery(runId: string, token: string, claimedAt: string, staleBefore: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE fetch_runs SET discovery_claim_token = ?, discovery_claimed_at = ?
      WHERE id = ? AND status = 'queued' AND
        (discovery_claim_token IS NULL OR discovery_claimed_at IS NULL OR discovery_claimed_at <= ?)`,
    ).bind(token, claimedAt, runId, staleBefore).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async releaseRunDiscoveryDelivery(runId: string, token: string): Promise<void> {
    await this.db.prepare(
      "UPDATE fetch_runs SET discovery_claim_token = NULL, discovery_claimed_at = NULL WHERE id = ? AND discovery_claim_token = ?",
    ).bind(runId, token).run();
  }

  async markRunRunningForDiscoveryDelivery(runId: string, token: string): Promise<void> {
    await this.db.prepare(
      `UPDATE fetch_runs SET status = 'running', discovery_claim_token = NULL, discovery_claimed_at = NULL
      WHERE id = ? AND status = 'queued' AND discovery_claim_token = ?`,
    ).bind(runId, token).run();
  }

  async markRunFailed(
    runId: string,
    errorCode: string,
    errorMessage: string,
    finishedAt: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE fetch_runs
        SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?
        WHERE id = ?`,
      )
      .bind(errorCode, errorMessage, finishedAt, runId)
      .run();
  }

  async reconcileStaleRuns(staleBefore: string, finishedAt: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE fetch_runs
        SET status = 'failed',
          error_code = 'run_timed_out',
          error_message = 'Collection run exceeded the ten-minute execution limit',
          finished_at = ?,
          discovery_claim_token = NULL,
          discovery_claimed_at = NULL
        WHERE status IN ('queued', 'running')
          AND unixepoch(started_at) <= unixepoch(?)`,
      )
      .bind(finishedAt, staleBefore)
      .run();
    return result.meta.changes ?? 0;
  }

  async markRunPartial(
    runId: string,
    errorCode: string,
    errorMessage: string,
    finishedAt: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE fetch_runs
        SET status = 'partial', error_code = ?, error_message = ?, finished_at = ?
        WHERE id = ? AND status != 'failed'`,
      )
      .bind(errorCode, errorMessage, finishedAt, runId)
      .run();
  }

  async refreshRunStatus(runId: string, finishedAt: string): Promise<void> {
    const row = await this.db
      .prepare(
        `SELECT status, selected_count, discovery_completed_at,
          (SELECT COUNT(*) FROM candidates WHERE run_id = fetch_runs.id AND status = 'summarized') AS summarized,
          (SELECT COUNT(*) FROM candidates WHERE run_id = fetch_runs.id AND status = 'failed') AS failed
        FROM fetch_runs WHERE id = ?`,
      )
      .bind(runId)
      .first<{
        status: FetchRun["status"];
        selected_count: number;
        discovery_completed_at: string | null;
        summarized: number;
        failed: number;
      }>();
    if (row === null || row.status === "failed" || row.discovery_completed_at === null) return;

    if (row.status === "partial") {
      await this.db
        .prepare("UPDATE fetch_runs SET summarized_count = ? WHERE id = ?")
        .bind(row.summarized, runId)
        .run();
      return;
    }

    const status: FetchRun["status"] =
      row.failed > 0
        ? "partial"
        : row.summarized === row.selected_count
          ? "completed"
          : "running";
    await this.db
      .prepare(
        `UPDATE fetch_runs
        SET status = ?, summarized_count = ?, finished_at = ?
        WHERE id = ?`,
      )
      .bind(status, row.summarized, status === "running" ? null : finishedAt, runId)
      .run();
  }

  async getDiscoveryCheckpoint(runId: string): Promise<{
    discovered: number;
    selected: number;
    itemIds: string[];
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT discovered_count, selected_count, discovery_completed_at
        FROM fetch_runs
        WHERE id = ?`
      )
      .bind(runId)
      .first<{
        discovered_count: number;
        selected_count: number;
        discovery_completed_at: string | null;
      }>();
    if (row === null || row.discovery_completed_at === null) return null;

    const candidates = await this.listCandidatesForRun(runId);
    return {
      discovered: row.discovered_count,
      selected: row.selected_count,
      itemIds: candidates.map((candidate) => candidate.itemId)
    };
  }

  async completeDiscovery(
    runId: string,
    result: { discovered: number; selected: number },
    completedAt: string
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE fetch_runs
        SET discovered_count = ?, selected_count = ?, discovery_completed_at = ?
        WHERE id = ?`
      )
      .bind(result.discovered, result.selected, completedAt, runId)
      .run();
  }

  async upsertSourceItem(item: SourceItem): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO source_items (
          id, source, external_id, title, author, reddit_url, source_url, score,
          upvote_ratio, comment_count, published_at, fetched_at, last_checked_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, external_id) DO UPDATE SET
          title = excluded.title,
          author = excluded.author,
          reddit_url = excluded.reddit_url,
          source_url = excluded.source_url,
          score = excluded.score,
          upvote_ratio = excluded.upvote_ratio,
          comment_count = excluded.comment_count,
          published_at = excluded.published_at,
          fetched_at = excluded.fetched_at,
          last_checked_at = excluded.last_checked_at,
          deleted_at = excluded.deleted_at
        WHERE source_items.deleted_at IS NULL`
      )
      .bind(
        item.id,
        item.source,
        item.externalId,
        item.title,
        item.author,
        item.redditUrl,
        item.sourceUrl,
        item.score,
        item.upvoteRatio,
        item.commentCount,
        item.publishedAt,
        item.fetchedAt,
        item.lastCheckedAt,
        item.deletedAt
      )
      .run();
  }

  async replaceComments(itemId: string, comments: SourceComment[]): Promise<void> {
    const statements = [
      this.db
        .prepare(
          `DELETE FROM source_comments
          WHERE item_id = ? AND deleted_at IS NULL AND EXISTS (
            SELECT 1 FROM source_items
            WHERE source_items.id = ? AND source_items.deleted_at IS NULL
          )`,
        )
        .bind(itemId, itemId),
      ...comments.map((comment) =>
        this.db
          .prepare(
            `INSERT INTO source_comments (
              id, item_id, external_id, parent_external_id, author, body, score, depth,
              reddit_url, published_at, fetched_at, deleted_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            FROM source_items
            WHERE id = ? AND deleted_at IS NULL
            ON CONFLICT DO UPDATE SET
              parent_external_id = excluded.parent_external_id,
              author = excluded.author,
              body = excluded.body,
              score = excluded.score,
              depth = excluded.depth,
              reddit_url = excluded.reddit_url,
              published_at = excluded.published_at,
              fetched_at = excluded.fetched_at,
              deleted_at = excluded.deleted_at
            WHERE source_comments.deleted_at IS NULL`
          )
          .bind(
            comment.id,
            itemId,
            comment.externalId,
            comment.parentExternalId,
            comment.author,
            comment.body,
            comment.score,
            comment.depth,
            comment.redditUrl,
            comment.publishedAt ?? null,
            comment.fetchedAt,
            comment.deletedAt,
            itemId,
          )
      )
    ];

    await this.db.batch(statements);
  }

  async getSourceItem(itemId: string): Promise<SourceItem | null> {
    const row = await this.db
      .prepare(
        `SELECT id, source, external_id, title, author, reddit_url, source_url, score,
          upvote_ratio, comment_count, published_at, fetched_at, last_checked_at, deleted_at
        FROM source_items WHERE id = ?`
      )
      .bind(itemId)
      .first<{
        id: string; source: string; external_id: string; title: string | null; author: string | null;
        reddit_url: string; source_url: string | null; score: number; upvote_ratio: number | null;
        comment_count: number; published_at: string; fetched_at: string; last_checked_at: string;
        deleted_at: string | null;
      }>();
    if (row === null) return null;
    return {
      id: row.id, source: row.source, externalId: row.external_id, title: row.title, author: row.author,
      redditUrl: row.reddit_url, sourceUrl: row.source_url, score: row.score, upvoteRatio: row.upvote_ratio,
      commentCount: row.comment_count, publishedAt: row.published_at, fetchedAt: row.fetched_at,
      lastCheckedAt: row.last_checked_at, deletedAt: row.deleted_at
    };
  }

  async listSourceItemsForCleanup(input: {
    recentSince: string;
    dailyBefore: string;
    weeklyBefore: string;
  }): Promise<Array<{ id: string; externalId: string }>> {
    const result = await this.db
      .prepare(
        `SELECT id, external_id
        FROM source_items
        WHERE deleted_at IS NULL AND (
          (fetched_at >= ? AND last_checked_at <= ?)
          OR (fetched_at < ? AND last_checked_at <= ?)
        )
        ORDER BY external_id ASC`,
      )
      .bind(
        input.recentSince,
        input.dailyBefore,
        input.recentSince,
        input.weeklyBefore,
      )
      .all<{ id: string; external_id: string }>();
    return result.results.map((row) => ({
      id: row.id,
      externalId: row.external_id,
    }));
  }

  async markSourceItemChecked(itemId: string, checkedAt: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE source_items SET last_checked_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .bind(checkedAt, itemId)
      .run();
  }

  async removeDeletedSourceItem(itemId: string, deletedAt: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE source_items
          SET deleted_at = ?, last_checked_at = ?
          WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(deletedAt, deletedAt, itemId),
      this.db
        .prepare(
          "UPDATE source_items SET title = NULL, author = NULL, source_url = NULL WHERE id = ?",
        )
        .bind(itemId),
      this.db
        .prepare(
          `UPDATE source_comments
          SET body = '', author = NULL, deleted_at = COALESCE(deleted_at, ?)
          WHERE item_id = ?`,
        )
        .bind(deletedAt, itemId),
      this.db
        .prepare(
          `UPDATE summaries
          SET status = 'source_deleted'
          WHERE candidate_id IN (SELECT id FROM candidates WHERE item_id = ?)`,
        )
        .bind(itemId),
    ]);
  }

  async removeDeletedSourceComment(
    commentId: string,
    deletedAt: string,
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare(
        `UPDATE source_comments
        SET body = '', author = NULL, deleted_at = COALESCE(deleted_at, ?)
        WHERE id = ?`,
      )
      .bind(deletedAt, commentId),
      this.db.prepare(
        `UPDATE summaries
        SET status = 'source_deleted'
        WHERE candidate_id IN (
          SELECT candidates.id
          FROM candidates
          JOIN source_comments ON source_comments.item_id = candidates.item_id
          WHERE source_comments.id = ? AND source_comments.deleted_at IS NOT NULL
        )`,
      )
      .bind(commentId),
    ]);
  }

  async listComments(itemId: string): Promise<SourceComment[]> {
    const result = await this.db
      .prepare(
        `SELECT id, item_id, external_id, parent_external_id, author, body, score, depth, reddit_url,
          published_at, fetched_at, deleted_at
        FROM source_comments WHERE item_id = ? ORDER BY score DESC, id ASC`
      )
      .bind(itemId)
      .all<{
        id: string; item_id: string; external_id: string; parent_external_id: string | null;
        author: string | null; body: string; score: number; depth: number; reddit_url: string;
        published_at: string | null; fetched_at: string; deleted_at: string | null;
      }>();
    return result.results.map((row) => ({
      id: row.id, itemId: row.item_id, externalId: row.external_id,
      parentExternalId: row.parent_external_id, author: row.author, body: row.body, score: row.score,
      depth: row.depth, redditUrl: row.reddit_url, publishedAt: row.published_at,
      fetchedAt: row.fetched_at, deletedAt: row.deleted_at, deleted: row.deleted_at !== null
    }));
  }

  async saveCandidate(candidate: Candidate): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO candidates (
          id, run_id, item_id, score, reasons, rank, status, selected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          run_id = excluded.run_id,
          item_id = excluded.item_id,
          score = excluded.score,
          reasons = excluded.reasons,
          rank = excluded.rank,
          status = excluded.status,
          selected_at = excluded.selected_at,
          summary_claimed_at = NULL,
          summary_claim_token = NULL`
      )
      .bind(
        candidate.id,
        candidate.runId,
        candidate.itemId,
        candidate.score,
        JSON.stringify(candidate.reasons),
        candidate.rank,
        candidate.status,
        candidate.selectedAt
      )
      .run();
  }

  async listCandidatesForRun(runId: string): Promise<Candidate[]> {
    const result = await this.db
      .prepare(
        `SELECT id, run_id, item_id, score, reasons, rank, status, selected_at
        FROM candidates
        WHERE run_id = ?
        ORDER BY rank ASC`
      )
      .bind(runId)
      .all<CandidateRow>();

    return result.results.map(toCandidate);
  }

  async getCandidate(runId: string, itemId: string): Promise<Candidate | null> {
    const row = await this.db
      .prepare(
        `SELECT id, run_id, item_id, score, reasons, rank, status, selected_at
        FROM candidates WHERE run_id = ? AND item_id = ?`
      )
      .bind(runId, itemId)
      .first<CandidateRow>();
    return row === null ? null : toCandidate(row);
  }

  async claimCandidateForSummary(
    candidateId: string,
    claimToken: string,
    claimedAt: string,
    staleBefore: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE candidates
        SET status = 'summarizing', summary_claimed_at = ?, summary_claim_token = ?
        WHERE id = ? AND (
          status IN ('selected', 'comments_ready', 'failed', 'summarized')
          OR (
            status = 'summarizing'
            AND (summary_claimed_at IS NULL OR summary_claimed_at <= ?)
          )
        )`
      )
      .bind(claimedAt, claimToken, candidateId, staleBefore)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async saveSummaryForClaim(
    summary: KnowledgeCardRecord,
    claimToken: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO summaries (
          id, candidate_id, status, title_zh, one_line_fact, why_interesting,
          comment_insights, caveats, confidence_note, model, prompt_version,
          input_hash, generated_at, reviewed_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM candidates
        JOIN source_items ON source_items.id = candidates.item_id
        WHERE candidates.id = ? AND candidates.status = 'summarizing'
          AND candidates.summary_claim_token = ?
          AND source_items.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM source_comments
            WHERE source_comments.item_id = candidates.item_id
              AND source_comments.deleted_at IS NOT NULL
          )
        ON CONFLICT(id) DO UPDATE SET
          candidate_id = excluded.candidate_id,
          status = excluded.status,
          title_zh = excluded.title_zh,
          one_line_fact = excluded.one_line_fact,
          why_interesting = excluded.why_interesting,
          comment_insights = excluded.comment_insights,
          caveats = excluded.caveats,
          confidence_note = excluded.confidence_note,
          model = excluded.model,
          prompt_version = excluded.prompt_version,
          input_hash = excluded.input_hash,
          generated_at = excluded.generated_at,
          reviewed_at = excluded.reviewed_at
        WHERE summaries.status != 'source_deleted' AND NOT (
          summaries.status IN ('draft', 'approved', 'rejected')
          AND excluded.status = 'failed'
        )`
      )
      .bind(
        summary.id,
        summary.candidateId,
        summary.status,
        summary.titleZh,
        summary.oneLineFact,
        summary.whyInteresting,
        JSON.stringify(summary.commentInsights),
        JSON.stringify(summary.caveats),
        summary.confidenceNote,
        summary.model,
        summary.promptVersion,
        summary.inputHash,
        summary.generatedAt,
        summary.reviewedAt ?? null,
        summary.candidateId,
        claimToken,
      )
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async completeSummaryClaim(
    candidateId: string,
    claimToken: string,
    status: Extract<Candidate["status"], "summarized" | "failed">,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE candidates
        SET status = ?, summary_claimed_at = NULL, summary_claim_token = NULL
        WHERE id = ? AND status = 'summarizing' AND summary_claim_token = ?`,
      )
      .bind(status, candidateId, claimToken)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async releaseSummaryClaim(
    candidateId: string,
    claimToken: string,
    status: Candidate["status"],
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE candidates
        SET status = ?, summary_claimed_at = NULL, summary_claim_token = NULL
        WHERE id = ? AND status = 'summarizing' AND summary_claim_token = ?`,
      )
      .bind(status, candidateId, claimToken)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async setCandidateStatus(
    candidateId: string,
    status: Candidate["status"],
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE candidates
        SET status = ?, summary_claimed_at = NULL, summary_claim_token = NULL
        WHERE id = ?`,
      )
      .bind(status, candidateId)
      .run();
  }

  async getSuccessfulSummary(
    candidateId: string,
    promptVersion: string,
    inputHash: string
  ): Promise<KnowledgeCardRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, candidate_id, status, title_zh, one_line_fact, why_interesting,
          comment_insights, caveats, confidence_note, model, prompt_version, input_hash,
          generated_at, reviewed_at
        FROM summaries
        WHERE candidate_id = ? AND prompt_version = ? AND input_hash = ?
          AND status IN ('draft', 'approved', 'rejected')`
      )
      .bind(candidateId, promptVersion, inputHash)
      .first<Omit<SummaryRow, "title_en" | "reddit_url" | "source_url">>();
    return row === null ? null : toSummaryRecord(row);
  }

  async saveSummary(summary: KnowledgeCardRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO summaries (
          id, candidate_id, status, title_zh, one_line_fact, why_interesting,
          comment_insights, caveats, confidence_note, model, prompt_version,
          input_hash, generated_at, reviewed_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM candidates
        JOIN source_items ON source_items.id = candidates.item_id
        WHERE candidates.id = ? AND source_items.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM source_comments
            WHERE source_comments.item_id = candidates.item_id
              AND source_comments.deleted_at IS NOT NULL
          )
        ON CONFLICT(id) DO UPDATE SET
          candidate_id = excluded.candidate_id,
          status = excluded.status,
          title_zh = excluded.title_zh,
          one_line_fact = excluded.one_line_fact,
          why_interesting = excluded.why_interesting,
          comment_insights = excluded.comment_insights,
          caveats = excluded.caveats,
          confidence_note = excluded.confidence_note,
          model = excluded.model,
          prompt_version = excluded.prompt_version,
          input_hash = excluded.input_hash,
          generated_at = excluded.generated_at,
          reviewed_at = excluded.reviewed_at
        WHERE summaries.status != 'source_deleted' AND NOT (
          summaries.status IN ('draft', 'approved', 'rejected')
          AND excluded.status = 'failed'
        )`
      )
      .bind(
        summary.id,
        summary.candidateId,
        summary.status,
        summary.titleZh,
        summary.oneLineFact,
        summary.whyInteresting,
        JSON.stringify(summary.commentInsights),
        JSON.stringify(summary.caveats),
        summary.confidenceNote,
        summary.model,
        summary.promptVersion,
        summary.inputHash,
        summary.generatedAt,
        summary.reviewedAt ?? null,
        summary.candidateId,
      )
      .run();
  }

  async recordReview(
    summaryId: string,
    action: "approve" | "reject",
    at: string
  ): Promise<boolean> {
    const status: SummaryStatus = action === "approve" ? "approved" : "rejected";
    const result = await this.db
      .prepare(
        `UPDATE summaries
        SET status = ?, reviewed_at = ?
        WHERE id = ? AND status != ? AND status != 'source_deleted'
          AND EXISTS (
            SELECT 1
            FROM candidates
            JOIN source_items ON source_items.id = candidates.item_id
            WHERE candidates.id = summaries.candidate_id
              AND source_items.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM source_comments
                WHERE source_comments.item_id = source_items.id
                  AND source_comments.deleted_at IS NOT NULL
              )
          )`,
      )
      .bind(status, at, summaryId, status)
      .run();
    if ((result.meta.changes ?? 0) === 0) return false;
    return true;
  }

  async getRecentSourceUrls(days: number): Promise<Set<string>> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.db
      .prepare(
        `SELECT DISTINCT source_items.source_url
        FROM candidates
        JOIN source_items ON source_items.id = candidates.item_id
        WHERE source_items.source_url IS NOT NULL
          AND candidates.selected_at >= ?`
      )
      .bind(cutoff)
      .all<{ source_url: string }>();

    return new Set(result.results.map((row) => row.source_url));
  }

  async getRecentTitles(days: number): Promise<string[]> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.db
      .prepare(
        `SELECT DISTINCT source_items.title, candidates.selected_at, source_items.id
        FROM candidates
        JOIN source_items ON source_items.id = candidates.item_id
        WHERE source_items.title IS NOT NULL
          AND candidates.selected_at >= ?
        ORDER BY candidates.selected_at DESC, source_items.id ASC`
      )
      .bind(cutoff)
      .all<{ title: string }>();

    return result.results.map((row) => row.title);
  }

  async getLatestRun(): Promise<FetchRun | null> {
    const row = await this.db
      .prepare(
        `SELECT id, local_date, status, discovered_count, selected_count, summarized_count,
          (SELECT COUNT(*) FROM candidates
            WHERE candidates.run_id = fetch_runs.id AND candidates.status = 'failed'
          ) AS failed_count,
          error_code, error_message, started_at, finished_at
        FROM fetch_runs
        ORDER BY local_date DESC, started_at DESC, id DESC
        LIMIT 1`
      )
      .first<FetchRunRow>();

    return row === null ? null : toFetchRun(row);
  }

  async listRuns(localDate?: string): Promise<FetchRun[]> {
    const statement = localDate === undefined
      ? this.db.prepare(
          `SELECT id, local_date, status, discovered_count, selected_count, summarized_count,
            (SELECT COUNT(*) FROM candidates
              WHERE candidates.run_id = fetch_runs.id AND candidates.status = 'failed'
            ) AS failed_count,
            error_code, error_message, started_at, finished_at
          FROM fetch_runs
          ORDER BY local_date DESC, started_at DESC, id DESC
          LIMIT 30`,
        )
      : this.db.prepare(
          `SELECT id, local_date, status, discovered_count, selected_count, summarized_count,
            (SELECT COUNT(*) FROM candidates
              WHERE candidates.run_id = fetch_runs.id AND candidates.status = 'failed'
            ) AS failed_count,
            error_code, error_message, started_at, finished_at
          FROM fetch_runs
          WHERE local_date = ?
          ORDER BY local_date DESC, started_at DESC, id DESC
          LIMIT 30`,
        ).bind(localDate);
    const result = await statement.all<FetchRunRow>();
    return result.results.map(toFetchRun);
  }

  async listPublicDates(): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT DISTINCT fetch_runs.local_date
        FROM summaries
        JOIN candidates ON candidates.id = summaries.candidate_id
        JOIN source_items ON source_items.id = candidates.item_id
        JOIN fetch_runs ON fetch_runs.id = candidates.run_id
        WHERE summaries.status IN ('draft', 'approved')
          AND source_items.deleted_at IS NULL
        ORDER BY fetch_runs.local_date DESC`,
      )
      .all<{ local_date: string }>();
    return result.results.map(({ local_date }) => local_date);
  }

  async listPublicCards(localDate?: string): Promise<PublicKnowledgeCard[]> {
    const selectedDate = localDate ?? (await this.listPublicDates())[0];
    if (selectedDate === undefined) return [];

    const result = await this.db
      .prepare(
        `SELECT summaries.id, summaries.status, summaries.title_zh,
          summaries.one_line_fact, summaries.why_interesting,
          summaries.comment_insights, summaries.caveats, summaries.confidence_note,
          summaries.generated_at, source_items.title AS title_en,
          source_items.reddit_url, source_items.source_url,
          fetch_runs.local_date AS run_local_date
        FROM summaries
        JOIN candidates ON candidates.id = summaries.candidate_id
        JOIN source_items ON source_items.id = candidates.item_id
        JOIN fetch_runs ON fetch_runs.id = candidates.run_id
        WHERE summaries.status IN ('draft', 'approved')
          AND source_items.deleted_at IS NULL
          AND fetch_runs.local_date = ?
        ORDER BY summaries.generated_at DESC, summaries.id DESC`,
      )
      .bind(selectedDate)
      .all<PublicSummaryRow>();
    return result.results.map(toPublicSummary);
  }

  async listCards(status?: SummaryStatus, localDate?: string): Promise<KnowledgeCard[]> {
    if (status === "source_deleted") return [];
    const conditions = [
      status === undefined ? "summaries.status != 'source_deleted'" : "summaries.status = ?",
      "source_items.deleted_at IS NULL",
      `NOT EXISTS (
        SELECT 1 FROM source_comments
        WHERE source_comments.item_id = source_items.id
          AND source_comments.deleted_at IS NOT NULL
      )`,
    ];
    const bindings: string[] = [];
    if (status !== undefined) bindings.push(status);
    if (localDate !== undefined) {
      conditions.push("fetch_runs.local_date = ?");
      bindings.push(localDate);
    }
    const statement = this.db.prepare(
      `SELECT summaries.id, summaries.candidate_id, summaries.status, summaries.title_zh,
        summaries.one_line_fact, summaries.why_interesting,
        comment_insights, caveats, confidence_note, model, prompt_version,
        input_hash, generated_at, reviewed_at, source_items.title AS title_en,
        source_items.reddit_url, source_items.source_url,
        candidates.score AS candidate_score, candidates.reasons AS selection_reasons,
        COALESCE((
          SELECT json_group_array(ordered_comments.reddit_url)
          FROM (
            SELECT source_comments.reddit_url
            FROM source_comments
            WHERE source_comments.item_id = source_items.id
              AND source_comments.deleted_at IS NULL
            ORDER BY source_comments.score DESC, source_comments.id ASC
          ) AS ordered_comments
        ), '[]') AS comment_links,
        CASE
          WHEN fetch_runs.error_code IS NOT NULL AND fetch_runs.error_message IS NOT NULL
          THEN json_array(json_object(
            'code', fetch_runs.error_code,
            'message', fetch_runs.error_message
          ))
          ELSE '[]'
        END AS warnings,
        fetch_runs.local_date AS run_local_date
      FROM summaries
      JOIN candidates ON candidates.id = summaries.candidate_id
      JOIN source_items ON source_items.id = candidates.item_id
      JOIN fetch_runs ON fetch_runs.id = candidates.run_id
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY summaries.generated_at DESC`,
    );
    const result = await (bindings.length === 0 ? statement : statement.bind(...bindings)).all<SummaryRow>();

    return result.results.map(toSummary);
  }

  async getCard(summaryId: string): Promise<KnowledgeCard | null> {
    const row = await this.db
      .prepare(
        `SELECT summaries.id, summaries.candidate_id, summaries.status, summaries.title_zh,
          summaries.one_line_fact, summaries.why_interesting,
          comment_insights, caveats, confidence_note, model, prompt_version,
          input_hash, generated_at, reviewed_at, source_items.title AS title_en,
          source_items.reddit_url, source_items.source_url,
          candidates.score AS candidate_score, candidates.reasons AS selection_reasons,
          COALESCE((
            SELECT json_group_array(ordered_comments.reddit_url)
            FROM (
              SELECT source_comments.reddit_url
              FROM source_comments
              WHERE source_comments.item_id = source_items.id
                AND source_comments.deleted_at IS NULL
              ORDER BY source_comments.score DESC, source_comments.id ASC
            ) AS ordered_comments
          ), '[]') AS comment_links,
          CASE
            WHEN fetch_runs.error_code IS NOT NULL AND fetch_runs.error_message IS NOT NULL
            THEN json_array(json_object(
              'code', fetch_runs.error_code,
              'message', fetch_runs.error_message
            ))
            ELSE '[]'
          END AS warnings,
          fetch_runs.local_date AS run_local_date
        FROM summaries
        JOIN candidates ON candidates.id = summaries.candidate_id
        JOIN source_items ON source_items.id = candidates.item_id
        JOIN fetch_runs ON fetch_runs.id = candidates.run_id
        WHERE summaries.id = ? AND summaries.status != 'source_deleted'
          AND source_items.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM source_comments
            WHERE source_comments.item_id = source_items.id
              AND source_comments.deleted_at IS NOT NULL
          )`,
      )
      .bind(summaryId)
      .first<SummaryRow>();
    return row === null ? null : toSummary(row);
  }

  async createOrGetCardRegeneration(
    summaryId: string,
    at: string,
  ): Promise<{ id: string; nonce: string; runId: string; itemId: string } | null> {
    const existing = await this.db.prepare(
      `SELECT id, nonce, run_id, item_id FROM regeneration_requests
      WHERE summary_id = ? AND completed_at IS NULL`,
    ).bind(summaryId).first<{ id: string; nonce: string; run_id: string; item_id: string }>();
    if (existing !== null) return { id: existing.id, nonce: existing.nonce, runId: existing.run_id, itemId: existing.item_id };
    const id = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO regeneration_requests (id, summary_id, candidate_id, run_id, item_id, nonce, created_at)
        SELECT ?, summaries.id, candidates.id, candidates.run_id, candidates.item_id, ?, ?
        FROM summaries
        JOIN candidates ON candidates.id = summaries.candidate_id
        WHERE summaries.id = ?
        ON CONFLICT DO NOTHING`,
      )
      .bind(id, nonce, at, summaryId)
      .run();
    const request = await this.db.prepare(
      `SELECT id, nonce, run_id, item_id FROM regeneration_requests
      WHERE summary_id = ? AND completed_at IS NULL`,
    ).bind(summaryId).first<{ id: string; nonce: string; run_id: string; item_id: string }>();
    return request === null ? null : { id: request.id, nonce: request.nonce, runId: request.run_id, itemId: request.item_id };
  }

  async claimCardRegenerationDelivery(id: string, token: string, claimedAt: string, staleBefore: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE regeneration_requests SET delivery_claim_token = ?, delivery_claimed_at = ?
      WHERE id = ? AND completed_at IS NULL AND enqueued_at IS NULL AND
        (delivery_claim_token IS NULL OR delivery_claimed_at IS NULL OR delivery_claimed_at <= ?)`,
    ).bind(token, claimedAt, id, staleBefore).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async releaseCardRegenerationDelivery(id: string, token: string): Promise<void> {
    await this.db.prepare(
      "UPDATE regeneration_requests SET delivery_claim_token = NULL, delivery_claimed_at = NULL WHERE id = ? AND delivery_claim_token = ?",
    ).bind(id, token).run();
  }

  async markCardRegenerationEnqueued(id: string, token: string, enqueuedAt: string): Promise<void> {
    await this.db.prepare(
      `UPDATE regeneration_requests SET enqueued_at = ?, delivery_claim_token = NULL, delivery_claimed_at = NULL
      WHERE id = ? AND delivery_claim_token = ?`,
    ).bind(enqueuedAt, id, token).run();
  }

  async getPendingCardRegeneration(id: string, nonce: string, candidateId: string): Promise<{ summaryId: string } | null> {
    const row = await this.db.prepare(
      `SELECT summary_id FROM regeneration_requests
      WHERE id = ? AND nonce = ? AND candidate_id = ? AND completed_at IS NULL`,
    ).bind(id, nonce, candidateId).first<{ summary_id: string }>();
    return row === null ? null : { summaryId: row.summary_id };
  }

  async getActiveCardRegeneration(candidateId: string): Promise<{ id: string; nonce: string; summaryId: string } | null> {
    const row = await this.db.prepare(
      "SELECT id, nonce, summary_id FROM regeneration_requests WHERE candidate_id = ? AND completed_at IS NULL",
    ).bind(candidateId).first<{ id: string; nonce: string; summary_id: string }>();
    return row === null ? null : { id: row.id, nonce: row.nonce, summaryId: row.summary_id };
  }

  async completeCardRegeneration(id: string, nonce: string, completedAt: string): Promise<void> {
    await this.db.prepare(
      `UPDATE regeneration_requests SET completed_at = ?, delivery_claim_token = NULL, delivery_claimed_at = NULL
      WHERE id = ? AND nonce = ? AND completed_at IS NULL`,
    ).bind(completedAt, id, nonce).run();
  }

  async setAnonymousEnabled(enabled: boolean, at = new Date().toISOString()): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO settings (
          key, enabled, consecutive_failures, updated_at, last_failure_local_date
        )
        VALUES (?, ?, 0, ?, NULL)
        ON CONFLICT(key) DO UPDATE SET
          enabled = excluded.enabled,
          consecutive_failures = 0,
          updated_at = excluded.updated_at,
          last_failure_local_date = NULL`
      )
      .bind(ANONYMOUS_COLLECTION_KEY, enabled ? 1 : 0, at)
      .run();
  }

  async recordAnonymousFailure(at: string): Promise<AnonymousCollection> {
    const localDate = shanghaiLocalDate(at);
    await this.db
      .prepare(
        `INSERT INTO settings (
          key, enabled, consecutive_failures, updated_at, last_failure_local_date
        )
        VALUES (?, 1, 1, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          consecutive_failures = CASE
            WHEN settings.last_failure_local_date = excluded.last_failure_local_date
              THEN settings.consecutive_failures
            WHEN date(settings.last_failure_local_date, '+1 day') = excluded.last_failure_local_date
              THEN settings.consecutive_failures + 1
            ELSE 1
          END,
          enabled = CASE
            WHEN settings.last_failure_local_date != excluded.last_failure_local_date
              AND date(settings.last_failure_local_date, '+1 day') = excluded.last_failure_local_date
              AND settings.consecutive_failures + 1 >= ?
              THEN 0
            ELSE settings.enabled
          END,
          updated_at = excluded.updated_at,
          last_failure_local_date = excluded.last_failure_local_date`
      )
      .bind(
        ANONYMOUS_COLLECTION_KEY,
        at,
        localDate,
        ANONYMOUS_FAILURE_THRESHOLD,
      )
      .run();

    return this.getAnonymousCollection();
  }

  async recordAnonymousSuccess(at: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO settings (
          key, enabled, consecutive_failures, updated_at, last_failure_local_date
        )
        VALUES (?, 1, 0, ?, NULL)
        ON CONFLICT(key) DO UPDATE SET
          consecutive_failures = 0,
          updated_at = excluded.updated_at,
          last_failure_local_date = NULL`,
      )
      .bind(ANONYMOUS_COLLECTION_KEY, at)
      .run();
  }

  async getAnonymousCollection(): Promise<AnonymousCollection> {
    const row = await this.db
      .prepare("SELECT enabled, consecutive_failures FROM settings WHERE key = ?")
      .bind(ANONYMOUS_COLLECTION_KEY)
      .first<AnonymousCollectionRow>();

    return row === null
      ? { enabled: true, consecutiveFailures: 0 }
      : {
          enabled: row.enabled === 1,
          consecutiveFailures: row.consecutive_failures
        };
  }
}
