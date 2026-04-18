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
// Row 5 = evening premium hours to pay per shift column
// Row 6 = overnight premium hours to pay per shift column
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

// Diagnostic helper — when a tab parses to 0 entries, this function probes
// the raw rows and returns a human-readable string describing what the parser
// actually saw, so we can pinpoint the structural issue (missing header row,
// wrong date format, etc.) without another debug round-trip.
function diagnoseZeroEntries(rows, tabName) {
  if (!rows || rows.length === 0) return "Tab has 0 rows.";

  const header = rows[0] || [];
  // Count shift columns the parser would detect
  let shiftColCount = 0;
  const shiftColHeaders = [];
  for (let i = 2; i < header.length; i++) {
    const raw = String(header[i] || "").trim();
    if (!raw || SKIP_HEADERS.has(raw.toUpperCase())) continue;
    const sid = headerToShiftId(raw);
    if (sid) { shiftColCount++; shiftColHeaders.push(raw); }
  }

  // Scan every row's col-A value and see how many parse as dates
  let dateRowCount = 0;
  const sampleColA = [];
  for (let r = 1; r < rows.length; r++) {
    const cell = String(rows[r]?.[0] || "").trim();
    if (r <= 10 && cell) sampleColA.push(`row${r + 1}="${cell}"`);
    if (cell && parseDateStr(cell)) dateRowCount++;
  }

  // First shift-column data cell sample (from row 8 / index 7) to confirm physician names are present
  const firstDataRow = rows[7] || [];
  const firstPhysicianSample = firstDataRow.slice(2, 5).map(v => `"${String(v || "").trim()}"`).join(",");

  return `Diagnostic: rows=${rows.length}, shift columns detected=${shiftColCount} (${shiftColHeaders.slice(0, 4).join(", ")}${shiftColHeaders.length > 4 ? "..." : ""}), rows with parseable date in col A=${dateRowCount}, col A samples=[${sampleColA.slice(0, 6).join(" ")}], row 8 shift cells=[${firstPhysicianSample}]`;
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
      const colIdx = parseInt(ci);
      const cell = String(row[colIdx]||"").trim();
      if (!cell || ["TBA",""].includes(cell.toUpperCase())) continue;
      const meta = colMeta[ci] || {};
      entries.push({
        dateStr, dateObj, dateISO: dateISO(dateObj),
        physician_raw: cell, shift_id: shiftId, column_header: colHeader, col_idx: colIdx, sheet: sheetName,
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

// ─────────────────────────────────────────────────────────────────────────────
// HARD-CODED EXCEPTION: UCC/Ward + Home Call concurrent override
// ─────────────────────────────────────────────────────────────────────────────
// Background: UCC/Ward is a 17:00–08:00 overnight shift (15 hours total). On
// rare occasions a physician is also scheduled to Home Call (24:00–08:00, 8
// overnight hours) on the same row in the schedule. Home Call in this case
// lies entirely inside UCC/Ward's time range — the physician is only working
// ONE continuous 15-hour shift, and Home Call is a duplicate tag for the
// overnight portion.
//
// Under the standard "pay-in-full" rule, the physician would be paid for both
// shifts (UCC/Ward's full reference row PLUS Home Call's 8 base + 8 overnight),
// which over-counts actual hours worked. The business rule in this specific
// concurrent scenario is: pay only for actual hours worked, which is 15 base
// hours plus 4 evening premium hours — no overnight premium, no Home Call pay.
//
// This override fires ONLY when a single physician has BOTH a UCC_WARD entry
// AND a HOME_CALL entry on the same schedule row (same dateISO). When it fires:
//   1. UCC/Ward's regular_hrs/evening_hrs/overnight_hrs are stamped to the
//      override values (15/4/0) and payable/invoiceable mirror regular_hrs.
//   2. Home Call is suppressed entirely (added to dupLog, blanked in Clean tab,
//      absent from Parsed Schedule and financial report).
//
// If the schedule ever changes such that UCC/Ward's actual hours, evening
// hours, or overnight premium should differ, update the constants below. This
// override is deliberately narrow — it does NOT affect UCC/Ward when worked
// in isolation, and it does NOT affect any other shift combinations.
// See USER_GUIDE.md Appendix A8 for the full rationale and worked example.
const UCC_WARD_HOMECALL_OVERRIDE = {
  regular_hrs: 15,
  evening_hrs: 4,
  overnight_hrs: 0,
};

function collapseDuplicates(entries) {
  // ── Pass 1: UCC/Ward + Home Call concurrent override ───────────────────────
  // Group entries by physician + dateISO. For any group that contains BOTH a
  // UCC_WARD shift AND a HOME_CALL shift, stamp the override values onto the
  // UCC/Ward entry and mark the Home Call entry for suppression.
  const byKey = {};
  for (const e of entries) {
    const key = `${e.physician}__${e.dateISO}`;
    (byKey[key] = byKey[key] || []).push(e);
  }
  const suppressed = new Set();
  const dupLog = [];
  for (const group of Object.values(byKey)) {
    if (group.length < 2) continue;
    const ucc = group.find(e => e.shift_id === "UCC_WARD");
    const hc  = group.find(e => e.shift_id === "HOME_CALL");
    if (!ucc || !hc) continue;
    // Apply the override to the UCC/Ward entry (mutates in place — these
    // modified values flow through write-parsed.js to the Parsed Schedule tab
    // and onward to the financial engine).
    ucc.regular_hrs     = UCC_WARD_HOMECALL_OVERRIDE.regular_hrs;
    ucc.evening_hrs     = UCC_WARD_HOMECALL_OVERRIDE.evening_hrs;
    ucc.overnight_hrs   = UCC_WARD_HOMECALL_OVERRIDE.overnight_hrs;
    ucc.payable_hrs     = UCC_WARD_HOMECALL_OVERRIDE.regular_hrs;
    ucc.invoiceable_hrs = UCC_WARD_HOMECALL_OVERRIDE.regular_hrs;
    // Flag the UCC/Ward entry so downstream (Parsed Schedule highlighting)
    // can mark it as a concurrent-override row.
    ucc.concurrent_override = true;
    // Suppress the Home Call entry
    suppressed.add(hc);
    dupLog.push({
      physician: hc.physician,
      date: hc.dateStr,
      shift_retained: ucc.column_header,
      shift_suppressed: hc.column_header,
      retained_col_idx: ucc.col_idx,
      suppressed_col_idx: hc.col_idx,
      // Explicit flag so write-parsed.js can distinguish this from the
      // standard weekend-daytime dedup (those still blank the cell; this
      // one keeps the name and gets a light-green background instead).
      is_concurrent_override: true,
      // Preserve the raw name and dateISO for downstream highlighting, since
      // the Clean-tab name map uses physician_raw → corrected name lookup.
      physician_raw: hc.physician_raw,
      dateISO: hc.dateISO,
      reason: `UCC/Ward + Home Call concurrent override — physician paid ${UCC_WARD_HOMECALL_OVERRIDE.regular_hrs}h base + ${UCC_WARD_HOMECALL_OVERRIDE.evening_hrs}h evening only`,
    });
  }

  // ── Pass 2: existing daytime dedup ─────────────────────────────────────────
  const seen = {}, kept = [];
  for (const e of entries) {
    if (suppressed.has(e)) continue;  // already suppressed by override
    if (!isDaytime(e)) { kept.push(e); continue; }
    const key = `${e.physician}__${e.dateISO}`;
    if (!(key in seen)) { seen[key] = { col_header: e.column_header, col_idx: e.col_idx }; kept.push(e); }
    else dupLog.push({
      physician: e.physician,
      date: e.dateStr,
      shift_retained: seen[key].col_header,
      shift_suppressed: e.column_header,
      retained_col_idx: seen[key].col_idx,
      suppressed_col_idx: e.col_idx,
      reason: "Same-day daytime overlap",
    });
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

    // Parse month tabs — also capture original tab structure for Clean output
    let allEntries = [];
    const tabStructures = {};  // tabName → { headers, refRows, rows }
    const tabErrors = [];      // per-tab errors so nothing fails silently
    for (const tab of monthTabs) {
      try {
        const safeTab = `'${tab.replace(/'/g, "''")}'`;
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: safeTab });
        const rawRows = resp.data.values || [];
        const beforeCount = allEntries.length;
        allEntries.push(...parseTab(rawRows, tab, yearFromTabName(tab) || selectedYear));
        const addedCount = allEntries.length - beforeCount;
        // Store the original tab structure for Clean tab reconstruction
        tabStructures[tab] = {
          headers: rawRows[0] || [],
          refRows: rawRows.slice(1, 7),  // rows 2-7 (indices 1-6)
          dataRows: rawRows.slice(7),     // row 8+ (index 7+)
        };
        // Flag tabs that returned zero entries — they were read but parseTab
        // produced nothing, which almost always means a row-structure issue.
        // Include a diagnostic probe so we don't have to guess what went wrong.
        if (addedCount === 0) {
          const diag = diagnoseZeroEntries(rawRows, tab);
          tabErrors.push({
            tab,
            error: `Tab was read successfully but no shift entries were extracted. ${diag}`,
            rowCount: rawRows.length,
          });
          console.error(`Parse: tab "${tab}" returned 0 entries (rowCount=${rawRows.length}) ${diag}`);
        }
      } catch (e) {
        // Surface the real error instead of swallowing it
        tabErrors.push({ tab, error: e.message });
        console.error(`Parse: tab "${tab}" failed:`, e.message);
      }
    }

    if (allEntries.length < 5) {
      const errDetail = tabErrors.length
        ? " Tab errors: " + tabErrors.map(e => `"${e.tab}": ${e.error}`).join(" | ")
        : "";
      return res.status(400).json({
        error: "Fewer than 5 entries parsed. Check spreadsheet URL and tab names." + errDetail,
        tabErrors,
      });
    }

    // Tag weekend and stat holiday entries
    tagEntries(allEntries, statHolidays);

    // Normalise names
    const { entries: normed, nameLog } = normaliseNames(allEntries, canonicalNames, corrections);

    // Collapse duplicates
    const { entries, dupLog } = collapseDuplicates(normed);

    res.status(200).json({ entries, canonicalNames, nameLog, dupLog, monthTabs, tabStructures, statHolidays: [...statHolidays], tabErrors });
  } catch (e) {
    console.error("Parse error:", e);
    res.status(500).json({ error: e.message });
  }
}
