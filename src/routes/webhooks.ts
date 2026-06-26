import { Router } from 'express'
import { webhookVerify } from '../middleware/webhookVerify.js'

export const webhooksRouter = Router()

// Mount the inbound webhook verification middleware for all routes in this router
webhooksRouter.use(webhookVerify)

webhooksRouter.post('/provider-callback', (req, res) => {
  // At this point, the request has been verified (HMAC, timestamp, nonce)
  // Process the webhook payload (available in req.body)
  
  res.status(200).json({ received: true })
})
