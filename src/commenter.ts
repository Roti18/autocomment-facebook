import { chromium, Locator, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
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
  timeText = timeText.toLowerCase().trim();
  
  // Minutes / hours / just now / barusan
  if (
    timeText.includes('menit') || 
    timeText.includes('jam') || 
    timeText.includes('min') || 
    timeText.endsWith('m') || 
    timeText.endsWith('j') || 
    timeText.endsWith('h') ||
    timeText.includes('just now') || 
    timeText.includes('baru saja') || 
    timeText.includes('sec') || 
    timeText.includes('dtk')
  ) {
    return 0; // Less than 1 day
  }
  
  if (timeText.includes('kemarin') || timeText.includes('yesterday')) {
    return 1;
  }
  
  // Days (e.g., "3 hr", "3 hari", "3 days", "3d")
  const dayMatch = timeText.match(/(\d+)\s*(hr|hari|d|day|days)/);
  if (dayMatch) {
    return parseInt(dayMatch[1], 10);
  }
  
  // If it ends with 'd' (e.g., '4d')
  const dMatch = timeText.match(/(\d+)d$/);
  if (dMatch) {
    return parseInt(dMatch[1], 10);
  }
  
  // Weeks (e.g., "1 mg", "1 minggu", "1w", "1 week")
  const weekMatch = timeText.match(/(\d+)\s*(mg|minggu|w|week|weeks)/);
  if (weekMatch) {
    return parseInt(weekMatch[1], 10) * 7;
  }
  
  // Months (e.g., "1 bln", "1 bulan", "1 month")
  const monthMatch = timeText.match(/(\d+)\s*(bln|bulan|m|month|months)/);
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
      console.log(`Scraping Group URL: ${group.group_url}`);
      try {
        await page.goto(group.group_url, { waitUntil: 'domcontentloaded' });
        await sleep(5000); // Allow DOM hydration

        // Scroll down 4 times to trigger lazy loading of recent posts
        console.log('Scrolling feed for recent posts...');
        for (let j = 0; j < 4; j++) {
          await page.evaluate(() => window.scrollBy(0, 800));
          await sleep(2500);
        }

        // Locate post article containers using aria-posinset
        const postElements = await page.locator('div[aria-posinset]').all();
        console.log(`Found ${postElements.length} post containers in this viewport.`);

        let addedCount = 0;
        for (const post of postElements) {
          try {
            // 1. Extract Author Name & Profile Link
            const authorLocator = post.locator('span[data-ad-rendering-role="title"], span.xt0psk2 strong, h3 strong, h2 strong, a[role="link"] strong').first();
            let authorName = 'Unknown Author';
            if (await authorLocator.isVisible()) {
              authorName = await authorLocator.innerText();
            } else {
              const profileLink = post.locator('a[role="link"][aria-label*="Profil"], a[role="link"][aria-label*="Profile"]').first();
              if (await profileLink.isVisible()) {
                const label = await profileLink.getAttribute('aria-label');
                if (label) {
                  authorName = label.replace(/Profil\s+|Profile\s+of\s+/i, '').trim();
                }
              }
            }

            const authorLinkLocator = post.locator('a[role="link"][href*="/user/"], h3 a[role="link"], h2 a[role="link"], span.xt0psk2 a[role="link"]').first();
            let authorProfileUrl = '';
            if (await authorLinkLocator.isVisible()) {
              const href = await authorLinkLocator.getAttribute('href');
              if (href) {
                try {
                  const urlObj = new URL(href, 'https://facebook.com');
                  urlObj.search = '';
                  authorProfileUrl = urlObj.toString();
                } catch (e) {}
              }
            }

            // Filter: Ignore own posts
            const isOwnPost = (myProfileUrl && authorProfileUrl && authorProfileUrl === myProfileUrl) ||
                              (process.env.MY_PROFILE_NAME && authorName.toLowerCase() === process.env.MY_PROFILE_NAME.toLowerCase());
            if (isOwnPost) {
              continue;
            }

            // 2. Extract Relative Time / Timestamp Link
            let timestampLink = null;
            const links = await post.locator('a[role="link"]').all();
            for (const link of links) {
              const href = await link.getAttribute('href');
              if (!href) continue;

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

            if (!timestampLink) {
              continue;
            }

            const href = await timestampLink.getAttribute('href');
            if (!href) continue;

            const timeText = await timestampLink.innerText();

            // Filter: Age Check (limit to under maxPostAgeDays)
            const ageDays = getPostAgeInDays(timeText);
            if (ageDays > config.maxPostAgeDays) {
              continue;
            }

            // 3. Extract Post Text & Keyword Check
            const messageLocators = [
              post.locator('div[data-ad-preview="message"]').first(),
              post.locator('span[data-ad-rendering-role="story_message"]').first(),
              post.locator('span[data-ad-rendering-role="description"]').first(),
              post.locator('div[dir="auto"]').first()
            ];
            
            let postText = '';
            for (const loc of messageLocators) {
              if (await loc.isVisible()) {
                postText = await loc.innerText();
                if (postText.trim()) break;
              }
            }
            
            const matchedKeyword = config.targetKeywords.find(keyword => postText.toLowerCase().includes(keyword));
            if (!matchedKeyword && config.targetKeywords.length > 0) {
              continue;
            }

            // 4. Resolve Permalink & Post ID ONLY for matching posts
            let postUrl = '';
            let postId = '';

            // If it is already a direct permalink URL
            if (href.includes('/posts/') || href.includes('/permalink/') || href.includes('/multi_permalink/')) {
              const urlObj = new URL(href, 'https://facebook.com');
              urlObj.search = '';
              postUrl = urlObj.toString();
              const match = href.match(/\/(?:permalink|posts|multi_permalink)\/(\d+)/);
              postId = match ? match[1] : postUrl;
            } else {
              // Resolve the relative query link (__cft__) by navigating directly in a new tab
              const absoluteUrl = new URL(href, page.url()).toString();
              const newPage = await context.newPage();
              try {
                await newPage.goto(absoluteUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
                const rawUrl = newPage.url();
                if (rawUrl) {
                  const urlObj = new URL(rawUrl, 'https://facebook.com');
                  urlObj.search = '';
                  postUrl = urlObj.toString();
                  
                  const match = postUrl.match(/\/(?:permalink|posts|multi_permalink)\/(\d+)/);
                  postId = match ? match[1] : postUrl;
                }
              } catch (e: any) {
                console.warn(`Error resolving permalink directly: ${e.message}`);
                const rawUrl = newPage.url();
                if (rawUrl) {
                  const urlObj = new URL(rawUrl, 'https://facebook.com');
                  urlObj.search = '';
                  postUrl = urlObj.toString();
                  const match = postUrl.match(/\/(?:permalink|posts|multi_permalink)\/(\d+)/);
                  postId = match ? match[1] : postUrl;
                }
              } finally {
                await newPage.close();
              }
            }

            if (!postId) {
              continue; // Skip if we cannot identify the post permalink URL
            }

            // Skip if already in database queue
            if (hasPostInQueue(postId)) {
              continue;
            }

            // Queue post
            const success = addToQueue(postId, group.id, postUrl, postText, authorName);
            if (success) {
              addedCount++;
              console.log(`[Queue Added] ID: ${postId} | Author: ${authorName} | Time: ${timeText} (${ageDays} days) | Keyword: "${matchedKeyword}"`);
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
      const queueItems = getPendingQueue(group.id, config.maxCommentsPerGroup);
      if (queueItems.length === 0) {
        console.log(`No pending queue comments for Group ID: ${group.id}.`);
        continue;
      }

      console.log(`Processing ${queueItems.length} comments for Group ID: ${group.id}...`);

      for (const item of queueItems) {
        console.log(`\nDirecting to post permalink: ${item.post_url}`);
        try {
          await page.goto(item.post_url, { waitUntil: 'domcontentloaded' });
          await sleep(5000); // Allow DOM hydration

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
          console.log(`Submitting Comment:\n"${resolvedComment}"`);

          // Focus and paste instantly
          await commentInput.focus();
          await page.keyboard.insertText(resolvedComment);
          await sleep(1000);

          // Submit by pressing Enter
          await page.keyboard.press('Enter');
          console.log('Sending comment...');
          await sleep(5000); // 5s verification and submission wait time

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
