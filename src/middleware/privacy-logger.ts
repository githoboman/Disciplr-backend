import { Request, Response, NextFunction } from 'express'
import { utcNow } from '../utils/timestamps.js'

const SENSITIVE_FIELDS = new Set([
    'email',
    'password',
    'token',
    'accesstoken',
    'refreshtoken',
    'apikey',
    'api_key',
    'secret',
    'clientsecret',
    'creator',
    'successdestination',
    'failuredestination',
    'authorization',
    'cookie',
    'x-api-key'
])

export function shouldRedact(key: string): boolean {
    return SENSITIVE_FIELDS.has(key.toLowerCase())
}

export function redact(value: any): any {
    if (value === null || value === undefined) {
        return value
    }
    
    if (Array.isArray(value)) {
        return value.map(item => redact(item))
    }
    
    if (typeof value === 'object') {
        const result: Record<string, any> = {}
        for (const [k, v] of Object.entries(value)) {
            if (shouldRedact(k)) {
                result[k] = '***REDACTED***'
            } else {
                result[k] = redact(v)
            }
        }
        return result
    }
    
    return value
}

/**
 * Middleware to mask PII in logs.
 * For this demo, it masks IP addresses and potentially sensitive fields in request bodies.
 */
export const privacyLogger = (req: Request, _res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const maskedIp = maskIp(ip)

    const timestamp = utcNow()
    const method = req.method
    const url = req.url

    // Simple body masking for PII fields identified in PRIVACY.md
    const sanitizedBody = redact(req.body)
    const sanitizedHeaders = redact(req.headers)

    console.log(`[${timestamp}] [IP: ${maskedIp}] ${method} ${url} - Headers: ${JSON.stringify(sanitizedHeaders)} - Body: ${JSON.stringify(sanitizedBody)}`)

    next()
}

export function maskIp(ip: string): string {
    if (ip.includes(':')) {
        // IPv6
        return ip.split(':').slice(0, 3).join(':') + ':xxxx:xxxx:xxxx:xxxx:xxxx'
    }
    // IPv4
    const parts = ip.split('.')
    if (parts.length === 4) {
        return `${parts[0]}.${parts[1]}.x.x`
    }
    return 'x.x.x.x'
}
