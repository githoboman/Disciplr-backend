import { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { ParsedEvent } from '../types/horizonSync.js'

// ── API-level idempotency (in-memory store) ───────────────────────────────────

interface StoredIdempotentResponse<T = unknown> {
  requestHash: string
  resourceId: string
  response: T
}

const apiIdempotencyStore = new Map<string, StoredIdempotentResponse>()

/** Accepts alphanumeric, hyphens, underscores, and colons; 1–255 characters. */
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_\-:]{1,255}$/

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const
  constructor(message = 'Idempotency key has already been used with a different payload.') {
    super(message)
    this.name = 'IdempotencyConflictError'
  }
}

export class IdempotencyKeyValidationError extends Error {
  readonly code = 'INVALID_IDEMPOTENCY_KEY' as const
  constructor(
    message = 'Idempotency key must be 1–255 characters and contain only letters, digits, hyphens, underscores, and colons.',
  ) {
    super(message)
    this.name = 'IdempotencyKeyValidationError'
  }
}

export const validateIdempotencyKey = (key: string): void => {
  if (!IDEMPOTENCY_KEY_REGEX.test(key)) {
    throw new IdempotencyKeyValidationError()
  }
}

// Recursively sort object keys so identical payloads with different property
// ordering produce the same hash.
const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as object).sort()) {
      sorted[k] = sortKeys((value as Record<string, unknown>)[k])
    }
    return sorted
  }
  return value
}

export const hashRequestPayload = (payload: unknown): string =>
  createHash('sha256').update(JSON.stringify(sortKeys(payload ?? null))).digest('hex')

export const getIdempotentResponse = async <T>(
  key: string,
  requestHash: string,
): Promise<T | null> => {
  const record = apiIdempotencyStore.get(key)
  if (!record) return null

  if (record.requestHash !== requestHash) {
    throw new IdempotencyConflictError()
  }

  return record.response as T
}

export const saveIdempotentResponse = async <T>(
  key: string,
  requestHash: string,
  resourceId: string,
  response: T,
): Promise<void> => {
  apiIdempotencyStore.set(key, { requestHash, resourceId, response })
}

export const resetIdempotencyStore = (): void => {
  apiIdempotencyStore.clear()
}

// ── Event-level idempotency (database-backed) ─────────────────────────────────

/**
 * Handles checking and recording of processed blockchain events to ensure
 * exactly-once execution.
 */
export class IdempotencyService {
  constructor(private readonly db: Knex) {}

  /** Returns true if the event has already been committed to processed_events. */
  async isEventProcessed(eventId: string, trx?: Knex.Transaction): Promise<boolean> {
    const result = await (trx ?? this.db)('processed_events')
      .where({ event_id: eventId })
      .first()
    return !!result
  }

  /**
   * Record the event as processed.
   * MUST be called inside the same transaction as the business-logic writes.
   */
  async markEventProcessed(event: ParsedEvent, trx: Knex.Transaction): Promise<void> {
    await trx('processed_events').insert({
      event_id: event.eventId,
      transaction_hash: event.transactionHash,
      event_index: event.eventIndex,
      ledger_number: event.ledgerNumber,
      processed_at: new Date(),
      created_at: new Date(),
    })
  }

  /** Retrieve a stored API-response for a request-level idempotency key. */
  async getStoredResponse(key: string): Promise<unknown> {
    const record = await this.db('idempotency_keys').where({ key }).first()
    return record ? record.response : null
  }

  /** Persist a response for a request-level idempotency key. */
  async storeResponse(key: string, response: unknown, trx?: Knex.Transaction): Promise<void> {
    await (trx ?? this.db)('idempotency_keys').insert({
      key,
      response: typeof response === 'string' ? response : JSON.stringify(response),
      created_at: new Date(),
    })
  }
}
