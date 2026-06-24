# Facebook Auto Commenter Bot

A Node.js and TypeScript automation script designed to scrape post feeds from Facebook groups and automatically post comments using Playwright and SQLite (better-sqlite3). It uses a Split Queue (Scrape-then-Comment) architecture to prevent Virtual DOM parsing issues caused by infinite scrolling on Facebook.

## Features

* Split Queue Architecture: Scrapes target posts and saves them to SQLite comments_queue first, then navigates directly to permalink URLs to post comments.
* Anti-Detection & Stealth: Uses a custom User Agent, disables automation infobars, hides webdriver indicators, and runs in a persistent browser context to reuse login cookies.
* Content Rotation: Supports Spintax format content rotation for comments to vary templates.
* Smart Filtering: Ignores bot's own posts, verifies post age limits (under 5 days), matches keywords, and implements comment limits per group (default 3 max).

## Requirements

* Node.js (version 18 or above recommended)
* npm (Node Package Manager)

## Installation

1. Install project dependencies:
   ```bash
   npm install
   ```

2. Download the Chromium browser binaries required for Playwright:
   ```bash
   npx playwright install chromium
   ```

## Configuration

1. Create a `.env` file in the root directory based on the `.env.example` file:
   ```bash
   cp .env.example .env
   ```

2. Configure the following variables in `.env`:
   * `HEADLESS`: Set to `false` to display the browser window (required for the first-time manual login) or `true` for background execution.
   * `FB_USER_DATA_DIR`: Directory path to store browser session profiles.
   * `MIN_DELAY_SECONDS` and `MAX_DELAY_SECONDS`: Random delay constraints between comments to mimic human behavior.
   * `POST_INTERVAL_MINUTES`: Minimum duration to wait before posting to the same group again.
   * `MY_PROFILE_URL`: Optional profile URL override. If blank, the bot will auto-detect your profile URL.
   * `TARGET_KEYWORDS`: Comma-separated list of keywords that target posts must contain.
   * `MAX_POST_AGE_DAYS`: Maximum age of posts to comment on (in days).
   * `MAX_COMMENTS_PER_GROUP`: Maximum number of comments per group in a single run.
   * `COMMENT_TEMPLATE_PATH`: Path to the comment template text file containing Spintax.

3. Optionally, create a `config.json` file in the root folder to supply authentication credentials for automatic login (to automatically fill username and password fields on the login screen):
   ```json
   {
     "email": "your_email_or_phone",
     "password": "your_password"
   }
   ```

4. Add your target Facebook group links to the `groups.json` file in the root folder:
   ```json
   [
     {
       "name": "test",
       "url": "https://www.facebook.com/groups/1746971519808959/"
     }
   ]
   ```

5. Populate your comment template options in the `comment_template.txt` file using Spintax formatting (e.g. `{Halo|Hi} kawan! {Ready?|Berapa harganya?}`).

## How to Run

1. Start the bot:
   ```bash
   npm start
   ```

2. Complete first-time manual login:
   * A Chromium browser window will open.
   * Log in to your Facebook account and complete any security checkpoints or CAPTCHAs.
   * Once you are on the Facebook home feed, the bot will automatically detect the active session, save it to the session directory, and begin scraping/commenting.
   * On subsequent runs, the bot will reuse this session and bypass the login step entirely.
