import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { BotConfig } from './types';

dotenv.config();

/**
 * Spintax Resolver: {option1|option2|option3}
 */
export function resolveSpintax(text: string): string {
  const spintaxPattern = /\{([^{}]+)\}/g;
  let prev = '';
  while (prev !== text) {
    prev = text;
    text = text.replace(spintaxPattern, (_match, group) => {
      const choices = group.split('|');
      return choices[Math.floor(Math.random() * choices.length)].trim();
    });
  }
  return text;
}

const DEFAULT_COMMENT = '{Halo|Hi|Permisi|Pagi|Siang} kak, {ready parfumnya?|boleh minta info?|masih ada?}';

const getCommentContent = (templatePath: string): string => {
  const resolvedPath = path.resolve(templatePath);
  if (fs.existsSync(resolvedPath)) {
    try {
      return fs.readFileSync(resolvedPath, 'utf8');
    } catch (_) {}
  }
  return DEFAULT_COMMENT;
};

const commentTemplatePath = process.env.COMMENT_TEMPLATE_PATH || 'comment_template.txt';
const rawCommentContent = getCommentContent(commentTemplatePath);

const stripLinks = (text: string): string =>
  text
    .split('\n')
    .filter(line => !line.trim().match(/^https?:\/\//i))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const config: BotConfig = {
  userDataDir: path.resolve(process.env.FB_USER_DATA_DIR || './user_data'),
  headless: process.env.HEADLESS === 'true',

  berandaScrollCount: parseInt(process.env.BERANDA_SCROLL_COUNT || '50', 10),
  berandaScrollDelay: parseInt(process.env.BERANDA_SCROLL_DELAY || '5', 10),

  targetKeywords: (process.env.TARGET_KEYWORDS || '')
    .split(',')
    .map(k => k.trim().toLowerCase())
    .filter(Boolean),

  readingDelayMin: parseInt(process.env.READING_DELAY_MIN || '15', 10),
  readingDelayMax: parseInt(process.env.READING_DELAY_MAX || '40', 10),

  cooldownMin: parseInt(process.env.COOLDOWN_MIN || '90', 10),
  cooldownMax: parseInt(process.env.COOLDOWN_MAX || '300', 10),

  longBreakInterval: parseInt(process.env.LONG_BREAK_INTERVAL || '4', 10),
  longBreakMinutes: parseInt(process.env.LONG_BREAK_MINUTES || '12', 10),

  maxTotalComments: parseInt(process.env.MAX_TOTAL_COMMENTS || '25', 10),

  commentTemplatePath,
  commentContent: rawCommentContent,
  commentContentNoLink: stripLinks(rawCommentContent),

  commentImagePath: process.env.COMMENT_IMAGE_PATH
    ? path.resolve(process.env.COMMENT_IMAGE_PATH)
    : null,

  myProfileUrl: process.env.MY_PROFILE_URL || null,
};
