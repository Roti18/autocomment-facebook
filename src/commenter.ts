import { chromium, Locator, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { config, resolveSpintax } from './config';
import { initDb, isPostCommented, markPostCommented, getAllCommentedPostIds, closeDb } from './db';

// ─────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Random integer between min and max (inclusive) */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Jitter multiplier between 0.8 and 1.5 */
function jitter(base: number): number {
  const mult = 0.8 + Math.random() * 0.7; // 0.8 ~ 1.5
  return Math.round(base * mult);
}

/** Extract numeric post ID from FB URL */
function extractPostId(href: string): string | null {
  const m =
    href.match(/\/(?:posts|permalink)\/(\d+)/) ||
    href.match(/[?&]story_fbid=(\d+)/) ||
    href.match(/[?&]set=(?:pcb|gm)\.(\d+)/) ||
    href.match(/[?&]fbid=(\d+)/);
  return m ? m[1] : null;
}

/** Get a Stable Post ID from a post container element */
async function getPostIdFromPost(post: Locator): Promise<string | null> {
  // 1. Try finding all links with numeric post IDs
  const allLinks = await post.locator('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]').all();
  for (const link of allLinks) {
    const href = await link.getAttribute('href');
    if (href) {
      const id = extractPostId(href);
      if (id) return id;
    }
  }
  // 2. Fallback — look for link with __cft__ (relative post link)
  const cftLinks = await post.locator('a[href*="__cft__"]').all();
  for (const link of cftLinks) {
    const href = await link.getAttribute('href');
    if (href) {
      const id = extractPostId(href);
      if (id) return id;
    }
  }
  return null;
}

/** Check if FB rejected the comment (only specific error indicators) */
async function isCommentRejected(page: Page): Promise<boolean> {
  const errorSelectors = [
    'span:has-text("tidak dapat memposting")',
    'span:has-text("can\'t post")',
    'span:has-text("diblokir sementara")',
    'span:has-text("spam")',
    'span:has-text("Something went wrong")',
    'span:has-text("Terjadi kesalahan")',
    'span:has-text("Komentar tidak dapat")',
    'span:has-text("You can\'t comment")',
    'span:has-text("terlalu banyak permintaan")',
    'span:has-text("too many requests")',
    'span:has-text("Tindakan ini diblokir")',
    'span:has-text("this action was blocked")',
  ];
  for (const sel of errorSelectors) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────
// CORE LOGIC
// ─────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   FB Auto Comment — BERANDA SCROLL MODE  ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // ─── Init database ───
  initDb();

  // ─── 1. Launch browser ───
  if (!fs.existsSync(config.userDataDir)) {
    fs.mkdirSync(config.userDataDir, { recursive: true });
  }

  console.log('Launching browser...');
  const context = await chromium.launchPersistentContext(config.userDataDir, {
    headless: config.headless,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: null,
    args: [
      '--disable-notifications',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      '--no-sandbox',
      '--disable-infobars',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = context.pages()[0] || (await context.newPage());

  // ─── 2. Auto-login jika config.json ada ───
  let authEmail = process.env.FB_EMAIL || '';
  let authPassword = process.env.FB_PASSWORD || '';
  const cfgPath = path.resolve(process.cwd(), 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.email && cfg.email !== 'NOMOR_HP_ATAU_EMAIL_LU_DISINI') authEmail = cfg.email;
      if (cfg.password && cfg.password !== 'PASSWORD_FB_LU_DISINI') authPassword = cfg.password;
    } catch (_) {}
  }

  console.log('Navigating to web.facebook.com...');
  await page.goto('https://web.facebook.com/', { waitUntil: 'domcontentloaded' });

  // ─── 3. Cek login ───
  const loggedInSelectors = [
    '[role="navigation"]',
    'input[placeholder*="Cari"]',
    'input[placeholder*="Search"]',
    '[aria-label="Facebook"]',
    'a[href*="/me/"]',
    'div[aria-label="Akun"]',
    'div[aria-label="Account"]',
  ];

  let isLogged = false;
  for (let i = 0; i < 20; i++) {
    for (const sel of loggedInSelectors) {
      if (await page.locator(sel).first().isVisible().catch(() => false)) {
        isLogged = true;
        break;
      }
    }
    if (isLogged) break;
    await sleep(500);
  }

  if (!isLogged) {
    // Coba auto-login
    if (authEmail && authPassword) {
      console.log(`Auto-login: ${authEmail}...`);
      try {
        await page.locator('input#email, input[name="email"]').first().fill(authEmail);
        await sleep(1000);
        await page.locator('input#pass, input[name="pass"]').first().fill(authPassword);
        await sleep(1000);
        await page.locator('button[name="login"]').first().click();
        await sleep(6000);
        // Re-check
        for (const sel of loggedInSelectors) {
          if (await page.locator(sel).first().isVisible().catch(() => false)) {
            isLogged = true;
            break;
          }
        }
      } catch (_) {}
    }

    if (!isLogged) {
      console.log('\n=== ⚠️  BELUM LOGIN. Silakan login manual di browser. ===\n');
      let waited = 0;
      while (!isLogged && waited < 180) {
        await sleep(5000);
        waited++;
        for (const sel of loggedInSelectors) {
          if (await page.locator(sel).first().isVisible().catch(() => false)) {
            isLogged = true;
            break;
          }
        }
        if (!isLogged && waited % 6 === 0) {
          console.log('⏳ Menunggu login manual...');
        }
      }
      if (!isLogged) throw new Error('Login timeout.');
      console.log('✓ Login terdeteksi!\n');
    }
  }
  console.log('✓ Session aktif.\n');

  // ─── 4. Navigasi ke Beranda ───
  console.log('Navigasi ke Beranda (homepage feed)...');
  await page.goto('https://web.facebook.com/', { waitUntil: 'domcontentloaded' });
  await sleep(jitter(3000));

  // ─── 5. Set myProfileUrl ───
  let myProfileUrl = config.myProfileUrl;
  if (!myProfileUrl) {
    const meLink = page.locator('a[href*="/me/"]').first();
    if ((await meLink.count()) > 0) {
      const href = await meLink.getAttribute('href');
      if (href) {
        try {
          const u = new URL(href, 'https://web.facebook.com');
          u.search = '';
          myProfileUrl = u.toString();
        } catch (_) {}
      }
    }
    if (myProfileUrl) console.log(`Profil terdeteksi: ${myProfileUrl}`);
    else console.warn('⚠️  Tidak bisa deteksi profil sendiri.');
  }

  // ─── 6. Set beranda ke Most Recent ───
  // FB beranda default "Top stories". Kita gak usah ganti — biar natural.
  // Yang penting kita scroll aja.

  // ─── 7. Variabel tracking ───
  const alreadyCommented = new Set<string>(getAllCommentedPostIds()); // load history dari DB
  let totalCommented = 0;
  let consecutiveScans = 0; // berapa kali scan tanpa ketemu keyword

  console.log(`\n🔍 Target keywords: ${config.targetKeywords.length > 0 ? config.targetKeywords.join(', ') : 'ALL POSTS (no filter)'}`);
  console.log(`📋 Max comments: ${config.maxTotalComments}`);
  console.log(`🔄 Scroll count: ${config.berandaScrollCount} × ~${config.berandaScrollDelay}s each\n`);

  // ─── 8. MAIN LOOP: scroll → scan → comment ───
  let scrollRound = 1;
  for (; scrollRound <= config.berandaScrollCount; scrollRound++) {
    // Cek limit
    if (totalCommented >= config.maxTotalComments) {
      console.log(`\n✓ Mencapai limit ${config.maxTotalComments} komentar. Selesai.`);
      break;
    }

    console.log(`─── Scroll ${scrollRound}/${config.berandaScrollCount} ───`);

    // a) Scroll dulu
    await page.evaluate(() => window.scrollBy(0, 800));
    const scrollPause = jitter(config.berandaScrollDelay);
    await sleep(scrollPause * 1000);

    // b) Collect visible posts on screen now
    const visiblePosts = await page.locator('div[aria-posinset]').all();
    if (visiblePosts.length === 0) {
      console.log('  (belum ada post termuat, scroll lanjut...)');
      continue;
    }

    console.log(`  ${visiblePosts.length} post terlihat.`);

    // c) Scan each post that we haven't seen yet
    for (let idx = 0; idx < visiblePosts.length; idx++) {
      if (totalCommented >= config.maxTotalComments) break;

      const post = visiblePosts[idx];

      try {
        // ── Get a stable ID for dedup ──
        const postId = await getPostIdFromPost(post);
        const dedupKey = postId || `post_${scrollRound}_${idx}`;

        if (alreadyCommented.has(dedupKey)) continue;

        // ── Extract author ──
        const authorLink = post
          .locator('a[role="link"][href*="/user/"], a[role="link"][href*="/profile.php"], h3 a[role="link"], h2 a[role="link"]')
          .first();
        let authorName = 'Unknown';
        let authorProfileUrl = '';
        if ((await authorLink.count()) > 0) {
          const href = await authorLink.getAttribute('href');
          if (href) {
            try {
              const u = new URL(href, 'https://web.facebook.com');
              u.search = '';
              authorProfileUrl = u.toString();
            } catch (_) {
              authorProfileUrl = href;
            }
          }
          const txt = await authorLink.innerText();
          if (txt?.trim()) authorName = txt.trim();
        }

        // ── Skip own posts ──
        const isOwn =
          (myProfileUrl && authorProfileUrl && authorProfileUrl === myProfileUrl) ||
          (process.env.MY_PROFILE_NAME &&
            authorName.toLowerCase() === process.env.MY_PROFILE_NAME.toLowerCase());
        if (isOwn) {
          alreadyCommented.add(dedupKey);
          continue;
        }

        // ── Extract post text ──
        // Click See More if needed
        try {
          const seeMore = post
            .locator(
              'div[role="button"]:has-text("Lihat selengkapnya"), div[role="button"]:has-text("See More")'
            )
            .first();
          if (await seeMore.isVisible().catch(() => false)) {
            await seeMore.click();
            await sleep(800);
          }
        } catch (_) {}

        let postText = '';
        const msgLoc = post
          .locator(
            'div[data-ad-preview="message"], span[data-ad-rendering-role="story_message"], span[data-ad-rendering-role="description"]'
          )
          .first();
        if (await msgLoc.isVisible().catch(() => false)) {
          postText = (await msgLoc.innerText()) || '';
        }
        if (!postText.trim()) {
          const blocks = await post.locator('div[dir="auto"]').all();
          const texts: string[] = [];
          for (const b of blocks) {
            const t = (await b.innerText()) || '';
            if (t.trim()) texts.push(t.trim());
          }
          postText = texts.join('\n');
        }

        if (!postText.trim()) {
          alreadyCommented.add(dedupKey);
          continue; // skip post without text
        }

        // ── Keyword check (fuzzy) ──
        // Normalize: hapus spasi, strip, underscore, titik biar "vip day" match "vipday"
        const normalize = (s: string) => s.toLowerCase().replace(/[\s\-_.]+/g, '');
        const normText = normalize(postText);
        if (config.targetKeywords.length > 0) {
          const normKeywords = config.targetKeywords.map(normalize);
          const matched = normKeywords.some(kw => normText.includes(kw));
          if (!matched) {
            alreadyCommented.add(dedupKey);
            continue;
          }
        }

        // ── Found a matching post! ──
        console.log(`\n🎯 MATCH! "${authorName}" — "${postText.slice(0, 100).replace(/\n/g, ' ')}..."`);

        alreadyCommented.add(dedupKey);

        // ── Dapetin post URL buat cek & simpan ──
        let postUrl = '';
        const timeLink = post.locator('a[href*="__cft__"], a[href*="/posts/"], a[href*="/permalink/"]').first();
        if ((await timeLink.count()) > 0) {
          const href = await timeLink.getAttribute('href');
          if (href) postUrl = new URL(href, 'https://web.facebook.com').toString();
        }
        if (!postUrl) {
          const anyLink = post.locator('a[href*="/posts/"], a[href*="story_fbid"]').first();
          if ((await anyLink.count()) > 0) {
            const href = await anyLink.getAttribute('href');
            if (href) postUrl = new URL(href, 'https://web.facebook.com').toString();
          }
        }
        if (!postUrl) {
          console.log('  ⚠️  Gak bisa dapet link post, skip.');
          continue;
        }

        console.log(`  🔗 ${postUrl}`);

        // ── Simulasi baca post (reading delay) ──
        const readingDelay = randInt(config.readingDelayMin, config.readingDelayMax);
        console.log(`  📖 Simulasi baca post... ${readingDelay}s`);
        await sleep(readingDelay * 1000);

        // ── COMMENT LANGSUNG DI FEED ──
        // Scroll post ke view biar aman
        await post.scrollIntoViewIfNeeded();
        await sleep(500);

        // Klik icon komentar di post
        const commentBtn = post
          .locator('div[aria-label="Beri komentar"]:not([aria-hidden="true"]), div[aria-label="Comment"]:not([aria-hidden="true"])')
          .first();

        if (!(await commentBtn.isVisible().catch(() => false))) {
          console.log('  ⚠️  Gak nemu icon komentar, skip.');
          continue;
        }

        await commentBtn.click();
        await sleep(2000);

        // Cari textbox komentar
        let commentInput = post.locator('div[contenteditable="true"][role="textbox"]').first();
        if (!(await commentInput.isVisible().catch(() => false))) {
          // Fallback: cari di page level
          commentInput = page.locator('div[contenteditable="true"][role="textbox"]').first();
          if (!(await commentInput.isVisible().catch(() => false))) {
            console.log('  ⚠️  Gak nemu kotak komentar, skip.');
            continue;
          }
        }

        // ── Type comment ──
        const commentText = resolveSpintax(config.commentContent);
        console.log(`  ✍️ Ngetik komentar...`);

        await commentInput.fill('');
        await sleep(300);
        await commentInput.fill(commentText);
        await sleep(500);

        // ── Attach image if configured ──
        if (config.commentImagePath && fs.existsSync(config.commentImagePath)) {
          try {
            const commentForm = page
              .locator('form:has(div[contenteditable="true"][role="textbox"])')
              .first();
            const fileInput = commentForm.locator('input[type="file"]').first();
            if ((await fileInput.count()) > 0) {
              await fileInput.setInputFiles(config.commentImagePath);
              console.log('  🖼️ Attach image via file input');
            } else {
              const photoBtn = commentForm
                .locator('div[aria-label="Foto/video"][role="button"], div[aria-label="Photo/video"][role="button"]')
                .first();
              if (await photoBtn.isVisible().catch(() => false)) {
                const [chooser] = await Promise.all([
                  page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
                  photoBtn.click(),
                ]);
                if (chooser) await chooser.setFiles(config.commentImagePath);
              }
            }
            await sleep(4000);
          } catch (_) {}
        }

        // ── Submit ──
        await page.keyboard.press('Enter');
        console.log('  📨 Komentar dikirim...');
        await sleep(4000);

        // ── Check rejected ──
        let commentSuccess = false;
        if (await isCommentRejected(page)) {
          console.log('  ⚠️  Ditolak FB (mungkin karena link). Coba tanpa link...');
          const noLinkText = resolveSpintax(config.commentContentNoLink);
          const box = page.locator('div[contenteditable="true"][role="textbox"]').first();
          if (await box.isVisible().catch(() => false)) {
            await box.fill('');
            await sleep(300);
            await box.fill(noLinkText);
            await sleep(500);
            await page.keyboard.press('Enter');
            await sleep(4000);
            if (!(await isCommentRejected(page))) {
              commentSuccess = true;
            }
          }
        } else {
          commentSuccess = true;
        }

        if (commentSuccess) {
          totalCommented++;
          markPostCommented(dedupKey, postUrl, authorName);
          console.log(`✅ KOMENTAR #${totalCommented} BERHASIL!`);

          // Cooldown
          if (config.longBreakInterval > 0 && totalCommented % config.longBreakInterval === 0) {
            const breakSec = config.longBreakMinutes * 60;
            console.log(`\n☕ Istirahat ${config.longBreakMinutes} menit (${totalCommented}/${config.maxTotalComments})...`);
            await sleep(breakSec * 1000);
          } else {
            const cooldown = randInt(config.cooldownMin, config.cooldownMax);
            console.log(`⏳ Cooldown ${cooldown}s...`);
            await sleep(cooldown * 1000);
          }
        }
      } catch (_) {
        // Skip post yang error
      }
    }

    // Reset consecutiveScans — kita udah proses post di round ini
  }

  // ─── 9. SELESAI ───
  console.log('\n╔══════════════════════════════════════════╗');
  console.log(`║   SELESAI! ${totalCommented} komentar berhasil.              ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Total scroll round: ${scrollRound - 1}`);
  console.log(`Total post discan: ${alreadyCommented.size}`);

  closeDb();
  await context.close();
  process.exit(0);
}

main().catch(err => {
  console.error('\n💥 Fatal:', err);
  process.exit(1);
});
