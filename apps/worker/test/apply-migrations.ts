import { applyD1Migrations, env } from "cloudflare:test";
import initialMigration from "../migrations/0001_initial.sql?raw";
import deliveryClaimsMigration from "../migrations/0002_delivery_claims.sql?raw";
import anonymousFailureDaysMigration from "../migrations/0003_anonymous_failure_days.sql?raw";

const triggerStart = deliveryClaimsMigration.indexOf("CREATE TRIGGER");
const deliveryClaimQueries = [
  ...deliveryClaimsMigration.slice(0, triggerStart).split(";").map((query) => query.trim()).filter(Boolean),
  deliveryClaimsMigration.slice(triggerStart).trim(),
];

export async function applyMigrations(db: D1Database = env.DB): Promise<void> {
  await applyD1Migrations(db, [
    {
      name: "0001_initial.sql",
      queries: initialMigration
        .split(";")
        .map((query) => query.trim())
        .filter(Boolean)
    }
    ,
    {
      name: "0002_delivery_claims.sql",
      queries: deliveryClaimQueries
    },
    {
      name: "0003_anonymous_failure_days.sql",
      queries: anonymousFailureDaysMigration
        .split(";")
        .map((query) => query.trim())
        .filter(Boolean)
    }
  ]);
}
