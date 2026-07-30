import { z } from "zod";
import type { SourceComment, SourceItem } from "../domain";
import { KnowledgeCardSchema, type KnowledgeCard } from "./card-schema";

export const CARD_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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
    "titleZh 必须是 4 至 30 个汉字左右的具体标题，不能使用“我”等占位词。",
    "oneLineFact 必须用完整中文句子概括原帖主张，并以“原帖声称”开头。",
    "whyInteresting 必须具体说明这条知识为什么值得读，不能只写字段标签。",
    "commentInsights 与 caveats 的每一项都必须是有实际信息的完整中文句子。",
    "confidenceNote 必须明确说明内容只基于原帖与评论、尚未完成外部核验。",
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

function parseResponseString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new InvalidCardResponse("Workers AI returned invalid JSON", {
      cause: error,
    });
  }
}

function responseValue(output: unknown): unknown {
  if (typeof output === "string") {
    return parseResponseString(output);
  }
  if (typeof output !== "object" || output === null) {
    throw new InvalidCardResponse("Workers AI did not return a JSON response");
  }
  const response = "response" in output ? output.response : undefined;
  if (typeof response === "string") {
    return parseResponseString(response);
  }
  if (typeof response === "object" && response !== null) {
    return response;
  }
  if ("titleZh" in output) {
    return output;
  }
  throw new InvalidCardResponse("Workers AI did not return a JSON response");
}

function normalizeCardCandidate(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (!("titleZh" in value) || !("oneLineFact" in value)) return value;
  if (
    typeof value.titleZh !== "string" ||
    value.titleZh.length >= 4 ||
    typeof value.oneLineFact !== "string"
  ) {
    return value;
  }
  const derivedTitle = value.oneLineFact
    .replace(/^原帖声称[，,:：\s]*/, "")
    .split(/[。！？!?]/, 1)[0]
    ?.trim()
    .slice(0, 30);
  if (derivedTitle === undefined || derivedTitle.length < 4) return value;
  return { ...value, titleZh: derivedTitle };
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
          max_tokens: 700,
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
        const card = KnowledgeCardSchema.parse(
          normalizeCardCandidate(responseValue(output)),
        );
        if (input.comments.length > 0 && card.commentInsights.length === 0) {
          throw new InvalidCardResponse(
            "Workers AI omitted comment insights despite available comments",
          );
        }
        return card;
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
