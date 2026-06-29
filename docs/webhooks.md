# Webhook Delivery

## Overview

The Disciplr backend delivers webhook events to subscriber endpoints with built-in resilience and bounded concurrency. Webhooks are signed with HMAC-SHA256 and support multiple payload schema versions.

---

## Concurrency-Bounded Dispatch Worker

### Problem

Webhook delivery can create resource exhaustion during burst events. Without concurrency bounds:
- Unlimited open sockets to subscribers
- Memory spike from buffered data
- Cascade failures if upstream is slow
- One slow subscriber blocks others

### Solution

The dispatcher uses a **bounded worker pool** with per-subscriber queuing:

```
Max concurrency: 10 (default, configurable)
Scheduler: Round-robin per subscriber
Circuit breaker: Per-subscriber CLOSED/OPEN/HALF_OPEN
Retry: Exponential backoff (3 attempts, 1s-30s)
```

### Configuration

| Environment Variable | Default | Description | Valid Range |
|---------------------|---------|-------------|-------------|
| `WEBHOOK_MAX_CONCURRENCY` | `10` | Max simultaneous outbound deliveries | 1-1000 |

### Example

```bash
# High-throughput environment (50 concurrent deliveries)
WEBHOOK_MAX_CONCURRENCY=50

# Resource-constrained environment (3 concurrent deliveries)
WEBHOOK_MAX_CONCURRENCY=3
```

---

## Fair Scheduling

The dispatcher prevents one slow endpoint from monopolizing the delivery budget using **round-robin per-subscriber** scheduling.

### Example Scenario

Three subscribers with queued events:
```
Subscriber A: [event1, event2, event3]
Subscriber B: [event1, event2]
Subscriber C: [event1]

Max concurrency: 3
```

**Dispatch order:**
```
Time 0ms:    A.event1,  B.event1,  C.event1  (round-robin, all 3 slots)
Time 50ms:   A.event2,  B.event2              (A still sending, next available)
Time 100ms:  A.event3                         (A completes last event)
```

**Result:**
- Each subscriber gets fair CPU time
- Subscriber A doesn't monopolize all 3 slots
- B and C don't starve
- Throughput is predictable

### Without Fair Scheduling (Anti-pattern)

```
Time 0ms:   A.event1,  A.event2,  A.event3  (all A, unfair)
Time 150ms: B.event1,  B.event2,  C.event1  (B and C starved)
```

---

## Circuit Breaker Integration

Each subscriber has an independent circuit breaker that prevents cascading failures.

### States

| State | Behavior | Transition |
|-------|----------|-----------|
| **CLOSED** | Deliveries dispatched normally | 5+ failures in 60s → OPEN |
| **OPEN** | All queued deliveries skipped, routed to dead-letter | 30s timeout → HALF_OPEN |
| **HALF_OPEN** | Single probe delivery attempted | Success → CLOSED, Failure → OPEN |

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `WEBHOOK_CIRCUIT_BREAKER_THRESHOLD` | `5` | Failures to trip breaker |
| `WEBHOOK_CIRCUIT_BREAKER_WINDOW_MS` | `60000` | Failure window (60s) |
| `WEBHOOK_CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS` | `30000` | Before probe attempt (30s) |

### Example

```
Subscriber endpoint is slow (500ms per request):
- Attempt 1: 500ms ✗ fail (1 failure)
- Attempt 2: 500ms ✗ fail (2 failures)
- Attempt 3: 500ms ✗ fail (3 failures)
- Attempt 4: 500ms ✗ fail (4 failures)
- Attempt 5: 500ms ✗ fail (5 failures → TRIP)

Breaker now OPEN for 30 seconds:
- All queued deliveries → dead-letter queue
- No new attempts for 30s

After 30 seconds:
- Breaker transitions to HALF_OPEN
- Single probe delivery sent
- If successful → CLOSED, resume normal dispatch
- If fails → back to OPEN
```

---

## Retry Strategy

Failed deliveries retry with **exponential backoff with jitter**.

### Configuration

```typescript
{
  maxAttempts: 3,                 // 3 tries total
  initialBackoffMs: 1_000,        // 1 second first retry
  maxBackoffMs: 30_000,           // 30 second max
  backoffMultiplier: 2,           // Double each retry
  jitterFactor: 0.25,             // 25% randomization (AWS Full Jitter)
}
```

### Example Timeline

```
Attempt 1 (T=0ms):     Delivery sent, fails
Wait: 1000ms ± 250ms randomness
Attempt 2 (T≈1250ms):  Delivery sent, fails
Wait: 2000ms ± 500ms randomness
Attempt 3 (T≈3750ms):  Delivery sent, fails
→ Route to dead-letter queue
```

### Retryable vs Non-Retryable Errors

**Retried:**
- `ECONNREFUSED` — Connection refused
- `ENOTFOUND` — DNS resolution failed
- `ETIMEDOUT` — Request timeout
- `HTTP 500` — Server error
- `HTTP 503` — Service unavailable

**Not retried (fail immediately):**
- `HTTP 400` — Bad request
- `HTTP 401` — Unauthorized
- `HTTP 403` — Forbidden
- `HTTP 404` — Not found
- Redirect response (manually rejected)

---

## Dead-Letter Queue

Failed deliveries after max retries are persisted for audit and manual replay.

### Persistence

```sql
CREATE TABLE webhook_dead_letters (
  id UUID PRIMARY KEY,
  subscriber_id UUID NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  last_error TEXT,
  attempts INTEGER,
  failed_at TIMESTAMP,
  replayed_at TIMESTAMP NULL
);
```

### Manual Replay

```typescript
// Replay a dead-letter:
const result = await replayDeadLetter(deadLetterId)
// → { replayed: true, subscriberId, error?: string }

// If successful, marked with replayed_at timestamp
// If fails, remains in dead-letter for retry
```

---

## Payload Schema Versioning

Subscribers can request different payload schemas for backward compatibility.

### Schema V1 (Original)

```json
{
  "eventId": "abc123:0",
  "eventType": "vault_created",
  "timestamp": "2026-06-28T12:34:56Z",
  "data": { "vaultId": "vault-123" },
  "organizationId": "org-456",
  "schema_version": 1
}
```

### Schema V2 (Compact)

```json
{
  "schema_version": 2,
  "event_type": "vault_created",
  "data": { "vaultId": "vault-123" }
}
```

### Configuration

```typescript
// When registering a subscriber:
await addSubscriber({
  organizationId: 'org-id',
  url: 'https://example.com/webhook',
  secret: 'signing-secret',
  events: ['vault_created', 'vault_completed'],
  schemaVersion: 2  // Optional, defaults to 1
})
```

#### POST `/api/admin/vaults/:id/replay-events`

Replays all recorded outbox lifecycle events for a single vault to an optional target subscriber. Preserves original event ordering and event IDs/idempotency keys.

Request Body (Optional):
```json
{
  "subscriber_id": "90b1e428-2f19-4b2b-8a71-3cb56667104b"
}
```

Response (200):
```json
{
  "replayed": true,
  "count": 3
}
```

## Test-Ping Endpoint

`POST /api/webhooks/:id/test` lets subscribers self-verify their delivery URL and HMAC wiring before real vault events start flowing.

### Authorization

- Caller must be authenticated (Bearer JWT).
- The subscriber must belong to the caller's organization (`enterpriseId` in the JWT must match `organizationId` on the subscriber). Cross-org pings return **403**.

### Rate Limiting

5 requests per subscriber per 60 seconds to prevent abuse as an SSRF probe.

### Request

```http
POST /api/webhooks/{subscriberId}/test
Authorization: Bearer <token>
```

No request body required.

### Response (200 — always returned for delivery attempts)

```json
{
  "delivered": true,
  "statusCode": 200,
  "latencyMs": 142,
  "signatureHeader": "sha256=<hex-digest>"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `delivered` | boolean | `true` if the subscriber returned 2xx |
| `statusCode` | number | HTTP status returned by the subscriber (present on delivery attempts) |
| `latencyMs` | number | Round-trip time in milliseconds |
| `signatureHeader` | string | The `x-disciplr-signature` value that was sent — use this to verify your HMAC code |
| `error` | string | Error description when `delivered: false` |

The subscriber's **secret is never returned** in the response. Use `signatureHeader` to confirm your HMAC implementation produces the same digest from the request body.

### Synthetic Payload

The test event uses the same versioned envelope (`buildVersionedPayload`) as real deliveries, so a passing test guarantees real deliveries will also verify. The event type is `webhook.test`.

Example v1 body:
```json
{
  "eventId": "test:<uuid>",
  "eventType": "webhook.test",
  "timestamp": "2026-06-28T00:00:00.000Z",
  "data": { "message": "This is a test delivery from Disciplr…" },
  "organizationId": "<your-org-id>",
  "schema_version": 1
}
```

### Error Cases

| HTTP Status | Condition |
|-------------|-----------|
| 401 | Missing or invalid Bearer token |
| 403 | Subscriber belongs to a different organization |
| 404 | Subscriber not found |
| 422 | Subscriber URL is blocked by the SSRF guard |
| 429 | Rate limit exceeded (5 pings/subscriber/minute) |
| 200 + `delivered: false` | Subscriber URL returned an error, timed out, or refused a redirect |

---

## Testing

```
POST /webhook HTTP/1.1
X-Disciplr-Signature: sha256=<hex-digest>
X-Disciplr-Event: vault_created
X-Disciplr-Event-Id: abc123:0
X-Disciplr-Delivery-Timestamp: 2026-06-28T12:34:56Z
Content-Type: application/json

{...payload...}
```

Run the test-ping tests specifically:
```bash
npm test -- src/tests/webhooks.testPing.test.ts
```

DLQ tests require a PostgreSQL database (`DATABASE_URL`). Without it, they are skipped gracefully.

```python
import hmac
import hashlib

secret = "signing-secret"
body = request.body.decode('utf-8')
signature = request.headers.get('X-Disciplr-Signature')

expected = 'sha256=' + hmac.new(
  secret.encode(),
  body.encode(),
  hashlib.sha256
).hexdigest()

if not hmac.compare_digest(expected, signature):
  return 401  # Unauthorized
```

### Secret Rotation

| Column | Type | Description |
|---|---|---|
| `id` | `uuid` (PK, auto-generated) | Unique subscriber identifier |
| `organization_id` | `varchar(255)` | Owning organization (NOT NULL) |
| `url` | `varchar(2048)` | Target webhook URL |
| `secret` | `text` | Current HMAC signing secret |
| `previous_secret` | `text` (nullable) | Previous secret retained during rotation grace window |
| `rotated_at` | `timestamptz` (nullable) | When the most recent rotation occurred |
| `events` | `jsonb` | Array of event types to receive; empty array = wildcard (all events) |
| `active` | `boolean` | Whether the subscriber is active |
| `schema_version` | `integer` (default `1`) | Payload schema version (see Payload Schema Versioning) |
| `field_policy` | `jsonb` | Field masking policy (see Field Masking & PII Stripping) |
| `created_at` | `timestamptz` | Creation timestamp |
| `updated_at` | `timestamptz` | Last update timestamp |

```typescript
// Rotate secret
await rotateSubscriberSecret(subscriberId, orgId, newSecret)

// Old secret remains valid during grace window
// allowing in-flight deliveries to verify
// Grace window: 24 hours (configurable via WEBHOOK_SECRET_GRACE_WINDOW_MS)
```

---

## Prometheus Metrics

### Gauges

| Metric | Type | Description |
|--------|------|-------------|
| `disciplr_webhook_dispatch_in_flight` | Gauge | Current in-flight deliveries |
| `disciplr_webhook_dispatch_queue_depth` | Gauge | Total queued deliveries waiting |
| `disciplr_webhook_breaker_closed` | Gauge | Subscribers with CLOSED breaker |
| `disciplr_webhook_breaker_open` | Gauge | Subscribers with OPEN breaker |
| `disciplr_webhook_breaker_half_open` | Gauge | Subscribers with HALF_OPEN breaker |

### Endpoint

```
GET /metrics
```

### Example Output

```
# HELP disciplr_webhook_dispatch_in_flight Number of webhook deliveries currently in flight
# TYPE disciplr_webhook_dispatch_in_flight gauge
disciplr_webhook_dispatch_in_flight 8

# HELP disciplr_webhook_dispatch_queue_depth Number of webhook deliveries waiting in queue
# TYPE disciplr_webhook_dispatch_queue_depth gauge
disciplr_webhook_dispatch_queue_depth 42

# HELP disciplr_webhook_breaker_open Number of webhook subscribers with open circuit breaker
# TYPE disciplr_webhook_breaker_open gauge
disciplr_webhook_breaker_open 2
```

---

## Monitoring & Alerting

### Key Metrics to Monitor

**1. Queue Depth Growth**
```promql
# Alert if queue growing unbounded
rate(disciplr_webhook_dispatch_queue_depth[5m]) > 100

# Alert if queue depth very high
disciplr_webhook_dispatch_queue_depth > 10000
```

**2. In-Flight Stuck**
```promql
# Alert if in-flight stuck at ceiling for extended period
disciplr_webhook_dispatch_in_flight == 10 AND rate(disciplr_webhook_dispatch_in_flight[10m]) == 0
```

**3. Circuit Breaker Trips**
```promql
# Alert if too many breakers open
disciplr_webhook_breaker_open > 50
```

**4. Dead-Letter Accumulation**
```sql
SELECT COUNT(*) FROM webhook_dead_letters
WHERE replayed_at IS NULL AND failed_at > NOW() - INTERVAL '1 hour'
```

---

## Performance Tuning

### Increasing Throughput

**Symptom:** Queue depth constantly growing, never caught up

**Solution:** Increase `WEBHOOK_MAX_CONCURRENCY`
```bash
WEBHOOK_MAX_CONCURRENCY=50
```

**Impact:**
- More concurrent sockets open
- Higher memory usage
- More file descriptors needed
- Better throughput for IO-bound workload

**Limits:**
- System file descriptor limit: `ulimit -n`
- Subscriber throughput ceiling (no benefit increasing beyond their capacity)

### Protecting Resources

**Symptom:** Memory usage spiking, system becoming unresponsive

**Solution:** Decrease `WEBHOOK_MAX_CONCURRENCY`
```bash
WEBHOOK_MAX_CONCURRENCY=3
```

**Impact:**
- Fewer concurrent sockets
- Lower memory usage
- Lower file descriptor usage
- Slower but stable throughput

### Tuning Circuit Breaker

**Symptom:** Too many false trips (good endpoints getting OPEN)

**Solution:** Increase threshold or window
```bash
WEBHOOK_CIRCUIT_BREAKER_THRESHOLD=10    # Was 5
WEBHOOK_CIRCUIT_BREAKER_WINDOW_MS=120000  # Was 60000 (2 min)
```

**Symptom:** Slow recovery from transient outages

**Solution:** Decrease half-open timeout
```bash
WEBHOOK_CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS=10000  # Was 30000
```

---

## Backpressure & Persistence

### In-Memory Queue

Enqueued deliveries are held in memory:
- Fast: No persistence overhead
- Risk: Lost on restart
- Safe for: Low-churn events (< 1000/min)

### Persistent Outbox (Recommended for Production)

For durability, persist webhook events to the outbox table before queueing:

```typescript
// Event processor writes to vault_outbox
await db('vault_outbox').insert({
  event_id: payload.eventId,
  event_type: payload.eventType,
  payload: JSON.stringify(payload),
  processed: false,
  attempts: 0
})

// Background worker polls outbox and dispatches
await relayOutboxBatch(batchSize)
```

**Benefits:**
- Survives process restart
- Bounded queue depth (disk-backed)
- Durable audit trail

---

## Troubleshooting

### Queue Growing Indefinitely

**Diagnosis:**
```promql
disciplr_webhook_dispatch_queue_depth > 50000
```

**Causes:**
1. Subscriber endpoints all failing or slow
2. Circuit breakers all open
3. Concurrency too low

**Remediation:**
1. Check subscriber health: `SELECT * FROM webhook_dead_letters WHERE failed_at > NOW() - INTERVAL '1 hour'`
2. Check breaker status: `SELECT COUNT(*) FROM webhook_breaker_states WHERE state = 'OPEN'`
3. Increase concurrency or add delivery workers

### Deliveries Stuck in Queue

**Diagnosis:**
```sql
SELECT COUNT(*) FROM webhook_dead_letters
WHERE created_at > NOW() - INTERVAL '10 minutes'
```

**Causes:**
1. All endpoints failing
2. Subscriber breakers all open

**Remediation:**
1. Investigate failures in dead-letter queue
2. Fix subscriber endpoints
3. Manually close breakers if needed: `DELETE FROM webhook_breaker_states WHERE state = 'OPEN'`

### High Memory Usage

**Diagnosis:**
```
RSS memory > expected
Process file descriptor count high
```

**Causes:**
1. Too many queued deliveries in memory
2. WEBHOOK_MAX_CONCURRENCY too high

**Remediation:**
1. Reduce WEBHOOK_MAX_CONCURRENCY
2. Ensure outbox relay is running: `relayOutboxBatch()`
3. Investigate slow subscribers

---

## API Reference

### dispatchWebhookEvent(payload)

```typescript
async function dispatchWebhookEvent(
  payload: WebhookDeliveryPayload
): Promise<WebhookDeliveryResult[]>
```

**Returns:** Empty array immediately (work continues in background)

**Side effects:** Enqueues deliveries to dispatcher

### addSubscriber(orgId, url, secret, events, schemaVersion?)

```typescript
async function addSubscriber(
  organizationId: string,
  url: string,
  secret: string,
  events: string[],
  schemaVersion?: number  // 1 or 2, defaults to 1
): Promise<WebhookSubscriber>
```

### rotateSubscriberSecret(id, orgId, newSecret)

```typescript
async function rotateSubscriberSecret(
  id: string,
  organizationId: string,
  newSecret: string
): Promise<WebhookSubscriber | null>
```

### replayDeadLetter(deadLetterId)

```typescript
async function replayDeadLetter(
  id: string
): Promise<{ replayed: boolean; subscriberId?: string; error?: string }>
```

---

## Field Masking & PII Stripping

Each webhook subscriber can have a configurable **field policy** that controls which fields appear in delivered payloads and whether PII is stripped. Field masking is applied **before** the HMAC signature is computed, ensuring subscribers can verify the signature on the masked payload.

### Field Policy Schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `'default' \| 'allowlist' \| 'denylist'` | `'default'` | How to filter fields |
| `fields` | `string[]` | `[]` | Field paths to include/exclude (depending on mode) |
| `stripPii` | `boolean` | `true` | Whether to apply PII masking |

### Policy Modes

| Mode | Behavior |
|------|----------|
| **default** | All fields are included. If `stripPii` is true, known PII fields are masked. |
| **allowlist** | Only fields listed in `fields` are included. All other fields are omitted. |
| **denylist** | All fields except those listed in `fields` are included. |

### Field Path Syntax

Field paths use dot notation for nested fields:
- `vaultId` - Top-level field
- `vault.name` - Nested field
- `vault.*` - Wildcard: matches all fields under `vault`

### PII Stripping

When `stripPii` is `true` (the default), the following fields are automatically masked using a deterministic SHA-256 hash (first 8 hex characters):

- `creator`
- `creatoraddress`
- `email`
- `failuredestination`
- `requesteruserid`
- `successdestination`
- `targetuserid`
- `userid`

Additionally, email addresses and Stellar account IDs found anywhere in string values are masked.

### Examples

#### Default Policy (PII Stripping Enabled)

```json
{
  "mode": "default",
  "fields": [],
  "stripPii": true
}
```

Input:
```json
{
  "vaultId": "123",
  "creator": "user@example.com",
  "amount": 1000
}
```

Output:
```json
{
  "vaultId": "123",
  "creator": "a4d8f3c2",
  "amount": 1000
}
```

#### Allowlist Mode

```json
{
  "mode": "allowlist",
  "fields": ["vaultId", "amount"],
  "stripPii": false
}
```

Input:
```json
{
  "vaultId": "123",
  "creator": "user@example.com",
  "amount": 1000,
  "secret": "sensitive"
}
```

Output:
```json
{
  "vaultId": "123",
  "amount": 1000
}
```

#### Denylist Mode

```json
{
  "mode": "denylist",
  "fields": ["internalId", "debugInfo.*"],
  "stripPii": true
}
```

### Admin API

#### `PATCH /api/admin/webhooks/subscribers/:id/field-policy`

Updates the field policy for a subscriber.

**Body:**
```json
{
  "organization_id": "org-123",
  "field_policy": {
    "mode": "allowlist",
    "fields": ["vaultId", "status", "amount"],
    "stripPii": true
  }
}
```

**Response 200:**
```json
{
  "id": "uuid",
  "field_policy": {
    "mode": "allowlist",
    "fields": ["vaultId", "status", "amount"],
    "stripPii": true
  }
}
```

### Database Schema

The `webhook_subscribers` table includes a `field_policy` JSONB column:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `field_policy` | `jsonb` | `{"mode": "default", "fields": [], "stripPii": true}` | Per-subscriber field masking configuration |

### Signature Implications

The HMAC signature is computed **after** field masking is applied. This means:

1. Different subscribers may receive different payloads for the same event (based on their field policies).
2. Each subscriber's signature is computed over their specific masked payload.
3. Subscribers can verify the signature using the masked payload they receive.

This design ensures that the signature always matches the delivered body, regardless of masking configuration.

---

## Outbound Webhooks
The Disciplr backend dispatches webhooks to subscribers when specific events occur. Subscribers can register to receive webhook deliveries for events such as `vault_created`, `vault_completed`, etc.

### SSRF Mitigation

Webhook URLs are validated to block internal addresses:
- `127.0.0.1`, `::1` (loopback)
- `10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12` (RFC-1918)
- `169.254.0.0/16` (link-local)
- `localtest.me` (known bypass domain)

### Secret Management

- Secrets stored in database (encrypted at rest recommended)
- Never logged or exposed in errors
- Rotated independently per subscriber
- Grace window allows gradual rollout

### Signature Verification

- HMAC-SHA256 prevents tampering
- Constant-time comparison prevents timing attacks
- Include in request validation (mandatory)

---

## Examples

### Register a Webhook Subscriber

```typescript
const subscriber = await addSubscriber(
  'org-123',
  'https://api.customer.com/webhook',
  'secret-key-123',
  ['vault_created', 'vault_completed'],
  2  // Schema version 2
)
```

### Verify Webhook in Recipient

```python
import hmac
import hashlib
import json

def verify_webhook(request):
    signature = request.headers.get('X-Disciplr-Signature')
    body = request.body.decode('utf-8')
    secret = 'secret-key-123'
    
    expected_sig = 'sha256=' + hmac.new(
        secret.encode(),
        body.encode(),
        hashlib.sha256
    ).hexdigest()
    
    if not hmac.compare_digest(expected_sig, signature):
        return False, 'Invalid signature'
    
    payload = json.loads(body)
    return True, payload
```

## Per-Organization Egress Allowlist

In addition to the global SSRF guard, operators can configure a per-org allowlist of permitted destination hosts. When at least one entry exists for an organization, webhook delivery is restricted to URLs whose hostname matches an allowlist entry (exact match or subdomain).

### Behaviour

| Org allowlist state | URL passes SSRF guard | Result |
|---|---|---|
| Empty (not configured) | ✓ | Delivery allowed (baseline SSRF guard only) |
| Non-empty | ✓, host on allowlist | Delivery allowed |
| Non-empty | ✓, host **not** on allowlist | Delivery denied — goes to dead-letter queue |
| Any | ✗ (private IP, loopback, etc.) | Delivery denied (unconditional baseline) |

The SSRF guard is always applied first, regardless of allowlist configuration. An allowlist entry for a private address cannot bypass the SSRF guard.

Enforcement is applied at **two points**:

1. **Subscriber registration** (`addSubscriber` / `upsertSubscriber`) — the URL is validated at creation time.
2. **Delivery time** (`dispatchWebhookEvent` / `replayDeadLetter`) — the subscriber's URL is re-checked before each delivery attempt. A host removed from the allowlist after registration stops receiving events immediately.

### Subdomain matching

An entry of `example.com` permits both `hooks.example.com` and `api.hooks.example.com` (any subdomain at any depth). An entry of `hooks.example.com` only permits that host and its subdomains, not `example.com` itself.

### Admin API

All allowlist endpoints require admin authentication.

#### List entries

```
GET /api/admin/webhooks/egress-allowlist?organization_id=<org>
```

Response:
```json
{
  "egress_allowlist": [
    { "id": "uuid", "organizationId": "org-1", "host": "hooks.example.com", "createdAt": "..." }
  ]
}
```

#### Add entry

```
POST /api/admin/webhooks/egress-allowlist
Content-Type: application/json

{ "organization_id": "org-1", "host": "hooks.example.com" }
```

Idempotent — posting a host that already exists returns the existing entry with `201`.

#### Remove entry

```
DELETE /api/admin/webhooks/egress-allowlist
Content-Type: application/json

{ "organization_id": "org-1", "host": "hooks.example.com" }
```

Returns `404` if the entry does not exist.

> **Warning**: removing the last entry for an org leaves the allowlist empty, which **removes the policy restriction** (baseline SSRF guard only). To block all delivery for an org, deactivate subscribers instead.

### Database

Allowlist entries are persisted in `org_webhook_egress_allowlists`:

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `organization_id` | VARCHAR(255) | Owning organization |
| `host` | VARCHAR(253) | Permitted hostname (stored lowercase) |
| `created_at` | TIMESTAMPTZ | Row creation time |

A unique constraint on `(organization_id, host)` prevents duplicate entries.
