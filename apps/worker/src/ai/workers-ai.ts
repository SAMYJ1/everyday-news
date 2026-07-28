import { z } from "zod";
import type { SourceComment, SourceItem } from "../domain";
import { KnowledgeCardSchema, type KnowledgeCard } from "./card-schema";

export const CARD_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

export interface CardInput {
  item: SourceItem;
  comments: SourceComment[];
}

export interface CardGenerator {
  generate(input: CardInput): Promise<KnowledgeCard>;
}

function promptFor({ item, comments }: CardInput, repair = false): string {
  const sourceUrl = item.sourceUrl ?? "（原帖未提供外部链接）";
  const commentExcerpts = comments.length === 0
    ? "（没有可用评论摘录）"
    : comments.map((comment, index) => `评论摘录 ${index + 1}：${comment.body}`).join("\n");

  return [
    "请根据以下 Reddit 原帖与评论摘录，生成简洁的中文知识卡片 JSON。",
    "只能将帖子内容表述为“原帖声称”，只能将评论内容表述为“评论补充”或评论观点。",
    "不得声称已进行外部事实核查，也不得把外部链接内容当作已验证事实。",
    "英文原标题和链接是只读元数据：保持原样，不要翻译、改写或臆造。",
    `英文原标题（只读元数据）：${item.title ?? "（无标题）"}`,
    `Reddit URL（只读元数据）：${item.redditUrl}`,
    `外部 URL（只读元数据）：${sourceUrl}`,
    "原帖内容：",
    item.title ?? "（无标题）",
    "评论摘录：",
    commentExcerpts,
    repair ? "上一次输出不符合 JSON Schema。请修复后只返回符合 Schema 的 JSON。" : "只返回符合 JSON Schema 的 JSON。"
  ].join("\n\n");
}

export class InvalidCardResponse extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidCardResponse";
  }
}

export class WorkersAiTemporaryFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkersAiTemporaryFailure";
  }
}

function responseValue(output: Record<string, unknown>): unknown {
  if (typeof output.response === "string") {
    try {
      return JSON.parse(output.response);
    } catch (error) {
      throw new InvalidCardResponse("Workers AI returned invalid JSON", {
        cause: error,
      });
    }
  }
  if (typeof output.response === "object" && output.response !== null) {
    return output.response;
  }
  throw new InvalidCardResponse("Workers AI did not return a JSON response");
}

export class WorkersAiCardGenerator implements CardGenerator {
  constructor(private readonly ai: Ai) {}

  async generate(input: CardInput): Promise<KnowledgeCard> {
    let lastInvalidResponse: InvalidCardResponse | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let output;
      try {
        output = await this.ai.run(CARD_MODEL, {
          prompt: promptFor(input, attempt === 1),
          temperature: 0.2,
          response_format: {
            type: "json_schema",
            json_schema: z.toJSONSchema(KnowledgeCardSchema),
          },
        });
      } catch (error) {
        throw new WorkersAiTemporaryFailure("Workers AI request failed", {
          cause: error,
        });
      }
      try {
        return KnowledgeCardSchema.parse(responseValue(output));
      } catch (error) {
        lastInvalidResponse =
          error instanceof InvalidCardResponse
            ? error
            : new InvalidCardResponse(
                "Workers AI response did not match the knowledge-card schema",
                { cause: error },
              );
      }
    }

    throw (
      lastInvalidResponse ??
      new InvalidCardResponse("Workers AI returned an invalid knowledge card")
    );
  }
}
