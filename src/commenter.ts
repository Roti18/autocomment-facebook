import { chromium, Locator, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { config, resolveSpintax, getSeedGroups } from './config';
import {
  initDb,
  getActiveGroups,
  seedGroups,
  hasPostInQueue,
  addToQueue,
  getPendingQueue,
  updateQueueStatus,
  closeDb
} from './db';

/**
 * Utility function to sleep for a specified duration in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse relative post age text (e.g. "5 hr", "kemarin", "2 j", "1w", "25 Juni") into age in days.
 */
function getPostAgeInDays(timeText: string): number {
  timeText = timeText.toLowerCase().replace(/\s+/g, '');
  
  // Minutes / hours / just now / barusan
  if (
    timeText.includes('menit') || 
    timeText.includes('min') || 
    timeText.includes('baru') || 
    timeText.includes('justnow') || 
    timeText.includes('sec') || 
    timeText.includes('dtk') ||
    /\d+m/.test(timeText)
  ) {
    return 0; // Less than 1 day
  }
  
  // Hours
  if (
    timeText.includes('jam') || 
    timeText.includes('hr') || 
    /\d+h/.test(timeText) ||
    /\d+j/.test(timeText)
  ) {
    return 0; // Less than 1 day
  }
  
  if (timeText.includes('kemarin') || timeText.includes('yesterday')) {
    return 1;
  }
  
  // Days (e.g., "3 hr", "3 hari", "3 days", "3d")
  const dayMatch = timeText.match(/(\d+)(hr|hari|d|day|days)/);
  if (dayMatch) {
    return parseInt(dayMatch[1], 10);
  }
  
  // Weeks (e.g., "1 mg", "1 minggu", "1w", "1 week")
  const weekMatch = timeText.match(/(\d+)(mg|minggu|w|week|weeks)/);
  if (weekMatch) {
    return parseInt(weekMatch[1], 10) * 7;
  }
  
  // Months (e.g., "1 bln", "1 bulan", "1 month")
  const monthMatch = timeText.match(/(\d+)(bln|bulan|m|month|months)/);
  if (monthMatch) {
    return parseInt(monthMatch[1], 10) * 30;
  }

  // Fallback: Try standard Date parse for absolute dates
  try {
    const dateObj = new Date(timeText);
    if (!isNaN(dateObj.getTime())) {
      const diffTime = Math.abs(Date.now() - dateObj.getTime());
      return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }
  } catch (e) {
    // Ignore parse errors
  }

  return 0; // Default fallback to process the post
}

/**
 * Extract numeric post ID from a Facebook URL.
 */
function extractPostId(href: string | null): string | null {
  if (!href) return null;
  
  // 1. Direct posts/permalink path
  const pathMatch = href.match(/\/(?:posts|permalink|multi_permalink)\/(\d+)/);
  if (pathMatch) return pathMatch[1];

  // 2. Query param story_fbid
  const storyMatch = href.match(/[?&]story_fbid=(\d+)/);
  if (storyMatch) return storyMatch[1];

  // 3. Query param set=gm.456 or set=pcb.456
  const setMatch = href.match(/[?&]set=(?:pcb|gm)\.(\d+)/);
  if (setMatch) return setMatch[1];

  // 4. Query param fbid
  const fbidMatch = href.match(/[?&]fbid=(\d+)/);
  if (fbidMatch) return fbidMatch[1];

  return null;
}

/**
 * Main automated commenter runner.
 */
async function main() {
  console.log('Initializing database...');
  initDb();

  // Load credentials for auto-login
  let authEmail = process.env.FB_EMAIL || '';
  let authPassword = process.env.FB_PASSWORD || '';
  const configJsonPath = path.resolve(process.cwd(), 'config.json');
  if (fs.existsSync(configJsonPath)) {
    try {
      const configJson = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
      if (configJson.email && configJson.email !== 'NOMOR_HP_ATAU_EMAIL_LU_DISINI') {
        authEmail = configJson.email;
      }
      if (configJson.password && configJson.password !== 'PASSWORD_FB_LU_DISINI') {
        authPassword = configJson.password;
      }
    } catch (err) {}
  }

  // Sync groups from groups.json
  const seedList = getSeedGroups();
  if (seedList.length > 0) {
    console.log('Syncing target groups from groups.json...');
    seedGroups(seedList);
  }

  const activeGroups = getActiveGroups();
  if (activeGroups.length === 0) {
    console.log('No active groups found in database. Exiting.');
    closeDb();
    return;
  }

  console.log(`Found ${activeGroups.length} active groups to process.`);

  // Create user data directory if it doesn't exist
  if (!fs.existsSync(config.userDataDir)) {
    fs.mkdirSync(config.userDataDir, { recursive: true });
    console.log(`Created user data directory at: ${config.userDataDir}`);
  }

  console.log('Launching browser with persistent context...');
  const context = await chromium.launchPersistentContext(config.userDataDir, {
    headless: config.headless,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: null, // Let browser screen size decide
    args: [
      '--disable-notifications',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      '--no-sandbox',
      '--disable-infobars'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });

  // Apply stealth script to bypass automation detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  try {
    // 1. Session Check & Bootstrap Login
    console.log('Navigating to Facebook Home...');
    await page.goto('https://facebook.com/', { waitUntil: 'domcontentloaded' });

    console.log('Checking login status...');
    const loginSelectors = [
      'input#email',
      'input[name="email"]',
      'button[name="login"]',
      'a[data-testid="open-registration-form-button"]'
    ];

    const loggedInSelectors = [
      '[role="navigation"]',
      'input[placeholder*="Cari"]',
      'input[placeholder*="Search"]',
      '[aria-label="Facebook"]',
      'a[href*="/me/"]',
      'div[aria-label="Akun"]'
    ];

    let isLogged = false;
    let isLoginScreen = false;

    // Polling to identify current page state
    for (let attempts = 0; attempts < 16; attempts++) {
      for (const sel of loggedInSelectors) {
        if (await page.locator(sel).first().isVisible()) {
          isLogged = true;
          break;
        }
      }
      if (isLogged) break;

      for (const sel of loginSelectors) {
        if (await page.locator(sel).first().isVisible()) {
          isLoginScreen = true;
          break;
        }
      }
      if (isLoginScreen) break;

      await sleep(500);
    }

    if (isLoginScreen && !isLogged) {
      if (authEmail && authPassword) {
        console.log(`\nAttempting automatic login for account: ${authEmail}...`);
        try {
          await page.locator('input#email, input[name="email"]').first().fill(authEmail);
          await sleep(1000);
          await page.locator('input#pass, input[name="pass"]').first().fill(authPassword);
          await sleep(1000);
          await page.locator('button[name="login"]').first().click();
          console.log('Login form submitted. Waiting for page navigation...');
          await sleep(6000);
          
          // Re-verify login status
          for (const sel of loggedInSelectors) {
            if (await page.locator(sel).first().isVisible()) {
              isLogged = true;
              break;
            }
          }
        } catch (authErr: any) {
          console.error(`Automatic login failed: ${authErr.message}`);
        }
      }

      if (!isLogged) {
        console.log('\n===============================================================');
        console.log('WARNING: Facebook session not found or expired.');
        console.log('Please log in manually in the browser window.');
        console.log('The bot will wait for you to complete login in the GUI...');
        console.log('===============================================================\n');

        let loggedIn = false;
        const maxRetries = 180; // 15 minutes wait limit to give plenty of time for captcha
        let retries = 0;

        while (!loggedIn && retries < maxRetries) {
          await sleep(5000);
          retries++;
          
          let feedVisible = false;
          for (const sel of loggedInSelectors) {
            if (await page.locator(sel).first().isVisible()) {
              feedVisible = true;
              break;
            }
          }

          if (feedVisible) {
            loggedIn = true;
          } else {
            const currentUrl = page.url();
            if (currentUrl.includes('checkpoint') || currentUrl.includes('captcha')) {
              if (retries % 3 === 0) {
                console.log('Bot status: Waiting for security checkpoint/CAPTCHA to be solved manually...');
              }
            } else {
              if (retries % 3 === 0) {
                console.log('Bot status: Waiting for manual login completion...');
              }
            }
          }
        }

        if (!loggedIn) {
          throw new Error('Login wait timeout exceeded. Exiting bot.');
        }
        console.log('Login detected successfully! Re-routing to start queue...');
        await sleep(3000);
      }
    } else if (isLogged) {
      console.log('Facebook session loaded successfully! (Logged in state verified)');
    } else {
      console.log('Could not identify login state clearly. Proceeding with existing session context...');
    }

    // 2. Scrape Own Profile URL to Ignore Own Posts
    let myProfileUrl = config.myProfileUrl;
    if (!myProfileUrl) {
      console.log('Scraping own profile URL for filtering own posts...');
      const meLink = page.locator('a[href*="/me/"]').first();
      if (await meLink.count() > 0) {
        const href = await meLink.getAttribute('href');
        if (href) {
          myProfileUrl = href;
        }
      }
      
      if (!myProfileUrl) {
        // Fallback: Search generic user profile links
        const profileLink = page.locator('a[href*="facebook.com/profile.php"], a[href^="/user/"], a[href^="/profile.php"]').first();
        if (await profileLink.count() > 0) {
          const href = await profileLink.getAttribute('href');
          if (href) {
            myProfileUrl = href;
          }
        }
      }

      if (myProfileUrl) {
        // Normalize URL (strip queries)
        try {
          const urlObj = new URL(myProfileUrl, 'https://facebook.com');
          urlObj.search = '';
          myProfileUrl = urlObj.toString();
          console.log(`Automatically detected bot Profile URL: ${myProfileUrl}`);
        } catch (e) {
          console.log(`Failed to normalize profile URL: ${myProfileUrl}`);
        }
      } else {
        console.warn('Warning: Could not detect bot profile URL. Own-post filters will rely on name matching.');
      }
    }

    // 3. FASE 1: SCRAPE & QUEUE
    console.log('\n===============================================================');
    console.log('PHASE 1: SCRAPE & QUEUE');
    console.log('===============================================================\n');

    for (const group of activeGroups) {
      const displayName = group.group_name || 'Unnamed Group';
      console.log(`Scraping Group: ${displayName} (${group.group_url})`);
      try {
        try {
          await page.goto(group.group_url, { waitUntil: 'commit', timeout: 15000 });
        } catch (gotoErr) {
          // Ignore navigation timeout if we can still find the posts
        }
        await sleep(3000); // Allow DOM hydration

        // Scroll down incrementally and collect posts progressively
        console.log(`Scrolling feed for recent posts (${config.scrollCount} times, delay: ${config.scrollDelaySeconds}s)...`);
        for (let j = 0; j < config.scrollCount; j++) {
          await page.evaluate(() => window.scrollBy(0, 1000));
          await sleep(config.scrollDelaySeconds * 1000);
        }

        // Locate post article containers using aria-posinset
        const postElements = await page.locator('div[aria-posinset]').all();
        console.log(`Found ${postElements.length} posts on page to analyze.`);

        let addedCount = 0;
        for (let idx = 0; idx < postElements.length; idx++) {
          const post = postElements[idx];
          try {
            // 1. Extract Author Name & Profile Link
            const authorLinkLocator = post.locator([
              'a[role="link"][href*="/user/"]',
              'a[role="link"][href*="/people/"]',
              'a[role="link"][href*="/profile.php"]',
              'h3 a[role="link"]',
              'h2 a[role="link"]'
            ].join(', ')).first();

            let authorName = 'Unknown Author';
            let authorProfileUrl = '';

            if (await authorLinkLocator.count() > 0) {
              const href = await authorLinkLocator.getAttribute('href');
              if (href) {
                try {
                  const urlObj = new URL(href, 'https://facebook.com');
                  urlObj.search = '';
                  authorProfileUrl = urlObj.toString();
                } catch (e) {
                  authorProfileUrl = href;
                }
              }
              const nameText = await authorLinkLocator.innerText();
              if (nameText && nameText.trim()) {
                authorName = nameText.trim();
              }
            }

            // Fallback author name extraction
            if (authorName === 'Unknown Author') {
              const titleLocator = post.locator('span[data-ad-rendering-role="title"], span.xt0psk2 strong, h3 strong, h2 strong').first();
              if (await titleLocator.isVisible()) {
                const titleText = await titleLocator.innerText();
                if (titleText && titleText.trim()) {
                  authorName = titleText.trim();
                }
              }
            }

            // Filter: Ignore own posts
            const isOwnPost = (myProfileUrl && authorProfileUrl && authorProfileUrl === myProfileUrl) ||
                              (process.env.MY_PROFILE_NAME && authorName.toLowerCase() === process.env.MY_PROFILE_NAME.toLowerCase());
            if (isOwnPost) {
              console.log(`  -> Skipped post ${idx + 1} by own account: ${authorName}`);
              continue;
            }

            // 2. Extract Relative Time / Timestamp Link
            let timestampLink = null;
            const links = await post.locator('a[role="link"]').all();
            for (const link of links) {
              const href = await link.getAttribute('href');
              const ariaHidden = await link.getAttribute('aria-hidden');
              if (!href || ariaHidden === 'true') continue;

              // Exclude profile pages, stories, photos, videos, and group navigation links
              if (
                href.includes('/user/') ||
                href.includes('/people/') ||
                href.includes('/profile.php') ||
                href.includes('/stories/') ||
                href.includes('/photo/') ||
                href.includes('/video/') ||
                (href.includes('/groups/') && !href.includes('/posts/') && !href.includes('/permalink/') && !href.includes('/multi_permalink/'))
              ) {
                continue;
              }

              // Match relative query link (__cft__) or direct permalink link
              if (href.includes('__cft__') || href.startsWith('?') || href.includes('/posts/') || href.includes('/permalink/') || href.includes('/multi_permalink/')) {
                timestampLink = link;
                break;
              }
            }

            // Silently skip non-post visual elements (spacers, create-post box, loading skeletons, etc.)
            if (!timestampLink) continue;

            const href = await timestampLink.getAttribute('href');
            if (!href) continue;

            const timeText = await timestampLink.innerText();
            const cleanTimeText = timeText.replace(/\n+/g, '').trim();

            // 3. Extract Post Text - click "See More" first if available
            try {
              const seeMoreBtn = post.locator(
                'div[role="button"]:has-text("Lihat selengkapnya"), ' +
                'div[role="button"]:has-text("See More"), ' +
                'div[role="button"]:has-text("See more"), ' +
                'span:has-text("Lihat selengkapnya"), ' +
                'span:has-text("See more")'
              ).first();
              if (await seeMoreBtn.isVisible()) {
                await seeMoreBtn.click();
                await sleep(500);
              }
            } catch (_) {
              // Ignore if see more click fails
            }

            // Collect text from multiple selectors
            const messageLocators = [
              post.locator('div[data-ad-preview="message"]').first(),
              post.locator('span[data-ad-rendering-role="story_message"]').first(),
              post.locator('span[data-ad-rendering-role="description"]').first()
            ];

            let postText = '';
            for (const loc of messageLocators) {
              if (await loc.isVisible()) {
                postText = await loc.innerText();
                if (postText.trim()) break;
              }
            }

            // Fallback: collect all div[dir="auto"] text blocks inside this post
            if (!postText.trim()) {
              const divs = await post.locator('div[dir="auto"]').all();
              const textBlocks: string[] = [];
              for (const div of divs) {
                const text = await div.innerText();
                if (text.trim()) textBlocks.push(text.trim());
              }
              postText = textBlocks.join('\n');
            }

            // Keyword check - case insensitive
            const postTextLower = postText.toLowerCase();
            const matchedKeyword = config.targetKeywords.find(keyword => postTextLower.includes(keyword.toLowerCase()));
            if (!matchedKeyword && config.targetKeywords.length > 0) {
              console.log(`  -> Skipped post ${idx + 1} by ${authorName}: No matching keywords found in text.`);
              continue;
            }

            // 4. Resolve Permalink & Post ID
            let postUrl = '';
            let postId = '';

            // Fast path: extract numeric post ID from links in the DOM
            const allLinks = await post.locator('a').all();
            for (const link of allLinks) {
              const hrefAttr = await link.getAttribute('href');
              if (hrefAttr) {
                const id = extractPostId(hrefAttr);
                if (id) {
                  postId = id;
                  const groupUrlMatch = group.group_url.match(/\/groups\/([^\/]+)/);
                  const groupNameOrId = groupUrlMatch ? groupUrlMatch[1] : '';
                  postUrl = `https://www.facebook.com/groups/${groupNameOrId}/posts/${postId}/`;
                  break;
                }
              }
            }

            // Fallback: open link in new tab and wait for redirect
            if (!postId) {
              const absoluteUrl = new URL(href, page.url()).toString();
              const newPage = await context.newPage();
              try {
                await newPage.goto(absoluteUrl, { waitUntil: 'commit', timeout: 10000 });
                let resolvedUrl = '';
                for (let retry = 0; retry < 10; retry++) {
                  resolvedUrl = newPage.url();
                  if (resolvedUrl.includes('/posts/') || resolvedUrl.includes('/permalink/') || resolvedUrl.includes('/multi_permalink/') || resolvedUrl.includes('story_fbid')) {
                    break;
                  }
                  await sleep(500);
                }
                if (resolvedUrl) {
                  const urlObj = new URL(resolvedUrl, 'https://facebook.com');
                  urlObj.search = '';
                  postUrl = urlObj.toString();
                  const extractedId = extractPostId(resolvedUrl);
                  postId = extractedId || '';
                }
              } catch (e: any) {
                console.warn(`Error resolving permalink: ${e.message}`);
              } finally {
                await newPage.close();
              }
            }

            // Last resort: generate a stable hash-based ID from post text + cleanTimeText
            if (!postId || !/^\d+$/.test(postId)) {
              if (postText.trim()) {
                const hashSource = `${group.group_url}::${cleanTimeText}::${postText.slice(0, 200)}`;
                const hash = crypto.createHash('sha256').update(hashSource).digest('hex');
                postId = `hash_${hash.slice(0, 16)}`;
                const groupUrlMatch = group.group_url.match(/\/groups\/([^\/]+)/);
                const groupNameOrId = groupUrlMatch ? groupUrlMatch[1] : '';
                postUrl = `${group.group_url}?hash_post=${hash.slice(0, 8)}`;
                console.log(`  -> Used hash-based ID for post ${idx + 1} by ${authorName}: ${postId}`);
              } else {
                continue; // Cannot identify post at all
              }
            }

            // Skip if already in database queue
            if (hasPostInQueue(postId)) {
              console.log(`  -> Skipped post ${idx + 1} by ${authorName}: Post ${postId} is already in the queue.`);
              continue;
            }

            // Queue post
            const success = addToQueue(postId, group.id, postUrl, postText, authorName);
            if (success) {
              addedCount++;
              console.log(`[Queue Added] ID: ${postId} | Author: ${authorName} | Time: ${cleanTimeText} | Keyword: "${matchedKeyword}"`);
            }
          } catch (postErr) {
            // Catch error in single post scrape to avoid crashing the whole group scrape loop
          }
        }
        console.log(`Group scrape finished. Added ${addedCount} posts to queue.`);

      } catch (groupErr: any) {
        console.error(`Error scraping group ${group.group_url}:`, groupErr.message);
      }
    }

    // 4. FASE 2: QUEUE PROCESSING (COMMENTING)
    console.log('\n===============================================================');
    console.log('PHASE 2: QUEUE PROCESSING (COMMENTING)');
    console.log('===============================================================\n');

    for (const group of activeGroups) {
      const displayName = group.group_name || 'Unnamed Group';
      const queueItems = getPendingQueue(group.id, config.maxCommentsPerGroup);
      if (queueItems.length === 0) {
        console.log(`No pending queue comments for Group: ${displayName}.`);
        continue;
      }

      console.log(`Processing ${queueItems.length} comments for Group: ${displayName}...`);

      for (const item of queueItems) {
        // Skip hash-based posts - no direct permalink, cannot find comment box
        if (item.post_id.startsWith('hash_')) {
          console.log(`  -> Skipping hash-based post ${item.post_id}: no direct permalink available.`);
          updateQueueStatus(item.id, 'failed', 'Hash-based post ID has no direct permalink.');
          continue;
        }

        // Normalize URL to web.facebook.com to avoid www → web redirect interruption
        const postUrl = item.post_url.replace('https://www.facebook.com', 'https://web.facebook.com');
        console.log(`\nDirecting to post permalink: ${postUrl}`);
        try {
          try {
            await page.goto(postUrl, { waitUntil: 'commit', timeout: 15000 });
          } catch (gotoErr) {
            // Ignore redirect-interrupted navigation errors - page usually still loads
          }
          await sleep(4000); // Allow DOM hydration after redirect

          // Locate commenting textbox
          const commentInputSelectors = [
            'div[contenteditable="true"][role="textbox"][aria-placeholder*="komentar" i]',
            'div[contenteditable="true"][role="textbox"][aria-placeholder*="comment" i]',
            'div[contenteditable="true"][role="textbox"][aria-label*="komentar" i]',
            'div[contenteditable="true"][role="textbox"][aria-label*="comment" i]',
            'div[contenteditable="true"][role="textbox"]'
          ];
          
          let commentInput: Locator | null = null;
          for (const selector of commentInputSelectors) {
            const loc = page.locator(selector).first();
            if (await loc.isVisible()) {
              commentInput = loc;
              break;
            }
          }

          // If not visible, click comment trigger button to activate it
          if (!commentInput) {
            const commentTrigger = page.locator('div[role="button"]:has-text("Komentar"), div[role="button"]:has-text("Comment"), span:has-text("Komentar"), span:has-text("Comment")').first();
            if (await commentTrigger.isVisible()) {
              console.log('Activating comment input field...');
              await commentTrigger.click();
              await sleep(2000);

              // Re-check after clicking
              for (const selector of commentInputSelectors) {
                const loc = page.locator(selector).first();
                if (await loc.isVisible()) {
                  commentInput = loc;
                  break;
                }
              }
            }
          }

          if (!commentInput) {
            throw new Error('Could not find the comment textbox on this post.');
          }

          // Resolve comment content spintax
          const resolvedComment = resolveSpintax(config.commentContent);
          console.log(`Submitting Comment (with links):\n"${resolvedComment}"`);

          // Helper: check if FB rejected the comment
          // Only trust specific error text - avoid false positives from div[role="alert"]
          const isCommentRejected = async (): Promise<boolean> => {
            const errorTexts = [
              'span:has-text("tidak dapat memposting")',
              'span:has-text("can\'t post")',
              'span:has-text("diblokir")',
              'span:has-text("spam")',
              'span:has-text("Something went wrong")',
              'span:has-text("Terjadi kesalahan")',
              'span:has-text("Komentar tidak dapat")',
            ];
            for (const sel of errorTexts) {
              if (await page.locator(sel).first().isVisible()) return true;
            }
            // If comment box still has content after submit = rejected
            try {
              const boxText = await commentInput!.innerText();
              if (boxText.trim().length > 0) return true;
            } catch (_) {}
            return false;
          };

          // Helper: submit a comment string and return true if successful
          const submitComment = async (text: string): Promise<boolean> => {
            await commentInput!.focus();
            // Clear box first (Ctrl+A → Delete)
            await page.keyboard.press('Control+a');
            await page.keyboard.press('Delete');
            await sleep(300);
            await page.keyboard.insertText(text);
            await sleep(800);
            await page.keyboard.press('Enter');
            await sleep(4000);
            return !(await isCommentRejected());
          };

          // Focus and paste instantly
          await commentInput.focus();
          await page.keyboard.insertText(resolvedComment);
          await sleep(1000);

          // Attach image to comment if configured
          if (config.commentImagePath) {
            if (fs.existsSync(config.commentImagePath)) {
              console.log(`Attaching image to comment: ${config.commentImagePath}`);
              try {
                // Scope file input to the comment form area to avoid triggering post composer
                const commentForm = page.locator('form:has(div[contenteditable="true"][role="textbox"])').first();
                const scopedFileInput = commentForm.locator('input[type="file"]').first();
                if (await scopedFileInput.count() > 0) {
                  await scopedFileInput.setInputFiles(config.commentImagePath);
                } else {
                  // Use filechooser event to intercept the file dialog safely
                  const photoBtn = commentForm.locator([
                    'div[aria-label="Foto/video"][role="button"]',
                    'div[aria-label="Photo/video"][role="button"]',
                    'div[aria-label="Foto"][role="button"]',
                    'div[aria-label="Photo"][role="button"]'
                  ].join(', ')).first();
                  if (await photoBtn.isVisible()) {
                    const [fileChooser] = await Promise.all([
                      page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
                      photoBtn.click()
                    ]);
                    if (fileChooser) {
                      await fileChooser.setFiles(config.commentImagePath);
                    }
                  } else {
                    console.warn('Warning: Could not find photo button in comment form. Skipping image.');
                  }
                }
                console.log('Waiting 4s for image upload preview...');
                await sleep(4000);
              } catch (imgErr: any) {
                console.warn(`Warning: Image attach failed (${imgErr.message}). Sending text-only comment.`);
              }
            } else {
              console.warn(`Warning: COMMENT_IMAGE_PATH "${config.commentImagePath}" not found. Skipping image.`);
            }
          }

          // Submit comment (with links first)
          await page.keyboard.press('Enter');
          console.log('Sending comment...');
          await sleep(4000);

          // Check if FB rejected due to links
          if (await isCommentRejected()) {
            console.log(`  -> Comment with links was REJECTED by Facebook. Retrying without links...`);
            const resolvedNoLink = resolveSpintax(config.commentContentNoLink);
            const retryOk = await submitComment(resolvedNoLink);
            if (retryOk) {
              console.log(`  -> No-link comment ACCEPTED for post ID: ${item.post_id}`);
            } else {
              throw new Error('Comment rejected even without links. Skipping post.');
            }
          }

          // Update queue status in DB
          updateQueueStatus(item.id, 'success');
          console.log(`Comment successfully processed for post ID: ${item.post_id}`);

          // Anti-spam cooldown delay
          const min = config.minDelaySeconds;
          const max = config.maxDelaySeconds;
          const delaySeconds = Math.floor(Math.random() * (max - min + 1)) + min;
          console.log(`Cooldown: Sleeping for ${delaySeconds} seconds before next post comment...`);
          await sleep(delaySeconds * 1000);

        } catch (err: any) {
          console.error(`FAILED to comment on post ${item.post_id}:`, err.message);
          updateQueueStatus(item.id, 'failed', err.message);
        }
      }
    }

  } finally {
    console.log('Closing browser...');
    await context.close();
    console.log('Closing database...');
    closeDb();
    console.log('Process completed.');
  }
}

// Run commenter
main().catch((err) => {
  console.error('Fatal error in commenter runner:', err);
});
