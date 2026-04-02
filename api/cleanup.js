/**
 * api/cleanup.js
 * Temporary utility — lists and optionally deletes files from the service account's Drive.
 * GET  /api/cleanup         → lists all files
 * POST /api/cleanup         → deletes all files (permanently)
 */

import { google } from "googleapis";

function getAuthClient() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

export default async function handler(req, res) {
  const auth = getAuthClient();
  const drive = google.drive({ version: "v3", auth });

  try {
    // List all files owned by the service account
    const list = await drive.files.list({
      pageSize: 200,
      fields: "files(id, name, mimeType, createdTime, owners)",
    });
    const files = list.data.files || [];

    if (req.method === "GET") {
      return res.status(200).json({
        count: files.length,
        files: files.map(f => ({ id: f.id, name: f.name, type: f.mimeType, created: f.createdTime })),
      });
    }

    if (req.method === "POST") {
      const deleted = [];
      const failed = [];
      for (const f of files) {
        try {
          await drive.files.delete({ fileId: f.id });
          deleted.push(f.name);
        } catch (e) {
          failed.push({ name: f.name, error: e.message });
        }
      }
      return res.status(200).json({ deleted: deleted.length, failed: failed.length, deletedFiles: deleted, failedFiles: failed });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("Cleanup error:", e);
    res.status(500).json({ error: e.message });
  }
}
