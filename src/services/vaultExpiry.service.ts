import db from '../db/index.js'
import { createNotification } from './notification.js'

// Configurable lead times in milliseconds (72h, 24h, 1h by default)
const DEFAULT_LEAD_TIMES_MS = [
  72 * 60 * 60 * 1000, // 72 hours
  24 * 60 * 60 * 1000, // 24 hours
  1 * 60 * 60 * 1000,  // 1 hour
]

export const markVaultExpiries = async (
  opts: { now?: Date; limit?: number } = {}
): Promise<number> => {
  const now = (opts.now ?? new Date()).toISOString()

  const query = db('vaults')
    .where('status', 'active')
    .andWhere('end_date', '<=', now)

  if (opts.limit) {
    query.limit(opts.limit)
  }

  const expiredVaults = await query.select('*')

  if (expiredVaults.length === 0) return 0

  const expiredIds = expiredVaults.map(v => v.id)

  await db('vaults')
    .whereIn('id', expiredIds)
    .where('status', 'active')
    .update({ status: 'failed' })

  for (const vault of expiredVaults) {
    await createNotification({
      user_id: vault.creator,
      type: 'vault_failure',
      title: 'Vault Deadline Reached',
      message: 'A vault in your account has expired and been marked as failed.',
      data: { vaultId: vault.id }
    })
  }

  return expiredVaults.length
}

export const sendMilestoneReminders = async (
  opts: { now?: Date; leadTimesMs?: number[]; limit?: number } = {}
): Promise<number> => {
  const now = opts.now ?? new Date()
  const leadTimesMs = opts.leadTimesMs ?? DEFAULT_LEAD_TIMES_MS
  const nowMs = now.getTime()

  // Get active vaults with their milestones
  const vaultMilestones = await db('vaults')
    .join('milestones', 'vaults.id', '=', 'milestones.vault_id')
    .where('vaults.status', 'active')
    .whereIn('milestones.status', ['pending'])
    .whereNotNull('milestones.due_date')
    .select(
      'vaults.id as vault_id',
      'vaults.creator as user_id',
      'milestones.id as milestone_id',
      'milestones.title as milestone_title',
      'milestones.due_date'
    )

  let remindersSent = 0

  for (const vm of vaultMilestones) {
    if (opts.limit && remindersSent >= opts.limit) break

    const dueDate = new Date(vm.due_date)
    const dueDateMs = dueDate.getTime()
    const timeUntilDue = dueDateMs - nowMs

    // Find which lead time buckets this milestone falls into
    for (const leadTimeMs of leadTimesMs) {
      // Only send reminder if we're within the lead time window
      if (timeUntilDue > 0 && timeUntilDue <= leadTimeMs) {
        // Create idempotency key to avoid duplicate reminders
        const idempotencyKey = `milestone-reminder-${vm.milestone_id}-${leadTimeMs}`
        
        // Convert lead time to human-readable string
        const leadTimeHours = leadTimeMs / (60 * 60 * 1000)
        const leadTimeText = leadTimeHours === 1 ? '1 hour' : `${leadTimeHours} hours`

        try {
          await createNotification({
            user_id: vm.user_id,
            type: 'milestone_reminder',
            title: `Milestone Reminder: ${vm.milestone_title}`,
            message: `Your milestone is due in ${leadTimeText}! Don't forget to check in before the deadline to avoid a slash.`,
            data: { 
              vaultId: vm.vault_id, 
              milestoneId: vm.milestone_id, 
              dueDate: vm.due_date,
              leadTimeMs 
            },
            idempotency_key: idempotencyKey
          })
          remindersSent++
        } catch (err) {
          // Ignore duplicate notifications (idempotency key collision)
          console.debug(`[milestone-reminder] Skipping duplicate reminder for milestone ${vm.milestone_id}`, err)
        }
        // Break after first matching lead time to avoid sending multiple reminders for the same milestone
        break
      }
    }
  }

  return remindersSent
}