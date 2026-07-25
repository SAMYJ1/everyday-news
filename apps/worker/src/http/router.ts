import { Repository } from "../db/repository";
import type { Env, PipelineMessage } from "../env";
import type { SummaryStatus } from "../domain";
import { isAuthorized } from "./auth";

const JSON_CONTENT_TYPE = "application/json";
const DELIVERY_CLAIM_LEASE_MS = 60_000;
const LISTABLE_CARD_STATUSES = new Set<SummaryStatus>(["draft", "approved", "rejected"]);

export interface RouterDeps {
  env: Env;
  repository: Repository;
  now: Date;
  startManualRun: () => Promise<{ id: string }>;
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  if (request.headers.get("Origin") !== env.APP_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": env.APP_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    Vary: "Origin",
  };
}

function json(request: Request, env: Env, body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders(request, env) });
}

function error(request: Request, env: Env, status: number, code: string, message: string): Response {
  return json(request, env, { error: { code, message } }, status);
}

function acceptsJson(request: Request): boolean {
  return request.headers.get("Content-Type") === JSON_CONTENT_TYPE;
}

async function parseEnabledBody(request: Request): Promise<boolean> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null &&
      Object.keys(body).length === 1 &&
      "enabled" in body &&
      (body as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

function cardId(pathname: string, action?: string): string | null {
  const match = pathname.match(action === undefined
    ? /^\/api\/cards\/([^/]+)$/
    : new RegExp(`^/api/cards/([^/]+)/${action}$`));
  return match === null ? null : decodeURIComponent(match[1]);
}

export async function routeRequest(request: Request, deps: RouterDeps): Promise<Response> {
  const { env, repository } = deps;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return request.headers.get("Origin") === env.APP_ORIGIN
      ? new Response(null, { status: 204, headers: corsHeaders(request, env) })
      : error(request, env, 403, "forbidden_origin", "Forbidden origin");
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(request, env, { ok: true, service: "everyday-news-api", version: 1 });
  }

  if (!isAuthorized(request, env)) {
    return error(request, env, 401, "unauthorized", "Unauthorized");
  }

  if (request.method === "POST" && !acceptsJson(request)) {
    return error(request, env, 415, "unsupported_media_type", "Content-Type must be application/json");
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/runs/latest") {
      return json(request, env, { run: await repository.getLatestRun() });
    }

    if (request.method === "GET" && url.pathname === "/api/cards") {
      const requestedStatus = url.searchParams.get("status");
      if (requestedStatus !== null && !LISTABLE_CARD_STATUSES.has(requestedStatus as SummaryStatus)) {
        return error(request, env, 400, "invalid_status", "Invalid card status");
      }
      return json(request, env, { cards: await repository.listCards(requestedStatus as SummaryStatus | undefined) });
    }

    const getId = cardId(url.pathname);
    if (request.method === "GET" && getId !== null) {
      const card = await repository.getCard(getId);
      return card === null
        ? error(request, env, 404, "not_found", "Card not found")
        : json(request, env, { card });
    }

    for (const action of ["approve", "reject"] as const) {
      const id = cardId(url.pathname, action);
      if (request.method === "POST" && id !== null) {
        const card = await repository.getCard(id);
        if (card === null) return error(request, env, 404, "not_found", "Card not found");
        await repository.recordReview(id, action, deps.now.toISOString());
        return json(request, env, { card: await repository.getCard(id) });
      }
    }

    const regenerateId = cardId(url.pathname, "regenerate");
    if (request.method === "POST" && regenerateId !== null) {
      const card = await repository.getCard(regenerateId);
      if (card === null) return error(request, env, 404, "not_found", "Card not found");
      const at = deps.now.toISOString();
      const regeneration = await repository.createOrGetCardRegeneration(regenerateId, at);
      if (regeneration !== null) {
        const token = crypto.randomUUID();
        const claimed = await repository.claimCardRegenerationDelivery(
          regeneration.id,
          token,
          at,
          new Date(deps.now.getTime() - DELIVERY_CLAIM_LEASE_MS).toISOString(),
        );
        if (claimed) {
          try {
            await env.PIPELINE.send({
              stage: "summarize",
              runId: regeneration.runId,
              itemId: regeneration.itemId,
              regeneration: { id: regeneration.id, nonce: regeneration.nonce },
            } satisfies PipelineMessage);
            await repository.markCardRegenerationEnqueued(regeneration.id, token, at);
          } catch (error) {
            await repository.releaseCardRegenerationDelivery(regeneration.id, token);
            throw error;
          }
        }
      }
      return json(request, env, { card: await repository.getCard(regenerateId) }, 202);
    }

    if (request.method === "POST" && url.pathname === "/api/runs") {
      return json(request, env, { run: await deps.startManualRun() }, 202);
    }

    if (request.method === "POST" && url.pathname === "/api/settings/anonymous-collection") {
      if (!await parseEnabledBody(request)) {
        return error(request, env, 400, "invalid_request", "Expected body { enabled: true }");
      }
      await repository.setAnonymousEnabled(true, deps.now.toISOString());
      return json(request, env, { anonymousCollection: await repository.getAnonymousCollection() });
    }
  } catch {
    return error(request, env, 500, "internal_error", "Internal server error");
  }

  return error(request, env, 404, "not_found", "Not found");
}
