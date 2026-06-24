export interface Group {
  id: number;
  group_url: string;
  status: 'active' | 'inactive';
}

export interface CommentQueueItem {
  id: number;
  post_id: string;
  group_id: number;
  post_url: string;
  post_text: string | null;
  author_name: string | null;
  status: 'pending' | 'success' | 'failed';
  error_message: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface BotConfig {
  userDataDir: string;
  headless: boolean;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  postIntervalMinutes: number;
  myProfileUrl: string | null;
  targetKeywords: string[];
  maxPostAgeDays: number;
  maxCommentsPerGroup: number;
  commentTemplatePath: string;
  commentContent: string;
}
