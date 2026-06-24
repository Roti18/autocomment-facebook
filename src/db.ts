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
      group_name TEXT,
      group_url TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('active', 'inactive')) DEFAULT 'active'
    )
  `).run();

  // Migration: check if group_name column exists, if not, add it
  try {
    const tableInfo = db.prepare("PRAGMA table_info(groups)").all() as any[];
    const hasGroupName = tableInfo.some(col => col.name === 'group_name');
    if (!hasGroupName) {
      db.prepare("ALTER TABLE groups ADD COLUMN group_name TEXT").run();
    }
  } catch (err) {
    console.error("Migration error:", err);
  }

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
export function seedGroups(groups: { name: string; url: string }[]) {
  const check = db.prepare("SELECT id FROM groups WHERE group_url = ?");
  const insert = db.prepare(`
    INSERT INTO groups (group_url, group_name, status)
    VALUES (?, ?, 'active')
  `);
  const update = db.prepare(`
    UPDATE groups SET group_name = ? WHERE group_url = ?
  `);

  const transaction = db.transaction((groupList) => {
    for (const group of groupList) {
      const existing = check.get(group.url);
      if (existing) {
        update.run(group.name, group.url);
      } else {
        insert.run(group.url, group.name);
      }
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
