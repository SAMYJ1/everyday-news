import { Repository } from "../db/repository";
import type { Env } from "../env";
import type { SummaryStatus } from "../domain";
import { isAuthorized } from "./auth";

const JSON_CONTENT_TYPE = "application/json";
const LISTABLE_CARD_STATUSES = new Set<SummaryStatus>(["draft", "approved", "rejected"]);

export interface RouterDeps {
  env: Env;
  repository: Repository;
  now: Date;
  runStaleAfterMs: number;
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

function isValidLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day);
}

function publicFeedLimit(value: string | null): number | null {
  if (value === null) return 20;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50 ? parsed : null;
}

function publicFeedCursor(value: string | null): { generatedAt: string; id: string } | null | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (
      typeof parsed !== "object" || parsed === null ||
      !("generatedAt" in parsed) || typeof parsed.generatedAt !== "string" ||
      Number.isNaN(Date.parse(parsed.generatedAt)) ||
      !("id" in parsed) || typeof parsed.id !== "string" || parsed.id.length === 0
    ) return null;
    return { generatedAt: parsed.generatedAt, id: parsed.id };
  } catch {
    return null;
  }
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

  if (request.method === "GET" && url.pathname === "/api/public/dates") {
    try {
      return json(request, env, { dates: await repository.listPublicDates() });
    } catch {
      return error(request, env, 500, "internal_error", "Internal server error");
    }
  }

  if (request.method === "GET" && url.pathname === "/api/public/cards") {
    const limit = publicFeedLimit(url.searchParams.get("limit"));
    if (limit === null) return error(request, env, 400, "invalid_limit", "Limit must be an integer from 1 to 50");
    const cursor = publicFeedCursor(url.searchParams.get("cursor"));
    if (cursor === null) return error(request, env, 400, "invalid_cursor", "Cursor is invalid");
    try {
      return json(request, env, await repository.listPublicFeed(limit, cursor));
    } catch {
      return error(request, env, 500, "internal_error", "Internal server error");
    }
  }

  if (!isAuthorized(request, env)) {
    return error(request, env, 401, "unauthorized", "Unauthorized");
  }

  if (request.method === "POST" && !acceptsJson(request)) {
    return error(request, env, 415, "unsupported_media_type", "Content-Type must be application/json");
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/runs/latest") {
      await repository.reconcileStaleRuns(
        new Date(deps.now.getTime() - deps.runStaleAfterMs).toISOString(),
        deps.now.toISOString(),
      );
      return json(request, env, { run: await repository.getLatestRun() });
    }

    if (request.method === "GET" && url.pathname === "/api/runs") {
      const date = url.searchParams.get("date");
      if (date !== null && !isValidLocalDate(date)) {
        return error(request, env, 400, "invalid_date", "Date must be a valid YYYY-MM-DD");
      }
      return json(request, env, { runs: await repository.listRuns(date ?? undefined) });
    }

    if (request.method === "GET" && url.pathname === "/api/cards") {
      const requestedStatus = url.searchParams.get("status");
      const date = url.searchParams.get("date");
      if (requestedStatus !== null && !LISTABLE_CARD_STATUSES.has(requestedStatus as SummaryStatus)) {
        return error(request, env, 400, "invalid_status", "Invalid card status");
      }
      if (date !== null && !isValidLocalDate(date)) {
        return error(request, env, 400, "invalid_date", "Date must be a valid YYYY-MM-DD");
      }
      return json(request, env, {
        cards: await repository.listCards(
          requestedStatus as SummaryStatus | undefined,
          date ?? undefined,
        ),
      });
    }

    const getId = cardId(url.pathname);
    if (request.method === "GET" && getId !== null) {
      const card = await repository.getCard(getId);
      return card === null
        ? error(request, env, 404, "not_found", "Card not found")
        : json(request, env, { card });
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
