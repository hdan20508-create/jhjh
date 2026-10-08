# Clearance Link Checker

Paste a clearance post from Discord and get the real in-store prices near you for every
`instoreclearance.com/s/...` link in it. You sign in to Discord **once** in a dedicated Chrome
profile; every check after that reuses the saved session, logging back in by itself when the
site's session expires.

```
Ninja 0.5qt Stainless Steel Creami NC501      → best $74.99 at Target Austin North (4.2 mi)
Retail: $75 (70% off)                            resell $170+ on eBay, est. profit $95
Resell: $170+ on eBay
https://instoreclearance.com/s/L4ljS
```

## Setup

Requires [Node.js](https://nodejs.org) 20+ (the LTS version) and Google Chrome. Microsoft Edge
also works if Chrome isn't installed.

**Windows:** download the project (Code → Download ZIP on GitHub, then unzip it) and double-click
`start.bat`. The first run installs what it needs, then the app opens in your browser. Keep the
black window open (minimized is fine) while you use it; closing it stops the app.

**Mac / Linux:**

```bash
npm install
npm start            # then open http://localhost:3000
```

### First time

1. Click **Log in with Discord**. A Chrome window opens on your computer. Sign in to Discord
   (scanning the QR code with the Discord app on your phone is quickest) and click **Authorize**.
   The window closes by itself.
2. Under **Where should it look?**, type a ZIP code, city or address and press Enter (or click
   **Use my location**). Drag the radius slider (10 to 80 miles) and let go; it saves itself.

### Every day

1. Copy a post in Discord (right-click the message → **Copy Text**).
2. Click **Paste & check**. That's it: each link is checked one at a time, and the table fills in.

- **Stop after this item** ends a run early and keeps what's already checked.
- Rows that weren't checked (you stopped, ran out of lookups, or got logged out) show
  **Not checked** with a **Check** button, plus a **Check N not checked** button above the table.
  Nothing is looked up twice unless you ask.
- Your last results come back when you reload the page or reopen the app.
- The browser tab title shows progress, e.g. "(2/6) Checking…", so you can keep using Discord.
- The same item posted under two links is only checked once.

The search area is saved in `settings.json` and used for every check until you change it. It
overrides whatever location is saved on the site itself. The site looks at the 50 closest stores
inside the radius, so a bigger radius won't add more than 50.

**Retailers not on your plan on the site** (check the site's plan list): the site hides their
prices and only says which nearby stores have the item on clearance. Those cards show "3 of 36
Target stores near you have it on clearance", the closest one, and the profit at the post's price.

**Check stock** on a store asks the site how many that store has (the same check as the site's
**Scan** button): "1 in stock · Aisle 14" or "Out of stock". It runs only when you click it, one
store at a time, since it likely uses a lookup. It's the store's own count, which can be off, so
call ahead before a long drive.

"Best near you" only counts stores selling **below** full price. If every nearby store is at full
price, the row says "Not on clearance near you".

There's also a command line:

```bash
npm run login                    # one-time Discord sign-in
npm run check -- post.txt        # or: pbpaste | npm run check
npm run area                     # show the search area
npm run area -- 78701 30         # set it: ZIP/city/address/"lat, lng", then radius in miles
npm run area -- 60               # change only the radius
```

### Settings (environment variables)

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | Web UI port (bound to localhost only) |
| `PROFILE_DIR` | `./.chrome-profile` | Where the Chrome profile (and your sessions) live |
| `BROWSER_CHANNEL` | `chrome` | `chrome`, `msedge`, or `chromium` (run `npx playwright install chromium` first) |
| `HEADLESS` | `true` | `false` shows the browser during checks |
| `SETTINGS_FILE` | `./settings.json` | Where the search area is saved |
| `LAT`, `LNG`, `LOCATION_LABEL` | unset | Starting search area, used until you save one in the app |
| `RADIUS_MILES` | `50` | Starting radius, used until you save one in the app |
| `CHECK_DELAY_MS` | `500` | Minimum gap between checks |
| `OPEN_BROWSER` | unset | `1` opens the app in your browser on start (`start.bat` sets it) |
| `ALLOWED_HOSTS` | unset | Extra host names allowed to reach the app, comma-separated (for phone access later) |

Only one copy of the app can use the Chrome profile at a time, so `npm run login` / `npm run check`
won't run while the web app is open (they say so). Use the web app's buttons instead.

**Safety:** the app only listens on this computer and only answers its own page. Requests from
other websites (or from an unexpected address) are refused, so a page you visit can't start a
login or spend your lookups.

## How the site's auth works

Traced from the live site on 2026-10-07:

1. `https://instoreclearance.com/s/<code>` answers with a **302** (no login needed) to
   `/deals?…&featuredItem=<token>`. The token is base64url of
   `<sku>:<retailer>:<unix time>:<signature>`; e.g. `s/MSnIK` is Target SKU `52994628`.
2. `/deals` is protected: without a session cookie the server sends a **307** to
   `/login?redirect=<deals url>`.
3. The login page's **Continue with Discord** button calls Supabase
   (`signInWithOAuth({ provider: 'discord', scopes: 'identify guilds.members.read' })`, PKCE flow),
   which goes to `discord.com/oauth2/authorize` (client `1380363144345682001`), or to
   `discord.com/login` first if Discord isn't signed in.
4. Discord redirects to the Supabase callback, then to `instoreclearance.com/callback`, where the
   site checks that your Discord account is allowed (that's what `guilds.members.read` is for). If it
   isn't, you land on `/login?error=unauthorized`.
5. The session is stored as a cookie, `sb-ufpyekjfmuwzfdczaddc-auth-token`, with a one-year cookie
   lifetime and a refresh token, so it survives browser restarts.
6. With a session, the deals page calls
   `GET https://ufpyekjfmuwzfdczaddc.supabase.co/functions/v1/getitem?token=<featuredItem>&stores=<ids>`
   with your bearer token, using stores near the location saved in `localStorage.userLocation`.
   The response has the item name, MSRP (`highestPrice`) and `priceAtStores`.

### What this app automates

- **Persistent profile** (`src/browser.js`): Playwright's `launchPersistentContext` on a dedicated
  profile directory, so the Discord login and the site session are kept like a normal Chrome
  profile. Use a dedicated directory, not your everyday Chrome profile: Chrome locks a profile
  while it's open and blocks automation on its default profile.
- **Login** (`completeLogin`): clicks the site's own **Continue with Discord** button. If Discord is
  already signed in, it approves the consent screen, but only after checking that the request is for
  the site's Discord app and Supabase callback, and refuses anything else. If Discord needs a
  password it waits for you (visible window) or stops with "needs login" (headless).
- **Search area** (`src/area.js`): place names are looked up with OpenStreetMap's free geocoder
  (US only). Before each check the area is written into the site's own `localStorage` keys
  (`userLocation`, `searchSettings.searchRadius`), the same ones the site's location picker
  writes, so the site asks for prices from stores in your area.
- **Speed** (`src/checker.js`): one deals page stays open. The app warms it up when you open the
  app or click Paste & check, and each check switches it to the next item with the site's own
  in-page navigation, so only the price request runs per item. If that doesn't answer within 8 s
  (or the item is already showing), it falls back to loading the page from scratch. Each check
  logs where its time went in the app window, e.g.
  `[check] target 52994628: 1.4s total (warm page) = start 0.0s + gap 1.0s + page 0.0s + price 0.4s + settle 0.0s`.
- **Checks** (`src/checker.js`): opens the resolved deals link in the signed-in profile and reads the
  site's own `getitem` response. If the page lands on `/login`, it logs in again first. It skips
  the unrelated deals feed, images and fonts.

The app never sees your Discord password or tokens. It drives the same pages you would click
through, in a browser profile that stays on your machine.

## Sharing site data for development (`npm run capture`)

Close the web app first (only one copy can use the browser profile), then:

```bash
npm run capture
```

The logged-in Chrome window opens on the site. Use it normally: open a deal, press **Scan** on a
store or two, open a locked item. Close the window when you're done. The app saves
`capture-<date>.json` in the project folder with what the site sent back.

Before saving, everything that could log someone in is removed: login/auth traffic is never
recorded, request headers and cookies are never recorded, and token-like fields, `eyJ…` tokens,
`Bearer …` values, API keys and email addresses are blanked. Open the file and check it before
sending it to anyone. `capture-*.json` files are git-ignored.

## Limits to know

- **Every check is one you start.** There are no scheduled or background checks, on purpose: the
  checker's hidden browser identifies itself as automated, and unattended lookups are the fastest
  way to burn credits or get an account flagged.

- **Credits.** The site meters lookups: a 429 means *"You ran out of credits! Please re-try again in
  an hour."* Each link check costs one lookup, so checks run one at a time with a delay, and a batch
  stops on the first 429.
- **Access.** The site only lets in Discord accounts it has approved. If your account isn't one, the
  login ends with "not authorized" and no automation changes that.
- **Discord input is a paste.** Reading the channel automatically would need a bot added by the
  server's admins. Automating your own user account (a "self-bot") breaks Discord's Terms of Service
  and can get the account banned.
- **The site can change.** The selectors and API names above come from the current build. If checks
  start timing out, the site was probably redeployed; the "How the site's auth works" section is
  what to re-check.
- **Keep the profile private.** `.chrome-profile/` holds live sessions for Discord and the site.
  It's in `.gitignore`; don't copy it anywhere you wouldn't put your password. `settings.json`
  (your search location) is git-ignored too.

## Development

```bash
npm test
```

Tests cover post parsing (using the sample post in `test/fixtures/`), token decoding, the
search area settings, and the price summary. The browser flow was tested live up to the Discord sign-in screen.
