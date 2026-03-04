import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { load as loadCheerio } from 'cheerio';
import { chromium } from 'playwright';

const CAL_URL = 'https://sparta.cz/cs/zapasy/1-muzi-a/2025-2026/kalendar';
const OUT_DIR = path.join(process.cwd(), 'docs');
const OUT_HTML = path.join(OUT_DIR, 'index.html');
const OUT_ICS = path.join(OUT_DIR, 'sparta.ics');

const pad2 = (n) => String(n).padStart(2, '0');

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeIcsText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// "floating" local datetime (Google to interpretuje podle časové zóny kalendáře uživatele)
function toIcsLocalDateTime(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(
    d.getHours(),
  )}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

async function fetchRenderedHtml(url) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      userAgent: 'sparta-ics-bot/1.0 (+playwright)',
    });

    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector(
      '.MatchPreview_League__JgAKd[data-context="league"]',
      {
        timeout: 15000,
      },
    );
    // krátký delay, ať doběhnou doplňující requesty s časy
    await page.waitForTimeout(1000);

    return await page.content();
  } finally {
    await browser.close();
  }
}

function normalizeSpace(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferSeasonYearHint(url) {
  const m = url.match(/(\d{4})-\d{4}/);
  if (m) return Number(m[1]);
  return new Date().getFullYear();
}

/**
 * Najdi "card container" pro zápas: nejbližší parent, který vypadá jako položka listu.
 * Heuristika, protože neznáme stabilní markup.
 */
function findContainer($, $a) {
  const candidates = ['article', 'li', 'section', 'div'];
  let $cur = $a;
  for (let i = 0; i < 8; i++) {
    $cur = $cur.parent();
    if (!$cur || !$cur.length) break;
    const tag = ($cur[0]?.tagName || '').toLowerCase();
    if (candidates.includes(tag)) {
      const txt = normalizeSpace($cur.text());
      // container by měl mít trochu více textu než jen odkaz
      if (txt.length >= 20) return $cur;
    }
  }
  // fallback
  return $a.parent();
}

/**
 * Heuristika na datum/čas z textu:
 * - datum ve formátu "4. 4." nebo "04.04." nebo "4.4."
 * - někdy může být i rok, ale často není.
 * - čas "18:00" apod.
 */
function extractDateTimeFromText(text, seasonYearHint = 2025) {
  const t = normalizeSpace(text);

  // varianta s dnem v týdnu (bereme POSLEDNÍ výskyt v řetězci):
  // "ne, 8. 3., 18:30" nebo "so, 4. 4."
  const dowRe =
    /\b(?:po|út|st|čt|pá|so|ne)\b\s*,\s*(\d{1,2})\.\s*(\d{1,2})\.(?:\s*,\s*([01]?\d|2[0-3]):([0-5]\d))?/gi;
  const dowMatches = Array.from(t.matchAll(dowRe));
  if (dowMatches.length) {
    const m = dowMatches[dowMatches.length - 1];
    const dd = Number(m[1]);
    const mo = Number(m[2]);
    const hh = m[3] != null ? Number(m[3]) : null;
    const mm = m[4] != null ? Number(m[4]) : null;
    const yyyy = mo >= 7 ? seasonYearHint : seasonYearHint + 1;
    return { dd, mo, yyyy, hh, mm, hasTime: m[3] != null };
  }

  // čas
  const timeMatch = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  const hh = timeMatch ? Number(timeMatch[1]) : null;
  const mm = timeMatch ? Number(timeMatch[2]) : null;

  // datum: d. m. (případně s rokem)
  const dateWithYear = t.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\b/);
  if (dateWithYear) {
    const dd = Number(dateWithYear[1]);
    const mo = Number(dateWithYear[2]);
    const yyyy = Number(dateWithYear[3]);
    return { dd, mo, yyyy, hh, mm, hasTime: !!timeMatch };
  }

  const dateNoYear = t.match(/\b(\d{1,2})\.\s*(\d{1,2})\.(?:\s|,|$)/);
  if (dateNoYear) {
    const dd = Number(dateNoYear[1]);
    const mo = Number(dateNoYear[2]);

    // sezóna 2025/2026: měsíce 7-12 -> 2025, 1-6 -> 2026 (heuristika)
    const yyyy = mo >= 7 ? seasonYearHint : seasonYearHint + 1;
    return { dd, mo, yyyy, hh, mm, hasTime: !!timeMatch };
  }

  return null;
}

function extractDateTime($container, debugText, seasonYearHint = 2025) {
  const $league = $container
    .find('.MatchPreview_League__JgAKd[data-context="league"]')
    .first();

  if ($league.length) {
    const $inner = $league.find('div').first();
    const leagueText = normalizeSpace(
      $inner.length ? $inner.text() : $league.text(),
    );

    const dt = extractDateTimeFromText(leagueText, seasonYearHint);
    if (dt) return dt;
  }

  const leagueTextFallback = normalizeSpace(
    $container.find('[data-context="league"]').first().text(),
  );
  return (
    extractDateTimeFromText(leagueTextFallback, seasonYearHint) ||
    extractDateTimeFromText(debugText, seasonYearHint)
  );
}

/**
 * Heuristika na teams z textu: vezme řádek a zkusí najít "Sparta" a soupeře.
 * Když to nedá, nechá summary jako "Sparta match (see link)".
 */
function extractSummary(text) {
  const t = normalizeSpace(text);

  // často bývá "AC Sparta Praha" někde v textu
  // zkusíme najít pattern "Sparta ... <něco>" – ale bez markup to může být bordel.
  // MVP: když text obsahuje "Sparta", necháme celé jako summary (zkrácené).
  if (/sparta/i.test(t)) {
    return t.length > 80 ? t.slice(0, 77) + '…' : t;
  }
  return 'AC Sparta Praha — match (see link)';
}

function extractRoundFromLeagueText(leagueText) {
  const roundMatch = leagueText.match(/(\d+\.\s*kolo)/i);
  if (roundMatch) return roundMatch[1];

  const beforeDow = leagueText.split(/\b(?:po|út|st|čt|pá|so|ne)\b/i)[0];
  const cleaned = normalizeSpace(beforeDow.replace(/[|•·]/g, ' '));
  return cleaned || null;
}

function extractMatchInfo($, $container, debugText) {
  const leagueText = normalizeSpace(
    $container.find('[data-context="league"]').first().text(),
  );

  let round =
    extractRoundFromLeagueText(leagueText) ||
    (normalizeSpace(debugText).match(/(\d+\.\s*kolo)/i)?.[1] ?? null);

  const teams = $container
    .find('[data-context="team"] strong')
    .map((_, el) => normalizeSpace($(el).text()))
    .get()
    .filter(Boolean);

  let home = null;
  let away = null;
  if (teams.length >= 2) {
    const dataHome =
      $container.find('[data-context="who"]').first().attr('data-home') ?? '';
    if (dataHome === 'false') {
      away = teams[0];
      home = teams[1];
    } else {
      home = teams[0];
      away = teams[1];
    }
  }

  return { round, home, away };
}

function uidFromLink(url) {
  return (
    'sparta-' +
    crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) +
    '@sparta.cz'
  );
}

function buildHtmlReport(items) {
  const groups = new Map();
  for (const it of items) {
    const key = it.group || 'Nezařazeno';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  let runningIndex = 1;
  const tables = Array.from(groups.entries())
    .map(([groupName, groupItems]) => {
      const rows = groupItems
        .map((it) => {
          const dt = it.dt
            ? `${it.dt.yyyy}-${pad2(it.dt.mo)}-${pad2(it.dt.dd)} ${
                it.dt.hh !== null ? `${pad2(it.dt.hh)}:${pad2(it.dt.mm)}` : '??:??'
              }`
            : 'NOT FOUND';

          return `
            <tr>
              <td>${runningIndex++}</td>
              <td style="text-align:left"><a href="${escapeHtml(it.href)}" target="_blank" rel="noreferrer">${escapeHtml(
                it.href,
              )}</a></td>
              <td>${escapeHtml(dt)}</td>
              <td>${escapeHtml(it.round ?? '—')}</td>
              <td>${escapeHtml(it.home ?? '—')}</td>
              <td>${escapeHtml(it.away ?? '—')}</td>
            </tr>
          `;
        })
        .join('\n');

      return `
        <h2>${escapeHtml(groupName)}</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Detail link</th>
              <th>Date/Time (parsed)</th>
              <th>Kolo</th>
              <th>Domácí</th>
              <th>Hosté</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      `;
    })
    .join('\n');

  return `<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sparta scrape report</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.4;padding:24px}
    h1{margin:0 0 8px}
    .meta{color:#555;margin:0 0 16px}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #ddd;padding:8px;vertical-align:top;text-align:center}
    th{position:sticky;top:0;background:#fff}
    pre{white-space:pre-wrap;word-break:break-word;margin:0}
    details summary{cursor:pointer}
  </style>
</head>
<body>
  <h1>Sparta scrape report</h1>
  <p class="meta">Source: <a href="${escapeHtml(CAL_URL)}" target="_blank" rel="noreferrer">${escapeHtml(
    CAL_URL,
  )}</a><br/>
  Items found: <strong>${items.length}</strong></p>

  <p>
    <a href="./sparta.ics">Download sparta.ics</a>
  </p>

  ${tables}
</body>
</html>`;
}

function buildIcs(items) {
  const now = new Date();
  const dtstamp = toIcsLocalDateTime(now) + 'Z';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sparta Fixtures//GitHub Actions//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const it of items) {
    // pokud datum nenajdeme, event vynecháme (jinak by to bylo random)
    if (!it.dt) continue;

    const { dd, mo, yyyy, hh, mm, hasTime } = it.dt;
    const start = new Date(yyyy, mo - 1, dd, hh ?? 18, mm ?? 0, 0);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uidFromLink(it.href)}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${toIcsLocalDateTime(start)}`);
    lines.push(`SUMMARY:${escapeIcsText(it.summary)}`);
    lines.push(`DESCRIPTION:${escapeIcsText(`Source: ${it.href}`)}`);
    if (!hasTime) lines.push('STATUS:TENTATIVE');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

async function main() {
  const html = await fetchRenderedHtml(CAL_URL);
  const $ = loadCheerio(html);
  const seasonYearHint = inferSeasonYearHint(CAL_URL);

  // všechny odkazy na detail zápasu
  const links = new Map(); // href -> item
  $('a[href]').each((_, el) => {
    const hrefRaw = $(el).attr('href');
    if (!hrefRaw) return;
    if (!hrefRaw.startsWith('/cs/zapas/')) return;

    const href = new URL(hrefRaw, CAL_URL).toString();
    if (links.has(href)) return;

    const $a = $(el);
    const $card = $a.closest('[data-component="match-preview"]');
    const $container = $card.length ? $card : findContainer($, $a);
    const debugText = normalizeSpace($container.text());

    const dt = extractDateTime($container, debugText, seasonYearHint);
    const summary = extractSummary(debugText);
    const { round, home, away } = extractMatchInfo($, $container, debugText);
    const $groupH2 = $a.closest('section').find('h2').first();
    $groupH2.find('a').remove();
    const group = normalizeSpace($groupH2.text());

    links.set(href, {
      href,
      dt,
      summary,
      debugText,
      round,
      home,
      away,
      group: group || null,
    });
  });

  const items = Array.from(links.values());

  if (!items.length) {
    throw new Error(
      'Nenašel jsem žádné odkazy na /cs/zapas/. Buď se změnil markup, nebo je stránka renderovaná JS a HTML je prázdné.',
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_HTML, buildHtmlReport(items), 'utf8');
  fs.writeFileSync(OUT_ICS, buildIcs(items), 'utf8');

  console.log(`Found ${items.length} match detail links.`);
  console.log(`Wrote ${OUT_HTML}`);
  console.log(`Wrote ${OUT_ICS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
