// netlify/functions/download.js
// Netlify Function (Node runtime).
// The browser calls /api/download?id=xxx (redirected here by netlify.toml).
// This function fetches the REAL PDF server-side (no CORS issue — it's a
// server-to-server request), stamps a watermark on every page, and returns
// it with Content-Disposition: attachment so the file downloads straight
// from pastpapersvalute.netlify.app instead of doenets.lk / catbox.

const { PDFDocument, degrees } = require("pdf-lib");
const groupedData = require("./data/all_papers_grouped.json");

const WATERMARK_URL = "https://files.catbox.moe/ub5gpl.png";

// Netlify Functions have a ~6MB response-body limit (base64 makes this
// closer to ~4.5MB of real file data). If a PDF is bigger than this we
// can't proxy it through a normal function — see the fallback below.
const MAX_SAFE_BYTES = 4.3 * 1024 * 1024;

// ---- Build an id -> paper lookup once per cold start (identical logic/ids to the frontend) ----
function detectExamFromTitle(title, subject) {
  const t = ((title || "") + " " + (subject || "")).toLowerCase();
  if (t.includes("advanced level") || /\ba\/l\b/.test(t)) return "A/L";
  if (t.includes("ordinary level") || /\bo\/l\b/.test(t)) return "O/L";
  if (t.includes("grade 5") || t.includes("grade five") || t.includes("scholarship") || t.includes("ශිෂ්‍යත්ව")) return "Grade 5";
  return "Other";
}

let PAPER_INDEX = null;
function buildIndex() {
  if (PAPER_INDEX) return PAPER_INDEX;
  const index = new Map();
  for (const yearKey in groupedData) {
    const yearData = groupedData[yearKey];
    if (!yearData || typeof yearData !== "object") continue;
    for (const bucket in yearData) {
      const arr = yearData[bucket];
      if (!Array.isArray(arr)) continue;
      arr.forEach((p) => {
        const subject = p.subject_en || p.subject_si || p.subject_ta || "Unknown";
        const paperTitle = p.title || `Paper ${p.id}`;
        const exam = detectExamFromTitle(paperTitle, subject);
        const year = p.year || yearKey;
        (p.pdfs || []).forEach((pdf, idx) => {
          if (!pdf || !pdf.url) return;
          const id = `doe_${p.id}_${pdf.medium || "M"}_${idx}`;
          index.set(id, {
            id,
            title: subject,
            subtitle: paperTitle,
            subject,
            exam,
            year,
            medium: pdf.medium || "English",
            url: pdf.url,
            filename: pdf.filename || `${subject}-${year}.pdf`,
          });
        });
      });
    }
  }
  PAPER_INDEX = index;
  return index;
}

let cachedWatermarkBytes = null;
async function getWatermarkBytes() {
  if (cachedWatermarkBytes) return cachedWatermarkBytes;
  const res = await fetch(WATERMARK_URL);
  if (!res.ok) throw new Error("Could not fetch watermark image");
  const buf = Buffer.from(await res.arrayBuffer());
  cachedWatermarkBytes = buf;
  return buf;
}

function safeFilename(name) {
  return (
    String(name || "paper")
      .replace(/[\\/:*?"<>|]+/g, "")
      .trim()
      .slice(0, 150) || "paper"
  );
}

exports.handler = async (event) => {
  try {
    const id = (event.queryStringParameters && event.queryStringParameters.id) || "";
    if (!id) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing ?id=" }) };
    }

    const index = buildIndex();
    const paper = index.get(String(id));
    if (!paper) {
      return { statusCode: 404, body: JSON.stringify({ error: "Paper not found" }) };
    }

    // 1. Fetch the ORIGINAL pdf server-side — no CORS restriction here
    const pdfRes = await fetch(paper.url);
    if (!pdfRes.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "Could not fetch the original PDF" }) };
    }
    const originalBytes = Buffer.from(await pdfRes.arrayBuffer());

    const filename = safeFilename(`${paper.title} - ${paper.year} - ${paper.medium}.pdf`).replace(
      /\.pdf\.pdf$/i,
      ".pdf"
    );

    // 2. Try to stamp a watermark on every page
    let finalBytes = originalBytes;
    try {
      const watermarkBytes = await getWatermarkBytes();
      const pdfDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
      const pngImage = await pdfDoc.embedPng(watermarkBytes);
      const pages = pdfDoc.getPages();

      pages.forEach((page) => {
        const { width, height } = page.getSize();
        const wmWidth = width * 0.5;
        const wmHeight = wmWidth * (pngImage.height / pngImage.width);

        page.drawImage(pngImage, {
          x: (width - wmWidth) / 2,
          y: (height - wmHeight) / 2,
          width: wmWidth,
          height: wmHeight,
          opacity: 0.18,
          rotate: degrees(30),
        });
      });

      finalBytes = Buffer.from(await pdfDoc.save());
    } catch (wmErr) {
      // Watermarking failed (unusual/encrypted PDF) — still serve the real
      // file from our own domain instead of failing the whole download.
      console.error("Watermarking failed, sending original file instead:", wmErr);
      finalBytes = originalBytes;
    }

    // 3. Netlify Functions cap the response body (~6MB, less once base64
    //    encoded). If the file is too big to proxy, tell the client so it
    //    can fall back to opening the original link directly instead of
    //    getting a broken/truncated download.
    if (finalBytes.length > MAX_SAFE_BYTES) {
      return {
        statusCode: 413,
        body: JSON.stringify({
          error: "File too large to proxy through this function",
          originalUrl: paper.url,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
      body: finalBytes.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error("Download proxy error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Download failed" }) };
  }
};
