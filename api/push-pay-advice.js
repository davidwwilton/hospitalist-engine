/**
 * api/push-pay-advice.js
 * Vercel serverless function — pushes per-physician pay advice tabs to each
 * physician's individual Google Sheet listed in the source schedule's
 * Contact Info tab, column Q.
 *
 * POST body: {
 *   sourceUrl,            // schedule spreadsheet URL (for reading Contact Info)
 *   contactSheet,         // tab name, defaults to "Contact Info"
 *   physicianResults,     // from /api/financial response
 *   periodLabel,          // e.g. "Custom Apr 1–Apr 14 2026"
 *   periodStart,          // ISO date string YYYY-MM-DD
 *   periodEnd,            // ISO date string YYYY-MM-DD
 * }
 *
 * Returns: {
 *   pushed:  [{ physician, tabName, sheetUrl }],
 *   skipped: [{ physician, reason }],
 *   tabName,
 * }
 *
 * Behaviour:
 *   - Physicians without a URL in column Q are skipped (this is the test
 *     workflow: populate column Q for one or two physicians, push, verify,
 *     then fill in the rest).
 *   - Physicians whose sheet hasn't been shared with the service account are
 *     skipped with a permission-denied reason. Add the service account email
 *     as Editor on the sheet to fix.
 */

import { google } from "googleapis";

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function getAuthClient() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

// Returns the spreadsheet ID, or null if the URL doesn't look like a Google
// Sheets URL. Unlike financial.js's extractSheetId, this does NOT throw —
// callers want to skip invalid URLs gracefully, not crash the whole push.
function safeExtractSheetId(url) {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Read the Contact Info tab and return [{ name, payAdviceUrl }, ...].
// Uses the same name-column priority logic as parse.js's extractCanonicalNames
// so the matching against physicianResults (which uses canonical names) lines up.
// The pay-advice URL lives in column Q (zero-indexed = 16).
function extractContactRows(rows) {
  if (!rows?.length) return [];
  const priority = ["schedule","name on","name","physician","doctor"];
  const header = rows[0];
  let nameIdx = null;
  for (const kw of priority) {
    for (let i = 0; i < header.length; i++) {
      if ((header[i] || "").toLowerCase().includes(kw)) { nameIdx = i; break; }
    }
    if (nameIdx !== null) break;
  }
  if (nameIdx === null) nameIdx = 0;
  const URL_COL = 16; // column Q
  return rows.slice(1)
    .map(r => ({
      name: (r[nameIdx] || "").trim(),
      payAdviceUrl: (r[URL_COL] || "").trim(),
    }))
    .filter(x => x.name && !["TBA","NAME"].includes(x.name.toUpperCase()));
}

async function ensureSheet(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  if (!meta.data.sheets.some(s => s.properties.title === title)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
  }
}

// Build the pay advice values matrix for one physician.
// Layout (rows):
//   1: "Pay Advice — {periodLabel}"
//   2: "Generated YYYY-MM-DD. Interim pay cycle. After-hours premiums paid quarterly."
//   3: blank
//   4: column headers
//   5+: one row per shift
//   last: TOTAL row (totals net pay only)
function buildAdviceValues(periodLabel, generatedDate, shiftDetails) {
  const headers = [
    "Date","Shift","Reg Hrs",
    "Evening Premium Hours","Overnight Premium Hours","Weekend/Stat Day Premium Hours",
    "Base Pay","Stat Pay","Cost Share","Op Holdback","Total Holdback","Net Pay",
  ];
  const fh = n => Number(n).toFixed(2);
  const fm = n => Number(n).toFixed(2); // dollars without $ prefix so Sheets numeric formatting works

  // Sort shifts by ISO date if available, otherwise leave in source order.
  const sorted = [...(shiftDetails || [])].sort((a, b) => {
    if (a.date_iso && b.date_iso) return a.date_iso.localeCompare(b.date_iso);
    return 0;
  });

  let totalNet = 0;
  const shiftRows = sorted.map(sd => {
    const net = (sd.base_pay || 0) + (sd.stat_bonus || 0) - (sd.cost_share || 0) - (sd.op_holdback || 0);
    totalNet += net;
    return [
      sd.date || "",
      sd.shift || "",
      fh(sd.regular_hrs || 0),
      fh(sd.evening_hrs || 0),
      fh(sd.overnight_hrs || 0),
      fh(sd.weekend_day_hrs || 0),
      fm(sd.base_pay || 0),
      fm(sd.stat_bonus || 0),
      fm(sd.cost_share || 0),
      fm(sd.op_holdback || 0),
      fm(sd.total_holdback || 0),
      fm(net),
    ];
  });

  const totalRow = ["TOTAL","","","","","","","","","","", fm(totalNet)];

  return [
    [`Pay Advice — ${periodLabel}`],
    [`Generated ${generatedDate}. Interim pay cycle. After-hours premiums paid quarterly.`],
    [],
    headers,
    ...shiftRows,
    totalRow,
  ];
}

async function writeAdviceTab(sheets, spreadsheetId, tabName, values) {
  await ensureSheet(sheets, spreadsheetId, tabName);
  // Clear any existing content on the tab (in case of a re-push for the same period)
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: tabName });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

// Pretty tab name like "Pay Advice Apr 1-14 2026" or, if the period crosses
// months, "Pay Advice Apr 28-May 11 2026".
function buildTabName(periodStartIso, periodEndIso) {
  const [sy, sm, sd] = periodStartIso.split("-").map(Number);
  const [ey, em, ed] = periodEndIso.split("-").map(Number);
  const startStr = `${MONTHS_SHORT[sm-1]} ${sd}`;
  const endStr   = (sm === em) ? `${ed}` : `${MONTHS_SHORT[em-1]} ${ed}`;
  // If start and end are in different years we include both years; otherwise once.
  const yearStr = (sy === ey) ? `${sy}` : `${sy}-${ey}`;
  return `Pay Advice ${startStr}-${endStr} ${yearStr}`;
}

// Categorise a Google API error message into a short, human-readable reason
// suitable for showing the financial admin in the result panel.
function classifyError(err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (/permission|denied|403/i.test(msg)) {
    return "Permission denied — share the sheet with the service account as Editor";
  }
  if (/not found|404/i.test(msg)) {
    return "Sheet not found — check the URL in Contact Info column Q";
  }
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const {
      sourceUrl,
      contactSheet = "Contact Info",
      physicianResults,
      periodLabel,
      periodStart,
      periodEnd,
    } = req.body;

    if (!sourceUrl) return res.status(400).json({ error: "sourceUrl is required" });
    if (!physicianResults || typeof physicianResults !== "object") {
      return res.status(400).json({ error: "physicianResults is required" });
    }
    if (!periodStart || !periodEnd) {
      return res.status(400).json({ error: "periodStart and periodEnd are required" });
    }

    const sourceId = safeExtractSheetId(sourceUrl);
    if (!sourceId) return res.status(400).json({ error: "Could not parse sourceUrl as a Google Sheets URL" });

    const auth = getAuthClient();
    const sheets = google.sheets({ version: "v4", auth });

    // Read Contact Info tab to build the {physician name → pay advice URL} map.
    let contactRows;
    try {
      const safeContactRange = `'${contactSheet.replace(/'/g, "''")}'`;
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: sourceId,
        range: safeContactRange,
      });
      contactRows = extractContactRows(resp.data.values || []);
    } catch (e) {
      return res.status(400).json({
        error: `Could not read Contact Info tab "${contactSheet}": ${e.message}`,
      });
    }

    const urlMap = {};
    for (const c of contactRows) {
      if (c.name) urlMap[c.name] = c.payAdviceUrl;
    }

    const tabName = buildTabName(periodStart, periodEnd);
    const generatedDate = new Date().toISOString().slice(0, 10);

    const pushed = [];
    const skipped = [];

    // Iterate physicians in alphabetical order so the result panel is stable.
    const physicianNames = Object.keys(physicianResults).sort();

    for (const physKey of physicianNames) {
      const pr = physicianResults[physKey];
      const physicianDisplayName = pr.physician || physKey;
      const url = urlMap[physicianDisplayName];

      if (!url) {
        skipped.push({
          physician: physicianDisplayName,
          reason: "No URL in Contact Info column Q",
        });
        continue;
      }

      const adviceId = safeExtractSheetId(url);
      if (!adviceId) {
        skipped.push({
          physician: physicianDisplayName,
          reason: `Invalid Google Sheets URL: ${url}`,
        });
        continue;
      }

      const values = buildAdviceValues(periodLabel, generatedDate, pr.shift_details || []);

      try {
        await writeAdviceTab(sheets, adviceId, tabName, values);
        pushed.push({
          physician: physicianDisplayName,
          tabName,
          sheetUrl: `https://docs.google.com/spreadsheets/d/${adviceId}`,
        });
      } catch (e) {
        skipped.push({
          physician: physicianDisplayName,
          reason: classifyError(e),
        });
      }
    }

    res.status(200).json({ pushed, skipped, tabName });
  } catch (e) {
    console.error("push-pay-advice error:", e);
    res.status(500).json({ error: e.message });
  }
}
