/**
 * pdfGenerator.cjs
 * Contains common logic to generate PDF from HTML using Edge/Chrome headless.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BROWSER_PATH = process.env.PDF_BROWSER_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PDF_DIR = path.join(__dirname, '..', '..', 'pdfs');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

/**
 * Generates a PDF file from the given HTML content.
 * 
 * @param {string} htmlContent The HTML content to render
 * @param {string} finalPdfPath The absolute path where the PDF should be saved
 * @returns {boolean} True if successful, false otherwise
 */
function generatePdfFromHtml(htmlContent, finalPdfPath) {
  const tempHtmlPath = finalPdfPath.replace('.pdf', '_temp.html');
  try {
    fs.writeFileSync(tempHtmlPath, htmlContent, 'utf-8');
    execFileSync(BROWSER_PATH, [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-logging",
      "--log-level=3",
      "--print-to-pdf=" + finalPdfPath,
      "--print-to-pdf-no-header",
      "--no-margins",
      tempHtmlPath
    ], { stdio: 'pipe' });
    return true;
  } catch (err) {
    console.error('[PDF Export Exception]', err.message);
    return false;
  } finally {
    try {
      if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

module.exports = {
  generatePdfFromHtml,
  BROWSER_PATH,
  PDF_DIR
};
