import type { Env } from "../env";

export function isAuthorized(request: Request, env: Pick<Env, "ADMIN_KEY">): boolean {
  return request.headers.get("Authorization") === `Bearer ${env.ADMIN_KEY}`;
}
