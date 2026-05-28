# Contracts — Error Code Catalog

This document is the authoritative reference for every error code surfaced by the
`accountability_vault` contract and mapped by the backend in
`src/middleware/errorHandler.ts`.

Keeping this catalog in sync with both the contract and the backend mapping is a
hard requirement: the string codes are part of the public API contract and **must
not be renamed or renumbered**.

---

## Error Response Envelope

All API errors are returned as a uniform JSON envelope:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "details": {},
    "requestId": "req-abc-123"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | Yes | Machine-readable code — use this for programmatic branching |
| `message` | string | Yes | Human-readable description |
| `details` | object | No | Field-level detail; only present on `VALIDATION_ERROR` |
| `requestId` | string | No | Echoed from `x-request-id` header for correlation |

---

## Error Code Catalog

The table below maps every `ErrorCode` constant defined in
`src/middleware/errorHandler.ts` to its HTTP status, meaning, and the
`AppError` factory method that produces it.

| # | Code | HTTP Status | Meaning | Factory / Trigger |
|---|------|-------------|---------|-------------------|
| 1 | `VALIDATION_ERROR` | 400 | Request payload failed schema validation. Includes field-level `details`. | `AppError.validation(msg, details)` |
| 2 | `BAD_REQUEST` | 400 | Malformed request syntax or invalid parameter that is not a schema violation. | `AppError.badRequest(msg, details?)` |
| 3 | `UNAUTHORIZED` | 401 | Authentication is required or the supplied credentials are invalid. | `AppError.unauthorized(msg?)` |
| 4 | `FORBIDDEN` | 403 | Authenticated but not authorised for the requested resource or action. | `AppError.forbidden(msg?)` |
| 5 | `NOT_FOUND` | 404 | The requested resource does not exist. Also emitted by the `notFound` middleware for unknown routes. | `AppError.notFound(msg?)` |
| 6 | `CONFLICT` | 409 | Resource state conflict, e.g. duplicate entry or concurrent modification. | `AppError.conflict(msg)` |
| 7 | `PAYLOAD_TOO_LARGE` | 413 | Request body exceeds the configured size limit. Auto-converted from express body-parser `entity.too.large` errors. | `AppError.payloadTooLarge(msg?)` |
| 8 | `UNPROCESSABLE` | 422 | Business-logic violation that cannot be resolved by the client changing the request format, e.g. deleting the last admin. | `AppError.unprocessable(msg)` |
| 9 | `RATE_LIMITED` | 429 | The caller has exceeded the allowed request rate for this endpoint. | `AppError.rateLimited(msg?)` |
| 10 | `INTERNAL_ERROR` | 500 | Unexpected server-side error. The response message is always the generic string `"Internal server error"` — no internals are leaked. | `AppError.internal(msg?)` |

---

## Factory Method Reference

```typescript
// src/middleware/errorHandler.ts

AppError.validation(message, details?)   // → 400 VALIDATION_ERROR
AppError.badRequest(message, details?)   // → 400 BAD_REQUEST
AppError.unauthorized(message?)          // → 401 UNAUTHORIZED
AppError.forbidden(message?)             // → 403 FORBIDDEN
AppError.notFound(message?)              // → 404 NOT_FOUND
AppError.conflict(message)               // → 409 CONFLICT
AppError.payloadTooLarge(message?)       // → 413 PAYLOAD_TOO_LARGE
AppError.unprocessable(message)          // → 422 UNPROCESSABLE
AppError.rateLimited(message?)           // → 429 RATE_LIMITED
AppError.internal(message?)              // → 500 INTERNAL_ERROR
```

---

## Stability Guarantee

The numeric index in the catalog table above is for documentation ordering only.
The **string code values** (e.g. `"VALIDATION_ERROR"`) are the stable identifiers
consumed by clients and must never be changed. Adding a new code is a
backwards-compatible change; removing or renaming an existing code is a breaking
change and requires a major API version bump.

---

## Cross-References

- Backend implementation: [`src/middleware/errorHandler.ts`](../src/middleware/errorHandler.ts)
- Error envelope contract: [`docs/error-contract.md`](../docs/error-contract.md)
- Unit tests: [`src/tests/errorHandler.test.ts`](../src/tests/errorHandler.test.ts)
- Body-size limit test: [`src/tests/bodyLimit.test.ts`](../src/tests/bodyLimit.test.ts)
