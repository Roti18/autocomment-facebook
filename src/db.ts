import Database from 'better-sqlite3';
import * as path from 'path';
import { Group, CommentQueueItem } from './types';

const dbPath = path.resolve(process.cwd(), 'facebook.db');
const db = new Database(dbPath);

// Enable Foreign Key support
db.pragma('foreign_keys = ON');

/**
 * Initialize SQLite database tables.
 */
export function initDb() {
  // Create groups table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_url TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('active', 'inactive')) DEFAULT 'active'
    )
  `).run();

  // Create comments_queue table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS comments_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id TEXT UNIQUE NOT NULL,
      group_id INTEGER NOT NULL,
      post_url TEXT NOT NULL,
      post_text TEXT,
      author_name TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'success', 'failed')) DEFAULT 'pending',
      error_message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT,
      FOREIGN KEY(group_id) REFERENCES groups(id)
    )
  `).run();
}

/**
 * Fetch all groups with 'active' status.
 */
export function getActiveGroups(): Group[] {
  const stmt = db.prepare("SELECT * FROM groups WHERE status = 'active'");
  return stmt.all() as Group[];
}

/**
 * Check if a post ID already exists in the queue/history.
 */
export function hasPostInQueue(postId: string): boolean {
  const stmt = db.prepare("SELECT 1 FROM comments_queue WHERE post_id = ?");
  const result = stmt.get(postId);
  return result !== undefined;
}

/**
 * Add a scraped post to the pending comment queue.
 */
export function addToQueue(
  postId: string,
  groupId: number,
  postUrl: string,
  postText: string,
  authorName: string
): boolean {
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO comments_queue (post_id, group_id, post_url, post_text, author_name, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `);
    const result = stmt.run(postId, groupId, postUrl, postText, authorName);
    return result.changes > 0;
  } catch (error) {
    console.error(`Error inserting post ${postId} into queue:`, error);
    return false;
  }
}

/**
 * Fetch pending posts for a specific group to process commenting.
 */
export function getPendingQueue(groupId: number, limit: number): CommentQueueItem[] {
  const stmt = db.prepare(`
    SELECT * FROM comments_queue 
    WHERE group_id = ? AND status = 'pending' 
    LIMIT ?
  `);
  return stmt.all(groupId, limit) as CommentQueueItem[];
}

/**
 * Update the commenting status of a queue item.
 */
export function updateQueueStatus(
  id: number,
  status: 'success' | 'failed',
  errorMessage: string | null = null
) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE comments_queue 
    SET status = ?, error_message = ?, processed_at = ? 
    WHERE id = ?
  `).run(status, errorMessage, now, id);
}

/**
 * Seed database with target groups.
 */
export function seedGroups(groups: { url: string }[]) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO groups (group_url, status)
    VALUES (?, 'active')
  `);

  const transaction = db.transaction((groupList) => {
    for (const group of groupList) {
      insert.run(group.url);
    }
  });

  transaction(groups);
}

/**
 * Close database connection safely.
 */
export function closeDb() {
  db.close();
}
