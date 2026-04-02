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
          Start_Hr: e.start_time ?? "", End_Hr: e.end_time ?? "",
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

    // Build "Clean Schedule" tab — mirrors original schedule format with corrected names
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

      // Collect unique dates in order, build a lookup: dateISO → { day, dateStr, shifts: { colHeader → physician } }
      const dateMap = new Map();
      for (const e of entries) {
        if (!dateMap.has(e.dateISO)) {
          const dateObj = new Date(e.dateISO + "T12:00:00");
          dateMap.set(e.dateISO, { dateStr: e.dateStr, day: DAY_NAMES[dateObj.getDay()], shifts: {} });
        }
        // Place corrected physician name in the cell; if multiple entries for same date+column, join with " / "
        const dayData = dateMap.get(e.dateISO);
        if (dayData.shifts[e.column_header]) {
          dayData.shifts[e.column_header] += " / " + e.physician;
        } else {
          dayData.shifts[e.column_header] = e.physician;
        }
      }

      // Assemble grid rows
      const gridHeaders = ["Date", "Day", ...colOrder];
      const gridValues = [gridHeaders];

      // Reference rows
      const timeRow = ["Shift Times", "", ...colOrder.map(c => colRef[c]?.time ?? "")];
      const regRow  = ["Regular Hrs", "", ...colOrder.map(c => colRef[c]?.regular ?? "")];
      const eveRow  = ["Evening Hrs", "", ...colOrder.map(c => colRef[c]?.evening ?? "")];
      const onRow   = ["Overnight Hrs", "", ...colOrder.map(c => colRef[c]?.overnight ?? "")];
      gridValues.push(timeRow, regRow, eveRow, onRow);

      // Date rows
      const sortedDates = [...dateMap.keys()].sort();
      for (const iso of sortedDates) {
        const d = dateMap.get(iso);
        gridValues.push([d.dateStr, d.day, ...colOrder.map(c => d.shifts[c] || "")]);
      }

      await ensureSheet(sheets, spreadsheetId, "Clean Schedule");
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
