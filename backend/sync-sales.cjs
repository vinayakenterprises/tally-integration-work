const {
  TALLY_URL,
  getEffectiveQueryDate,
  isWithinScheduleWindow,
  getTallySelectedCompany,
  fetchFromTallyWithRetry,
  injectCompanyInXml,
  SCHEDULE_INTERVAL_MS,
  SCHEDULE_START_HOUR,
  SCHEDULE_START_MIN,
  SCHEDULE_END_HOUR,
  SCHEDULE_END_MIN
} = require('./tallyCore.cjs');

const {
  hashJson,
  loadLastSnapshot,
  saveSnapshot,
  saveOutgoingJson
} = require('./utils/syncState.cjs');

const {
  SALES_INVOICE_XML,
  parseSalesVouchers
} = require('./tallySalesCore.cjs');

const axios = require('axios');

// ============================================================
// CONFIGURATION
// ============================================================
const PUSH_API_URL = `${process.env.API_BASE_URL_LOCAL || 'http://vl6966bh-3000.inc1.devtunnels.ms'}/api/v1/o2d/invoice-details-from-tally`;
const TYPE = 'sales';

/**
 * Main routine: Fetch Sales Invoices, parse, and push to API.
 */
async function syncAndPushSales(queryDate) {
  const displayDate = `${queryDate.slice(0, 4)}-${queryDate.slice(4, 6)}-${queryDate.slice(6, 8)}`;

  try {
    // 1. Ensure we are connected to the correct company
    const selectedCompany = await getTallySelectedCompany();
    if (!selectedCompany) {
      console.error('[Sales Sync Error] Could not determine Tally company or no company open.');
      return { status: 'error', reason: 'no_company' };
    }

    console.log(`[Sales Sync] Using Company: ${selectedCompany.name}`);

    // 2. Fetch Sales Invoices
    const xmlPayload = injectCompanyInXml(SALES_INVOICE_XML, selectedCompany.name, queryDate, queryDate);

    console.log(`[Sales Sync] Fetching Sales Invoices for ${displayDate}...`);
    const xmlResponse = await fetchFromTallyWithRetry(xmlPayload);
    require('fs').writeFileSync('scratch_sales_today.xml', xmlResponse);
    require('fs').writeFileSync('scratch_sales_20260414.xml', xmlResponse);

    // 3. Parse Sales Invoices
    const vouchers = parseSalesVouchers(xmlResponse, selectedCompany);
    
    // 3b. Filter out required fields for the API
    const simplifiedPayload = vouchers.map(v => {
      // Convert Tally date "YYYYMMDD" to "YYYY-MM-DD"
      let dateStr = v.invoiceInfo.invoiceDate || "";
      if (dateStr.length === 8) {
        dateStr = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
      }

      return {
        actual_dispatch_date: dateStr,
        invoice_number: v.invoiceInfo.invoiceNo || "",
        quantity: v.totals.totalQuantity || 0,
        total_invoice_amount: v.totals.totalInvoiceAmount || 0
      };
    });
    
    const result = simplifiedPayload;

    saveOutgoingJson(TYPE, queryDate, result);

    const newHash = hashJson(result);
    const previous = loadLastSnapshot(TYPE, queryDate);

    if (previous && previous.hash === newHash) {
      console.log(`[Sales Sync] No changes detected for ${displayDate}. Skipping push.`);
      return { status: 'unchanged', date: displayDate };
    }

    console.log(`[Sales Sync] Data changed (or first run) for ${displayDate}. Pushing JSON to API...`);

    // 4. Push to API as JSON (One by one)
    let allSuccess = true;
    let anySuccess = false;
    
    for (const invoice of result) {
      try {
        console.log(`[Sales API] Pushing Invoice ${invoice.invoice_number}...`);
        const pushResponse = await axios.post(PUSH_API_URL, invoice, {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 30000
        });

        if (pushResponse.status >= 200 && pushResponse.status < 300) {
          console.log(`[Sales API] Success! Status: ${pushResponse.status} OK`);
          anySuccess = true;
        } else {
          allSuccess = false;
          console.error(`[Sales API] Non-success response for ${invoice.invoice_number}: ${pushResponse.status}`);
        }
      } catch (err) {
        allSuccess = false;
        console.error(`[Sales Sync Error] Push failed for ${invoice.invoice_number}: ${err.message}`);
        if (err.response) {
          console.error(`[Sales API Error Response] ${err.response.status} -`, err.response.data);
        }
      }
    }

    if (allSuccess) {
      saveSnapshot(TYPE, queryDate, newHash, result);
      return { status: 'pushed', date: displayDate, data: result };
    } else if (anySuccess) {
      saveSnapshot(TYPE, queryDate, newHash, result); // partial success
      return { status: 'partial_pushed', date: displayDate };
    } else {
      return { status: 'push_failed', date: displayDate };
    }
  } catch (err) {
    console.error(`[Sales Sync Error] Sync failed: ${err.message}`);
    if (err.response) {
      console.error(`[Sales API Error Response] ${err.response.status} -`, err.response.data);
    }
    return { status: 'error', date: displayDate, error: err.message };
  }
}

// ============================================================
// SCHEDULER LOGIC
// ============================================================
function runScheduler() {
  console.log(`[Sales Scheduler] Started. Polling every ${SCHEDULE_INTERVAL_MS / 1000}s`);

  const tick = async () => {
    if (!isWithinScheduleWindow()) {
      console.log('[Sales Scheduler] Outside active window. Sleeping...');
      return;
    }

    try {
      const today = getEffectiveQueryDate();
      console.log(`\n[Sales Scheduler] Running sync for ${today} at ${new Date().toLocaleTimeString()}...`);
      await syncAndPushSales(today);
    } catch (e) {
      console.error('[Sales Scheduler] Unhandled error during poll:', e);
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
    console.log(`[Sales Sync] Running one-time sync for custom date: ${cliDate}`);
    syncAndPushSales(cliDate).then((outcome) => {
      console.log(`[Sales Sync] One-time sync completed. Status: ${outcome.status}`);
      process.exit(outcome.status === 'error' || outcome.status === 'push_failed' ? 1 : 0);
    });
  } else {
    runScheduler();
  }
}

module.exports = { syncAndPushSales };
