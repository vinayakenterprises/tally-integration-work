const {
  TALLY_URL,
  SALES_ORDERS_XML,
  injectCompanyInXml,
  parseVouchers,
  flattenVouchers,
  fetchFromTallyWithRetry,
  getEffectiveQueryDate,
  hashJson,
  loadLastSnapshot,
  saveSnapshot,
  saveOutgoingJson,
  postMultipartData,
  isWithinScheduleWindow,
  getTallySelectedCompany,
  exportSalesOrderAsPdf,
  SCHEDULE_INTERVAL_MS,
  SCHEDULE_START_HOUR,
  SCHEDULE_START_MIN,
  SCHEDULE_END_HOUR,
  SCHEDULE_END_MIN
} = require('./tallyCore.cjs');

// ============================================================
// CONFIGURATION
// ============================================================
const PUSH_API_URL = 'https://vl6966bh-3000.inc1.devtunnels.ms/api/v1/o2d/so-orders-from-tally';
const TYPE = 'so';

/**
 * Syncs Sales Orders for a specific date from Tally and pushes them to PUSH_API_URL if changed.
 */
async function syncAndPushSO(queryDate, testSuffix) {
  const displayDate = `${queryDate.slice(0, 4)}-${queryDate.slice(4, 6)}-${queryDate.slice(6, 8)}`;

  try {
    // 1. Get open company
    const selectedCompany = await getTallySelectedCompany();
    if (!selectedCompany) {
      return { status: 'error', message: 'Tally connection or company selection failed', date: displayDate };
    }

    // 2. Fetch Sales Orders
    const soPayload = injectCompanyInXml(SALES_ORDERS_XML, selectedCompany.name, queryDate, queryDate);
    const soXml = await fetchFromTallyWithRetry(soPayload);
    const vouchers = parseVouchers(soXml);

    const pdfMap = {};

    // Generate PDFs for all Sales Orders locally
    for (const v of vouchers) {
      console.log(`[SO PDF Export] Generating PDF for Sales Order: ${v.vouchernumber} (${v.guid})...`);
      const pdfPath = await exportSalesOrderAsPdf(v, selectedCompany.name);
      if (pdfPath) {
        const sanitizedOrderNo = (v.vouchernumber || v.guid).replace(/[^a-zA-Z0-9-_]/g, '_').trim();
        const filename = `${sanitizedOrderNo}.pdf`;
        pdfMap[filename] = pdfPath;
      }
    }

    const soRows = flattenVouchers(vouchers);
    for (const row of soRows) {
      const sanitizedOrderNo = (row.orderno || row.guid).replace(/[^a-zA-Z0-9-_]/g, '_').trim();
      const filename = `${sanitizedOrderNo}.pdf`;
      if (pdfMap[filename]) {
        row.pdf = filename;
      }
    }

    // ------------------------------------------------------------------
    // TEST BLOCK: Append incrementing number to orderno for testing
    // To disable this test logic, just don't pass the 2nd argument in command line.
    if (testSuffix) {
      let currentSuffix = parseInt(testSuffix, 10);
      if (!isNaN(currentSuffix)) {
        for (const row of soRows) {
          row.orderno = `${row.orderno}/${currentSuffix}`;
          currentSuffix++;
        }
        console.log(`[Sales Orders Sync] Applied incrementing test suffixes starting from /${testSuffix} to Order Numbers.`);
      }
    }
    // ------------------------------------------------------------------

    const result = {
      salesOrders: soRows
    };

    const outgoingFile = saveOutgoingJson(TYPE, queryDate, result);
    console.log(`[Sales Orders Sync] JSON payload saved to ${outgoingFile}`);

    // 3. Change Detection
    const newHash = hashJson(result);
    const previous = loadLastSnapshot(TYPE, queryDate);

    if (previous && previous.hash === newHash) {
      console.log(`[Sales Orders Sync] No change in data for ${displayDate}. Skipping push.`);
      return { status: 'unchanged', date: displayDate, data: result };
    }

    console.log(`[Sales Orders Sync] Data changed (or first run) for ${displayDate}. Pushing JSON to API...`);

    // 4. Push to API one by one
    let allSuccess = true;
    let lastErrorStatus = null;
    let lastErrorBody = null;

    for (const row of soRows) {
      const singleOrderPayload = { salesOrders: [row] };
      const singlePdfMap = {};
      if (row.pdf && pdfMap[row.pdf]) {
        singlePdfMap[row.pdf] = pdfMap[row.pdf];
      }
      
      console.log(`[Sales Orders Sync] Pushing Order: ${row.orderno} to API...`);
      const pushResponse = await postMultipartData(PUSH_API_URL, singleOrderPayload, singlePdfMap);
      console.log(`[Sales Orders API] Order ${row.orderno} Status: ${pushResponse.statusCode}`);
      
      if (pushResponse.statusCode < 200 || pushResponse.statusCode >= 300) {
        console.error(`[Sales Orders API] Non-success response for ${row.orderno}: ${pushResponse.statusCode} - ${pushResponse.body}`);
        allSuccess = false;
        lastErrorStatus = pushResponse.statusCode;
        lastErrorBody = pushResponse.body;
      }
    }

    if (allSuccess) {
      saveSnapshot(TYPE, queryDate, newHash, result);
      return { status: 'pushed', date: displayDate, data: result };
    } else {
      return { status: 'push_failed', date: displayDate, apiStatus: lastErrorStatus, body: lastErrorBody };
    }
  } catch (err) {
    console.error(`[Sales Orders Sync Error] Sync failed: ${err.message}`);
    return { status: 'error', error: err.message, date: displayDate };
  }
}

// ============================================================
// SCHEDULER
// ============================================================
async function schedulerTick() {
  const now = new Date();
  if (!isWithinScheduleWindow(now)) {
    console.log(`[SO Scheduler] ${now.toLocaleTimeString()} is outside the active window. Skipping.`);
    return;
  }
  const queryDate = getEffectiveQueryDate();
  console.log(`\n[SO Scheduler] Running sync for ${queryDate} at ${now.toLocaleTimeString()}...`);
  await syncAndPushSO(queryDate);
}

function startScheduler() {
  schedulerTick();
  setInterval(schedulerTick, SCHEDULE_INTERVAL_MS);
  console.log(`[SO Scheduler] Started. Checking every ${SCHEDULE_INTERVAL_MS / 60000} min(s), window ${SCHEDULE_START_HOUR}:${String(SCHEDULE_START_MIN).padStart(2, '0')}–${SCHEDULE_END_HOUR}:${String(SCHEDULE_END_MIN).padStart(2, '0')}.`);
}

// Automatically start scheduler if this script is executed directly
if (require.main === module) {
  console.log("🚀 Running Sales Orders Sync standalone...");
  const args = process.argv.slice(2);
  const cliDate = args[0] ? args[0].replace(/-/g, '') : null;
  if (cliDate) {
    if (!/^\d{8}$/.test(cliDate)) {
      console.error(`❌ Invalid date format: "${args[0]}". Please use YYYYMMDD or YYYY-MM-DD.`);
      process.exit(1);
    }
    const testSuffix = args[1] || null;
    console.log(`[Sales Orders Sync] Running one-time sync for custom date: ${cliDate}`);
    syncAndPushSO(cliDate, testSuffix).then((outcome) => {
      console.log(`[Sales Orders Sync] One-time sync completed. Status: ${outcome.status}`);
      process.exit(outcome.status === 'error' || outcome.status === 'push_failed' ? 1 : 0);
    });
  } else {
    startScheduler();
  }
}
module.exports = {
  syncAndPushSO,
  startSchedulerSO: startScheduler
};
