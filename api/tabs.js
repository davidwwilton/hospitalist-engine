/**
 * api/tabs.js
 * Vercel serverless function — returns the list of tab names from a Google Sheet.
 * POST body: { url }
 * Returns: { tabs: string[] }
 */

import { google } from "googleapis";

function extractSheetId(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error(`Invalid Google Sheets URL: ${url}`);
  return m[1];
}

function getAuthClient() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });

    const auth = getAuthClient();
    const sheets = google.sheets({ version: "v4", auth });
    const spreadsheetId = extractSheetId(url);

    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
    const tabs = meta.data.sheets.map(s => s.properties.title);

    res.status(200).json({ tabs });
  } catch (e) {
    console.error("Tabs error:", e.message);
    res.status(500).json({ error: e.message });
  }
}
