import { z } from "zod";

export const KnowledgeCardSchema = z.strictObject({
  titleZh: z.string().min(4).regex(/[\u3400-\u9fff]/, "titleZh must contain Chinese text"),
  oneLineFact: z.string().min(10),
  whyInteresting: z.string().min(8),
  commentInsights: z.array(z.string().min(8)).max(3),
  caveats: z.array(z.string().min(8)).max(3),
  confidenceNote: z.string().min(8)
});

export type KnowledgeCard = z.infer<typeof KnowledgeCardSchema>;
