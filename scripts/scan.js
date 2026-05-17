import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
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
async function scanPage(browser, url, viewport, siteId) {
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

  // בדיקת אלמנטים קריטיים
  for (const selector of globalSettings.criticalSelectors) {
    const exists = await page.locator(selector).first().isVisible().catch(() => false);
    if (!exists) {
      issues.push({
        type: 'missing_element',
        severity: 'warning',
        message: `אלמנט חסר או מוסתר: ${selector}`
      });
    }
  }

  // הוספת שגיאות JS
  if (jsErrors.length > 0) {
    issues.push({
      type: 'js_error',
      severity: 'warning',
      message: `${jsErrors.length} שגיאות JS: ${jsErrors.slice(0, 3).join(' | ')}`
    });
  }

  // בקשות שנכשלו (סינון - מתעלמים מ-analytics וכו')
  const significantFails = failedRequests.filter(r =>
    !r.url.includes('google-analytics') &&
    !r.url.includes('facebook.com/tr') &&
    !r.url.includes('hotjar')
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

  await context.close();
  return { url, viewport: viewport.name, issues, loadTime, status };
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

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`\n  [${i + 1}/${urls.length}] ${url}`);
    for (const viewport of globalSettings.viewports) {
      const result = await scanPage(browser, url, viewport, site.id);
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
    await sendReport(results, mode, site, globalSettings);
    console.log(`📧 דוח נשלח במייל עבור ${site.name}`);
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
