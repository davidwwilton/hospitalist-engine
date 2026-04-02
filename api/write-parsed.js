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
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: title });
  const values = [headers, ...rows.map(r => headers.map(h => String(r[h] ?? "")))];
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: title, valueInputOption: "RAW",
    requestBody: { values },
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { entries, nameLog, dupLog, config } = req.body;
    const { outputUrl } = config;

    const auth = getAuthClient();
    const sheets = google.sheets({ version:"v4", auth });

    if (!outputUrl) return res.status(400).json({ error: "Output spreadsheet URL is required." });
    const spreadsheetId = extractSheetId(outputUrl);

    // Build parsed rows — hours come from schedule reference rows, not hardcoded
    const parsedHeaders = ["Date","Date_ISO","Month","Day","Physician","Physician_Raw","Name_Status","Shift_ID","Column_Header","Sheet_Tab","Start_Hr","End_Hr","Regular_Hrs","Evening_Hrs","Overnight_Hrs","Payable_Hrs","Invoiceable_Hrs","Is_Weekend","Is_Stat_Holiday"];
    const parsedRows = entries
      .sort((a,b) => a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : a.physician < b.physician ? -1 : 1)
      .map(e => {
        const dateObj = new Date(e.dateISO + "T12:00:00");
        return {
          Date: e.dateStr, Date_ISO: e.dateISO,
          Month: MONTH_FULL[dateObj.getMonth()+1] || "",
          Day: DAY_NAMES[dateObj.getDay()],
          Physician: e.physician, Physician_Raw: e.physician_raw,
          Name_Status: e.name_status || "",
          Shift_ID: e.shift_id, Column_Header: e.column_header, Sheet_Tab: e.sheet,
          Start_Hr: e.start_time != null ? String(e.start_time % 24).padStart(2,"0") + ":00" : "",
          End_Hr: e.end_time != null ? String(e.end_time % 24).padStart(2,"0") + ":00" : "",
          Regular_Hrs: e.regular_hrs ?? 0, Evening_Hrs: e.evening_hrs ?? 0, Overnight_Hrs: e.overnight_hrs ?? 0,
          Payable_Hrs: e.payable_hrs ?? 0, Invoiceable_Hrs: e.invoiceable_hrs ?? 0,
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

    // Build "Clean Schedule" tab — mirrors original schedule format with corrected names.
    // Appends new date rows on each parse so dates accumulate consecutively.
    {
      // Collect shift columns in the order they first appear
      const colOrder = [];
      const colSet = new Set();
      for (const e of entries) {
        if (!colSet.has(e.column_header)) {
          colSet.add(e.column_header);
          colOrder.push(e.column_header);
        }
      }

      // Build reference row data per column (from first entry for each column)
      const colRef = {};
      for (const e of entries) {
        if (!colRef[e.column_header]) {
          colRef[e.column_header] = {
            time: (e.start_time != null && e.end_time != null)
              ? `${String(e.start_time).padStart(2,"0")} - ${String(e.end_time > 24 ? e.end_time - 24 : e.end_time).padStart(2,"0")}`
              : "",
            regular: e.regular_hrs ?? "",
            evening: e.evening_hrs ?? "",
            overnight: e.overnight_hrs ?? "",
          };
        }
      }

      // Build new date rows from current parse
      const newDateMap = new Map();
      for (const e of entries) {
        if (!newDateMap.has(e.dateISO)) {
          const dateObj = new Date(e.dateISO + "T12:00:00");
          newDateMap.set(e.dateISO, { dateStr: e.dateStr, day: DAY_NAMES[dateObj.getDay()], shifts: {} });
        }
        const dayData = newDateMap.get(e.dateISO);
        if (dayData.shifts[e.column_header]) {
          dayData.shifts[e.column_header] += " / " + e.physician;
        } else {
          dayData.shifts[e.column_header] = e.physician;
        }
      }

      // Read existing Clean Schedule to preserve previously parsed dates
      await ensureSheet(sheets, spreadsheetId, "Clean Schedule");
      let existingHeaders = null;
      const existingDateRows = new Map(); // dateISO → row array
      try {
        const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Clean Schedule" });
        const rows = existing.data.values || [];
        if (rows.length > 0) {
          existingHeaders = rows[0];
          // Date rows start after header (row 0) + 2 blank rows + 4 reference rows = row index 7
          for (let i = 7; i < rows.length; i++) {
            const row = rows[i];
            if (!row || !row[0]) continue;
            // Parse "D-Mon" format to get ISO date for dedup
            const dateStr = String(row[0]).trim();
            const m = dateStr.match(/^(\d{1,2})-([A-Za-z]{3})$/);
            if (m) {
              const monthIdx = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12}[m[2].toLowerCase()];
              if (monthIdx) {
                const iso = `2026-${String(monthIdx).padStart(2,"0")}-${String(parseInt(m[1])).padStart(2,"0")}`;
                existingDateRows.set(iso, row);
              }
            }
          }
          // Merge any existing columns not in current parse
          if (existingHeaders.length > 2) {
            for (let i = 2; i < existingHeaders.length; i++) {
              const h = existingHeaders[i];
              if (h && !colSet.has(h)) {
                colSet.add(h);
                colOrder.push(h);
              }
            }
          }
        }
      } catch { /* no existing data — that's fine */ }

      // Build column index mapping for existing rows
      const existingColIndex = {};
      if (existingHeaders) {
        for (let i = 0; i < existingHeaders.length; i++) {
          existingColIndex[existingHeaders[i]] = i;
        }
      }

      // Assemble final grid — same structure as original schedule:
      // Row 1: Headers | Row 2-3: blank | Row 4: times | Row 5: regular | Row 6: evening | Row 7: overnight | Row 8+: dates
      const gridHeaders = ["Date", "Day", ...colOrder];
      const gridValues = [gridHeaders];

      // Blank rows 2-3 (matching original schedule structure)
      gridValues.push(new Array(gridHeaders.length).fill(""));
      gridValues.push(new Array(gridHeaders.length).fill(""));

      // Reference rows 4-7
      gridValues.push(["", "", ...colOrder.map(c => colRef[c]?.time ?? "")]);
      gridValues.push(["", "", ...colOrder.map(c => colRef[c]?.regular ?? "")]);
      gridValues.push(["", "", ...colOrder.map(c => colRef[c]?.evening ?? "")]);
      gridValues.push(["", "", ...colOrder.map(c => colRef[c]?.overnight ?? "")]);

      // Merge existing + new dates, new data overwrites existing for the same date
      const allDates = new Map(existingDateRows);
      const newDatesISO = new Set(newDateMap.keys());
      for (const iso of newDatesISO) {
        const d = newDateMap.get(iso);
        const row = new Array(gridHeaders.length).fill("");
        row[0] = d.dateStr;
        row[1] = d.day;
        for (let i = 0; i < colOrder.length; i++) {
          row[i + 2] = d.shifts[colOrder[i]] || "";
        }
        allDates.set(iso, row);
      }

      // For existing dates NOT in the new parse, re-map columns to new header order
      for (const [iso, row] of allDates) {
        if (newDatesISO.has(iso)) continue; // already built with new column order
        const remapped = new Array(gridHeaders.length).fill("");
        remapped[0] = row[0] || "";
        remapped[1] = row[1] || "";
        for (let i = 0; i < colOrder.length; i++) {
          const oldIdx = existingColIndex[colOrder[i]];
          if (oldIdx != null && oldIdx < row.length) {
            remapped[i + 2] = row[oldIdx] || "";
          }
        }
        allDates.set(iso, remapped);
      }

      // Sort all dates and append
      const sortedDates = [...allDates.keys()].sort();
      for (const iso of sortedDates) {
        gridValues.push(allDates.get(iso));
      }

      await sheets.spreadsheets.values.clear({ spreadsheetId, range: "Clean Schedule" });
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: "Clean Schedule", valueInputOption: "RAW",
        requestBody: { values: gridValues },
      });
    }

    // Build "Back to Back Shifts" tab — identifies overlapping consecutive shifts
    // and shows where invoiceable hours are deducted vs paid hours
    {
      const byPhysician = {};
      for (const e of entries) {
        if (!byPhysician[e.physician]) byPhysician[e.physician] = [];
        byPhysician[e.physician].push(e);
      }

      const overlapRows = [];
      for (const [phys, shifts] of Object.entries(byPhysician)) {
        const sorted = [...shifts].sort((a, b) => {
          if (a.dateISO !== b.dateISO) return a.dateISO < b.dateISO ? -1 : 1;
          return (a.start_time || 0) - (b.start_time || 0);
        });

        for (let i = 0; i < sorted.length - 1; i++) {
          const a = sorted[i], b = sorted[i + 1];
          if (a.end_time == null || b.start_time == null || a.start_time == null || b.end_time == null) continue;
          if (a.end_time <= 24) continue; // shift A doesn't cross midnight

          const dateA = new Date(a.dateISO + "T12:00:00");
          const dateB = new Date(b.dateISO + "T12:00:00");
          if ((dateB - dateA) / 86400000 !== 1) continue; // must be consecutive days

          const aRunsUntil = a.end_time - 24;
          const overlap = Math.max(0, aRunsUntil - b.start_time);
          if (overlap <= 0) continue;

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

      if (overlapRows.length) {
        await writeSheet(sheets, spreadsheetId, "Back to Back Shifts",
          ["Physician", "Shift_A_Date", "Shift_A", "Shift_A_Time", "Shift_B_Date", "Shift_B", "Shift_B_Time",
           "Overlap_Hrs", "Shift_B_Paid_Hrs", "Shift_B_Invoiced_Hrs", "Deducted_Hrs", "Note"],
          overlapRows);
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
