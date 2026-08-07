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
  postJson,
  isWithinScheduleWindow,
  getTallySelectedCompany,
  exportVoucherAsPdf,
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
async function syncAndPushSO(queryDate) {
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
    const soRows = flattenVouchers(parseVouchers(soXml));

    // 2b. Generate and attach voucher PDFs (using unique caching per GUID)
    const pdfCache = {};
    for (const row of soRows) {
      if (row.guid && !pdfCache[row.guid]) {
        console.log(`[SO PDF Export] Generating PDF for Sales Order: ${row.orderno} (${row.guid})...`);
        const pdfBase64 = await exportVoucherAsPdf(row.guid, selectedCompany.name);
        if (pdfBase64) {
          const approxSizeBytes = Math.round(pdfBase64.length * 0.75);
          const sizeKb = (approxSizeBytes / 1024).toFixed(2);
          console.log(`   ✅ PDF generated: "${row.orderno}.pdf", Size: ${sizeKb} KB (${approxSizeBytes} bytes)`);
        } else {
          console.warn(`   ❌ PDF generation failed for: "${row.orderno}.pdf"`);
        }
        pdfCache[row.guid] = pdfBase64 || null;
      }
      row.voucherPdfBase64 = row.guid ? pdfCache[row.guid] : null;
    }

    const result = {
      // company: selectedCompany.name,
      // date: displayDate,
      salesOrders: soRows
    };

    // 3. Change Detection
    const newHash = hashJson(result);
    const previous = loadLastSnapshot(TYPE, queryDate);

    if (previous && previous.hash === newHash) {
      console.log(`[Sales Orders Sync] No change in data for ${displayDate}. Skipping push.`);
      return { status: 'unchanged', date: displayDate, data: result };
    }

    console.log(`[Sales Orders Sync] Data changed (or first run) for ${displayDate}. Pushing to API...`);

    // 4. Push to API
    const pushResponse = await postJson(PUSH_API_URL, result);
    console.log(`[Sales Orders API] Status: ${pushResponse.statusCode}`);

    if (pushResponse.statusCode >= 200 && pushResponse.statusCode < 300) {
      saveSnapshot(TYPE, queryDate, newHash, result);
      return { status: 'pushed', date: displayDate, apiStatus: pushResponse.statusCode, data: result };
    } else {
      console.error(`[Sales Orders API] Non-success response: ${pushResponse.statusCode} - ${pushResponse.body}`);
      return { status: 'push_failed', date: displayDate, apiStatus: pushResponse.statusCode, body: pushResponse.body };
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
  console.log('🚀 Running Sales Orders Sync standalone...');
  startScheduler();
}

module.exports = {
  syncAndPushSO,
  startSchedulerSO: startScheduler
};
