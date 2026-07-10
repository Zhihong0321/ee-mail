import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySedaApprovalEmail,
  parseSedaApprovalEmail,
} from '../src/seda-email-parser.js';

const sampleEmail = {
  from_email: 'admin@eternalgy.my',
  subject: 'Fwd: ATP202613514: Approval for eATAP Application',
  text_content: `
---------- Forwarded message ---------
From: <noreply@seda.gov.my>
Date: Thu, Jun 18, 2026 at 12:27 PM
Subject: ATP202613514: Approval for eATAP Application
To: <leehua66@yahoo.com.tw>
Cc: <ADMIN@eternalgy.my>

Application Approved!
Dear MDM TIAN LEE HUA,

Application Details
Applicant: TIAN LEE HUA
Application Number: ATP202613514
Installation Address: 11A, JALAN SEMARAK API
TAMAN SELATAN
83700 YONG PENG
JOHOR
Important Notice
`,
};

test('matches the sample in sender-first order', () => {
  const result = classifySedaApprovalEmail(sampleEmail);
  assert.equal(result.matched, true);
  assert.equal(result.stage, 'matched');
});

test('extracts sample fields and ATAP name candidate', () => {
  const result = parseSedaApprovalEmail(sampleEmail);
  assert.equal(result.customerName, 'TIAN LEE HUA');
  assert.equal(result.applicationNumber, 'ATP202613514');
  assert.equal(result.installationAddress, '11A, JALAN SEMARAK API\nTAMAN SELATAN\n83700 YONG PENG\nJOHOR');
  assert.deepEqual(result.nameCandidates, ['TIAN LEE HUA', 'TIAN LEE HUA (ATAP)']);
});

test('rejects non-ATAP subjects after sender check', () => {
  const result = classifySedaApprovalEmail({
    ...sampleEmail,
    subject: 'Fwd: General SEDA information',
  });
  assert.equal(result.matched, false);
  assert.equal(result.stage, 'subject');
});

test('rejects unrelated senders before inspecting the subject', () => {
  const result = classifySedaApprovalEmail({
    ...sampleEmail,
    from_email: 'someone@example.com',
    text_content: 'From: <someone@example.com>\\nSubject: ATAP Approval',
  });
  assert.equal(result.matched, false);
  assert.equal(result.stage, 'sender');
});

test('requires seda.gov.my in message headers or body', () => {
  const result = classifySedaApprovalEmail({
    ...sampleEmail,
    text_content: sampleEmail.text_content.replace('noreply@seda.gov.my', 'noreply@example.com'),
  });
  assert.equal(result.matched, false);
  assert.equal(result.stage, 'seda_domain');
});
