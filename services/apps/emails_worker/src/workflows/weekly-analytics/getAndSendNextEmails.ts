import {
  proxyActivities,
  startChild,
  ParentClosePolicy,
  ChildWorkflowCancellationType,
} from '@temporalio/workflow'

import { TemporalWorkflowId } from '@crowd/types'

import * as activities from '../../activities/weekly-analytics/getNextEmails'
import { weeklySendEmailAndUpdateHistory } from './sendEmailAndUpdateHistory'

// Configure timeouts and retry policies to fetch emails to send.
const { weeklyGetNextEmails } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
})

// Configure timeouts and retry policies to fetch emails to send.
const { calculateTimes } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
})

/*
weeklyGetAndSendNextEmails is a Temporal workflow that:
  - [Activity]: Get address emails to send a new email digest to.
  - [Child Workflow]: Build and send the email for each user found in the
    previous activity. Child workflows are completely "detached" from the parent
    workflow, meaning they will continue to run and not be cancelled even if this
    one is.
*/
export async function weeklyGetAndSendNextEmails(): Promise<void> {
  const [tenants, calculatedTimes] = await Promise.all([weeklyGetNextEmails(), calculateTimes()])

  await Promise.all(
    tenants.map((tenant) => {
      return startChild(weeklySendEmailAndUpdateHistory, {
        workflowId: `${TemporalWorkflowId.EMAIL_WEEKLY_ANALYTICS}/${tenant.tenantId}`,
        cancellationType: ChildWorkflowCancellationType.ABANDON,
        parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
        workflowExecutionTimeout: '15 minutes',
        retry: {
          backoffCoefficient: 2,
          maximumAttempts: 10,
          initialInterval: 2 * 1000,
          maximumInterval: 30 * 1000,
        },
        args: [
          {
            tenantId: tenant.tenantId,
            tenantName: tenant.tenantName,
            unixEpoch: calculatedTimes.unixEpoch,
            dateTimeEndThisWeek: calculatedTimes.dateTimeEndThisWeek,
            dateTimeStartThisWeek: calculatedTimes.dateTimeStartThisWeek,
            dateTimeEndPreviousWeek: calculatedTimes.dateTimeEndPreviousWeek,
            dateTimeStartPreviousWeek: calculatedTimes.dateTimeStartPreviousWeek,
          },
        ],
        searchAttributes: {
          TenantId: [tenant.tenantId],
        },
      })
    }),
  )
}
