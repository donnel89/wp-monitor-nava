import { Resend } from 'resend';
import fs from 'fs/promises';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendReport(results, mode, config) {
  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);
  const criticalCount = results.reduce(
    (sum, r) => sum + r.issues.filter(i => i.severity === 'critical').length, 0
  );

  const modeLabel = { daily: 'יומית', weekly: 'שבועית', monthly: 'חודשית' }[mode];
  const subject = `${criticalCount > 0 ? '🚨' : '⚠️'} דוח סריקה ${modeLabel} - ${totalIssues} בעיות באתר`;

  const html = buildHtml(results, mode, config, totalIssues, criticalCount);

  // איסוף קבצי diff לקבצים מצורפים (עד 5 כדי לא לחרוג ממגבלות)
  const attachments = [];
  const diffIssues = results
    .flatMap(r => r.issues.filter(i => i.diffPath).map(i => ({ ...i, url: r.url, viewport: r.viewport })))
    .slice(0, 5);

  for (const issue of diffIssues) {
    try {
      const content = await fs.readFile(issue.diffPath);
      attachments.push({
        filename: `diff_${issue.viewport}_${attachments.length + 1}.png`,
        content
      });
    } catch (err) {
      console.warn(`לא ניתן לצרף ${issue.diffPath}`);
    }
  }

  const { data, error } = await resend.emails.send({
    from: config.fromEmail,
    to: config.alertEmail,
    subject,
    html,
    attachments
  });

  if (error) {
    console.error('שגיאה בשליחת המייל:', error);
    throw error;
  }
  return data;
}

function buildHtml(results, mode, config, totalIssues, criticalCount) {
  const modeLabel = { daily: 'יומית', weekly: 'שבועית', monthly: 'חודשית' }[mode];
  const date = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

  const problematicResults = results.filter(r => r.issues.length > 0);

  const rows = problematicResults.map(r => {
    const issuesHtml = r.issues.map(i => {
      const color = i.severity === 'critical' ? '#dc2626' : '#f59e0b';
      return `<div style="margin: 4px 0; padding: 6px; background: ${color}15; border-right: 3px solid ${color}; border-radius: 4px;">
        <strong style="color: ${color};">${i.type}</strong>: ${i.message}
      </div>`;
    }).join('');

    return `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; vertical-align: top;">
          <a href="${r.url}" style="color: #2563eb; text-decoration: none; word-break: break-all;">${r.url}</a>
          <div style="color: #6b7280; font-size: 12px; margin-top: 4px;">
            ${r.viewport} | HTTP ${r.status || 'N/A'} | ${r.loadTime ? r.loadTime + 'ms' : 'נכשל'}
          </div>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">${issuesHtml}</td>
      </tr>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <title>דוח ניטור אתר</title>
</head>
<body style="font-family: -apple-system, 'Segoe UI', Arial, sans-serif; background: #f9fafb; margin: 0; padding: 20px;">
  <div style="max-width: 800px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">

    <div style="background: ${criticalCount > 0 ? '#dc2626' : '#f59e0b'}; color: white; padding: 24px;">
      <h1 style="margin: 0; font-size: 24px;">דוח סריקה ${modeLabel}</h1>
      <p style="margin: 8px 0 0 0; opacity: 0.9;">${config.siteName} | ${date}</p>
    </div>

    <div style="padding: 24px;">
      <div style="display: flex; gap: 16px; margin-bottom: 24px;">
        <div style="flex: 1; padding: 16px; background: #fef2f2; border-radius: 8px; text-align: center;">
          <div style="font-size: 28px; font-weight: bold; color: #dc2626;">${criticalCount}</div>
          <div style="color: #6b7280; font-size: 14px;">בעיות קריטיות</div>
        </div>
        <div style="flex: 1; padding: 16px; background: #fffbeb; border-radius: 8px; text-align: center;">
          <div style="font-size: 28px; font-weight: bold; color: #f59e0b;">${totalIssues - criticalCount}</div>
          <div style="color: #6b7280; font-size: 14px;">אזהרות</div>
        </div>
        <div style="flex: 1; padding: 16px; background: #f0fdf4; border-radius: 8px; text-align: center;">
          <div style="font-size: 28px; font-weight: bold; color: #16a34a;">${results.length - problematicResults.length}</div>
          <div style="color: #6b7280; font-size: 14px;">תקינים</div>
        </div>
      </div>

      <h2 style="font-size: 18px; color: #111827; margin: 24px 0 12px;">פירוט בעיות (${problematicResults.length} עמודים)</h2>

      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <thead>
          <tr style="background: #f3f4f6;">
            <th style="padding: 12px; text-align: right; color: #374151;">עמוד</th>
            <th style="padding: 12px; text-align: right; color: #374151;">בעיות</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div style="margin-top: 24px; padding: 16px; background: #f9fafb; border-radius: 8px; color: #6b7280; font-size: 13px;">
        <strong>💡 טיפ:</strong> אם הבדלים ויזואליים הם תוצאה של שינוי מכוון, מחק את התיקייה
        <code style="background: white; padding: 2px 6px; border-radius: 4px;">screenshots/baseline/${mode}</code>
        כדי לעדכן את הבייסליין.
      </div>
    </div>

  </div>
</body>
</html>`;
}
