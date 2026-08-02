import { applyD1Migrations, env } from "cloudflare:test";
import initialMigration from "../migrations/0001_initial.sql?raw";
import deliveryClaimsMigration from "../migrations/0002_delivery_claims.sql?raw";
import anonymousFailureDaysMigration from "../migrations/0003_anonymous_failure_days.sql?raw";
import runAttemptsMigration from "../migrations/0004_run_attempts.sql?raw";
import aiPublishingMigration from "../migrations/0005_ai_publishing.sql?raw";

function migrationQueries(sql: string): string[] {
  const triggerPattern = /CREATE TRIGGER[\s\S]*?END;/g;
  const triggers = [...sql.matchAll(triggerPattern)].map(([trigger]) => trigger.trim());
  const statements = sql
    .replace(triggerPattern, "")
    .split(";")
    .map((query) => query.trim())
    .filter(Boolean);
  return [...statements, ...triggers];
}

export const migrations = [
    {
      name: "0001_initial.sql",
      queries: migrationQueries(initialMigration)
    },
    {
      name: "0002_delivery_claims.sql",
      queries: migrationQueries(deliveryClaimsMigration)
    },
    {
      name: "0003_anonymous_failure_days.sql",
      queries: migrationQueries(anonymousFailureDaysMigration)
    },
    {
      name: "0004_run_attempts.sql",
      queries: migrationQueries(runAttemptsMigration)
    },
    {
      name: "0005_ai_publishing.sql",
      queries: migrationQueries(aiPublishingMigration)
    }
  ];

export async function applyMigrations(
  db: D1Database = env.DB,
  through?: string,
): Promise<void> {
  const end = through === undefined
    ? migrations.length
    : migrations.findIndex(({ name }) => name === through) + 1;
  if (end === 0) throw new Error(`Unknown migration: ${through}`);
  await applyD1Migrations(db, migrations.slice(0, end));
}
