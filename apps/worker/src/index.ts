import { WorkersAiCardGenerator, WorkersAiTemporaryFailure } from "./ai/workers-ai";
import { Repository } from "./db/repository";
import type { Env, PipelineMessage } from "./env";
import { routeRequest } from "./http/router";
import { collectComments } from "./pipeline/comments";
import { recordAccessFailure, syncSourceState, type AccessFailureCode } from "./pipeline/cleanup";
import { discoverCandidates, type PipelineDeps } from "./pipeline/discover";
import {
  SUMMARY_CLAIM_LEASE_MS,
  SummaryClaimUnavailable,
  summarizeCandidate,
} from "./pipeline/summarize";
import {
  AnonymousJsonRedditAdapter,
  RedditAccessDenied,
  RedditChallenge,
  RedditRateLimited,
  RedditTemporaryFailure,
} from "./reddit/anonymous-json";
import type { RedditSourceAdapter } from "./reddit/adapter";
import type { CardGenerator } from "./ai/workers-ai";

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const SUMMARY_CLAIM_RETRY_DELAY_SECONDS = Math.ceil(SUMMARY_CLAIM_LEASE_MS / 1_000);
const RUN_DELIVERY_CLAIM_LEASE_MS = 60_000;
// Reddit transport retries use the delivery attempt number: 30s, 60s, 120s, 240s, then 300s.
const REDDIT_RETRY_BASE_DELAY_SECONDS = 30;
const REDDIT_RETRY_MAX_DELAY_SECONDS = 300;

export class PipelineTemporaryFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PipelineTemporaryFailure";
  }
}

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
  return error instanceof WorkersAiTemporaryFailure ||
    error instanceof PipelineTemporaryFailure;
}

function redditRetryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(
    REDDIT_RETRY_MAX_DELAY_SECONDS,
    REDDIT_RETRY_BASE_DELAY_SECONDS * (2 ** exponent),
  );
}

function accessFailureCode(error: unknown): AccessFailureCode | null {
  if (error instanceof RedditAccessDenied) {
    return error.status === 401 ? "unauthorized" : "forbidden";
  }
  if (error instanceof RedditRateLimited) return "rate_limited";
  if (error instanceof RedditChallenge) return "challenge";
  return null;
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
  const token = crypto.randomUUID();
  const claimed = await repository.claimRunDiscoveryDelivery(
    result.run.id,
    token,
    now.toISOString(),
    new Date(now.getTime() - RUN_DELIVERY_CLAIM_LEASE_MS).toISOString(),
  );
  if (claimed) {
    try {
      await pipeline.send({ stage: "discover", runId: result.run.id });
      await repository.markRunRunningForDiscoveryDelivery(result.run.id, token);
    } catch (error) {
      await repository.releaseRunDiscoveryDelivery(result.run.id, token);
      throw error;
    }
  }
  return result.run;
}

function completedCommentsStage(status: string): boolean {
  return status === "comments_ready" || status === "summarizing" || status === "summarized" || status === "failed";
}

function completedSummaryStage(status: string): boolean {
  return status === "summarized" || status === "failed";
}

async function sendPipeline(
  pipeline: Queue<PipelineMessage>,
  body: PipelineMessage,
): Promise<void> {
  try {
    await pipeline.send(body);
  } catch (error) {
    throw new PipelineTemporaryFailure("Pipeline queue delivery failed", {
      cause: error,
    });
  }
}

async function refreshRunStatus(
  repository: Repository,
  runId: string,
  finishedAt: string,
): Promise<void> {
  try {
    await repository.refreshRunStatus(runId, finishedAt);
  } catch (error) {
    throw new PipelineTemporaryFailure("Run status refresh failed", {
      cause: error,
    });
  }
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
      onDiscoveryRequestSucceeded: async (at) => {
        await repository.recordAnonymousSuccess(at.toISOString());
      },
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
      if (
        message.body.stage !== "summarize" &&
        await repository.getRunStatus(message.body.runId) === "failed"
      ) {
        if (message.body.stage === "comments") {
          const candidate = await repository.getCandidate(
            message.body.runId,
            message.body.itemId,
          );
          if (candidate?.status === "selected") {
            await repository.setCandidateStatus(candidate.id, "failed");
          }
        }
        message.ack();
        return;
      }

      switch (message.body.stage) {
        case "discover": {
          const anonymous = await repository.getAnonymousCollection();
          if (!anonymous.enabled) {
            await repository.markRunFailed(
              message.body.runId,
              "anonymous_disabled",
              "Anonymous Reddit collection is disabled",
              current.toISOString(),
            );
            message.ack();
            return;
          }
          await repository.markRunRunning(message.body.runId);
          await syncSourceState(deps, current);
          const result = await discoverCandidates(deps, message.body.runId);
          for (const itemId of result.itemIds) {
            await sendPipeline(
              env.PIPELINE,
              { stage: "comments", runId: message.body.runId, itemId },
            );
          }
          await refreshRunStatus(repository, message.body.runId, current.toISOString());
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
            await sendPipeline(env.PIPELINE, { ...message.body, stage: "summarize" });
            message.ack();
            return;
          }
          if (completedCommentsStage(candidate.status)) {
            if (completedSummaryStage(candidate.status)) {
              await refreshRunStatus(repository, message.body.runId, current.toISOString());
            }
            message.ack();
            return;
          }
          const anonymous = await repository.getAnonymousCollection();
          if (!anonymous.enabled) {
            await repository.setCandidateStatus(candidate.id, "failed");
            await repository.markRunFailed(
              message.body.runId,
              "anonymous_disabled",
              "Anonymous Reddit collection is disabled",
              current.toISOString(),
            );
            message.ack();
            return;
          }
          await collectComments(deps, message.body.runId, message.body.itemId);
          await repository.setCandidateStatus(candidate.id, "comments_ready");
          await sendPipeline(env.PIPELINE, { ...message.body, stage: "summarize" });
          message.ack();
          return;
        }
        case "summarize": {
          const candidate = await repository.getCandidate(message.body.runId, message.body.itemId);
          if (candidate === null) {
            message.ack();
            return;
          }
          if (
            completedSummaryStage(candidate.status) &&
            message.body.regeneration === undefined &&
            await repository.getActiveCardRegeneration(candidate.id) === null
          ) {
            await refreshRunStatus(repository, message.body.runId, current.toISOString());
            message.ack();
            return;
          }
          await summarizeCandidate(
            { ...deps, generator: options.generator ?? new WorkersAiCardGenerator(env.AI) },
            message.body.runId,
            message.body.itemId,
            message.body.regeneration,
          );
          await refreshRunStatus(repository, message.body.runId, current.toISOString());
          message.ack();
          return;
        }
      }
    } catch (error) {
      if (error instanceof SummaryClaimUnavailable) {
        message.retry({ delaySeconds: SUMMARY_CLAIM_RETRY_DELAY_SECONDS });
        return;
      }
      const accessCode = accessFailureCode(error);
      if (accessCode !== null) {
        if (message.body.stage === "comments") {
          try {
            const candidate = await repository.getCandidate(
              message.body.runId,
              message.body.itemId,
            );
            if (candidate?.status === "selected") {
              await repository.setCandidateStatus(candidate.id, "failed");
            }
          } catch {
            // The run-level terminal failure is independent of candidate recovery.
          }
        }
        try {
          await recordAccessFailure(repository, accessCode, current.toISOString());
        } catch {
          // Breaker persistence is best effort; the run failure is independent.
        }
        try {
          await repository.markRunFailed(
            message.body.runId,
            accessCode,
            errorMessage(error),
            current.toISOString(),
          );
        } catch {
          // Access denial is terminal even when its run failure cannot be persisted.
        }
        message.ack();
        return;
      }
      if (error instanceof RedditTemporaryFailure) {
        message.retry({
          delaySeconds: redditRetryDelaySeconds(message.attempts),
        });
        return;
      }
      if (isTemporaryFailure(error)) {
        message.retry();
        return;
      }

      try {
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
      } catch {
        // Unknown recovery-write failures are terminal for this delivery.
      }
      message.ack();
    }
  }

  return {
    async fetch(request, env) {
      return routeRequest(request, {
        env,
        repository: new Repository(env.DB),
        now: clock(),
        startManualRun: () => {
          const now = clock();
          return startRun(
            new Repository(env.DB),
            env.PIPELINE,
            shanghaiLocalDate(now),
            "manual",
            now,
          );
        },
      });
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
          message.ack();
        }
      }
    },
  };
}

export default createWorker();
