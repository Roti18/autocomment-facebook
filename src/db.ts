import Database from 'better-sqlite3';
import * as path from 'path';

interface CommentedPost {
  id: number;
  post_id: string;
  post_url: string;
  author_name: string | null;
  commented_at: string;
}

const dbPath = path.resolve(process.cwd(), 'facebook.db');
const db = new Database(dbPath);

/** Initialize database: create table if not exists */
export function initDb() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS commented_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id TEXT UNIQUE NOT NULL,
      post_url TEXT NOT NULL,
      author_name TEXT,
      commented_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Migration: add post_url & author_name columns if missing (v1 -> v2)
  try {
    const tableInfo = db.prepare("PRAGMA table_info(commented_posts)").all() as any[];
    if (!tableInfo.some(col => col.name === 'post_url')) {
      db.prepare("ALTER TABLE commented_posts ADD COLUMN post_url TEXT NOT NULL DEFAULT ''").run();
    }
    if (!tableInfo.some(col => col.name === 'author_name')) {
      db.prepare("ALTER TABLE commented_posts ADD COLUMN author_name TEXT").run();
    }
  } catch (_) {}
}

/** Check if a post has already been commented */
export function isPostCommented(postId: string): boolean {
  const result = db.prepare("SELECT 1 FROM commented_posts WHERE post_id = ?").get(postId);
  return result !== undefined;
}

/** Mark a post as commented (returns true if inserted, false if already exists) */
export function markPostCommented(
  postId: string,
  postUrl: string,
  authorName?: string
): boolean {
  try {
    const result = db.prepare(`
      INSERT OR IGNORE INTO commented_posts (post_id, post_url, author_name)
      VALUES (?, ?, ?)
    `).run(postId, postUrl, authorName || null);
    return result.changes > 0;
  } catch (_) {
    return false;
  }
}

/** Load all previously commented post IDs (for populating the in-memory Set) */
export function getAllCommentedPostIds(): string[] {
  const rows = db.prepare("SELECT post_id FROM commented_posts").all() as Pick<CommentedPost, 'post_id'>[];
  return rows.map(r => r.post_id);
}

/** Close database connection */
export function closeDb() {
  db.close();
}
