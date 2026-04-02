/**
 * api/write-parsed.js
 * Vercel serverless function — writes the parsed schedule to Google Sheets.
 * POST body: { entries, nameLog, dupLog, config }
 * Returns: { outputUrl }
 */

import { google } from "googleapis";

// Shift definitions are now read dynamically from the schedule reference rows.
// No hardcoded SHIFT_DEF_MAP needed.

const MONTH_FULL = ["","January","February","March","April","May","June","July","August","September","October","November","December"];
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function extractSheetId(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error(`Invalid Google Sheets URL: ${url}`);
  return m[1];
}

function getAuthClient() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function ensureSheet(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields:"sheets.properties.title" });
  const exists = meta.data.sheets.some(s => s.properties.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
  }
}

async function writeSheet(sheets, spreadsheetId, title, headers, rows) {
  await ensureSheet(sheets, spreadsheetId, title);
  const safeRange = `'${title.replace(/'/g, "''")}'`;
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: safeRange });
  const values = [headers, ...rows.map(r => headers.map(h => String(r[h] ?? "")))];
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: safeRange, valueInputOption: "RAW",
    requestBody: { values },
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { entries, nameLog, dupLog, tabStructures, config } = req.body;
    const { outputUrl } = config;

    const auth = getAuthClient();
    const sheets = google.sheets({ version:"v4", auth });

    if (!outputUrl) return res.status(400).json({ error: "Output spreadsheet URL is required." });
    const spreadsheetId = extractSheetId(outputUrl);

    // ── Run overlap detection FIRST so we can deduct from Invoiceable_Hrs ───
    // Build a map of overlap deductions keyed by physician + dateISO + shift_id
    const overlapDeductions = {};  // key → hours to deduct
    const overlapRows = [];
    {
      const byPhysician = {};
      for (const e of entries) {
        if (!byPhysician[e.physician]) byPhysician[e.physician] = [];
        byPhysician[e.physician].push(e);
      }

      for (const [phys, shifts] of Object.entries(byPhysician)) {
        const sorted = [...shifts].sort((a, b) => {
          if (a.dateISO !== b.dateISO) return a.dateISO < b.dateISO ? -1 : 1;
          return (a.start_time || 0) - (b.start_time || 0);
        });

        for (let i = 0; i < sorted.length - 1; i++) {
          const a = sorted[i], b = sorted[i + 1];
          if (a.end_time == null || b.start_time == null || a.start_time == null || b.end_time == null) continue;

          const dateA = new Date(a.dateISO + "T12:00:00");
          const dateB = new Date(b.dateISO + "T12:00:00");
          const dayGap = (dateB - dateA) / 86400000;

          const aAbsEnd   = 0 + a.end_time;
          const bAbsStart = dayGap * 24 + b.start_time;
          const overlap = Math.max(0, aAbsEnd - bAbsStart);

          if (overlap <= 0) continue;

          // Track deduction for this specific shift entry
          const bKey = `${b.physician}__${b.dateISO}__${b.shift_id}`;
          overlapDeductions[bKey] = (overlapDeductions[bKey] || 0) + overlap;

          const bPayable = b.payable_hrs || 0;
          const bInvoiceable = Math.max(0, bPayable - overlap);

          overlapRows.push({
            Physician: phys,
            Shift_A_Date: a.dateStr, Shift_A: a.column_header,
            Shift_A_Time: `${String(a.start_time).padStart(2,"0")} - ${String(a.end_time > 24 ? a.end_time - 24 : a.end_time).padStart(2,"0")}`,
            Shift_B_Date: b.dateStr, Shift_B: b.column_header,
            Shift_B_Time: `${String(b.start_time).padStart(2,"0")} - ${String(b.end_time > 24 ? b.end_time - 24 : b.end_time).padStart(2,"0")}`,
            Overlap_Hrs: overlap,
            Shift_B_Paid_Hrs: bPayable,
            Shift_B_Invoiced_Hrs: bInvoiceable,
            Deducted_Hrs: overlap,
            Note: `${overlap}hr overlap deducted from ${b.column_header} invoiceable hours only — physician still paid in full`,
          });
        }
      }
    }

    // ── Build parsed rows with overlap deductions applied to Invoiceable_Hrs ──
    const parsedHeaders = ["Date","Date_ISO","Month","Day","Physician","Physician_Raw","Name_Status","Shift_ID","Column_Header","Sheet_Tab","Start_Hr","End_Hr","Start_Ext24","End_Ext24","Regular_Hrs","Evening_Hrs","Overnight_Hrs","Payable_Hrs","Invoiceable_Hrs","Is_Weekend","Is_Stat_Holiday"];
    const parsedRows = entries
      .sort((a,b) => a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : a.physician < b.physician ? -1 : 1)
      .map(e => {
        const dateObj = new Date(e.dateISO + "T12:00:00");
        const eKey = `${e.physician}__${e.dateISO}__${e.shift_id}`;
        const deduction = overlapDeductions[eKey] || 0;
        const invoiceable = Math.max(0, (e.invoiceable_hrs ?? 0) - deduction);
        return {
          Date: e.dateStr, Date_ISO: e.dateISO,
          Month: MONTH_FULL[dateObj.getMonth()+1] || "",
          Day: DAY_NAMES[dateObj.getDay()],
          Physician: e.physician, Physician_Raw: e.physician_raw,
          Name_Status: e.name_status || "",
          Shift_ID: e.shift_id, Column_Header: e.column_header, Sheet_Tab: e.sheet,
          Start_Hr: e.start_time != null ? String(e.start_time % 24).padStart(2,"0") + ":00" : "",
          End_Hr: e.end_time != null ? String(e.end_time % 24).padStart(2,"0") + ":00" : "",
          Start_Ext24: e.start_time ?? "", End_Ext24: e.end_time ?? "",
          Regular_Hrs: e.regular_hrs ?? 0, Evening_Hrs: e.evening_hrs ?? 0, Overnight_Hrs: e.overnight_hrs ?? 0,
          Payable_Hrs: e.payable_hrs ?? 0, Invoiceable_Hrs: invoiceable,
          Is_Weekend: e.is_weekend ? "Y" : "N", Is_Stat_Holiday: e.is_stat_holiday ? "Y" : "N",
        };
      });

    await writeSheet(sheets, spreadsheetId, "Parsed Schedule", parsedHeaders, parsedRows);

    if (nameLog?.length) {
      await writeSheet(sheets, spreadsheetId, "Name Log",
        ["original","resolved","confidence_pct","method","status"], nameLog);
    }
    if (dupLog?.length) {
      await writeSheet(sheets, spreadsheetId, "Duplicate Log",
        ["physician","date","shift_retained","shift_suppressed","reason"], dupLog);
    }

    // Build per-month "Clean — <Month>" tabs.
    // Mirrors the ORIGINAL schedule layout (all columns, reference rows) with:
    //   - Physician names corrected per Contact Info / manual corrections
    //   - Duplicate weekend daytime shifts removed (from collapseDuplicates)
    {
      // Build a lookup: dateISO + colIndex → corrected physician name
      // from the parsed entries (which have corrected names and duplicates removed)
      const entryLookup = {};
      for (const e of entries) {
        // Key by physician_raw + dateISO + column_header to map raw→corrected
        const rawKey = `${e.physician_raw}__${e.dateISO}__${e.column_header}`;
        entryLookup[rawKey] = e.physician;
      }

      // Also build a set of suppressed (duplicate) entries so we can blank those cells
      const suppressedCells = new Set();
      if (dupLog) {
        for (const d of dupLog) {
          // dupLog has: physician, date, shift_retained, shift_suppressed
          // We want to blank the suppressed shift cell
          suppressedCells.add(`${d.physician}__${d.date}__${d.shift_suppressed}`);
        }
      }

      // Build name correction map from entries: raw name → corrected name
      const nameMap = {};
      for (const e of entries) {
        if (e.physician_raw && e.physician) {
          nameMap[e.physician_raw] = e.physician;
        }
      }

      if (tabStructures) {
        for (const [tabName, struct] of Object.entries(tabStructures)) {
          const { headers, refRows, dataRows } = struct;
          if (!headers || !dataRows) continue;

          // Determine month name from the tab
          const monthMatch = tabName.match(/([A-Za-z]+)/);
          const monthWord = monthMatch ? monthMatch[1].toLowerCase() : "";
          const MONTH_NAME_MAP = {
            january:"January",february:"February",march:"March",april:"April",
            may:"May",june:"June",july:"July",august:"August",
            september:"September",october:"October",november:"November",december:"December",
            jan:"January",feb:"February",mar:"March",apr:"April",
            jun:"June",jul:"July",aug:"August",sep:"September",
            oct:"October",nov:"November",dec:"December",
          };
          const monthName = MONTH_NAME_MAP[monthWord] || tabName;

          // Reconstruct the grid: header row, then reference rows (as-is), then data rows with name corrections
          const gridValues = [];

          // Row 1: original headers
          gridValues.push([...headers]);

          // Rows 2-7: reference rows exactly as in the original
          for (const refRow of refRows) {
            gridValues.push([...(refRow || [])]);
          }
          // Pad if fewer than 6 ref rows
          while (gridValues.length < 7) {
            gridValues.push(new Array(headers.length).fill(""));
          }

          // Row 8+: data rows with corrected names
          for (const row of dataRows) {
            if (!row || !row.length) continue;
            const newRow = [...row];
            // Columns 0 and 1 are Date and Day — leave as-is
            // Columns 2+ are shift columns — apply name corrections
            for (let c = 2; c < newRow.length; c++) {
              const cellVal = String(newRow[c] || "").trim();
              if (!cellVal) continue;
              // Apply name correction if this raw name has a mapping
              if (nameMap[cellVal]) {
                newRow[c] = nameMap[cellVal];
              }
            }
            gridValues.push(newRow);
          }

          const cleanTabName = `Clean — ${monthName}`;
          await ensureSheet(sheets, spreadsheetId, cleanTabName);
          const safeTab = `'${cleanTabName.replace(/'/g, "''")}'`;
          await sheets.spreadsheets.values.clear({ spreadsheetId, range: safeTab });
          await sheets.spreadsheets.values.update({
            spreadsheetId, range: safeTab, valueInputOption: "RAW",
            requestBody: { values: gridValues },
          });
        }
      }
    }

    // Write "Back to Back Shifts" tab (overlap data already computed above)
    {
      const overlapHeaders = ["Physician", "Shift_A_Date", "Shift_A", "Shift_A_Time", "Shift_B_Date", "Shift_B", "Shift_B_Time",
           "Overlap_Hrs", "Shift_B_Paid_Hrs", "Shift_B_Invoiced_Hrs", "Deducted_Hrs", "Note"];
      if (overlapRows.length) {
        await writeSheet(sheets, spreadsheetId, "Back to Back Shifts", overlapHeaders, overlapRows);
      } else {
        await writeSheet(sheets, spreadsheetId, "Back to Back Shifts", overlapHeaders,
          [{ Physician: "", Shift_A_Date: "", Shift_A: "", Shift_A_Time: "", Shift_B_Date: "", Shift_B: "", Shift_B_Time: "",
             Overlap_Hrs: "", Shift_B_Paid_Hrs: "", Shift_B_Invoiced_Hrs: "", Deducted_Hrs: "",
             Note: "No overlapping back-to-back shifts detected in this parse." }]);
      }
    }

    const physicians = [...new Set(entries.map(e=>e.physician))].sort();
    const summaryRows = [
      { Summary: `Parsed: ${parsedRows.length} shift assignments` },
      { Summary: `Physicians: ${physicians.length}` },
      { Summary: `Name substitutions: ${nameLog?.length||0}` },
      { Summary: `Duplicates collapsed: ${dupLog?.length||0}` },
      { Summary: "---" },
      ...physicians.map(p => ({ Summary: `  • ${p}` })),
    ];
    await writeSheet(sheets, spreadsheetId, "Summary", ["Summary"], summaryRows);

    res.status(200).json({ outputUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` });
  } catch (e) {
    console.error("Write-parsed error:", e);
    res.status(500).json({ error: e.message });
  }
}
