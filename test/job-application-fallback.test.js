import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicRecruitmentFallback } from '../src/job-application-service.js';

const departments = [
  { department: 'IT', is_active: true },
  { department: 'Finance', is_active: true },
];

test('recognizes a role-only reply to a vacancy clarification', () => {
  const result = deterministicRecruitmentFallback({
    from_email: 'candidate@example.com',
    subject: 'Re: Re: IT JOB Vacancy',
    text_content: 'Software Engineer',
  }, departments);

  assert.equal(result.classification, 'job_application');
  assert.equal(result.applicant.position, 'Software Engineer');
  assert.equal(result.applicant.department, 'IT');
});

test('ignores Gmail quoted history when extracting a role-only reply', () => {
  const result = deterministicRecruitmentFallback({
    from_email: 'candidate@example.com',
    subject: 'Re: Re: IT JOB Vacancy',
    text_content: 'Software Engineer\n\nOn Tue, Jul 28, 2026 wrote:\n\n> Please reply with the position or department.',
  }, departments);

  assert.equal(result.classification, 'job_application');
  assert.equal(result.applicant.position, 'Software Engineer');
});

test('keeps a vague availability question in clarification', () => {
  const result = deterministicRecruitmentFallback({
    from_email: 'candidate@example.com',
    subject: 'IT JOB Vacancy',
    text_content: 'Do you have job?',
  }, departments);

  assert.equal(result.classification, 'uncertain');
});

test('does not silently discard an email when AI is unavailable', () => {
  const result = deterministicRecruitmentFallback({
    from_email: 'candidate@example.com',
    subject: 'Hello',
    text_content: 'I would like to know more.',
  });

  assert.equal(result.classification, 'uncertain');
  assert.equal(result.applicant.email, 'candidate@example.com');
});
