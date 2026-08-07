const {
  TALLY_URL,
  PURCHASE_ORDERS_XML,
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
  SCHEDULE_INTERVAL_MS,
  SCHEDULE_START_HOUR,
  SCHEDULE_START_MIN,
  SCHEDULE_END_HOUR,
  SCHEDULE_END_MIN
} = require('./tallyCore.cjs');

// ============================================================
// CONFIGURATION
// ============================================================
const PUSH_API_URL = 'https://api.mittalu.com/api/v1/o2d/po-orders-from-tally'; // Replace with your PO API endpoint
const TYPE = 'po';

/**
 * Syncs Purchase Orders for a specific date from Tally and pushes them to PUSH_API_URL if changed.
 */
async function syncAndPushPO(queryDate) {
  const displayDate = `${queryDate.slice(0, 4)}-${queryDate.slice(4, 6)}-${queryDate.slice(6, 8)}`;

  try {
    // 1. Get open company
    const selectedCompany = await getTallySelectedCompany();
    if (!selectedCompany) {
      return { status: 'error', message: 'Tally connection or company selection failed', date: displayDate };
    }

    // 2. Fetch Purchase Orders
    const poPayload = injectCompanyInXml(PURCHASE_ORDERS_XML, selectedCompany.name, queryDate, queryDate);
    const poXml = await fetchFromTallyWithRetry(poPayload);
    const poRows = flattenVouchers(parseVouchers(poXml));

    const result = {
      // company: selectedCompany.name,
      // date: displayDate,
      purchaseOrders: poRows
    };

    // 3. Change Detection
    const newHash = hashJson(result);
    const previous = loadLastSnapshot(TYPE, queryDate);

    if (previous && previous.hash === newHash) {
      console.log(`[Purchase Orders Sync] No change in data for ${displayDate}. Skipping push.`);
      return { status: 'unchanged', date: displayDate, data: result };
    }

    console.log(`[Purchase Orders Sync] Data changed (or first run) for ${displayDate}. Pushing to API...`);

    // 4. Push to API
    const pushResponse = await postJson(PUSH_API_URL, result);
    console.log(`[Purchase Orders API] Status: ${pushResponse.statusCode}`);

    if (pushResponse.statusCode >= 200 && pushResponse.statusCode < 300) {
      saveSnapshot(TYPE, queryDate, newHash, result);
      return { status: 'pushed', date: displayDate, apiStatus: pushResponse.statusCode, data: result };
    } else {
      console.error(`[Purchase Orders API] Non-success response: ${pushResponse.statusCode} - ${pushResponse.body}`);
      return { status: 'push_failed', date: displayDate, apiStatus: pushResponse.statusCode, body: pushResponse.body };
    }
  } catch (err) {
    console.error(`[Purchase Orders Sync Error] Sync failed: ${err.message}`);
    return { status: 'error', error: err.message, date: displayDate };
  }
}

// ============================================================
// SCHEDULER
// ============================================================
async function schedulerTick() {
  const now = new Date();
  if (!isWithinScheduleWindow(now)) {
    console.log(`[PO Scheduler] ${now.toLocaleTimeString()} is outside the active window. Skipping.`);
    return;
  }
  const queryDate = getEffectiveQueryDate();
  console.log(`\n[PO Scheduler] Running sync for ${queryDate} at ${now.toLocaleTimeString()}...`);
  await syncAndPushPO(queryDate);
}

function startScheduler() {
  schedulerTick();
  setInterval(schedulerTick, SCHEDULE_INTERVAL_MS);
  console.log(`[PO Scheduler] Started. Checking every ${SCHEDULE_INTERVAL_MS / 60000} min(s), window ${SCHEDULE_START_HOUR}:${String(SCHEDULE_START_MIN).padStart(2, '0')}–${SCHEDULE_END_HOUR}:${String(SCHEDULE_END_MIN).padStart(2, '0')}.`);
}

// Automatically start scheduler if this script is executed directly
if (require.main === module) {
  console.log('🚀 Running Purchase Orders Sync standalone...');
  startScheduler();
}

module.exports = {
  syncAndPushPO,
  startSchedulerPO: startScheduler
};
