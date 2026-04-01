/**
 * api/parse.js
 * Vercel serverless function — runs the schedule parser using the service account.
 * POST body: { sourceUrl, contactSheet, months }
 * Returns: { entries, canonicalNames, nameLog, dupLog, monthTabs }
 */

import { google } from "googleapis";

const SHIFT_DEFS = [
  { id: "LB8A",      start: 8,  end: 17, payable: 9, invoiceable: 9 },
  { id: "SURGE",     start: 8,  end: 17, payable: 9, invoiceable: 9 },
  { id: "INTAKE1",   start: 8,  end: 17, payable: 9, invoiceable: 9 },
  { id: "INTAKE2",   start: 8,  end: 17, payable: 9, invoiceable: 9 },
  { id: "WARD",      start: 8,  end: 17, payable: 9, invoiceable: 9 },
  { id: "ER_EVE",    start: 16, end: 25, payable: 9, invoiceable: 9 },
  { id: "WARD_EVE",  start: 17, end: 25, payable: 8, invoiceable: 8 },
  { id: "HOME_CALL", start: 24, end: 32, payable: 8, invoiceable: 8,
    afterHoursOverride: { eveningHours: 0, overnightHours: 0 } },
  { id: "UCC_WARD",  start: 17, end: 32, payable: 9, invoiceable: 9,
    afterHoursOverride: { eveningHours: 4, overnightHours: 0 } },
];
const SHIFT_DEF_MAP = Object.fromEntries(SHIFT_DEFS.map(s => [s.id, s]));

const MONTH_ABBR = {
  jan:1,feb:2,mar:3,apr:4,may:5,jun:6,
  jul:7,aug:8,sep:9,oct:10,nov:11,dec:12
};
const YEAR = 2026;

const HEADER_PATTERNS = [
  [/\bER\s*EVE\b/i,       "ER_EVE"],
  [/\bWARD\s*EVE\b/i,     "WARD_EVE"],
  [/\bHOME\s*CALL\b/i,    "HOME_CALL"],
  [/\bHC\b/i,             "HOME_CALL"],
  [/\bUCC[\s/]*WARD\b/i,  "UCC_WARD"],
  [/\bSURGE?\b/i,         "SURGE"],
  [/\bINTAKE\s*1\b/i,     "INTAKE1"],
  [/\bINTAKE\s*2\b/i,     "INTAKE2"],
  [/\bLB\s*8\s*A?\b/i,    "LB8A"],
  [/\bWARD\b/i,           "WARD"],
];

function extractSheetId(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error(`Invalid Google Sheets URL: ${url}`);
  return m[1];
}

function parseDateStr(s) {
  const m = s.trim().match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (!m) return null;
  const day = parseInt(m[1]);
  const mon = MONTH_ABBR[m[2].toLowerCase()];
  if (!mon) return null;
  const d = new Date(YEAR, mon - 1, day);
  return d.getMonth() === mon - 1 ? d : null;
}

function dateISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function matchHeader(h) {
  for (const [pat, id] of HEADER_PATTERNS) if (pat.test(h)) return id;
  return null;
}

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

function parseTab(rows, sheetName) {
  if (!rows || rows.length < 2) return [];
  const header = rows[0];
  const shiftCols = {};
  for (let i=2; i<header.length; i++) {
    const sid = matchHeader(String(header[i]));
    if (sid) shiftCols[i] = [sid, String(header[i])];
  }
  const entries = [];
  for (const row of rows.slice(1)) {
    if (!row?.length) continue;
    const dateStr = String(row[0]||"").trim();
    const dateObj = parseDateStr(dateStr);
    if (!dateObj) continue;
    for (const [ci, [shiftId, colHeader]] of Object.entries(shiftCols)) {
      const cell = String(row[parseInt(ci)]||"").trim();
      if (!cell || ["TBA",""].includes(cell.toUpperCase())) continue;
      entries.push({ dateStr, dateObj, dateISO: dateISO(dateObj), physician_raw: cell, shift_id: shiftId, column_header: colHeader, sheet: sheetName });
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

function isDaytime(shiftId) {
  const d = SHIFT_DEF_MAP[shiftId];
  return d && d.start===8 && d.end===17;
}

function collapseDuplicates(entries) {
  const seen = {}, kept = [], dupLog = [];
  for (const e of entries) {
    if (!isDaytime(e.shift_id)) { kept.push(e); continue; }
    const key = `${e.physician}__${e.dateISO}`;
    if (!(key in seen)) { seen[key]=e.column_header; kept.push(e); }
    else dupLog.push({ physician: e.physician, date: e.dateStr, shift_retained: seen[key], shift_suppressed: e.column_header, reason: "Same-day daytime overlap" });
  }
  return { entries: kept, dupLog };
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
    const monthTabs = months.length > 0
      ? allTabs.filter(t => months.some(m => t.toLowerCase().includes(m.toLowerCase())))
      : allTabs.filter(t => Object.keys(MONTH_ABBR).some(m => t.toLowerCase().includes(m)));

    if (!monthTabs.length) return res.status(400).json({ error: "No month tabs found in spreadsheet." });

    // Load canonical names
    let canonicalNames = [];
    try {
      const contactResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: contactSheet });
      canonicalNames = extractCanonicalNames(contactResp.data.values || []);
    } catch (e) {
      return res.status(400).json({ error: `Could not read contact sheet "${contactSheet}": ${e.message}` });
    }

    // Parse month tabs
    let allEntries = [];
    for (const tab of monthTabs) {
      try {
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: tab });
        allEntries.push(...parseTab(resp.data.values || [], tab));
      } catch { /* skip unreadable tabs */ }
    }

    if (allEntries.length < 5) return res.status(400).json({ error: "Fewer than 5 entries parsed. Check spreadsheet URL and tab names." });

    // Normalise names
    const { entries: normed, nameLog } = normaliseNames(allEntries, canonicalNames, corrections);

    // Collapse duplicates
    const { entries, dupLog } = collapseDuplicates(normed);

    res.status(200).json({ entries, canonicalNames, nameLog, dupLog, monthTabs });
  } catch (e) {
    console.error("Parse error:", e);
    res.status(500).json({ error: e.message });
  }
}
