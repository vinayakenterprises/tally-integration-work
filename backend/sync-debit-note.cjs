const {
  getEffectiveQueryDate,
  isWithinScheduleWindow,
  getTallySelectedCompany,
  fetchFromTallyWithRetry,
  injectCompanyInXml,
  SCHEDULE_INTERVAL_MS,
  postMultipartData,
  BANK_LEDGERS_XML,
  parseBankLedgers
} = require('./tallyCore.cjs');

const {
  hashJson,
  loadLastSnapshot,
  saveSnapshot,
  saveOutgoingJson
} = require('./utils/syncState.cjs');

const {
  DEBIT_NOTE_XML,
  parseDebitNoteVouchers,
  exportDebitNoteAsPdf
} = require('./tallyDebitNoteCore.cjs');

const fs = require('fs');

// CONFIGURATION
// ============================================================
const PUSH_API_URL = `${process.env.API_BASE_URL_LOCAL || 'http://vl6966bh-3000.inc1.devtunnels.ms'}/api/v1/o2d/get-credit-debit-note-from-tally`;
const TYPE = 'debit_note';

/**
 * Main routine: Fetch Debit Notes, generate PDFs, and push to API.
 */
async function syncAndPushDebitNotes(queryDate) {
  const displayDate = `${queryDate.slice(0, 4)}-${queryDate.slice(4, 6)}-${queryDate.slice(6, 8)}`;

  try {
    // 1. Ensure we are connected to the correct company
    const selectedCompany = await getTallySelectedCompany();
    if (!selectedCompany) {
      console.error('[Debit Note Sync Error] Could not determine Tally company or no company open.');
      return { status: 'error', reason: 'no_company' };
    }

    console.log(`[Debit Note Sync] Using Company: ${selectedCompany.name}`);

    // 2. Fetch Debit Notes
    const xmlPayload = injectCompanyInXml(DEBIT_NOTE_XML, selectedCompany.name, queryDate, queryDate);

    console.log(`[Debit Note Sync] Fetching Debit Notes for ${displayDate}...`);
    const xmlResponse = await fetchFromTallyWithRetry(xmlPayload);

    // 3. Parse Debit Notes
    const vouchers = parseDebitNoteVouchers(xmlResponse, selectedCompany);

    // Check if anything changed
    const resultJson = vouchers;
    saveOutgoingJson(TYPE, queryDate, resultJson);

    const newHash = hashJson(resultJson);
    const previous = loadLastSnapshot(TYPE, queryDate);

    if (previous && previous.hash === newHash) {
      console.log(`[Debit Note Sync] No changes detected for ${displayDate}. Skipping push.`);
      return { status: 'unchanged', date: displayDate };
    }

    console.log(`[Debit Note Sync] Data changed (or first run) for ${displayDate}. Generating PDFs and pushing to API...`);

    // 4. Fetch Bank Details
    let bankDetails = null;
    try {
      const bankXml = await fetchFromTallyWithRetry(BANK_LEDGERS_XML);
      const banks = parseBankLedgers(bankXml);
      if (banks && banks.length > 0) {
        bankDetails = banks[0];
      }
    } catch (err) {
      console.warn(`[Debit Note PDF Export] Could not fetch bank ledgers: ${err.message}`);
    }

    // 5. Generate PDFs for all Debit Notes locally
    for (const v of vouchers) {
      console.log(`[Debit Note PDF Export] Generating PDF for Debit Note: ${v.voucher_info.voucher_number}...`);
      const pdfPath = await exportDebitNoteAsPdf(v, selectedCompany, bankDetails);
      if (pdfPath) {
        v.pdf_path = pdfPath; // Store local path temporarily for pushing
      }
    }

    // 5. Push to API (Multipart to include JSON and PDF file)
    let allSuccess = true;
    let anySuccess = false;

    for (const cn of vouchers) {
      try {
        console.log(`[Debit Note API] Pushing Debit Note ${cn.voucher_info.voucher_number}...`);

        // Skip actual push if dummy URL is provided
        if (PUSH_API_URL === 'abc-debit-note' || !PUSH_API_URL.startsWith('http')) {
          console.log(`[Debit Note API] Dummy URL configured ('${PUSH_API_URL}'). Simulating success.`);
          anySuccess = true;
          continue;
        }

        const FormData = require('form-data');
        const form = new FormData();
        form.append('document_type', 'Debit Note');
        form.append('credit_debit_note_number', cn.voucher_info.voucher_number);
        form.append('credit_debit_note_amount', cn.totals.total_amount.toString());
        form.append('credit_debit_note_quantity', cn.totals.total_quantity.toString());

        if (cn.pdf_path && fs.existsSync(cn.pdf_path)) {
          form.append('pdf-file', fs.createReadStream(cn.pdf_path), { filename: require('path').basename(cn.pdf_path) });
        }

        const pushResponse = await require('axios').post(PUSH_API_URL, form, {
          headers: { ...form.getHeaders() },
          timeout: 30000
        });

        if (pushResponse && pushResponse.status >= 200 && pushResponse.status < 300) {
          console.log(`[Debit Note API] Success! Status: ${pushResponse.status} OK`);
          anySuccess = true;
        } else {
          allSuccess = false;
          console.error(`[Debit Note API] Non-success response for ${cn.voucher_info.voucher_number}`);
        }
      } catch (err) {
        allSuccess = false;
        console.error(`[Debit Note Sync Error] Push failed for ${cn.voucher_info.voucher_number}: ${err.message}`);
      }
    }

    if (allSuccess) {
      saveSnapshot(TYPE, queryDate, newHash, resultJson);
      return { status: 'pushed', date: displayDate, data: resultJson };
    } else if (anySuccess) {
      saveSnapshot(TYPE, queryDate, newHash, resultJson); // partial success
      return { status: 'partial_pushed', date: displayDate };
    } else {
      return { status: 'push_failed', date: displayDate };
    }
  } catch (err) {
    console.error(`[Debit Note Sync Error] Sync failed: ${err.stack}`);
    return { status: 'error', date: displayDate, error: err.message };
  }
}

// ============================================================
// SCHEDULER LOGIC
// ============================================================
function runScheduler() {
  console.log(`[Debit Note Scheduler] Started. Polling every ${SCHEDULE_INTERVAL_MS / 1000}s`);

  const tick = async () => {
    if (!isWithinScheduleWindow()) {
      console.log('[Debit Note Scheduler] Outside active window. Sleeping...');
      return;
    }

    try {
      const today = getEffectiveQueryDate();
      console.log(`\n[Debit Note Scheduler] Running sync for ${today} at ${new Date().toLocaleTimeString()}...`);
      await syncAndPushDebitNotes(today);
    } catch (e) {
      console.error('[Debit Note Scheduler] Unhandled error during poll:', e);
    }
  };

  tick();
  setInterval(tick, SCHEDULE_INTERVAL_MS);
}

// ============================================================
// CLI ENTRY POINT
// ============================================================
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args[0] === 'daemon' || args[0] === 'serve' || args[0] === 'schedule') {
    runScheduler();
  } else if (args[0]) {
    const cliDate = args[0].replace(/-/g, '');
    if (cliDate.length !== 8) {
      console.error(`❌ Invalid date format: "${args[0]}". Please use YYYYMMDD or YYYY-MM-DD.`);
      process.exit(1);
    }
    console.log(`[Debit Note Sync] Running one-time sync for custom date: ${cliDate}`);
    syncAndPushDebitNotes(cliDate).then((outcome) => {
      console.log(`[Debit Note Sync] One-time sync completed. Status: ${outcome.status}`);
      process.exit(outcome.status === 'error' || outcome.status === 'push_failed' ? 1 : 0);
    });
  } else {
    runScheduler();
  }
}

module.exports = { syncAndPushDebitNotes };
