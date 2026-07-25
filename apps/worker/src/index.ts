import { WorkersAiCardGenerator, WorkersAiTemporaryFailure } from "./ai/workers-ai";
import { Repository } from "./db/repository";
import type { Env, PipelineMessage } from "./env";
import { collectComments } from "./pipeline/comments";
import { discoverCandidates, type PipelineDeps } from "./pipeline/discover";
import { SummaryClaimUnavailable, summarizeCandidate } from "./pipeline/summarize";
import { AnonymousJsonRedditAdapter, RedditAccessDenied, RedditRateLimited, RedditTemporaryFailure } from "./reddit/anonymous-json";
import type { RedditSourceAdapter } from "./reddit/adapter";
import type { CardGenerator } from "./ai/workers-ai";

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

export interface WorkerOptions {
  now?: () => Date;
  reddit?: RedditSourceAdapter;
  generator?: CardGenerator;
}

function shanghaiLocalDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function isTemporaryFailure(error: unknown): boolean {
  return error instanceof RedditRateLimited ||
    error instanceof RedditTemporaryFailure ||
    error instanceof WorkersAiTemporaryFailure;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown pipeline error";
}

export async function startRun(
  repository: Repository,
  pipeline: Queue<PipelineMessage>,
  localDate: string,
  _trigger: "scheduled" | "manual",
  now: Date,
) {
  const result = await repository.createOrGetRun({
    localDate,
    startedAt: now.toISOString(),
  });
  if (result.created || result.run.status === "queued") {
    await pipeline.send({ stage: "discover", runId: result.run.id });
    await repository.markRunRunning(result.run.id);
  }
  return result.run;
}

function completedCommentsStage(status: string): boolean {
  return status === "comments_ready" || status === "summarizing" || status === "summarized" || status === "failed";
}

function completedSummaryStage(status: string): boolean {
  return status === "summarized" || status === "failed";
}

export function createWorker(options: WorkerOptions = {}): ExportedHandler<Env, PipelineMessage> {
  const clock = options.now ?? (() => new Date());

  function pipelineDeps(env: Env, repository: Repository): PipelineDeps {
    return {
      repository,
      reddit: options.reddit ?? new AnonymousJsonRedditAdapter({
        fetcher: fetch,
        userAgent: env.REDDIT_USER_AGENT,
      }),
      now: clock,
    };
  }

  async function processMessage(
    message: Message<PipelineMessage>,
    env: Env,
    repository: Repository,
  ): Promise<void> {
    const deps = pipelineDeps(env, repository);
    const current = clock();

    try {
      switch (message.body.stage) {
        case "discover": {
          await repository.markRunRunning(message.body.runId);
          const result = await discoverCandidates(deps, message.body.runId);
          try {
            for (const itemId of result.itemIds) {
              await env.PIPELINE.send({ stage: "comments", runId: message.body.runId, itemId });
            }
          } catch {
            message.retry();
            return;
          }
          await repository.refreshRunStatus(message.body.runId, current.toISOString());
          message.ack();
          return;
        }
        case "comments": {
          const candidate = await repository.getCandidate(message.body.runId, message.body.itemId);
          if (candidate === null) {
            message.ack();
            return;
          }
          if (candidate.status === "comments_ready") {
            try {
              await env.PIPELINE.send({ ...message.body, stage: "summarize" });
            } catch {
              message.retry();
              return;
            }
            message.ack();
            return;
          }
          if (completedCommentsStage(candidate.status)) {
            if (completedSummaryStage(candidate.status)) {
              await repository.refreshRunStatus(message.body.runId, current.toISOString());
            }
            message.ack();
            return;
          }
          await collectComments(deps, message.body.runId, message.body.itemId);
          await repository.setCandidateStatus(candidate.id, "comments_ready");
          try {
            await env.PIPELINE.send({ ...message.body, stage: "summarize" });
          } catch {
            message.retry();
            return;
          }
          message.ack();
          return;
        }
        case "summarize": {
          const candidate = await repository.getCandidate(message.body.runId, message.body.itemId);
          if (candidate === null) {
            message.ack();
            return;
          }
          if (completedSummaryStage(candidate.status)) {
            await repository.refreshRunStatus(message.body.runId, current.toISOString());
            message.ack();
            return;
          }
          await summarizeCandidate(
            { ...deps, generator: options.generator ?? new WorkersAiCardGenerator(env.AI) },
            message.body.runId,
            message.body.itemId,
          );
          await repository.refreshRunStatus(message.body.runId, current.toISOString());
          message.ack();
          return;
        }
      }
    } catch (error) {
      if (error instanceof SummaryClaimUnavailable) {
        message.retry();
        return;
      }
      if (isTemporaryFailure(error)) {
        message.retry();
        return;
      }
      if (error instanceof RedditAccessDenied) {
        await repository.markRunFailed(
          message.body.runId,
          "reddit_access_denied",
          error.message,
          current.toISOString(),
        );
        message.ack();
        return;
      }

      if (message.body.stage !== "discover") {
        const candidate = await repository.getCandidate(message.body.runId, message.body.itemId);
        if (candidate !== null) await repository.setCandidateStatus(candidate.id, "failed");
      }
      await repository.markRunPartial(
        message.body.runId,
        `pipeline_${message.body.stage}_failed`,
        errorMessage(error),
        current.toISOString(),
      );
      message.ack();
    }
  }

  return {
    fetch(request) {
      if (new URL(request.url).pathname === "/api/health") {
        return Response.json({ ok: true, service: "everyday-news-api", version: 1 });
      }

      return new Response("Not Found", { status: 404 });
    },
    async scheduled(_event, env, _ctx) {
      const now = clock();
      await startRun(
        new Repository(env.DB),
        env.PIPELINE,
        shanghaiLocalDate(now),
        "scheduled",
        now,
      );
    },
    async queue(batch, env, _ctx) {
      const repository = new Repository(env.DB);
      for (const message of batch.messages) {
        try {
          await processMessage(message, env, repository);
        } catch {
          message.retry();
        }
      }
    },
  };
}

export default createWorker();
