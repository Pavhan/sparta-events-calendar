// scripts/generate-sparta-ics.mjs
import fs from 'node:fs';
import path from 'node:path';

const OUT_PATH = path.join(process.cwd(), 'docs', 'sparta.ics');

// ZDROJ DAT — vyměnitelné
// Tip: vyber stránku, kde jsou zápasy v HTML tabulce a jsou veřejně dostupné.
const SOURCE_URL = 'https://sparta.cz/cs/zapasy/1-muzi-a/2025-2026/kalendar'; // příklad zdroje (sezónu upravíš)

// --- helpers ---
const pad2 = (n) => String(n).padStart(2, '0');

// iCal datetime in "floating time" (bez timezone). Google to pak bere podle kalendáře uživatele.
// Kdybys chtěl přesné časy v CZ, řeší se to TZID=Europe/Prague.
function toIcsLocalDateTime(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(
    d.getHours(),
  )}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function escapeIcsText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function makeUid(seed) {
  return `sparta-${seed}@github-actions`;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'sparta-ics-bot/1.0',
      accept: 'text/html',
    },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return await res.text();
}

/**
 * MVP parser:
 * Vytáhne řádky, kde je datum + domácí tým + hostující tým.
 * Tohle je křehké. Jakmile to zdroj změní, opravíš regex.
 */
function parseMatchesFromHtml(html) {
  // Worldfootball často obsahuje datum formátu "DD/MM/YYYY" a potom týmy v tabulce.
  // Regex je úmyslně jednoduchý.
  const re =
    /(\d{2}\/\d{2}\/\d{4}).{0,200}?(Sparta Prag|Sparta Praha).{0,200}?<\/td>\s*<td[^>]*>\s*-\s*<\/td>\s*<td[^>]*>\s*([^<]+)\s*</gim;

  const matches = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const dateStr = m[1]; // DD/MM/YYYY
    const home = m[2].trim();
    const away = m[3].trim();

    const [dd, mm, yyyy] = dateStr.split('/').map((x) => Number(x));
    // Čas často není dostupný. Dám default 18:00 lokálně.
    const start = new Date(yyyy, mm - 1, dd, 18, 0, 0);

    matches.push({
      start,
      summary: `${home} vs ${away}`,
      description: 'Fixture (auto-generated). Time may be approximate.',
      location: '',
      uidSeed: `${yyyy}${pad2(mm)}${pad2(dd)}-${away.toLowerCase().replace(/\W+/g, '-')}`,
    });
  }

  // Dedup
  const seen = new Set();
  return matches.filter((x) => {
    const k = x.uidSeed;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildIcs(events) {
  const now = new Date();
  const dtstamp = toIcsLocalDateTime(now) + 'Z'; // dtstamp může být Z

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sparta Fixtures//GitHub Actions//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${makeUid(ev.uidSeed)}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${toIcsLocalDateTime(ev.start)}`);
    lines.push(`SUMMARY:${escapeIcsText(ev.summary)}`);
    if (ev.description)
      lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

async function main() {
  const html = await fetchText(SOURCE_URL);
  const events = parseMatchesFromHtml(html);

  if (!events.length) {
    throw new Error(
      `Parsed 0 events. Source markup likely changed or wrong SOURCE_URL: ${SOURCE_URL}`,
    );
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, buildIcs(events), 'utf8');

  console.log(`Generated ${events.length} events → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
