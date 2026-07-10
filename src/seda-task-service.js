import config from './config.js';
import {
  isDatabaseAvailable,
  getReceivedEmailById,
  getReceivedEmailByEmailId,
  getReceivedEmailsSince,
  createSedaPendingTask,
  getSedaTaskById,
  getSedaTasks,
  getSedaTaskStats,
  claimNextSedaTask,
  completeSedaTask,
  deferSedaTask,
  retrySedaTask,
} from './database.js';
import {
  classifySedaApprovalEmail,
  parseSedaApprovalEmail,
} from './seda-email-parser.js';

const TASK_TYPE = 'SEDA_ATAP_APPROVAL';
const DEFAULT_API_URL = 'https://admin.atap.solar/api/v1/seda/status';
const DEFAULT_RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

let workerTimer = null;
let workerBusy = false;

function getSedaApiUrl() {
  return config.SEDA_STATUS_API_URL || DEFAULT_API_URL;
}

function getRetryDelay(attemptCount) {
  const exponent = Math.max(0, Number(attemptCount || 1) - 1);
  return Math.min(DEFAULT_RETRY_DELAY_MS * (2 ** exponent), MAX_RETRY_DELAY_MS);
}

function serializeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function compactTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    task_type: task.task_type,
    source_email_id: task.source_email_id,
    status: task.status,
    requires_manual_review: task.requires_manual_review,
    customer_name: task.customer_name,
    installation_address: task.installation_address,
    application_number: task.application_number,
    attempt_count: task.attempt_count,
    next_retry_at: task.next_retry_at,
    last_error: task.last_error,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at,
  };
}

export async function enqueueSedaTaskForReceivedEmail(email) {
  if (!isDatabaseAvailable()) {
    throw new Error('Database not available');
  }

  const classification = classifySedaApprovalEmail(email);
  if (!classification.matched) {
    return {
      matched: false,
      classification,
      task: null,
    };
  }

  const parsed = parseSedaApprovalEmail(email);
  const requiresManualReview = !parsed.customerName || !parsed.installationAddress;
  const payload = {
    name: parsed.customerName || null,
    address: parsed.installationAddress || null,
    status: 'Approved',
    dry_run: config.SEDA_STATUS_DRY_RUN,
    name_candidates: parsed.nameCandidates,
    application_number: parsed.applicationNumber || null,
  };

  const taskResult = await createSedaPendingTask({
    taskType: TASK_TYPE,
    sourceReceivedEmailId: email.id,
    sourceEmailId: email.email_id,
    customerName: parsed.customerName || null,
    installationAddress: parsed.installationAddress || null,
    applicationNumber: parsed.applicationNumber || null,
    payload,
    requiresManualReview,
    initialError: requiresManualReview
      ? 'Could not extract customer name and installation address'
      : null,
  });

  return {
    matched: true,
    classification,
    parsed,
    created: taskResult.created,
    task: compactTask(taskResult.task),
  };
}

export async function enqueueSedaTaskForReceivedEmailId(reference) {
  const email = /^\d+$/.test(String(reference))
    ? await getReceivedEmailById(Number(reference))
    : await getReceivedEmailByEmailId(reference);

  if (!email) {
    const error = new Error('Received email not found');
    error.status = 404;
    throw error;
  }

  return enqueueSedaTaskForReceivedEmail(email);
}

export async function scanReceivedEmailsForSedaTasks({ sinceDays = 7, domain = null, limit = 500 } = {}) {
  if (!isDatabaseAvailable()) {
    throw new Error('Database not available');
  }

  const days = Number(sinceDays);
  if (!Number.isFinite(days) || days <= 0) {
    const error = new Error('sinceDays must be a positive number');
    error.status = 400;
    throw error;
  }

  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const emails = await getReceivedEmailsSince({ sinceDate, domain, limit });

  const matches = [];
  let matched = 0;
  let created = 0;

  for (const email of emails) {
    const result = await enqueueSedaTaskForReceivedEmail(email);
    if (result.matched) {
      matched += 1;
      if (result.created) created += 1;
      matches.push({
        sourceEmailId: email.email_id,
        created: result.created,
        task: result.task,
      });
    }
  }

  return {
    sinceDate: sinceDate.toISOString(),
    scanned: emails.length,
    matched,
    created,
    tasks: matches,
  };
}

async function requestSedaStatus(payload) {
  if (!config.SEDA_API_KEY) {
    const error = new Error('SEDA_API_KEY is not configured');
    error.code = 'SEDA_API_KEY_MISSING';
    error.manualReview = true;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(getSedaApiUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.SEDA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseText = await response.text();
    let body;
    try {
      body = responseText ? JSON.parse(responseText) : {};
    } catch {
      body = { raw: responseText };
    }

    return {
      httpStatus: response.status,
      body,
      request: payload,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isSuccessfulUpdate(result) {
  return result?.body?.success === true && result?.body?.updated === true;
}

function shouldRetry(result) {
  return !result || result.httpStatus === 408 || result.httpStatus === 425 ||
    result.httpStatus === 429 || result.httpStatus >= 500;
}

function requiresManualReview(result) {
  return result?.httpStatus === 401 || result?.httpStatus === 403 ||
    result?.httpStatus === 404 || result?.httpStatus === 409;
}

async function processClaimedSedaTask(task) {
  if (!task.customer_name || !task.installation_address) {
    await deferSedaTask(task.id, {
      requiresManualReview: true,
      lastError: 'Customer name or installation address is missing',
      apiAttempts: [],
      nextRetryAt: null,
    });
    return { status: 'manual_review', taskId: task.id };
  }

  const nameCandidates = Array.isArray(task.payload?.name_candidates) &&
    task.payload.name_candidates.length > 0
    ? task.payload.name_candidates
    : [task.customer_name];

  const attempts = [];
  let lastResult = null;

  for (const candidateName of [...new Set(nameCandidates)]) {
    const payload = {
      name: candidateName,
      address: task.installation_address,
      status: 'Approved',
      dry_run: config.SEDA_STATUS_DRY_RUN,
    };

    try {
      const result = await requestSedaStatus(payload);
      lastResult = result;
      attempts.push(result);

      if (isSuccessfulUpdate(result)) {
        await completeSedaTask(task.id, {
          apiRequest: payload,
          apiResponse: result.body,
          apiAttempts: attempts,
        });
        return { status: 'completed', taskId: task.id, response: result.body };
      }

      if (result.body?.success === true && result.body?.dry_run === true) {
        await deferSedaTask(task.id, {
          requiresManualReview: true,
          lastError: 'SEDA API dry-run matched but did not update the record',
          nextRetryAt: null,
          apiRequest: payload,
          apiResponse: result.body,
          apiAttempts: attempts,
        });
        return { status: 'dry_run', taskId: task.id, response: result.body };
      }

      if (result.httpStatus === 404) {
        continue;
      }

      if (requiresManualReview(result)) {
        await deferSedaTask(task.id, {
          requiresManualReview: true,
          lastError: result.body?.error || `SEDA API returned HTTP ${result.httpStatus}`,
          nextRetryAt: null,
          apiRequest: payload,
          apiResponse: result.body,
          apiAttempts: attempts,
        });
        return { status: 'manual_review', taskId: task.id, response: result.body };
      }

      if (shouldRetry(result)) {
        const nextRetryAt = new Date(Date.now() + getRetryDelay(task.attempt_count));
        await deferSedaTask(task.id, {
          requiresManualReview: false,
          lastError: result.body?.error || `SEDA API returned HTTP ${result.httpStatus}`,
          nextRetryAt,
          apiRequest: payload,
          apiResponse: result.body,
          apiAttempts: attempts,
        });
        return { status: 'retry', taskId: task.id, response: result.body };
      }

      await deferSedaTask(task.id, {
        requiresManualReview: true,
        lastError: result.body?.error || `SEDA API returned HTTP ${result.httpStatus}`,
        nextRetryAt: null,
        apiRequest: payload,
        apiResponse: result.body,
        apiAttempts: attempts,
      });
      return { status: 'manual_review', taskId: task.id, response: result.body };
    } catch (error) {
      const message = serializeError(error);
      if (error.code === 'SEDA_API_KEY_MISSING') {
        await deferSedaTask(task.id, {
          requiresManualReview: true,
          lastError: message,
          nextRetryAt: null,
          apiRequest: payload,
          apiResponse: null,
          apiAttempts: attempts,
        });
        return { status: 'manual_review', taskId: task.id, error: message };
      }

      const nextRetryAt = new Date(Date.now() + getRetryDelay(task.attempt_count));
      await deferSedaTask(task.id, {
        requiresManualReview: false,
        lastError: message,
        nextRetryAt,
        apiRequest: payload,
        apiResponse: lastResult?.body || null,
        apiAttempts: attempts,
      });
      return { status: 'retry', taskId: task.id, error: message };
    }
  }

  await deferSedaTask(task.id, {
    requiresManualReview: true,
    lastError: lastResult?.body?.error || 'No SEDA registration matched any safe name candidate',
    nextRetryAt: null,
    apiRequest: lastResult?.request || null,
    apiResponse: lastResult?.body || null,
    apiAttempts: attempts,
  });
  return {
    status: 'manual_review',
    taskId: task.id,
    response: lastResult?.body || null,
  };
}

export async function processNextSedaTask() {
  if (!isDatabaseAvailable()) return null;

  const task = await claimNextSedaTask();
  if (!task) return null;

  try {
    return await processClaimedSedaTask(task);
  } catch (error) {
    const message = serializeError(error);
    const nextRetryAt = new Date(Date.now() + getRetryDelay(task.attempt_count));
    await deferSedaTask(task.id, {
      requiresManualReview: false,
      lastError: message,
      nextRetryAt,
      apiAttempts: [],
    });
    return { status: 'retry', taskId: task.id, error: message };
  }
}

export async function processSedaTaskById(taskId) {
  const task = await getSedaTaskById(taskId);
  if (!task) {
    const error = new Error('SEDA task not found');
    error.status = 404;
    throw error;
  }

  if (task.status === 'COMPLETED') {
    return { status: 'completed', taskId: task.id, task: compactTask(task) };
  }

  await retrySedaTask(task.id);
  return processNextSedaTask();
}

export async function retrySedaTaskById(taskId) {
  const task = await getSedaTaskById(taskId);
  if (!task) {
    const error = new Error('SEDA task not found');
    error.status = 404;
    throw error;
  }

  const retried = await retrySedaTask(task.id);
  return compactTask(retried);
}

export function startSedaTaskWorker() {
  if (workerTimer) return stopSedaTaskWorker;

  const intervalMs = config.SEDA_TASK_WORKER_INTERVAL_MS;
  const tick = async () => {
    if (workerBusy || !isDatabaseAvailable()) return;
    workerBusy = true;
    try {
      const result = await processNextSedaTask();
      if (result) {
        console.log(`📌 SEDA task worker: ${JSON.stringify({
          taskId: result.taskId,
          status: result.status,
        })}`);
      }
    } catch (error) {
      console.error('❌ SEDA task worker error:', error.message);
    } finally {
      workerBusy = false;
    }
  };

  void tick();
  workerTimer = setInterval(() => void tick(), intervalMs);
  workerTimer.unref?.();
  return stopSedaTaskWorker;
}

export function stopSedaTaskWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

export {
  TASK_TYPE,
  getSedaTasks,
  getSedaTaskById,
  getSedaTaskStats,
};
