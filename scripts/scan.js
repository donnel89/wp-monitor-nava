import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import tls from 'tls';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { XMLParser } from 'fast-xml-parser';
import { sendReport } from './reporter.js';

// קריאת ארגומנט - daily / weekly / monthly
const mode = process.argv[2] || 'daily';
const VALID_MODES = ['daily', 'weekly', 'monthly'];

if (!VALID_MODES.includes(mode)) {
  console.error(`❌ מצב לא תקין: ${mode}. אפשרויות: ${VALID_MODES.join(', ')}`);
  process.exit(1);
}

console.log(`🔍 התחלת סריקה במצב: ${mode}`);

// טעינת קונפיגורציה
const config = JSON.parse(await fs.readFile('./config.json', 'utf-8'));
const { globalSettings } = config;

// קביעת כתובות לסריקה לפי מצב ואתר
async function getUrlsToScan(mode, site) {
  if (mode === 'daily') return site.daily.urls;
  if (mode === 'weekly') {
    return site.weekly.urls.length > 0
      ? site.weekly.urls
      : site.daily.urls; // fallback
  }
  if (mode === 'monthly') {
    return await fetchSitemapUrls(site.monthly.sitemapUrl, site.monthly.maxUrls);
  }
  return [];
}

// משיכת URLs מ-sitemap
async function fetchSitemapUrls(sitemapUrl, maxUrls) {
  try {
    const res = await fetch(sitemapUrl);
    const xml = await res.text();
    const parser = new XMLParser();
    const parsed = parser.parse(xml);

    let urls = [];
    if (parsed.urlset?.url) {
      const urlEntries = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
      urls = urlEntries.map(u => u.loc).filter(Boolean);
    } else if (parsed.sitemapindex?.sitemap) {
      // sitemap index - משיכה רקורסיבית
      const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
        ? parsed.sitemapindex.sitemap
        : [parsed.sitemapindex.sitemap];
      for (const sm of sitemaps) {
        const subUrls = await fetchSitemapUrls(sm.loc, maxUrls - urls.length);
        urls.push(...subUrls);
        if (urls.length >= maxUrls) break;
      }
    }
    return urls.slice(0, maxUrls);
  } catch (err) {
    console.error(`❌ שגיאה במשיכת sitemap: ${err.message}`);
    return [];
  }
}

// יצירת תיקיות עבודה לאתר מסוים
async function ensureDirs(siteId) {
  await fs.mkdir(`./screenshots/baseline/${siteId}/${mode}`, { recursive: true });
  await fs.mkdir(`./screenshots/current/${siteId}/${mode}`, { recursive: true });
  await fs.mkdir(`./screenshots/diff/${siteId}/${mode}`, { recursive: true });
  await fs.mkdir(`./results/${siteId}`, { recursive: true });
}

// המרת URL לשם קובץ בטוח
function urlToFilename(url, viewport) {
  const safe = url.replace(/[^a-z0-9]/gi, '_').slice(0, 100);
  return `${safe}_${viewport}.png`;
}

// בדיקה של עמוד יחיד
async function scanPage(browser, url, viewport, siteId, siteBaseUrl) {
  const issues = [];
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    userAgent: 'WP-Monitor-Bot/1.0'
  });
  const page = await context.newPage();

  // איסוף שגיאות JS
  const jsErrors = [];
  page.on('pageerror', err => jsErrors.push(err.message));

  // איסוף שגיאות console
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // איסוף בקשות שנכשלו
  const failedRequests = [];
  page.on('requestfailed', req => {
    failedRequests.push({ url: req.url(), reason: req.failure()?.errorText });
  });

  let response;
  let loadTime = 0;
  try {
    const start = Date.now();
    response = await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    loadTime = Date.now() - start;
  } catch (err) {
    issues.push({ type: 'load_error', severity: 'critical', message: err.message });
    await context.close();
    return { url, viewport: viewport.name, issues, loadTime: null, status: null };
  }

  const status = response?.status() || 0;

  // בדיקת סטטוס HTTP
  if (status >= 400) {
    issues.push({
      type: 'http_error',
      severity: 'critical',
      message: `HTTP ${status}`
    });
  }

  // בדיקת זמן טעינה
  if (loadTime > 10000) {
    issues.push({
      type: 'slow_load',
      severity: 'warning',
      message: `זמן טעינה ${(loadTime / 1000).toFixed(1)} שניות`
    });
  }

  // בדיקת אלמנטים קריטיים — קיום בדום בלבד (לא נראות)
  // לכל selector מגדירים גם fallback רחב יותר
  const CRITICAL_FALLBACKS = {
    'nav': 'nav, [role="navigation"], .nav-menu, .main-nav, .primary-nav, #nav, #navigation, [class*="main-menu"], [class*="site-nav"]',
    'header': 'header, [role="banner"], #header, .site-header',
    'footer': 'footer, [role="contentinfo"], #footer, .site-footer',
  };
  for (const selector of globalSettings.criticalSelectors) {
    const broadSel = CRITICAL_FALLBACKS[selector] || selector;
    const count = await page.locator(broadSel).count().catch(() => 0);
    if (count === 0) {
      issues.push({
        type: 'missing_element',
        severity: 'warning',
        message: `${selector} חסר לחלוטין מה-DOM`
      });
    }
  }

  // סינון שגיאות JS ידועות שאינן בעיה אמיתית
  const JS_ERROR_IGNORE = [
    'addEventListener is not a function',   // YouTube IFrame API - באג ידוע, לא משפיע על הגולש
    'playerObject',                          // YouTube player API פנימי
    'ytInitialData',                         // YouTube embed initialization
    'ResizeObserver loop',                   // אזהרת דפדפן, לא שגיאה אמיתית
    'Non-Error promise rejection',           // אזהרה גנרית של Chrome
    'extension',                             // שגיאות של תוספי דפדפן
    'chrome-extension',
  ];
  const realJsErrors = jsErrors.filter(e =>
    !JS_ERROR_IGNORE.some(ignore => e.toLowerCase().includes(ignore.toLowerCase()))
  );
  if (realJsErrors.length > 0) {
    issues.push({
      type: 'js_error',
      severity: 'warning',
      message: `${realJsErrors.length} שגיאות JS: ${realJsErrors.slice(0, 3).join(' | ')}`
    });
  }

  // בקשות שנכשלו — סינון שירותים צד שלישי שמוגבלי rate-limit או לא קריטיים
  const REQUEST_IGNORE = [
    'google-analytics', 'googletagmanager', 'gtag',   // Analytics
    'facebook.com/tr', 'connect.facebook',             // Facebook Pixel
    'hotjar', 'clarity.ms',                            // Heatmaps
    'ipapi.co', 'ipinfo.io', 'ip-api.com',             // Geo-IP: rate-limited מ-GitHub IPs
    'doubleclick.net', 'googlesyndication',            // פרסומות Google
    'tiktok.com', 'snap.com', 'pinterest.com/ct',     // Pixels שיווקיים
    'intercom.io', 'crisp.chat', 'tawk.to',            // צ'אטים
  ];
  const significantFails = failedRequests.filter(r =>
    !REQUEST_IGNORE.some(ignore => r.url.includes(ignore))
  );
  if (significantFails.length > 0) {
    issues.push({
      type: 'failed_requests',
      severity: 'warning',
      message: `${significantFails.length} בקשות נכשלו: ${significantFails.slice(0, 2).map(r => r.url).join(', ')}`
    });
  }

  // צילום מסך והשוואה ויזואלית
  if (status < 400) {
    const filename = urlToFilename(url, viewport.name);
    const currentPath = `./screenshots/current/${siteId}/${mode}/${filename}`;
    const baselinePath = `./screenshots/baseline/${siteId}/${mode}/${filename}`;
    const diffPath = `./screenshots/diff/${siteId}/${mode}/${filename}`;

    await page.screenshot({ path: currentPath, fullPage: true });

    // השוואה לבייסליין אם קיים
    try {
      await fs.access(baselinePath);
      const diffResult = await compareImages(baselinePath, currentPath, diffPath);
      if (diffResult.diffRatio > globalSettings.diffThreshold) {
        issues.push({
          type: 'visual_diff',
          severity: 'warning',
          message: `${(diffResult.diffRatio * 100).toFixed(1)}% הבדל ויזואלי מהבייסליין`,
          diffPath
        });
      }
    } catch {
      // אין בייסליין - יוצרים אחד עכשיו
      await fs.copyFile(currentPath, baselinePath);
      console.log(`  📸 נוצר baseline חדש עבור ${viewport.name}`);
    }
  }

  // בדיקות תוכן, SEO ונגישות — desktop בלבד (ללא כפילות)
  if (status < 400 && viewport.name === 'desktop') {
    await checkSeo(page, issues, url);
    await checkBrokenImages(page, issues);
    await checkMixedContent(page, issues, url);
    await checkAccessibility(page, issues);
    await checkGdprBanner(page, issues, url, siteBaseUrl);
    await checkContactInfo(page, issues, url, siteBaseUrl);
    await checkBrokenInternalLinks(page, issues, url);
    await checkFormSubmission(page, issues);
    await checkNavigation(page, issues, url);
    await checkInteractiveElements(page, issues);
    await checkPopupsLightbox(page, issues);
  }

  // גלילה — כל viewport (טוען lazy images, בודק sticky header)
  if (status < 400) {
    await checkScrollBehavior(page, issues, viewport);
  }

  // Core Web Vitals — כל viewport
  if (status < 400) {
    await checkCoreWebVitals(page, issues);
  }

  // בדיקות אינטראקציה — המבורגר + כפתורי CTA
  if (status < 400) {
    await testInteractions(page, issues, viewport);
  }

  await context.close();
  return { url, viewport: viewport.name, issues, loadTime, status };
}

// ============================================================
//  בדיקות אינטראקציה
// ============================================================

// סלקטורים נפוצים לכפתור המבורגר
const HAMBURGER_SELECTORS = [
  'button.hamburger', '.menu-toggle', '.nav-toggle', '.navbar-toggle',
  '#nav-toggle', '#menu-toggle', '.burger', '.mobile-menu-toggle',
  'button[aria-label*="menu" i]', 'button[aria-label*="תפריט"]',
  'button[aria-expanded]', '[class*="hamburger"]', '[class*="menu-btn"]',
  '[class*="mobile-menu"]', '[class*="nav-icon"]',
];

// סלקטורים נפוצים לכפתורי CTA
const CTA_SELECTORS = [
  'a.btn', 'a.button', '.wp-block-button__link', '.wp-block-button a',
  '[class*="cta"] a', 'a[class*="btn-"]', 'a[class*="-btn"]',
  'a[class*="button"]', '.elementor-button-link', '.et_pb_button',
];

async function testInteractions(page, issues, viewport) {
  // בדיקת המבורגר — רק במובייל
  if (viewport.name === 'mobile') {
    await testHamburger(page, issues);
  }

  // בדיקת כפתורי CTA — כל viewport
  await testCtaButtons(page, issues, viewport);
}

async function testHamburger(page, issues) {
  // מחפש כפתור המבורגר גלוי
  let hamburger = null;
  for (const sel of HAMBURGER_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 })) { hamburger = el; break; }
    } catch {}
  }

  if (!hamburger) return; // אין המבורגר — דלג

  try {
    // לפני לחיצה — בודק מה מוסתר
    const navHiddenBefore = await page.locator('nav').first().isHidden().catch(() => true);

    await hamburger.click({ timeout: 3000 });
    await page.waitForTimeout(700);

    // אחרי לחיצה — nav / menu צריך להיפתח
    const navVisibleAfter = await page.locator(
      'nav, [class*="nav-menu"], [class*="mobile-menu"], [id*="menu"]'
    ).first().isVisible({ timeout: 1500 }).catch(() => false);

    if (navHiddenBefore && !navVisibleAfter) {
      issues.push({
        type: 'hamburger_broken',
        severity: 'warning',
        message: 'לחיצה על תפריט המבורגר לא פתחה את הניווט'
      });
    }
  } catch (err) {
    issues.push({
      type: 'hamburger_broken',
      severity: 'warning',
      message: `כפתור המבורגר לא הגיב ללחיצה: ${err.message.split('\n')[0]}`
    });
  }
}

async function testCtaButtons(page, issues, viewport) {
  const ctaData = [];

  for (const sel of CTA_SELECTORS) {
    try {
      const els = await page.locator(sel).all();
      for (const el of els.slice(0, 8)) {
        if (!(await el.isVisible().catch(() => false))) continue;
        const href = await el.getAttribute('href').catch(() => null);
        const text = (await el.textContent().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 50);
        if (text || href) ctaData.push({ href, text });
      }
    } catch {}
    if (ctaData.length >= 8) break;
  }

  if (ctaData.length === 0) return;

  // כפתורים ללא href או עם href ריק
  const emptyCtAs = ctaData.filter(c => !c.href || c.href === '#' || c.href === 'javascript:void(0)');
  if (emptyCtAs.length > 0) {
    issues.push({
      type: 'cta_no_link',
      severity: 'warning',
      message: `${emptyCtAs.length} כפתורי CTA ללא קישור: "${emptyCtAs.map(c => c.text).join('", "')}"`,
    });
  }

  // בדיקת קישורים — HEAD request במקביל (רק קישורי טקסט מלא)
  const linksToCheck = ctaData
    .filter(c => c.href && c.href.startsWith('http') && !emptyCtAs.includes(c))
    .slice(0, 5);

  const brokenLinks = [];
  await Promise.all(linksToCheck.map(async ({ href, text }) => {
    try {
      const res = await fetch(href, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      if (res.status >= 400) {
        brokenLinks.push(`"${text}" → HTTP ${res.status} (${href})`);
      }
    } catch {}
  }));

  if (brokenLinks.length > 0) {
    issues.push({
      type: 'cta_broken_link',
      severity: 'critical',
      message: `כפתורי CTA עם קישור שבור: ${brokenLinks.join(' | ')}`
    });
  }
}


// השוואת תמונות
async function compareImages(baselinePath, currentPath, diffPath) {
  const baseline = PNG.sync.read(await fs.readFile(baselinePath));
  const current = PNG.sync.read(await fs.readFile(currentPath));

  // אם הגדלים שונים - נחשב את זה כהבדל גדול
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return { diffRatio: 1.0, diffPixels: -1 };
  }

  const { width, height } = baseline;
  const diff = new PNG({ width, height });

  const diffPixels = pixelmatch(
    baseline.data,
    current.data,
    diff.data,
    width,
    height,
    { threshold: 0.1 }
  );

  await fs.writeFile(diffPath, PNG.sync.write(diff));
  return { diffRatio: diffPixels / (width * height), diffPixels };
}

// ============================================================
//  SEO
// ============================================================
async function checkSeo(page, issues, url) {
  // כותרת
  const title = await page.title().catch(() => '');
  if (!title) {
    issues.push({ type: 'seo_title', severity: 'warning', message: 'חסר תג <title>' });
  } else if (title.length < 30) {
    issues.push({ type: 'seo_title', severity: 'warning', message: `title קצר מדי: ${title.length} תווים (מינימום 30) — "${title}"` });
  } else if (title.length > 60) {
    issues.push({ type: 'seo_title', severity: 'warning', message: `title ארוך מדי: ${title.length} תווים (מקסימום 60)` });
  }

  // תיאור
  const desc = await page.locator('meta[name="description"]').getAttribute('content').catch(() => null);
  if (!desc) {
    issues.push({ type: 'seo_description', severity: 'warning', message: 'חסר meta description' });
  } else if (desc.length < 100) {
    issues.push({ type: 'seo_description', severity: 'warning', message: `meta description קצר: ${desc.length} תווים (מינימום 100)` });
  } else if (desc.length > 160) {
    issues.push({ type: 'seo_description', severity: 'warning', message: `meta description ארוך: ${desc.length} תווים (מקסימום 160)` });
  }

  // H1
  const h1Count = await page.locator('h1').count().catch(() => 0);
  if (h1Count === 0) {
    issues.push({ type: 'seo_h1', severity: 'warning', message: 'חסר תג H1 בעמוד' });
  } else if (h1Count > 1) {
    issues.push({ type: 'seo_h1', severity: 'warning', message: `${h1Count} תגי H1 — צריך בדיוק אחד` });
  }

  // noindex — קריטי!
  const robots = await page.locator('meta[name="robots"]').getAttribute('content').catch(() => null);
  if (robots && robots.toLowerCase().includes('noindex')) {
    issues.push({ type: 'seo_noindex', severity: 'critical', message: `⛔ עמוד מסומן noindex — גוגל לא יסרוק אותו! (robots: "${robots}")` });
  }

  // Open Graph
  const ogTitle = await page.locator('meta[property="og:title"]').getAttribute('content').catch(() => null);
  const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null);
  if (!ogTitle || !ogImage) {
    const missing = [!ogTitle && 'og:title', !ogImage && 'og:image'].filter(Boolean).join(', ');
    issues.push({ type: 'seo_og', severity: 'warning', message: `חסרים תגי Open Graph: ${missing} (שיתוף ברשתות חברתיות)` });
  }
}

// ============================================================
//  תמונות שבורות
// ============================================================
async function checkBrokenImages(page, issues) {
  const broken = await page.evaluate(() =>
    Array.from(document.images)
      .filter(img => img.complete && img.naturalWidth === 0 && img.src.startsWith('http'))
      .map(img => img.src.split('/').pop())
      .slice(0, 5)
  ).catch(() => []);

  if (broken.length > 0) {
    issues.push({ type: 'broken_images', severity: 'warning', message: `${broken.length} תמונות שבורות: ${broken.join(', ')}` });
  }
}

// ============================================================
//  Mixed Content
// ============================================================
async function checkMixedContent(page, issues, url) {
  if (!url.startsWith('https')) return;
  const mixed = await page.evaluate(() =>
    Array.from(document.querySelectorAll('img[src^="http:"],script[src^="http:"],link[href^="http:"],iframe[src^="http:"]'))
      .map(el => (el.src || el.href || '').split('/').slice(0, 3).join('/'))
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 3)
  ).catch(() => []);

  if (mixed.length > 0) {
    issues.push({ type: 'mixed_content', severity: 'warning', message: `${mixed.length} משאבי HTTP על אתר HTTPS (מנעול אדום בדפדפן): ${mixed.join(', ')}` });
  }
}

// ============================================================
//  קישורים פנימיים שבורים
// ============================================================
async function checkBrokenInternalLinks(page, issues, pageUrl) {
  const origin = new URL(pageUrl).origin;
  const links = await page.evaluate((orig) =>
    [...new Set(
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => { try { return new URL(a.href).href; } catch { return null; } })
        .filter(h => h && h.startsWith(orig) && !h.includes('#') && !h.match(/\.(pdf|zip|jpg|png|gif|svg|webp)$/i))
    )].slice(0, 15)
  , origin).catch(() => []);

  const broken = [];
  await Promise.all(links.map(async link => {
    try {
      const r = await fetch(link, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'follow' });
      if (r.status === 404) broken.push(link.replace(origin, '') || '/');
    } catch {}
  }));

  if (broken.length > 0) {
    issues.push({ type: 'broken_links', severity: 'warning', message: `${broken.length} קישורים פנימיים 404: ${broken.slice(0, 3).join(', ')}` });
  }
}

// ============================================================
//  נגישות
// ============================================================
async function checkAccessibility(page, issues) {
  const result = await page.evaluate(() => {
    const imgsNoAlt = Array.from(document.querySelectorAll('img'))
      .filter(img => img.offsetParent !== null && !img.hasAttribute('alt') && img.src.startsWith('http'))
      .length;
    const btnsNoLabel = Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(b => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'))
      .length;
    return { imgsNoAlt, btnsNoLabel };
  }).catch(() => ({ imgsNoAlt: 0, btnsNoLabel: 0 }));

  if (result.imgsNoAlt > 0)
    issues.push({ type: 'a11y_alt', severity: 'warning', message: `${result.imgsNoAlt} תמונות ללא alt text (נגישות + SEO)` });
  if (result.btnsNoLabel > 0)
    issues.push({ type: 'a11y_btn', severity: 'warning', message: `${result.btnsNoLabel} כפתורים ללא aria-label` });
}

// ============================================================
//  GDPR — באנר עוגיות
// ============================================================
async function checkGdprBanner(page, issues, url, siteBaseUrl) {
  // בודק רק בעמוד הבית
  const cleanUrl = url.replace(/\/$/, '');
  const cleanBase = (siteBaseUrl || '').replace(/\/$/, '');
  if (cleanUrl !== cleanBase) return;

  const hasBanner = await page.evaluate(() => {
    const selectors = ['[id*="cookie"],[class*="cookie"],[id*="gdpr"],[class*="gdpr"],[id*="consent"],[class*="consent"],[id*="cookie-banner"],[class*="cookie-banner"]'];
    if (document.querySelector(selectors.join(','))) return true;
    const keywords = ['cookie','עוגי','gdpr','consent','פרטיות'];
    return Array.from(document.querySelectorAll('*'))
      .filter(el => { const s = window.getComputedStyle(el); return s.position==='fixed'||s.position==='sticky'; })
      .some(el => keywords.some(k => el.textContent.toLowerCase().includes(k)));
  }).catch(() => true);

  if (!hasBanner) {
    issues.push({ type: 'gdpr_missing', severity: 'warning', message: 'לא נמצא באנר עוגיות (GDPR) — חובה לפי חוק בישראל ו-EU' });
  }
}

// ============================================================
//  טלפון / WhatsApp
// ============================================================
async function checkContactInfo(page, issues, url, siteBaseUrl) {
  const cleanUrl = url.replace(/\/$/, '');
  const cleanBase = (siteBaseUrl || '').replace(/\/$/, '');
  const isHome    = cleanUrl === cleanBase;
  const isContact = /contact|צור.קשר|יצור.קשר|%d7%a6%d7%95%d7%a8|%d7%99%d7%a6%d7%95%d7%a8/i.test(url);
  if (!isHome && !isContact) return;

  const hasPhone = await page.evaluate(() =>
    /(\+972|05\d[-\s]?\d{7}|0[23489]\d?[-\s]?\d{7})/.test(document.body.innerText)
  ).catch(() => false);

  if (!hasPhone) {
    issues.push({ type: 'missing_phone', severity: 'warning', message: 'לא נמצא מספר טלפון ישראלי בעמוד (חשוב לאמון + SEO מקומי)' });
  }
}

// ============================================================
//  Core Web Vitals (LCP + CLS)
// ============================================================
async function checkCoreWebVitals(page, issues) {
  const metrics = await page.evaluate(() =>
    new Promise(resolve => {
      const r = { lcp: null, cls: 0 };
      try {
        new PerformanceObserver(l => { const e = l.getEntries(); if (e.length) r.lcp = e[e.length-1].startTime; })
          .observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) r.cls += e.value; })
          .observe({ type: 'layout-shift', buffered: true });
      } catch {}
      setTimeout(() => resolve(r), 1200);
    })
  ).catch(() => null);

  if (!metrics) return;

  if (metrics.lcp > 4000)
    issues.push({ type: 'cwv_lcp', severity: 'warning', message: `LCP איטי: ${(metrics.lcp/1000).toFixed(1)}s — צריך להיות מתחת ל-2.5s` });
  else if (metrics.lcp > 2500)
    issues.push({ type: 'cwv_lcp', severity: 'warning', message: `LCP סביר: ${(metrics.lcp/1000).toFixed(1)}s — גוגל מעדיף מתחת ל-2.5s` });

  if (metrics.cls > 0.25)
    issues.push({ type: 'cwv_cls', severity: 'warning', message: `CLS גבוה: ${metrics.cls.toFixed(3)} — הדף קופץ הרבה בטעינה (מקסימום תקין: 0.1)` });
  else if (metrics.cls > 0.1)
    issues.push({ type: 'cwv_cls', severity: 'warning', message: `CLS בינוני: ${metrics.cls.toFixed(3)} — (מקסימום תקין: 0.1)` });
}

// ============================================================
//  שליחת טופס אמיתית + בדיקת תגובה
// ============================================================
async function checkFormSubmission(page, issues) {
  const forms = await page.locator('form').all().catch(() => []);
  if (forms.length === 0) return;

  const TEST_DATA = {
    text:     'WP Monitor Test',
    name:     'WP Monitor Bot',
    email:    'monitor-test@wp-monitor-check.invalid',
    tel:      '050-0000000',
    phone:    '050-0000000',
    textarea: 'הודעת בדיקה אוטומטית מ-WP Monitor. ניתן להתעלם.',
    search:   'בדיקה',
    number:   '1',
    url:      'https://example.com',
  };

  for (const form of forms.slice(0, 2)) {
    try {
      if (!(await form.isVisible().catch(() => false))) continue;

      // וודא שיש כפתור submit
      const submitBtn = form.locator('button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"])').first();
      if (!(await submitBtn.isVisible().catch(() => false))) {
        issues.push({ type: 'form_no_submit', severity: 'warning', message: 'טופס ללא כפתור שליחה גלוי' });
        continue;
      }

      // מלא את כל השדות הגלויים
      const inputs = await form.locator(
        'input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select'
      ).all();

      let filled = 0;
      for (const inp of inputs) {
        try {
          if (!(await inp.isVisible({ timeout: 800 }))) continue;
          const type = ((await inp.getAttribute('type')) || 'text').toLowerCase();
          const name = ((await inp.getAttribute('name')) || '').toLowerCase();
          const placeholder = ((await inp.getAttribute('placeholder')) || '').toLowerCase();
          const tag  = await inp.evaluate(el => el.tagName.toLowerCase());

          if (tag === 'select') {
            const opts = await inp.locator('option').all();
            if (opts.length > 1) await inp.selectOption({ index: 1 });
          } else {
            // בחר ערך לפי name/placeholder/type
            let val = TEST_DATA[type] || TEST_DATA.text;
            if (name.includes('name') || placeholder.includes('שם'))     val = TEST_DATA.name;
            if (name.includes('email') || type === 'email')               val = TEST_DATA.email;
            if (name.includes('phone') || name.includes('tel') || type === 'tel') val = TEST_DATA.tel;
            if (tag === 'textarea')                                        val = TEST_DATA.textarea;
            await inp.fill(val, { timeout: 2000 });
          }
          filled++;
        } catch {}
      }

      if (filled === 0) continue;

      // שלח את הטופס ובדוק תגובה
      const [navResponse] = await Promise.all([
        page.waitForNavigation({ timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => null),
        submitBtn.click({ timeout: 3000 }),
      ]);

      await page.waitForTimeout(1500);

      // בדוק תגובת הצלחה
      const pageText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
      const SUCCESS_KEYWORDS = ['תודה', 'נשלח', 'קיבלנו', 'thank you', 'sent', 'success', 'received', 'בהצלחה', 'הודעתך'];
      const ERROR_KEYWORDS   = ['שגיאה', 'error', 'failed', 'נכשל', 'problem', 'invalid'];

      const hasSuccess = SUCCESS_KEYWORDS.some(k => pageText.includes(k));
      const hasError   = ERROR_KEYWORDS.some(k => pageText.includes(k));

      if (hasError) {
        issues.push({ type: 'form_submit_error', severity: 'critical', message: 'שליחת הטופס החזירה הודעת שגיאה' });
      } else if (!hasSuccess && navResponse === null) {
        issues.push({ type: 'form_no_response', severity: 'warning', message: 'שליחת הטופס לא הציגה הודעת הצלחה ולא ניווטה לדף תודה' });
      }

      // חזור לעמוד המקורי
      await page.goBack({ timeout: 5000, waitUntil: 'domcontentloaded' }).catch(() => {});
      break; // מספיק לבדוק טופס אחד לעמוד

    } catch {}
  }
}

// ============================================================
//  גלילה — lazy load + sticky header + back-to-top
// ============================================================
async function checkScrollBehavior(page, issues, viewport) {
  try {
    const pageHeight = await page.evaluate(() => document.body.scrollHeight);
    if (pageHeight < 1200) return; // עמוד קצר — לא רלוונטי

    // גלול לאט לתחתית — מדמה גולש אמיתי + מטעין lazy images
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let scrolled = 0;
        const step = Math.floor(window.innerHeight * 0.6);
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          scrolled += step;
          if (scrolled >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 150);
      });
    });
    await page.waitForTimeout(600);

    // בדוק תמונות שעדיין לא נטענו אחרי גלילה
    const lazyBroken = await page.evaluate(() =>
      Array.from(document.images)
        .filter(img => img.complete && img.naturalWidth === 0 && img.src.startsWith('http'))
        .length
    ).catch(() => 0);

    if (lazyBroken > 0) {
      issues.push({ type: 'lazy_images_broken', severity: 'warning', message: `${lazyBroken} תמונות Lazy Load שבורות — לא נטענו אחרי גלילה` });
    }

    // בדוק sticky header — צריך להיות גלוי אחרי גלילה
    const headerSticky = await page.locator('header, .site-header, #header').first()
      .isVisible().catch(() => true);
    if (!headerSticky) {
      issues.push({ type: 'header_scroll', severity: 'warning', message: 'ה-Header נעלם בגלילה (sticky header לא עובד)' });
    }

    // גלול חזרה למעלה ובדוק back-to-top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);

  } catch {}
}

// ============================================================
//  Popup / Lightbox
// ============================================================
async function checkPopupsLightbox(page, issues) {
  // סלקטורים לכפתורי פתיחת popup
  const POPUP_TRIGGERS = [
    '[data-fancybox]', '[data-lightbox]', '[data-magnific-popup]',
    '[data-elementor-open-lightbox]', '.popup-trigger', '.open-popup',
    'a[href*="#popup"]', '[data-toggle="modal"]', '.lightbox',
    'a[href$=".jpg"]:not([target])', 'a[href$=".png"]:not([target])',
  ];

  for (const sel of POPUP_TRIGGERS) {
    try {
      const triggers = await page.locator(sel).all();
      for (const trigger of triggers.slice(0, 2)) {
        if (!(await trigger.isVisible().catch(() => false))) continue;

        await trigger.click({ timeout: 2000 });
        await page.waitForTimeout(800);

        // חפש popup/modal/lightbox פתוח
        const popupOpen = await page.locator(
          '.fancybox-container, .mfp-container, .elementor-popup-modal, ' +
          '[class*="lightbox"][style*="display: block"], ' +
          '[class*="modal"][style*="display: block"], ' +
          '.popup-overlay:visible, [aria-modal="true"]'
        ).first().isVisible().catch(() => false);

        if (!popupOpen) {
          issues.push({ type: 'popup_broken', severity: 'warning', message: `לחיצה על "${sel}" לא פתחה popup/lightbox` });
        } else {
          // בדוק שיש כפתור סגירה
          const closeBtn = page.locator(
            '.fancybox-close-small, .mfp-close, .elementor-popup-modal .dialog-close-button, ' +
            '[aria-label*="close" i], [aria-label*="סגור"], [class*="close"]'
          ).first();

          if (await closeBtn.isVisible().catch(() => false)) {
            await closeBtn.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(400);
          }
        }
        break; // מספיק בדיקה אחת מכל סוג
      }
    } catch {}
  }
}

// ============================================================
//  בדיקת ניווט — לחיצה על פריטי תפריט ראשי
// ============================================================
async function checkNavigation(page, issues, pageUrl) {
  // רק בעמוד הבית — כדי לא לכפול בדיקות
  const baseUrl = new URL(pageUrl).origin;
  if (pageUrl.replace(/\/$/, '') !== baseUrl) return;

  // מוצא קישורי תפריט ראשי
  const navLinks = await page.evaluate((origin) => {
    const navEl = document.querySelector('nav, [role="navigation"], .nav-menu, .main-nav');
    if (!navEl) return [];
    return [...new Set(
      Array.from(navEl.querySelectorAll('a[href]'))
        .map(a => { try { const u = new URL(a.href); return u.origin === origin ? u.href : null; } catch { return null; } })
        .filter(Boolean)
        .filter(h => !h.includes('#'))
    )].slice(0, 6);
  }, baseUrl).catch(() => []);

  if (navLinks.length === 0) return;

  const brokenNav = [];
  await Promise.all(navLinks.map(async link => {
    try {
      const r = await fetch(link, { method: 'HEAD', signal: AbortSignal.timeout(6000), redirect: 'follow' });
      if (r.status >= 400) brokenNav.push(`${link.replace(baseUrl,'')} → ${r.status}`);
    } catch {}
  }));

  if (brokenNav.length > 0) {
    issues.push({
      type: 'nav_broken_links',
      severity: 'critical',
      message: `פריטי ניווט ראשי עם שגיאה: ${brokenNav.join(', ')}`
    });
  }
}

// ============================================================
//  בדיקת אלמנטים אינטראקטיביים — accordion, tabs, popup
// ============================================================
async function checkInteractiveElements(page, issues) {
  // Accordion / FAQ
  const accordions = await page.locator(
    '.accordion, [data-toggle="collapse"], .faq-item, .elementor-accordion-item, .wp-block-faq, details'
  ).all().catch(() => []);

  for (const acc of accordions.slice(0, 3)) {
    try {
      if (!(await acc.isVisible())) continue;
      const trigger = acc.locator('summary, .accordion-title, .elementor-accordion-title, [aria-expanded], .faq-question').first();
      if (!(await trigger.isVisible().catch(() => false))) continue;

      const beforeClick = await acc.locator('.accordion-content, .elementor-accordion-content, .faq-answer, [aria-hidden]').first()
        .isVisible().catch(() => null);

      await trigger.click({ timeout: 2000 });
      await page.waitForTimeout(400);

      const afterClick = await acc.locator('.accordion-content, .elementor-accordion-content, .faq-answer, [aria-hidden]').first()
        .isVisible().catch(() => null);

      if (beforeClick === false && afterClick === false) {
        issues.push({ type: 'accordion_broken', severity: 'warning', message: 'לחיצה על accordion/FAQ לא פתחה את התוכן' });
        break;
      }
    } catch {}
  }

  // Tabs
  const tabs = await page.locator('.nav-tabs .nav-link, .elementor-tab-title, [role="tab"]').all().catch(() => []);
  for (const tab of tabs.slice(1, 3)) { // מדלג על הראשון שכבר פתוח
    try {
      if (!(await tab.isVisible())) continue;
      await tab.click({ timeout: 2000 });
      await page.waitForTimeout(300);
      const isActive = await tab.evaluate(el =>
        el.classList.contains('active') || el.getAttribute('aria-selected') === 'true'
      ).catch(() => false);
      if (!isActive) {
        issues.push({ type: 'tabs_broken', severity: 'warning', message: 'לחיצה על Tab לא הפעילה אותו' });
        break;
      }
    } catch {}
  }
}

// ============================================================
//  SSL Expiry (per site)
// ============================================================
async function checkSslExpiry(site) {
  const issues = [];
  if (!site.baseUrl.startsWith('https')) return issues;
  try {
    const { hostname } = new URL(site.baseUrl);
    const daysLeft = await new Promise(resolve => {
      const sock = tls.connect(443, hostname, { servername: hostname, rejectUnauthorized: false }, () => {
        const expiry = new Date(sock.getPeerCertificate().valid_to);
        sock.end();
        resolve(Math.floor((expiry - Date.now()) / 86400000));
      });
      sock.on('error', () => resolve(null));
      sock.setTimeout(8000, () => { sock.destroy(); resolve(null); });
    });

    if (daysLeft === null) return issues;
    if (daysLeft <= 0)
      issues.push({ type: 'ssl_expired', severity: 'critical', message: '⛔ תעודת SSL פגת תוקף — האתר מציג שגיאת אבטחה לגולשים!' });
    else if (daysLeft <= 14)
      issues.push({ type: 'ssl_expiry', severity: 'critical', message: `תעודת SSL פגה בעוד ${daysLeft} ימים בלבד!` });
    else if (daysLeft <= 30)
      issues.push({ type: 'ssl_expiry', severity: 'warning', message: `תעודת SSL פגה בעוד ${daysLeft} ימים` });
  } catch {}
  return issues;
}

// ============================================================
//  WordPress Security (per site)
// ============================================================
async function checkWordPressSecurity(site) {
  const issues = [];
  const base = site.baseUrl.replace(/\/$/, '');

  // wp-login.php חשוף
  try {
    const r = await fetch(`${base}/wp-login.php`, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
    if (r.status === 200)
      issues.push({ type: 'wp_login_exposed', severity: 'warning', message: 'wp-login.php נגיש ללא הגנה — סיכון Brute Force' });
  } catch {}

  // xmlrpc.php פתוח
  try {
    const r = await fetch(`${base}/xmlrpc.php`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 200 || r.status === 405)
      issues.push({ type: 'wp_xmlrpc', severity: 'warning', message: 'xmlrpc.php פתוח — מומלץ לחסום (סיכון DDoS ו-Brute Force)' });
  } catch {}

  // גרסת WordPress חשופה
  try {
    const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(8000) });
    const html = await r.text();
    const match = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']*WordPress[^"']*)["']/i);
    if (match)
      issues.push({ type: 'wp_version_exposed', severity: 'warning', message: `גרסת WordPress חשופה: "${match[1]}" — מסייע לתוקפים` });
  } catch {}

  return issues;
}

// סריקת אתר בודד
async function scanSite(browser, site) {
  console.log(`\n🌐 סורק אתר: ${site.name} (${site.id})`);

  await ensureDirs(site.id);
  const urls = await getUrlsToScan(mode, site);

  if (urls.length === 0) {
    console.warn(`⚠️ לא נמצאו URLs לסריקה עבור ${site.name}`);
    return null;
  }

  console.log(`📋 סורק ${urls.length} עמודים ב-${globalSettings.viewports.length} viewports`);

  const results = [];

  // בדיקות ברמת האתר (פעם אחת בלבד)
  console.log(`  🔒 בודק SSL ואבטחת WordPress...`);
  const siteIssues = [
    ...(await checkSslExpiry(site)),
    ...(await checkWordPressSecurity(site))
  ];
  if (siteIssues.length > 0) {
    results.push({ url: site.baseUrl, viewport: 'site', issues: siteIssues, loadTime: null, status: null });
    console.log(`  ⚠️ נמצאו ${siteIssues.length} בעיות ברמת האתר`);
  } else {
    console.log(`  ✅ SSL ואבטחה תקינים`);
  }

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`\n  [${i + 1}/${urls.length}] ${url}`);
    for (const viewport of globalSettings.viewports) {
      const result = await scanPage(browser, url, viewport, site.id, site.baseUrl);
      results.push(result);
      const issueCount = result.issues.length;
      const icon = issueCount === 0 ? '✅' : '⚠️';
      console.log(`    ${icon} ${viewport.name}: ${issueCount} בעיות, ${result.loadTime}ms, HTTP ${result.status}`);
    }
  }

  // סיכום לאתר
  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);
  const criticalIssues = results.reduce(
    (sum, r) => sum + r.issues.filter(i => i.severity === 'critical').length, 0
  );

  console.log(`\n📊 סיכום ${site.name}: ${totalIssues} בעיות סה"כ (${criticalIssues} קריטיות)`);

  // שמירת תוצאות ל-JSON
  const jsonResults = {
    mode,
    timestamp: new Date().toISOString(),
    siteId: site.id,
    siteName: site.name,
    baseUrl: site.baseUrl,
    summary: {
      total: results.length,
      ok: results.filter(r => r.issues.length === 0).length,
      warnings: results.filter(r => r.issues.some(i => i.severity === 'warning')).length,
      critical: criticalIssues
    },
    results: results.map(r => ({
      url: r.url,
      viewport: r.viewport,
      status: r.status,
      loadTime: r.loadTime,
      issues: r.issues.map(i => ({ type: i.type, severity: i.severity, message: i.message }))
    }))
  };

  await fs.writeFile(`./results/${site.id}/${mode}.json`, JSON.stringify(jsonResults, null, 2));
  console.log(`💾 תוצאות נשמרו ב-results/${site.id}/${mode}.json`);

  // שליחת דוח אם יש בעיות
  if (totalIssues > 0) {
    try {
      await sendReport(results, mode, site, globalSettings);
      console.log(`📧 דוח נשלח במייל עבור ${site.name}`);
    } catch (emailErr) {
      console.error(`⚠️ שליחת מייל נכשלה עבור ${site.name}: ${emailErr.message}`);
    }
  } else {
    console.log(`✨ הכל תקין ב-${site.name} - לא נשלח מייל`);
  }

  return { id: site.id, name: site.name, baseUrl: site.baseUrl };
}

// MAIN
async function main() {
  const activeSites = config.sites.filter(s => s.active !== false);

  if (activeSites.length === 0) {
    console.error('❌ לא נמצאו אתרים פעילים ב-config.json');
    process.exit(1);
  }

  console.log(`🌐 מצא ${activeSites.length} אתרים פעילים`);

  const browser = await chromium.launch();
  const scannedSites = [];

  for (const site of activeSites) {
    try {
      const result = await scanSite(browser, site);
      if (result) scannedSites.push(result);
    } catch (err) {
      console.error(`💥 שגיאה בסריקת ${site.name}: ${err.message}`);
    }
  }

  await browser.close();

  // שמירת index.json עם רשימת האתרים
  const indexData = {
    updatedAt: new Date().toISOString(),
    mode,
    sites: scannedSites
  };
  await fs.writeFile('./results/index.json', JSON.stringify(indexData, null, 2));
  console.log('\n📁 results/index.json עודכן');

  console.log(`\n✅ סריקה הושלמה עבור ${scannedSites.length} אתרים`);
}

main().catch(err => {
  console.error('💥 שגיאה כללית:', err);
  process.exit(1);
});
