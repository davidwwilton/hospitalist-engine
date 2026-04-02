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
