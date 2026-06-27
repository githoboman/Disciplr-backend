# Notification Delivery System

The application uses an abstraction for notification delivery, allowing for multiple providers (Email, Console, etc.) and reliable delivery via background jobs.

## Architecture

1.  **Job Enqueueing**: Notifications are enqueued as `notification.send` jobs.
2.  **Job Execution**: The job handler uses an injected `NotificationService` instance to select and execute the configured provider.
3.  **Retries**: Jobs are automatically retried with exponential backoff on failure.

## Provider Interface

All providers must implement the `NotificationProvider` interface:

```typescript
export interface NotificationProvider {
  name: string
  send(recipient: string, subject: string, body: string): Promise<void>
}
```

## Configuration

The active provider is selected at boot via the validated `NOTIFICATION_PROVIDER` environment variable and injected through `src/index.ts` → `src/app-bootstrap.ts` → `BackgroundJobSystem`.
Available providers:
- `email`: Sends via Email (Stub implementation).
- `console`: Logs to console (Default for local development).

### Fail-fast behavior

- `NotificationService` is initialized with a provider registry and a default provider name.
- If the configured provider name is unknown, startup fails with an explicit error.
- If a runtime override requests an unknown provider, the send operation throws immediately.
- Silent fallback to `console` for unknown provider names is intentionally removed to avoid masking misconfiguration.

## Milestone Reminders

The system sends deadline-approaching reminders for active vault milestones. These reminders are sent at configurable lead times before the milestone's due date.

### Lead Time Configuration

By default, reminders are sent at three intervals:
- 72 hours before the deadline
- 24 hours before the deadline
- 1 hour before the deadline

You can customize the lead times by passing an array of millisecond values to the `sendMilestoneReminders` function or the `milestone.reminders` job payload:

```typescript
// Example: Send reminders 48 hours, 12 hours, and 30 minutes before deadline
sendMilestoneReminders({
  leadTimesMs: [
    48 * 60 * 60 * 1000,  // 48 hours
    12 * 60 * 60 * 1000,  // 12 hours
    30 * 60 * 1000        // 30 minutes
  ]
})
```

### Reminder Deduplication

Reminders are deduplicated using an idempotency key, ensuring only one reminder is sent per lead time bucket per milestone, even if the job runs multiple times.

### Notification Type

Milestone reminders use the `milestone_reminder` notification type and include:
- Milestone title
- Time remaining until deadline
- Vault ID
- Milestone ID
- Due date

## Observability

- **Metrics**: Queue metrics can be accessed via `GET /api/jobs/metrics`.
- **Logs**: Job execution is logged. PII (recipient, subject, body) is filtered from the logs for security and compliance.
- **Failures**: Persistent failures are recorded and observable via the metrics endpoint.

## Retry Policy

The system uses an exponential backoff strategy:
- `delay = min(60s, 1s * 2^(attempt - 1))`
- Execution is observable via `/api/jobs/metrics` and failures are tracked with their error messages.
