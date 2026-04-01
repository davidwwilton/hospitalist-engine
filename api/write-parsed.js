/**
 * api/write-parsed.js
 * Vercel serverless function — writes the parsed schedule to Google Sheets.
 * POST body: { entries, nameLog, dupLog, config }
 * Returns: { outputUrl }
 */

import { google } from "googleapis";

const SHIFT_DEF_MAP = {
  LB8A:      { start:8,  end:17, payable:9, invoiceable:9 },
  SURGE:     { start:8,  end:17, payable:9, invoiceable:9 },
  INTAKE1:   { start:8,  end:17, payable:9, invoiceable:9 },
  INTAKE2:   { start:8,  end:17, payable:9, invoiceable:9 },
  WARD:      { start:8,  end:17, payable:9, invoiceable:9 },
  ER_EVE:    { start:16, end:25, payable:9, invoiceable:9 },
  WARD_EVE:  { start:17, end:25, payable:8, invoiceable:8 },
  HOME_CALL: { start:24, end:32, payable:8, invoiceable:8 },
  UCC_WARD:  { start:17, end:32, payable:9, invoiceable:9 },
};

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
    scopes: ["https://www.googleapis.com/auth/spreadsheets","https://www.googleapis.com/auth/drive"],
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
    const { outputUrl, shareEmail, createNew } = config;

    const auth = getAuthClient();
    const sheets = google.sheets({ version:"v4", auth });
    const drive = google.drive({ version:"v3", auth });

    let spreadsheetId;
    if (!createNew && outputUrl) {
      spreadsheetId = extractSheetId(outputUrl);
    } else {
      const now = new Date().toISOString().slice(0,16).replace("T"," ");
      const created = await drive.files.create({
        requestBody: {
          name: `Hospitalist Parsed Schedule — ${now}`,
          mimeType: "application/vnd.google-apps.spreadsheet",
        },
        fields: "id",
      });
      spreadsheetId = created.data.id;
      if (shareEmail) {
        try {
          await drive.permissions.create({
            fileId: spreadsheetId,
            transferOwnership: true,
            requestBody: { type:"user", role:"owner", emailAddress: shareEmail },
          });
        } catch {}
      }
    }

    // Build parsed rows
    const parsedHeaders = ["Date","Date_ISO","Month","Day","Physician","Physician_Raw","Name_Status","Shift_ID","Column_Header","Sheet_Tab","Start_Hr","End_Hr","Payable_Hrs","Invoiceable_Hrs","Is_Daytime","Has_AfterHours_Override"];
    const parsedRows = entries
      .sort((a,b) => a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : a.physician < b.physician ? -1 : 1)
      .map(e => {
        const d = SHIFT_DEF_MAP[e.shift_id] || {};
        const dateObj = new Date(e.dateISO + "T12:00:00");
        return {
          Date: e.dateStr, Date_ISO: e.dateISO,
          Month: MONTH_FULL[dateObj.getMonth()+1] || "",
          Day: DAY_NAMES[dateObj.getDay()],
          Physician: e.physician, Physician_Raw: e.physician_raw,
          Name_Status: e.name_status || "",
          Shift_ID: e.shift_id, Column_Header: e.column_header, Sheet_Tab: e.sheet,
          Start_Hr: d.start ?? "", End_Hr: d.end ?? "",
          Payable_Hrs: d.payable ?? "", Invoiceable_Hrs: d.invoiceable ?? "",
          Is_Daytime: (d.start===8 && d.end===17) ? "Y" : "N",
          Has_AfterHours_Override: ["HOME_CALL","UCC_WARD"].includes(e.shift_id) ? "Y" : "N",
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

    // Clean up: remove file from service account's Drive (user owns it now)
    if (createNew !== false && shareEmail) {
      try { await drive.files.update({ fileId: spreadsheetId, removeParents: "root" }); } catch {}
    }

    res.status(200).json({ outputUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` });
  } catch (e) {
    console.error("Write-parsed error:", e);
    res.status(500).json({ error: e.message });
  }
}
