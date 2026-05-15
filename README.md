# 🔍 WP-Monitor - ניטור אוטומטי לאתר וורדפרס

כלי לסריקה אוטומטית של אתר וורדפרס בתדירויות שונות, עם זיהוי שבירות עיצוביות, שגיאות טעינה, ובעיות פונקציונליות, ושליחת דוח במייל.

## ✨ מה הכלי בודק

לכל עמוד, בדסקטופ וב-mobile:
- ✅ סטטוס HTTP (200/404/500)
- ✅ זמן טעינה
- ✅ שגיאות JavaScript ב-console
- ✅ בקשות שנכשלו (תמונות, CSS, JS)
- ✅ אלמנטים קריטיים קיימים (header, footer, nav)
- ✅ **השוואה ויזואלית** מול צילום קודם (visual regression)

## 📅 תדירויות סריקה

| מצב | כמות עמודים | מתי רץ |
|------|------------|---------|
| **יומית** | 10 עמודים קריטיים (קבועים) | כל יום ב-09:00 |
| **שבועית** | 50 עמודים (קבועים) | יום ראשון ב-08:00 |
| **חודשית** | כל האתר מה-sitemap | ה-1 בחודש |

המייל נשלח **רק אם נמצאו בעיות**.

---

## 🚀 הוראות התקנה

### שלב 1: יצירת חשבון Resend (חינמי)

1. היכנס ל-https://resend.com
2. צור חשבון והוסף את הדומיין שלך (או השתמש בדומיין ברירת מחדל לבדיקות)
3. קבל API Key מ-https://resend.com/api-keys

### שלב 2: העלאה ל-GitHub

```bash
# יצירת ריפו חדש
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/USERNAME/wp-monitor.git
git push -u origin main
```

### שלב 3: הוספת ה-API Key ל-GitHub Secrets

ב-GitHub → Settings → Secrets and variables → Actions → New repository secret:
- **Name:** `RESEND_API_KEY`
- **Value:** המפתח מ-Resend

### שלב 4: עריכת config.json

```json
{
  "siteName": "האתר שלי",
  "baseUrl": "https://yoursite.com",
  "alertEmail": "you@yoursite.com",
  "fromEmail": "monitor@yoursite.com",
  "diffThreshold": 0.05,
  "daily": {
    "urls": [
      "https://yoursite.com/",
      "https://yoursite.com/about",
      ...
    ]
  },
  "weekly": {
    "urls": [/* 50 עמודים */]
  },
  "monthly": {
    "sitemapUrl": "https://yoursite.com/sitemap.xml"
  }
}
```

**שדות חשובים:**
- `diffThreshold` - אחוז שינוי ויזואלי שמעליו זה ייחשב לבעיה (0.05 = 5%)
- `fromEmail` - חייב להיות דומיין שאומת ב-Resend
- `alertEmail` - לאן יישלחו ההתראות

### שלב 5: הרצה ראשונה

ב-GitHub → Actions → בחר "סריקה יומית" → Run workflow.
ההרצה הראשונה תיצור את ה-baseline (תמונות ייחוס). מההרצה השנייה ואילך תהיה השוואה.

---

## 🧪 הרצה לוקאלית (לבדיקות)

```bash
npm install
npx playwright install --with-deps chromium

# סריקה ידנית
export RESEND_API_KEY="re_xxxx"
npm run scan:daily
```

---

## 🔄 עדכון baseline (אחרי שינוי מכוון באתר)

אחרי שעיצבת מחדש את האתר, ה-diff ייתן הרבה false positives. כדי לאפס:

**ב-GitHub:**
1. Actions → Caches → מחק את הקאש הרלוונטי
2. הרץ workflow ידנית - יצור baseline חדש

**לוקאלית:**
```bash
rm -rf screenshots/baseline/daily
npm run scan:daily
```

---

## 📁 מבנה הפרויקט

```
wp-monitor/
├── config.json                    # הגדרות והכתובות לסריקה
├── package.json
├── scripts/
│   ├── scan.js                    # הסקריפט הראשי
│   └── reporter.js                # שליחת מייל
├── screenshots/
│   ├── baseline/                  # תמונות ייחוס
│   ├── current/                   # תמונות אחרונות
│   └── diff/                      # תמונות הפרשים
└── .github/workflows/
    ├── daily-scan.yml
    ├── weekly-scan.yml
    └── monthly-scan.yml
```

---

## 💰 עלויות

- **GitHub Actions:** 2000 דקות בחינם בחודש (מספיק בקלות)
- **Resend:** 3000 מיילים בחודש בחינם
- **סה"כ:** 0 ₪

---

## 🛠️ הרחבות עתידיות אפשריות

- בדיקות Lighthouse (ביצועים, נגישות, SEO)
- בדיקת broken links פנימיים
- ניטור zertifikate SSL
- אינטגרציה עם Slack/Telegram במקום מייל
- שלב הסוכן המתקן (שלב 3 שדיברנו עליו)
