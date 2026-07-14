export interface BotConfig {
  userDataDir: string;
  headless: boolean;

  // Beranda scrolling
  berandaScrollCount: number;
  berandaScrollDelay: number;

  // Keyword filters
  targetKeywords: string[];

  // Simulasi baca post
  readingDelayMin: number;
  readingDelayMax: number;

  // Cooldown after comment
  cooldownMin: number;
  cooldownMax: number;

  // Long break every N comments
  longBreakInterval: number;
  longBreakMinutes: number;

  // Total limit
  maxTotalComments: number;

  // Comment content
  commentTemplatePath: string;
  commentContent: string;
  commentContentNoLink: string;

  // Image
  commentImagePath: string | null;

  // Profile
  myProfileUrl: string | null;
}
