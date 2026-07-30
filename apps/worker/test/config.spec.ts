import { describe, expect, it } from "vitest";
import { PIPELINE_MAX_RETRIES } from "../src/index";
import wranglerConfig from "../wrangler.jsonc?raw";

describe("Worker configuration", () => {
  it("keeps Queue delivery retries aligned with application terminalization", () => {
    const config = JSON.parse(wranglerConfig) as {
      queues: { consumers: Array<{ max_retries: number }> };
      observability: {
        enabled: boolean;
        logs: {
          enabled: boolean;
          head_sampling_rate: number;
          invocation_logs: boolean;
        };
      };
    };

    expect(config.queues.consumers).toHaveLength(1);
    expect(config.queues.consumers[0].max_retries).toBe(PIPELINE_MAX_RETRIES);
    expect(config.observability).toEqual({
      enabled: true,
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        invocation_logs: true,
      },
    });
  });
});
