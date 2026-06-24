import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { BotConfig } from './types';

// Load .env file
dotenv.config();

/**
 * Spintax Resolver: Rotates text using {option1|option2|option3} format.
 * Supports nested structures by resolving from the innermost brackets outwards.
 */
export function resolveSpintax(text: string): string {
  const spintaxPattern = /\{([^{}]+)\}/g;
  let matches = text.match(spintaxPattern);
  
  while (matches && matches.length > 0) {
    for (const match of matches) {
      const choices = match.slice(1, -1).split('|');
      const selected = choices[Math.floor(Math.random() * choices.length)];
      text = text.replace(match, selected);
    }
    matches = text.match(spintaxPattern);
  }
  
  return text;
}

// Default values
const DEFAULT_COMMENT_CONTENT = '{Halo|Hi|Permisi} kak, {ready parfumnya?|boleh minta info harga dan detailnya?}';

const getCommentContent = (templatePath: string): string => {
  const resolvedPath = path.resolve(templatePath);
  if (fs.existsSync(resolvedPath)) {
    try {
      return fs.readFileSync(resolvedPath, 'utf8');
    } catch (err) {
      console.error('Error reading comment template file:', err);
    }
  }
  return DEFAULT_COMMENT_CONTENT;
};

const commentTemplatePath = process.env.COMMENT_TEMPLATE_PATH || 'comment_template.txt';

export const config: BotConfig = {
  userDataDir: path.resolve(process.env.FB_USER_DATA_DIR || 'user_data'),
  headless: process.env.HEADLESS === 'true',
  minDelaySeconds: parseInt(process.env.MIN_DELAY_SECONDS || '60', 10),
  maxDelaySeconds: parseInt(process.env.MAX_DELAY_SECONDS || '180', 10),
  postIntervalMinutes: parseInt(process.env.POST_INTERVAL_MINUTES || '60', 10),
  myProfileUrl: process.env.MY_PROFILE_URL || null,
  targetKeywords: (process.env.TARGET_KEYWORDS || '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean),
  maxPostAgeDays: parseInt(process.env.MAX_POST_AGE_DAYS || '5', 10),
  maxCommentsPerGroup: parseInt(process.env.MAX_COMMENTS_PER_GROUP || '3', 10),
  commentTemplatePath: commentTemplatePath,
  commentContent: getCommentContent(commentTemplatePath),
};

// Default seed groups: parsed from groups.json if exists
export const getSeedGroups = (): { name: string; url: string }[] => {
  const jsonPath = path.resolve(process.cwd(), 'groups.json');
  
  if (fs.existsSync(jsonPath)) {
    try {
      const fileContent = fs.readFileSync(jsonPath, 'utf8');
      const parsed = JSON.parse(fileContent);
      if (Array.isArray(parsed)) {
        return parsed.map((item: any) => ({
          name: item.name || 'Unnamed Group',
          url: item.url.trim(),
        }));
      }
    } catch (jsonError) {
      console.error('Error reading/parsing groups.json, falling back to empty list.', jsonError);
    }
  }

  return [];
};
