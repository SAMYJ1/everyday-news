import { applyD1Migrations, env } from "cloudflare:test";
import initialMigration from "../migrations/0001_initial.sql?raw";

export async function applyMigrations(db: D1Database = env.DB): Promise<void> {
  await applyD1Migrations(db, [
    {
      name: "0001_initial.sql",
      queries: initialMigration
        .split(";")
        .map((query) => query.trim())
        .filter(Boolean)
    }
  ]);
}
