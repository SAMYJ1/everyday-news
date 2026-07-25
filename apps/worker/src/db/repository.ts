import type {
  AnonymousCollection,
  Candidate,
  FetchRun,
  KnowledgeCard,
  KnowledgeCardRecord,
  SourceComment,
  SourceItem,
  SummaryStatus
} from "../domain";

const ANONYMOUS_COLLECTION_KEY = "anonymous_collection";
const ANONYMOUS_FAILURE_THRESHOLD = 3;

interface FetchRunRow {
  id: string;
  local_date: string;
  status: FetchRun["status"];
  discovered_count: number;
  selected_count: number;
  summarized_count: number;
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

function toFetchRun(row: FetchRunRow): FetchRun {
  return {
    id: row.id,
    localDate: row.local_date,
    status: row.status,
    discoveredCount: row.discovered_count,
    selectedCount: row.selected_count,
    summarizedCount: row.summarized_count,
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
    sourceUrl: row.source_url
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

export class Repository {
  constructor(private readonly db: D1Database) {}

  async getRunByLocalDate(localDate: string): Promise<FetchRun | null> {
    const row = await this.db
      .prepare(
        `SELECT id, local_date, status, discovered_count, selected_count, summarized_count,
          error_code, error_message, started_at, finished_at
        FROM fetch_runs WHERE local_date = ?`,
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
        ON CONFLICT(local_date) DO NOTHING`,
      )
      .bind(id, input.localDate, input.startedAt)
      .run();
    const run = await this.getRunByLocalDate(input.localDate);
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
          deleted_at = excluded.deleted_at`
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
      this.db.prepare("DELETE FROM source_comments WHERE item_id = ?").bind(itemId),
      ...comments.map((comment) =>
        this.db
          .prepare(
            `INSERT INTO source_comments (
              id, item_id, external_id, parent_external_id, author, body, score, depth,
              reddit_url, published_at, fetched_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
            comment.deletedAt
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
        WHERE id = ? AND status = 'summarizing' AND summary_claim_token = ?
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
        WHERE NOT (
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        WHERE NOT (
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
        summary.reviewedAt ?? null
      )
      .run();
  }

  async recordReview(
    summaryId: string,
    action: "approve" | "reject",
    at: string
  ): Promise<void> {
    const status: SummaryStatus = action === "approve" ? "approved" : "rejected";

    await this.db.batch([
      this.db
        .prepare("UPDATE summaries SET status = ?, reviewed_at = ? WHERE id = ?")
        .bind(status, at, summaryId),
      this.db
        .prepare("INSERT INTO review_actions (summary_id, action, created_at) VALUES (?, ?, ?)")
        .bind(summaryId, action, at)
    ]);
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
          error_code, error_message, started_at, finished_at
        FROM fetch_runs
        ORDER BY local_date DESC, started_at DESC
        LIMIT 1`
      )
      .first<FetchRunRow>();

    return row === null ? null : toFetchRun(row);
  }

  async listCards(status?: SummaryStatus): Promise<KnowledgeCard[]> {
    const statement =
      status === undefined
        ? this.db.prepare(
            `SELECT summaries.id, summaries.candidate_id, summaries.status, summaries.title_zh,
              summaries.one_line_fact, summaries.why_interesting,
              comment_insights, caveats, confidence_note, model, prompt_version,
              input_hash, generated_at, reviewed_at, source_items.title AS title_en,
              source_items.reddit_url, source_items.source_url
            FROM summaries
            JOIN candidates ON candidates.id = summaries.candidate_id
            JOIN source_items ON source_items.id = candidates.item_id
            WHERE summaries.status != 'source_deleted'
            ORDER BY summaries.generated_at DESC`
          )
        : this.db
            .prepare(
              `SELECT summaries.id, summaries.candidate_id, summaries.status, summaries.title_zh,
                summaries.one_line_fact, summaries.why_interesting,
                comment_insights, caveats, confidence_note, model, prompt_version,
                input_hash, generated_at, reviewed_at, source_items.title AS title_en,
                source_items.reddit_url, source_items.source_url
              FROM summaries
              JOIN candidates ON candidates.id = summaries.candidate_id
              JOIN source_items ON source_items.id = candidates.item_id
              WHERE summaries.status = ?
              ORDER BY summaries.generated_at DESC`
            )
            .bind(status);
    const result = await statement.all<SummaryRow>();

    return result.results.map(toSummary);
  }

  async setAnonymousEnabled(enabled: boolean, at = new Date().toISOString()): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO settings (key, enabled, consecutive_failures, updated_at)
        VALUES (?, ?, 0, ?)
        ON CONFLICT(key) DO UPDATE SET
          enabled = excluded.enabled,
          consecutive_failures = 0,
          updated_at = excluded.updated_at`
      )
      .bind(ANONYMOUS_COLLECTION_KEY, enabled ? 1 : 0, at)
      .run();
  }

  async recordAnonymousFailure(at: string): Promise<AnonymousCollection> {
    await this.db
      .prepare(
        `INSERT INTO settings (key, enabled, consecutive_failures, updated_at)
        VALUES (?, 1, 1, ?)
        ON CONFLICT(key) DO UPDATE SET
          consecutive_failures = settings.consecutive_failures + 1,
          enabled = CASE
            WHEN settings.consecutive_failures + 1 >= ? THEN 0
            ELSE settings.enabled
          END,
          updated_at = excluded.updated_at`
      )
      .bind(ANONYMOUS_COLLECTION_KEY, at, ANONYMOUS_FAILURE_THRESHOLD)
      .run();

    return this.getAnonymousCollection();
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
