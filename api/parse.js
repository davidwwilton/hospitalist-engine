/**
 * api/parse.js
 * Vercel serverless function — runs the schedule parser using the service account.
 * POST body: { sourceUrl, contactSheet, months }
 * Returns: { entries, canonicalNames, nameLog, dupLog, monthTabs }
 */

import { google } from "googleapis";

// Reference rows in each month tab (0-indexed):
// Row 0 = column headers (shift names)
// Row 3 = start/end times per shift column (e.g. "08 - 17", "16 - 01")
// Row 4 = regular hours to pay per shift column
// Row 5 = evening bonus hours to pay per shift column
// Row 6 = overnight bonus hours to pay per shift column
const REF_ROW_TIMES   = 3;
const REF_ROW_REGULAR = 4;
const REF_ROW_EVENING = 5;
const REF_ROW_OVERNIGHT = 6;

function parseShiftTime(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr).trim();
  // Handle "08 - 17", "0800-1700", "08-17", "0800 - 1700" etc.
  const m = s.match(/^(\d{2,4})\s*-\s*(\d{2,4})$/);
  if (!m) return null;
  let startVal = m[1], endVal = m[2];
  // If 4-digit, take first 2 as hours; if 2-digit, use as-is
  const startHr = parseInt(startVal.length >= 4 ? startVal.slice(0,2) : startVal);
  const endHr   = parseInt(endVal.length >= 4 ? endVal.slice(0,2) : endVal);
  // If end <= start, shift crosses midnight — use extended-24 convention
  const end = endHr <= startHr ? endHr + 24 : endHr;
  return { start: startHr, end };
}

const MONTH_ABBR = {
  jan:1,feb:2,mar:3,apr:4,may:5,jun:6,
  jul:7,aug:8,sep:9,oct:10,nov:11,dec:12
};
const DEFAULT_YEAR = new Date().getFullYear();

// Extract a 4-digit year from a tab name like "January 2026", "Feb 2025", etc.
// Returns null if no year found (caller should provide a fallback).
function yearFromTabName(tabName) {
  const m = tabName.match(/\b(20\d{2})\b/);
  return m ? parseInt(m[1]) : null;
}

// Shift columns are detected dynamically from column headers.
// Any column from index 2+ with a non-empty header is treated as a shift column.
// The shift ID is derived by normalising the header text:
//   "ER Eve" → "ER_EVE",  "Home Call" → "HOME_CALL",  "UCC/Ward" → "UCC_WARD"
function headerToShiftId(header) {
  return header.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function extractSheetId(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error(`Invalid Google Sheets URL: ${url}`);
  return m[1];
}

function parseDateStr(s, year) {
  const str = s.trim();

  // Format 1: "1-Mar", "15-Jan" (day-abbreviated month, no year)
  const m1 = str.match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (m1) {
    const day = parseInt(m1[1]);
    const mon = MONTH_ABBR[m1[2].toLowerCase()];
    if (mon) {
      const yr = year || DEFAULT_YEAR;
      const d = new Date(yr, mon - 1, day);
      return d.getMonth() === mon - 1 ? d : null;
    }
  }

  // Format 2: full date — "1/1/2026", "01/01/2026", "2026-01-01", "1-1-2026"
  // Try d/m/y first (common in Canadian/UK schedules)
  const m2 = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m2) {
    const a = parseInt(m2[1]), b = parseInt(m2[2]), y = parseInt(m2[3]);
    // d/m/y: day first, month second
    const d = new Date(y, b - 1, a);
    if (d.getMonth() === b - 1 && d.getDate() === a) return d;
  }

  // Try y-m-d (ISO format)
  const m3 = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m3) {
    const y = parseInt(m3[1]), mo = parseInt(m3[2]), da = parseInt(m3[3]);
    const d = new Date(y, mo - 1, da);
    if (d.getMonth() === mo - 1 && d.getDate() === da) return d;
  }

  return null;
}

// Extract year from the first data row (row 8 / index 7) of a month tab.
// The first date cell often has a full d/m/y date that subsequent rows derive from.
function extractYearFromTab(rows) {
  // Check row index 7 (row 8 in the sheet — first date row after reference rows)
  // Also try a few rows after in case row 7 is empty
  for (let i = 7; i < Math.min(rows.length, 12); i++) {
    const cell = String(rows[i]?.[0] || "").trim();
    if (!cell) continue;
    // Look for a 4-digit year in any date format
    const ym = cell.match(/\b(20\d{2})\b/);
    if (ym) return parseInt(ym[1]);
    // Also try parsing as a full date
    const parsed = parseDateStr(cell);
    if (parsed) return parsed.getFullYear();
  }
  return null;
}

function dateISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// Columns 0 and 1 are reserved for Date and Day — skip them.
// Any other column with a non-empty header is a shift column.
const SKIP_HEADERS = new Set(["DATE", "DAY", ""]);

function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a.length < b.length) [a,b] = [b,a];
  let prev = Array.from({length: b.length+1}, (_,i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i+1];
    for (let j = 0; j < b.length; j++)
      curr.push(Math.min(prev[j+1]+1, curr[j]+1, prev[j]+(a[i]!==b[j]?1:0)));
    prev = curr;
  }
  return prev[prev.length-1];
}

function nameConfidence(raw, canonical) {
  const rn = raw.replace(/[.\s]+/g," ").trim().toLowerCase();
  const cn = canonical.replace(/[.\s]+/g," ").trim().toLowerCase();
  if (rn === cn) return [1.0, "exact"];
  const rt = rn.split(" "), ct = cn.split(" ");
  if (rt.length <= ct.length && rt.every((t,i) => ct[i].startsWith(t))) return [0.88,"prefix"];
  if (rt.length===1 && rt[0]===ct[ct.length-1]) return [0.75,"last-name"];
  const maxLen = Math.max(rn.length, cn.length, 1);
  return [1 - levenshtein(rn,cn)/maxLen, "levenshtein"];
}

function resolveName(raw, canonicalNames) {
  if (!raw || ["TBA",""].includes(raw.trim().toUpperCase())) return [null,0,"none","UNRESOLVED"];
  let bestName=null, bestConf=0, bestMethod="none";
  for (const canon of canonicalNames) {
    const [conf, method] = nameConfidence(raw, canon);
    if (conf > bestConf) { bestConf=conf; bestMethod=method; bestName=canon; }
  }
  const status = bestConf>=0.90 ? "AUTO" : bestConf>=0.75 ? "REVIEW" : "UNRESOLVED";
  return [bestName, bestConf, bestMethod, status];
}

function extractCanonicalNames(rows) {
  if (!rows?.length) return [];
  const priority = ["schedule","name on","name","physician","doctor"];
  const header = rows[0];
  let colIdx = null;
  for (const kw of priority) {
    for (let i=0; i<header.length; i++) {
      if (header[i].toLowerCase().includes(kw)) { colIdx=i; break; }
    }
    if (colIdx!==null) break;
  }
  if (colIdx===null) colIdx=0;
  return rows.slice(1).map(r=>(r[colIdx]||"").trim()).filter(v=>v&&!["TBA","NAME",""].includes(v.toUpperCase()));
}

function parseTab(rows, sheetName, year) {
  if (!rows || rows.length < 2) return [];
  // Best year source: full date in first data row (row 8), then tab name, then argument
  const dataYear = extractYearFromTab(rows);
  const effectiveYear = dataYear || year || DEFAULT_YEAR;

  const header = rows[0];
  const shiftCols = {};
  for (let i=2; i<header.length; i++) {
    const raw = String(header[i] || "").trim();
    if (!raw || SKIP_HEADERS.has(raw.toUpperCase())) continue;
    const sid = headerToShiftId(raw);
    if (sid) shiftCols[i] = [sid, raw];
  }

  // Extract reference data from rows 4-7 (indices 3-6) per shift column
  const refTimes    = rows[REF_ROW_TIMES]    || [];
  const refRegular  = rows[REF_ROW_REGULAR]  || [];
  const refEvening  = rows[REF_ROW_EVENING]  || [];
  const refOvernight= rows[REF_ROW_OVERNIGHT]|| [];

  const colMeta = {};
  for (const [ci, [shiftId, colHeader]] of Object.entries(shiftCols)) {
    const idx = parseInt(ci);
    const time = parseShiftTime(refTimes[idx]);
    let regular_hrs   = parseFloat(refRegular[idx])   || 0;
    const evening_hrs   = parseFloat(refEvening[idx])   || 0;
    const overnight_hrs = parseFloat(refOvernight[idx]) || 0;

    // Fallback: if regular_hrs is 0 but valid shift times exist,
    // calculate total hours from the time range (end - start).
    // This handles columns where the reference row is empty or
    // the Google Sheets API truncated trailing cells.
    if (regular_hrs === 0 && time) {
      regular_hrs = time.end - time.start;
    }

    colMeta[ci] = {
      start: time?.start ?? null,
      end:   time?.end   ?? null,
      regular_hrs,
      evening_hrs,
      overnight_hrs,
    };
  }

  const entries = [];
  for (const row of rows.slice(1)) {
    if (!row?.length) continue;
    const dateStr = String(row[0]||"").trim();
    const dateObj = parseDateStr(dateStr, effectiveYear);
    if (!dateObj) continue;
    for (const [ci, [shiftId, colHeader]] of Object.entries(shiftCols)) {
      const cell = String(row[parseInt(ci)]||"").trim();
      if (!cell || ["TBA",""].includes(cell.toUpperCase())) continue;
      const meta = colMeta[ci] || {};
      entries.push({
        dateStr, dateObj, dateISO: dateISO(dateObj),
        physician_raw: cell, shift_id: shiftId, column_header: colHeader, sheet: sheetName,
        start_time: meta.start, end_time: meta.end,
        regular_hrs: meta.regular_hrs, evening_hrs: meta.evening_hrs, overnight_hrs: meta.overnight_hrs,
        payable_hrs: meta.regular_hrs, invoiceable_hrs: meta.regular_hrs,
      });
    }
  }
  return entries;
}

function normaliseNames(entries, canonicalNames, corrections={}) {
  const cache = {};
  const nameLog = [];
  for (const e of entries) {
    const raw = e.physician_raw;
    if (!(raw in cache)) {
      let canon, conf, method, status;
      if (raw in corrections) { canon=corrections[raw]; conf=1.0; method="manual"; status="AUTO"; }
      else [canon, conf, method, status] = resolveName(raw, canonicalNames);
      cache[raw] = [canon, conf, method, status];
      if (method!=="exact" || status!=="AUTO")
        nameLog.push({ original: raw, resolved: canon||"UNRESOLVED", confidence_pct: `${(conf*100).toFixed(0)}%`, confidence: conf, method, status });
    }
    const [canon,,, nameStatus] = cache[raw];
    e.physician = canon || raw;
    e.name_status = nameStatus;
  }
  return { entries, nameLog };
}

function isDaytime(entry) {
  // A daytime shift starts and ends within normal business hours (no crossing midnight)
  return entry.start_time != null && entry.end_time != null
    && entry.start_time >= 7 && entry.end_time <= 18 && entry.end_time > entry.start_time;
}

function collapseDuplicates(entries) {
  const seen = {}, kept = [], dupLog = [];
  for (const e of entries) {
    if (!isDaytime(e)) { kept.push(e); continue; }
    const key = `${e.physician}__${e.dateISO}`;
    if (!(key in seen)) { seen[key]=e.column_header; kept.push(e); }
    else dupLog.push({ physician: e.physician, date: e.dateStr, shift_retained: seen[key], shift_suppressed: e.column_header, reason: "Same-day daytime overlap" });
  }
  return { entries: kept, dupLog };
}

const MONTH_NAMES_FULL = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
};

function parseStatHolidays(rows, tabName) {
  // Parses a "Stat Holidays" tab.
  // Handles various formats:
  //   - Column A = "January 1" (simple)
  //   - Column A = "January 1", B = "Thursday", C = "New Year's Day" (multi-column)
  //   - Header rows like "Stat Holidays 2026" are skipped
  //   - Cell may contain extra text after the date, e.g. "January 1 Thursday"
  // Year is extracted from tab name (e.g. "Stat Holidays 2026") or defaults to current year.
  const year = yearFromTabName(tabName || "") || DEFAULT_YEAR;
  const holidays = new Set();
  if (!rows?.length) return holidays;
  for (const row of rows) {
    let found = false;
    // Try each cell in the row to find a "Month Day" pattern
    for (let c = 0; c < Math.min(row.length, 4) && !found; c++) {
      const cell = String(row[c] || "").trim();
      if (!cell) continue;
      // Match "Month Day" at the start of the cell (don't require end-of-string)
      const m = cell.match(/^([A-Za-z]+)\s+(\d{1,2})\b/);
      if (!m) continue;
      const mon = MONTH_NAMES_FULL[m[1].toLowerCase()];
      if (!mon) continue;
      const d = new Date(year, mon - 1, parseInt(m[2]));
      if (d.getMonth() === mon - 1) {
        holidays.add(dateISO(d));
        found = true;
      }
    }
  }
  return holidays;
}

function tagEntries(entries, statHolidays) {
  for (const e of entries) {
    const d = e.dateObj || new Date(e.dateISO + "T12:00:00");
    const dayOfWeek = d.getDay(); // 0=Sun, 6=Sat
    e.is_weekend = (dayOfWeek === 0 || dayOfWeek === 6);
    e.is_stat_holiday = statHolidays.has(e.dateISO);
  }
  return entries;
}

function getAuthClient() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { sourceUrl, contactSheet = "Contact Info", months = [], corrections = {} } = req.body;
    if (!sourceUrl) return res.status(400).json({ error: "sourceUrl is required" });

    const auth = getAuthClient();
    const sheets = google.sheets({ version: "v4", auth });
    const spreadsheetId = extractSheetId(sourceUrl);

    // Get tab list
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
    const allTabs = meta.data.sheets.map(s => s.properties.title);
    if (months.length === 0) {
      return res.status(400).json({ error: "Please select at least one month to parse." });
    }
    // months[] entries are "Jan 2026", "Feb 2026" etc. — strip year for tab matching
    const monthKeys = months.map(m => {
      const parts = m.split(/\s+/);
      return { abbr: parts[0], year: parts[1] ? parseInt(parts[1]) : null };
    });
    const monthTabs = allTabs.filter(t =>
      monthKeys.some(mk => t.toLowerCase().includes(mk.abbr.toLowerCase()))
    );
    // Build a year hint from the selected months (use the first one with a year)
    const selectedYear = monthKeys.find(mk => mk.year)?.year || null;

    if (!monthTabs.length) return res.status(400).json({ error: "No month tabs found in spreadsheet." });

    // Load canonical names
    let canonicalNames = [];
    try {
      const safeContactSheet = `'${contactSheet.replace(/'/g, "''")}'`;
      const contactResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: safeContactSheet });
      canonicalNames = extractCanonicalNames(contactResp.data.values || []);
    } catch (e) {
      return res.status(400).json({ error: `Could not read contact sheet "${contactSheet}": ${e.message}` });
    }

    // Load stat holidays (optional tab)
    let statHolidays = new Set();
    const statTab = allTabs.find(t => t.toLowerCase().includes("stat holiday"));
    if (statTab) {
      try {
        // Wrap tab name in single quotes for Sheets API (handles spaces/special chars)
        const safeRange = `'${statTab.replace(/'/g, "''")}'`;
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: safeRange });
        statHolidays = parseStatHolidays(resp.data.values || [], statTab);
      } catch (e) {
        console.error("Stat holidays read error:", e.message);
      }
    }

    // Parse month tabs
    let allEntries = [];
    for (const tab of monthTabs) {
      try {
        const safeTab = `'${tab.replace(/'/g, "''")}'`;
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: safeTab });
        allEntries.push(...parseTab(resp.data.values || [], tab, yearFromTabName(tab) || selectedYear));
      } catch { /* skip unreadable tabs */ }
    }

    if (allEntries.length < 5) return res.status(400).json({ error: "Fewer than 5 entries parsed. Check spreadsheet URL and tab names." });

    // Tag weekend and stat holiday entries
    tagEntries(allEntries, statHolidays);

    // Normalise names
    const { entries: normed, nameLog } = normaliseNames(allEntries, canonicalNames, corrections);

    // Collapse duplicates
    const { entries, dupLog } = collapseDuplicates(normed);

    res.status(200).json({ entries, canonicalNames, nameLog, dupLog, monthTabs, statHolidays: [...statHolidays] });
  } catch (e) {
    console.error("Parse error:", e);
    res.status(500).json({ error: e.message });
  }
}
