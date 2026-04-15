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

// ── Highlight colour palette (Google Sheets RGB fractions, 0–1) ──────────────
// Keep these in sync with the Legend tab and USER_GUIDE.md Appendix A8.1.
// Priority when a cell qualifies for more than one: GREEN > ORANGE > PURPLE.
const COLOR_GREEN  = { red: 0.72, green: 0.88, blue: 0.72 }; // concurrent override (UCC/Ward + Home Call)
const COLOR_ORANGE = { red: 1.00, green: 0.80, blue: 0.55 }; // back-to-back overlap (second shift)
const COLOR_PURPLE = { red: 0.85, green: 0.75, blue: 0.95 }; // stat holiday
const COLOR_WHITE  = { red: 1.00, green: 1.00, blue: 1.00 }; // used to clear old highlights on rerun

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
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields:"sheets.properties(sheetId,title)" });
  const existing = meta.data.sheets.find(s => s.properties.title === title);
  if (existing) return existing.properties.sheetId;
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

async function writeSheet(sheets, spreadsheetId, title, headers, rows) {
  const sheetId = await ensureSheet(sheets, spreadsheetId, title);
  const safeRange = `'${title.replace(/'/g, "''")}'`;
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: safeRange });
  const values = [headers, ...rows.map(r => headers.map(h => String(r[h] ?? "")))];
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: safeRange, valueInputOption: "RAW",
    requestBody: { values },
  });
  return sheetId;
}

/**
 * Build a repeatCell request that paints a single cell's background colour.
 * startRowIndex / startColumnIndex are 0-based grid coordinates.
 */
function paintCellRequest(sheetId, rowIdx, colIdx, color) {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: rowIdx,
        endRowIndex: rowIdx + 1,
        startColumnIndex: colIdx,
        endColumnIndex: colIdx + 1,
      },
      cell: { userEnteredFormat: { backgroundColor: color } },
      fields: "userEnteredFormat.backgroundColor",
    },
  };
}

/**
 * Build a repeatCell request that paints an entire row across a column range.
 */
function paintRowRequest(sheetId, rowIdx, startCol, endCol, color) {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: rowIdx,
        endRowIndex: rowIdx + 1,
        startColumnIndex: startCol,
        endColumnIndex: endCol,
      },
      cell: { userEnteredFormat: { backgroundColor: color } },
      fields: "userEnteredFormat.backgroundColor",
    },
  };
}

/**
 * Paint the whole used area of a sheet white. Used to wipe stale highlights
 * from a prior run before applying the new ones, so re-running the parser
 * doesn't leave ghost colours on cells that no longer qualify.
 */
function clearHighlightsRequest(sheetId, rowCount, colCount) {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 0,
        endRowIndex: rowCount,
        startColumnIndex: 0,
        endColumnIndex: colCount,
      },
      cell: { userEnteredFormat: { backgroundColor: COLOR_WHITE } },
      fields: "userEnteredFormat.backgroundColor",
    },
  };
}

/**
 * Run a batch of formatting requests (chunked to stay under API limits).
 */
async function runBatchFormat(sheets, spreadsheetId, requests) {
  if (!requests.length) return;
  const CHUNK = 500;
  for (let i = 0; i < requests.length; i += CHUNK) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: requests.slice(i, i + CHUNK) },
    });
  }
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
    // Also track the "second shift" entries themselves for orange highlighting.
    // We key by physician + dateISO + column_header so we can later match to
    // both parsedRows (Parsed Schedule) and grid cells (Clean — Month tab).
    const backToBackSecondKeys = new Set();
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
          backToBackSecondKeys.add(bKey);

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
    // While building, decide each row's highlight colour by priority
    // (green > orange > purple). parsedRowColors[i] is the colour (or null)
    // for row i+1 of the Parsed Schedule tab (row 0 is the header).
    const parsedHeaders = ["Date","Date_ISO","Month","Day","Physician","Physician_Raw","Name_Status","Shift_ID","Column_Header","Sheet_Tab","Start_Hr","End_Hr","Start_Ext24","End_Ext24","Regular_Hrs","Evening_Hrs","Overnight_Hrs","Payable_Hrs","Invoiceable_Hrs","Is_Weekend","Is_Stat_Holiday"];
    const sortedEntries = [...entries].sort((a,b) =>
      a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 :
      a.physician < b.physician ? -1 : 1);
    const parsedRowColors = [];
    const parsedRows = sortedEntries.map(e => {
      const dateObj = new Date(e.dateISO + "T12:00:00");
      const eKey = `${e.physician}__${e.dateISO}__${e.shift_id}`;
      const deduction = overlapDeductions[eKey] || 0;
      const invoiceable = Math.max(0, (e.invoiceable_hrs ?? 0) - deduction);

      // Priority: green > orange > purple
      let color = null;
      if (e.concurrent_override) color = COLOR_GREEN;
      else if (backToBackSecondKeys.has(eKey)) color = COLOR_ORANGE;
      else if (e.is_stat_holiday) color = COLOR_PURPLE;
      parsedRowColors.push(color);

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

    const parsedSheetId = await writeSheet(sheets, spreadsheetId, "Parsed Schedule", parsedHeaders, parsedRows);

    // Apply Parsed Schedule row highlighting
    {
      const requests = [];
      // Clear any stale highlights from a previous run across the used range
      requests.push(clearHighlightsRequest(parsedSheetId, parsedRows.length + 1, parsedHeaders.length));
      parsedRowColors.forEach((color, i) => {
        if (!color) return;
        // Row 0 is the header; row i+1 is the entry row
        requests.push(paintRowRequest(parsedSheetId, i + 1, 0, parsedHeaders.length, color));
      });
      await runBatchFormat(sheets, spreadsheetId, requests);
    }

    if (nameLog?.length) {
      await writeSheet(sheets, spreadsheetId, "Name Log",
        ["original","resolved","confidence_pct","method","status"], nameLog);
    }
    if (dupLog?.length) {
      await writeSheet(sheets, spreadsheetId, "Duplicate Log",
        ["physician","date","shift_retained","shift_suppressed","reason"], dupLog);
    }

    // ── Build per-month "Clean — <Month>" tabs ────────────────────────────────
    // Mirrors the ORIGINAL schedule layout (all columns, reference rows) with:
    //   - Physician names corrected per Contact Info / manual corrections
    //   - Weekend daytime duplicate cells BLANKED (standard dedup)
    //   - UCC/Ward + Home Call concurrent-override cells KEPT (name preserved)
    //     and highlighted light green
    //   - Back-to-back overlap "second shift" cells highlighted orange
    //   - Stat holiday shift cells highlighted purple
    //   - Priority when multiple apply: green > orange > purple
    {
      // Split dupLog into two buckets by the new is_concurrent_override flag
      // set in api/parse.js. Weekend daytime dupes (no flag) still blank.
      // UCC/Ward + Home Call (flag set) stay visible with a green highlight.
      const blankingCells = new Set();       // still blanked out
      const concurrentCells = new Set();     // keep name, highlight green
      if (dupLog) {
        for (const d of dupLog) {
          if (d.suppressed_col_idx == null) continue;
          const key = `${d.physician}__${d.date}__${d.suppressed_col_idx}`;
          if (d.is_concurrent_override) concurrentCells.add(key);
          else blankingCells.add(key);
        }
      }

      // Name correction map: raw name → corrected name.
      // We populate this from BOTH the kept entries AND the dupLog
      // (the suppressed Home Call entry isn't in `entries` any more, so
      // without this fallback its raw name wouldn't get corrected in the
      // Clean tab).
      const nameMap = {};
      for (const e of entries) {
        if (e.physician_raw && e.physician) nameMap[e.physician_raw] = e.physician;
      }
      if (dupLog) {
        for (const d of dupLog) {
          if (d.physician_raw && d.physician) nameMap[d.physician_raw] = d.physician;
        }
      }

      // Build a per-tab lookup from (dateStr, col_idx) → entry so we can
      // decide each cell's highlight colour without scanning all entries.
      const entriesByTab = {};
      for (const e of entries) {
        if (!entriesByTab[e.sheet]) entriesByTab[e.sheet] = {};
        entriesByTab[e.sheet][`${e.dateStr}__${e.col_idx}`] = e;
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

          // Reconstruct the grid and, in parallel, collect (rowIdx, colIdx,
          // color) tuples for cells that need highlighting.
          const gridValues = [];
          const highlightCells = [];  // { rowIdx, colIdx, color }

          // Row 0 (gridValues index 0): original headers
          gridValues.push([...headers]);

          // Rows 1–6: reference rows exactly as in the original
          for (const refRow of refRows) {
            gridValues.push([...(refRow || [])]);
          }
          while (gridValues.length < 7) {
            gridValues.push(new Array(headers.length).fill(""));
          }

          // Row 7+: data rows with name corrections, blanking, and highlight tracking
          const tabEntries = entriesByTab[tabName] || {};
          for (const row of dataRows) {
            if (!row || !row.length) continue;
            const newRow = [...row];
            const rowDateStr = String(newRow[0] || "").trim();
            const gridRowIdx = gridValues.length;  // where this row will live

            for (let c = 2; c < newRow.length; c++) {
              const cellVal = String(newRow[c] || "").trim();
              if (!cellVal) continue;
              const correctedName = nameMap[cellVal] || cellVal;
              const dupKey = `${correctedName}__${rowDateStr}__${c}`;

              // Concurrent override (UCC/Ward + Home Call): keep name, green.
              // This takes precedence over everything else for this cell.
              if (concurrentCells.has(dupKey)) {
                newRow[c] = correctedName;
                highlightCells.push({ rowIdx: gridRowIdx, colIdx: c, color: COLOR_GREEN });
                continue;
              }

              // Standard weekend daytime dedup: blank the cell as before.
              if (blankingCells.has(dupKey)) {
                newRow[c] = "";
                continue;
              }

              // Apply name correction
              if (nameMap[cellVal]) newRow[c] = nameMap[cellVal];

              // Look up the parsed entry to decide green/orange/purple highlight.
              // This branch handles cells whose entry IS still in the parsed
              // list (i.e. not a suppressed dupe). That includes the UCC/Ward
              // side of the concurrent override — its entry has the flag
              // `concurrent_override=true` set by api/parse.js and needs the
              // same green background as the Home Call side handled above.
              // Priority: green > orange > purple.
              const entry = tabEntries[`${rowDateStr}__${c}`];
              if (!entry) continue;
              const eKey = `${entry.physician}__${entry.dateISO}__${entry.shift_id}`;
              if (entry.concurrent_override) {
                highlightCells.push({ rowIdx: gridRowIdx, colIdx: c, color: COLOR_GREEN });
              } else if (backToBackSecondKeys.has(eKey)) {
                highlightCells.push({ rowIdx: gridRowIdx, colIdx: c, color: COLOR_ORANGE });
              } else if (entry.is_stat_holiday) {
                highlightCells.push({ rowIdx: gridRowIdx, colIdx: c, color: COLOR_PURPLE });
              }
            }
            gridValues.push(newRow);
          }

          const cleanTabName = `Clean — ${monthName}`;
          const cleanSheetId = await ensureSheet(sheets, spreadsheetId, cleanTabName);
          const safeTab = `'${cleanTabName.replace(/'/g, "''")}'`;
          await sheets.spreadsheets.values.clear({ spreadsheetId, range: safeTab });
          await sheets.spreadsheets.values.update({
            spreadsheetId, range: safeTab, valueInputOption: "RAW",
            requestBody: { values: gridValues },
          });

          // Apply highlighting (plus clear any stale colours first)
          const requests = [
            clearHighlightsRequest(cleanSheetId, gridValues.length, headers.length),
            ...highlightCells.map(h => paintCellRequest(cleanSheetId, h.rowIdx, h.colIdx, h.color)),
          ];
          await runBatchFormat(sheets, spreadsheetId, requests);
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

    // ── Legend tab ───────────────────────────────────────────────────────────
    // Simple reference sheet: one row per colour, with the actual background
    // painted on the first cell so readers can see the colour rather than
    // guessing from an RGB code. Kept at the end so it doesn't clutter the
    // main workflow tabs.
    {
      const legendHeaders = ["Colour", "Meaning", "Where it appears", "Notes"];
      const legendRows = [
        {
          Colour: "", // will be painted green
          Meaning: "Concurrent override (UCC/Ward + Home Call)",
          "Where it appears": "Clean — Month tab cell; Parsed Schedule UCC/Ward row",
          Notes: "Physician worked UCC/Ward + Home Call on the same day. Pay forced to 15 regular + 5 evening hours. See USER_GUIDE Appendix A8.1.",
        },
        {
          Colour: "", // orange
          Meaning: "Back-to-back overlap (second shift)",
          "Where it appears": "Clean — Month tab cell; Parsed Schedule row of the second shift",
          Notes: "Overlap hours deducted from Invoiceable_Hrs. Physician paid in full. See the Back to Back Shifts tab.",
        },
        {
          Colour: "", // purple
          Meaning: "Stat holiday shift",
          "Where it appears": "Clean — Month tab cell; Parsed Schedule row",
          Notes: "Shift falls on a statutory holiday. Stat bonus handled by the financial engine.",
        },
      ];
      const legendSheetId = await writeSheet(sheets, spreadsheetId, "Legend", legendHeaders, legendRows);

      // Paint the Colour column cells to match the scheme.
      const legendRequests = [
        clearHighlightsRequest(legendSheetId, legendRows.length + 1, legendHeaders.length),
        paintCellRequest(legendSheetId, 1, 0, COLOR_GREEN),
        paintCellRequest(legendSheetId, 2, 0, COLOR_ORANGE),
        paintCellRequest(legendSheetId, 3, 0, COLOR_PURPLE),
      ];
      await runBatchFormat(sheets, spreadsheetId, legendRequests);
    }

    res.status(200).json({ outputUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` });
  } catch (e) {
    console.error("Write-parsed error:", e);
    res.status(500).json({ error: e.message });
  }
}
