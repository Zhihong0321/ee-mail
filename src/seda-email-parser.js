const ADMIN_SENDER = 'admin@eternalgy.my';
const SEDA_DOMAIN = 'seda.gov.my';

const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi;

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

export function htmlToText(html = '') {
  return decodeHtmlEntities(String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|table|section|article|header|footer)>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanExtractedValue(value) {
  return String(value || '')
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanAddress(value) {
  return String(value || '')
    .replace(/[*_]/g, '')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function asSearchableText(email) {
  const pieces = [
    email?.text_content,
    htmlToText(email?.html_content || ''),
    JSON.stringify(email?.headers || {}),
    JSON.stringify(email?.raw_data || {}),
  ];

  return pieces.filter(Boolean).join('\n');
}

export function extractEmailAddresses(value = '') {
  return [...new Set((String(value).match(EMAIL_PATTERN) || []).map(email => email.toLowerCase()))];
}

function isSedaAddress(email) {
  const normalized = String(email || '').toLowerCase();
  return normalized === SEDA_DOMAIN || normalized.endsWith(`@${SEDA_DOMAIN}`);
}

export function inspectSedaSender(email) {
  const bodyText = [
    email?.text_content,
    htmlToText(email?.html_content || ''),
  ].filter(Boolean).join('\n');

  const forwardedFromLines = bodyText
    .split(/\r?\n/)
    .filter(line => /^\s*from\s*:/i.test(line));

  const headerFromValues = [
    email?.headers?.from,
    email?.raw_data?.from,
  ].filter(Boolean);

  const envelopeSender = String(email?.from_email || '').trim().toLowerCase();
  const senderAddresses = extractEmailAddresses([
    envelopeSender,
    ...headerFromValues,
    ...forwardedFromLines,
  ].join('\n'));

  const matchedSenders = [...new Set(senderAddresses)].filter(sender =>
    sender === ADMIN_SENDER || isSedaAddress(sender)
  );

  return {
    matched: envelopeSender === ADMIN_SENDER ||
      isSedaAddress(envelopeSender) ||
      matchedSenders.length > 0,
    envelopeSender,
    matchedSenders,
  };
}

export function isAtapApprovalSubject(subject = '') {
  const normalized = String(subject)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const hasApproval = normalized.includes('approval');
  const hasAtap = normalized.includes('atap') || /\batp\d+\b/.test(normalized);
  return hasApproval && hasAtap;
}

export function containsSedaDomain(email) {
  const searchableText = asSearchableText(email);
  return extractEmailAddresses(searchableText).some(isSedaAddress);
}

export function classifySedaApprovalEmail(email) {
  const senderCheck = inspectSedaSender(email);
  if (!senderCheck.matched) {
    return {
      matched: false,
      stage: 'sender',
      reason: 'Sender is not admin@eternalgy.my or a SEDA sender',
      senderCheck,
    };
  }

  if (!isAtapApprovalSubject(email?.subject)) {
    return {
      matched: false,
      stage: 'subject',
      reason: 'Subject is not an ATAP approval message',
      senderCheck,
    };
  }

  if (!containsSedaDomain(email)) {
    return {
      matched: false,
      stage: 'seda_domain',
      reason: 'Headers or body do not contain seda.gov.my',
      senderCheck,
    };
  }

  return {
    matched: true,
    stage: 'matched',
    senderCheck,
  };
}

export function parseSedaApprovalEmail(email) {
  const text = [
    email?.text_content,
    htmlToText(email?.html_content || ''),
  ].filter(Boolean).join('\n');

  const applicantMatch = text.match(/(?:^|\n)\s*Applicant\s*:\s*([^\n]+)/i);
  const fallbackNameMatch = text.match(/Dear\s+(?:MDM|MR|MS|MRS|DR)?\s*([^,\n!]+)[,!]?/i);
  const customerName = cleanExtractedValue(applicantMatch?.[1] || fallbackNameMatch?.[1] || '');

  const addressMatch = text.match(
    /Installation\s+Address\s*:\s*([\s\S]*?)(?=\n\s*[*_]*Important\s+Notice|\n\s*View\s+Application\s+Details|\n\s*[*_]*SEDA\s+Malaysia|$)/i
  );
  const installationAddress = cleanAddress(addressMatch?.[1] || '');

  const applicationMatch = text.match(/Application\s+Number\s*:\s*[*_]*([A-Z]{2,}[A-Z0-9-]*)/i);
  const applicationNumber = cleanExtractedValue(applicationMatch?.[1] || '');

  const nameCandidates = [];
  if (customerName) {
    nameCandidates.push(customerName);
    if (/atap/i.test(email?.subject || '') && !/\(\s*atap\s*\)$/i.test(customerName)) {
      nameCandidates.push(`${customerName} (ATAP)`);
    }
  }

  return {
    customerName,
    installationAddress,
    applicationNumber,
    nameCandidates,
  };
}

export const SEDA_APPROVAL_CONSTANTS = {
  ADMIN_SENDER,
  SEDA_DOMAIN,
};
