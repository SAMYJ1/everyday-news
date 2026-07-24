import type { SourceComment, SourceItem } from "../domain";

export interface RedditSourceAdapter {
  listTopPosts(options: { limit: number; time: "day" }): Promise<SourceItem[]>;
  getPostWithComments(
    postId: string,
    options: { limit: number; depth: number },
  ): Promise<{
    item: SourceItem;
    comments: SourceComment[];
  }>;
  checkItems(ids: string[]): Promise<Array<{ id: string; deleted: boolean }>>;
}
