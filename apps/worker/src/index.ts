import type { Env, PipelineMessage } from "./env";

export default {
  fetch(request) {
    if (new URL(request.url).pathname === "/api/health") {
      return Response.json({ ok: true, service: "everyday-news-api", version: 1 });
    }

    return new Response("Not Found", { status: 404 });
  },
  scheduled(_event, _env, _ctx) {},
  queue(_batch, _env, _ctx) {}
} satisfies ExportedHandler<Env, PipelineMessage>;
