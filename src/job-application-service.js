import config from './config.js';
import { sendEmail } from './email-service.js';
import {
  getHodDepartments,
  getHodDepartment,
  getJobApplicationByReceivedEmailId,
  saveJobApplication,
  updateJobApplication,
  savePipelineEvent,
} from './database.js';
import { sendWhatsAppMessage } from './whatsapp-client.js';

const CLASSIFICATIONS = new Set([
  'job_application',
  'uncertain',
  'not_job_application',
]);
const AI_REQUEST_TIMEOUT_MS = 15000;

async function logPipelineEvent(eventName, details = {}) {
  try {
    await savePipelineEvent({ eventName, ...details });
  } catch (err) {
    console.error('Pipeline event logging failed:', err.message);
  }
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsonObject(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('LLM did not return a JSON object');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeClassification(value) {
  const classification = String(value || '').toLowerCase().trim();
  return CLASSIFICATIONS.has(classification) ? classification : 'uncertain';
}

function applicationPrompt(email, hodDepartments = []) {
  const body = email.text
    || email.text_content
    || stripHtml(email.html || email.html_content);
  const availableDepartments = hodDepartments
    .filter(department => department?.is_active !== false && department?.department)
    .map(department => department.department);
  return `Classify and extract this inbound email for a recruitment mailbox.

Return JSON only with this exact shape:
{
  "classification": "job_application" | "uncertain" | "not_job_application",
  "confidence": 0,
  "reason": "short reason",
  "applicant": {
    "name": null,
    "email": null,
    "phone": null,
    "whatsapp_number": null,
    "position": null,
    "department": null,
    "years_experience": null,
    "location": null,
    "availability": [],
    "resume_summary": null
  }
}

Rules:
- A job application includes a CV/resume, employment history, job-seeking language, or a clear application for a role.
- An email asking about a vacancy but lacking enough information is "uncertain".
- Marketing, invoices, automated notices, and unrelated personal messages are "not_job_application".
- Use the sender email as applicant.email when the message does not provide another email.
- Choose applicant.department from this active HOD department list when the role, skills, or experience clearly match one of them: ${JSON.stringify(availableDepartments)}
- Return the exact department name from that list. Do not invent a department name.
- Use null only when the available list has no reasonable match.
- Never invent values. Use null or [] when missing.

Sender: ${email.from_email}
Recipient: ${email.to_email}
Subject: ${email.subject}
Attachments: ${JSON.stringify(email.attachments || [])}
Body:
${body.slice(0, 30000)}`;
}

function getAiConfig() {
  const values = {
    apiKey: config.AI_API_KEY,
    apiBaseUrl: config.AI_API_BASE_URL,
    model: config.AI_MODEL,
  };
  const missingConfig = [
    ['AI_API_KEY', values.apiKey],
    ['AI_API_BASE_URL', values.apiBaseUrl],
    ['AI_MODEL', values.model],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missingConfig.length > 0) {
    const error = new Error(`${missingConfig.join(', ')} must be configured`);
    error.code = 'AI_CONFIG_MISSING';
    error.status = 503;
    throw error;
  }
  return values;
}

async function callAiApi(body, { emailId = null } = {}) {
  const startedAt = Date.now();
  const { apiKey, apiBaseUrl, model } = getAiConfig();
  await logPipelineEvent('ai.request.started', {
    emailId,
    metadata: { model, timeoutMs: AI_REQUEST_TIMEOUT_MS },
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error?.message || data.message || `AI API error: ${response.status}`);
      error.status = response.status;
      await logPipelineEvent('ai.request.failed', {
        level: 'error',
        emailId,
        metadata: { status: response.status, latencyMs: Date.now() - startedAt, model },
        message: error.message,
      });
      throw error;
    }
    await logPipelineEvent('ai.request.completed', {
      emailId,
      metadata: { status: response.status, latencyMs: Date.now() - startedAt, model },
    });
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const error = new Error(`AI API timed out after ${AI_REQUEST_TIMEOUT_MS}ms`);
      error.code = 'AI_TIMEOUT';
      error.status = 504;
      await logPipelineEvent('ai.request.timeout', {
        level: 'error',
        emailId,
        metadata: { latencyMs: Date.now() - startedAt, model },
        message: error.message,
      });
      throw error;
    }
    await logPipelineEvent('ai.request.failed', {
      level: 'error',
      emailId,
      metadata: { latencyMs: Date.now() - startedAt, model, code: err.code || null },
      message: err.message,
    });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkAiHealth() {
  const startedAt = Date.now();
  const { model } = getAiConfig();
  const data = await callAiApi({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'You are an AI health probe. Return JSON only: {"ok":true}.',
      },
      { role: 'user', content: 'Health check. Return {"ok":true}.' },
    ],
  });
  const content = data.choices?.[0]?.message?.content;
  const parsed = parseJsonObject(content);
  if (parsed.ok !== true) {
    const error = new Error('AI API returned an invalid health response');
    error.code = 'AI_INVALID_RESPONSE';
    error.status = 502;
    throw error;
  }
  return { ok: true, model, latencyMs: Date.now() - startedAt };
}

async function classifyAndExtract(email) {
  const { model } = getAiConfig();
  const hodDepartments = await getHodDepartments();
  const data = await callAiApi({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'You extract recruitment emails into conservative structured JSON.',
      },
      { role: 'user', content: applicationPrompt(email, hodDepartments) },
    ],
  }, { emailId: email.email_id || null });

  const content = data.choices?.[0]?.message?.content;
  const parsed = parseJsonObject(content);
  parsed.classification = normalizeClassification(parsed.classification);
  parsed.confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  parsed.applicant = parsed.applicant && typeof parsed.applicant === 'object'
    ? parsed.applicant
    : {};
  if (!parsed.applicant.email) parsed.applicant.email = email.from_email;
  return parsed;
}

function candidateReply({ applicant, uncertain = false }) {
  const greeting = applicant?.name ? `Hi ${applicant.name},` : 'Hi,';
  if (uncertain) {
    return `${greeting}

Thank you for contacting Eternalgy. We are not sure whether your email is an application for a job vacancy.

Please reply with the position or department you are applying for and attach your CV/resume if available.

Regards,
Eternalgy Recruitment`;
  }

  return `${greeting}

Thank you for your job application to Eternalgy.

For interview coordination, please reply with:
1. Your WhatsApp number, which is compulsory for the interview invitation.
2. Two or three possible interview dates and times, including your time zone.

Our recruitment team will review your application and contact you.

Regards,
Eternalgy Recruitment`;
}

function hodMessage({ application, email }) {
  const a = application;
  const availability = Array.isArray(a.availability) && a.availability.length
    ? a.availability.join('; ')
    : 'Not provided';
  return [
    'New job application received',
    `Name: ${a.applicant_name || 'Not provided'}`,
    `Email: ${a.applicant_email || email.from_email}`,
    `WhatsApp: ${a.whatsapp_number || 'Not provided'}`,
    `Position: ${a.applied_position || 'Not provided'}`,
    `Department: ${a.department || 'Not provided'}`,
    `Experience: ${a.years_experience || 'Not provided'}`,
    `Availability: ${availability}`,
    `Subject: ${email.subject || '(no subject)'}`,
  ].join('\n');
}

export async function processJobApplicationEmail(email) {
  const context = { emailId: email?.email_id || null, receivedEmailId: email?.id || null };
  await logPipelineEvent('application.processing.started', context);
  if (!email?.id || !email.from_email) {
    throw new Error('Received email record is incomplete');
  }

  const existing = await getJobApplicationByReceivedEmailId(email.id);
  if (existing?.processing_status === 'completed') {
    await logPipelineEvent('application.processing.skipped', {
      ...context,
      applicationId: existing.id,
      metadata: { reason: 'already_completed', status: existing.status },
    });
    return { skipped: true, application: existing };
  }

  let extracted;
  try {
    extracted = await classifyAndExtract({ ...email, emailId: email.email_id });
  } catch (err) {
    await logPipelineEvent('application.processing.failed', {
      ...context,
      level: 'error',
      metadata: { code: err.code || null, status: err.status || null },
      message: err.message,
    });
    throw err;
  }
  const applicant = extracted.applicant || {};
  const application = await saveJobApplication({
    receivedEmailId: email.id,
    classification: extracted.classification,
    confidence: extracted.confidence,
    classificationReason: extracted.reason,
    applicantName: applicant.name,
    applicantEmail: applicant.email || email.from_email,
    phone: applicant.phone,
    whatsappNumber: applicant.whatsapp_number,
    appliedPosition: applicant.position,
    department: applicant.department,
    yearsExperience: applicant.years_experience,
    location: applicant.location,
    availability: applicant.availability,
    resumeSummary: applicant.resume_summary,
    extraction: extracted,
    processingStatus: 'processing',
  });

  await logPipelineEvent('application.classified', {
    ...context,
    applicationId: application?.id,
    metadata: {
      classification: extracted.classification,
      confidence: extracted.confidence,
      department: applicant.department || null,
    },
  });

  if (extracted.classification === 'not_job_application') {
    return updateJobApplication(application.id, {
      processingStatus: 'completed',
      status: 'ignored',
    });
  }

  const uncertain = extracted.classification === 'uncertain';
  await logPipelineEvent('candidate.reply.started', {
    ...context,
    applicationId: application?.id,
    metadata: { classification: extracted.classification, uncertain },
  });
  try {
    await sendEmail({
    to: email.from_email,
    from: config.JOB_APPLICATION_FROM,
    domain: config.EMAIL_DOMAIN,
    subject: uncertain
      ? `Re: ${email.subject || 'Your email to Eternalgy'}`
      : `Re: ${email.subject || 'Your job application to Eternalgy'}`,
    text: candidateReply({ applicant, uncertain }),
    html: `<pre style="font-family: Arial, sans-serif; white-space: pre-wrap;">${candidateReply({ applicant, uncertain })}</pre>`,
    });
    await logPipelineEvent('candidate.reply.sent', {
      ...context,
      applicationId: application?.id,
      metadata: { uncertain },
    });
  } catch (err) {
    await logPipelineEvent('candidate.reply.failed', {
      ...context,
      applicationId: application?.id,
      level: 'error',
      message: err.message,
    });
    throw err;
  }

  if (uncertain) {
    return updateJobApplication(application.id, {
      processingStatus: 'completed',
      status: 'clarification_requested',
      acknowledgementSentAt: new Date(),
    });
  }

  const hod = await getHodDepartment(applicant.department);
  if (hod?.hod_whatsapp_number) {
    try {
      await sendWhatsAppMessage({
        to: hod.hod_whatsapp_number,
        text: hodMessage({ application, email }),
      });
      return updateJobApplication(application.id, {
        processingStatus: 'completed',
        status: 'new',
        acknowledgementSentAt: new Date(),
        hodNotifiedAt: new Date(),
        notificationError: null,
      });
    } catch (err) {
      return updateJobApplication(application.id, {
        processingStatus: 'completed',
        status: 'new',
        acknowledgementSentAt: new Date(),
        notificationError: err.message,
      });
    }
  }

  return updateJobApplication(application.id, {
    processingStatus: 'completed',
    status: 'new',
    acknowledgementSentAt: new Date(),
    notificationError: applicant.department
      ? `No HOD WhatsApp number configured for department: ${applicant.department}`
      : 'No department was extracted and no default HOD is configured',
  });
}
