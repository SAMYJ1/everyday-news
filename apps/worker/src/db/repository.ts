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

export class Repository {
  constructor(private readonly db: D1Database) {}

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
          selected_at = excluded.selected_at`
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
          reviewed_at = excluded.reviewed_at`
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
        `SELECT source_url
        FROM source_items
        WHERE source_url IS NOT NULL AND published_at >= ?`
      )
      .bind(cutoff)
      .all<{ source_url: string }>();

    return new Set(result.results.map((row) => row.source_url));
  }

  async getRecentTitles(days: number): Promise<string[]> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.db
      .prepare(
        `SELECT title
        FROM source_items
        WHERE title IS NOT NULL AND published_at >= ?
        ORDER BY published_at DESC, id ASC`
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
