import commandLineArgs from 'command-line-args'
import commandLineUsage from 'command-line-usage'
import * as fs from 'fs'
import path from 'path'
import { getServiceLogger } from '@crowd/logging'
import SequelizeRepository from '@/database/repositories/sequelizeRepository'
import MemberRepository from '@/database/repositories/memberRepository'
import { sendBulkEnrichMessage, sendNodeWorkerMessage } from '@/serverless/utils/nodeWorkerSQS'
import OrganizationRepository from '@/database/repositories/organizationRepository'
import { NodeWorkerMessageType } from '@/serverless/types/workerTypes'
import { NodeWorkerMessageBase } from '@/types/mq/nodeWorkerMessageBase'
import getUserContext from '@/database/utils/getUserContext'
import { IRepositoryOptions } from '@/database/repositories/IRepositoryOptions'
import SegmentService from '@/services/segmentService'

/* eslint-disable no-console */

const banner = fs.readFileSync(path.join(__dirname, 'banner.txt'), 'utf8')

const log = getServiceLogger()

const options = [
  {
    name: 'tenant',
    alias: 't',
    type: String,
    description: 'The unique ID of tenant that you would like to enrich.',
  },
  {
    name: 'help',
    alias: 'h',
    type: Boolean,
    description: 'Print this usage guide.',
  },
  {
    name: 'organization',
    alias: 'o',
    type: Boolean,
    defaultValue: false,
    description: 'Enrich organizations of the tenant',
  },
  {
    name: 'member',
    alias: 'm',
    type: Boolean,
    defaultValue: false,
    description: 'Enrich members of the tenant',
  },
  {
    name: 'memberIds',
    alias: 'i',
    type: String,
    description:
      'Comma separated member ids that you would like to enrich - If this option is not present, script will enrich all members given limit.',
  },
]
const sections = [
  {
    content: banner,
    raw: true,
  },
  {
    header: 'Enrich members, organizations or both of the tenant',
    content: 'Enrich all enrichable members, organizations or both of the tenant',
  },
  {
    header: 'Options',
    optionList: options,
  },
]

const usage = commandLineUsage(sections)
const parameters = commandLineArgs(options)

if (parameters.help || (!parameters.tenant && (!parameters.organization || !parameters.member))) {
  console.log(usage)
} else {
  setImmediate(async () => {
    const tenantIds = parameters.tenant.split(',')
    const enrichMembers = parameters.member
    const enrichOrganizations = parameters.organization
    const limit = 1000

    for (const tenantId of tenantIds) {
      const options = await SequelizeRepository.getDefaultIRepositoryOptions()
      const tenant = await options.database.tenant.findByPk(tenantId)

      if (!tenant) {
        log.error({ tenantId }, 'Tenant not found!')
        process.exit(1)
      } else {
        log.info(
          { tenantId },
          `Tenant found - starting enrichment operation for tenant ${tenantId}`,
        )

        const userContext: IRepositoryOptions = await getUserContext(tenantId)
        const segmentService = new SegmentService(userContext)
        const { rows: segments } = await segmentService.querySubprojects({})

        log.info({ tenantId }, `Total segments found in the tenant: ${segments.length}`)

        // get all segment ids for the tenant
        const segmentIds = segments.map((segment) => segment.id)

        const optionsWithTenant = await SequelizeRepository.getDefaultIRepositoryOptions(
          userContext,
          tenant,
          segments,
        )

        if (enrichMembers) {
          if (parameters.memberIds) {
            const memberIds = parameters.memberIds.split(',')
            await sendBulkEnrichMessage(tenantId, memberIds, segmentIds, false, true)
            log.info(
              { tenantId },
              `Enrichment message for ${memberIds.length} sent to nodejs-worker!`,
            )
          } else {
            let offset = 0
            let totalMembers = 0

            const { count } = await MemberRepository.getMemberIdsandCountForEnrich(
              { countOnly: true },
              optionsWithTenant,
            )
            totalMembers = count
            log.info({ tenantId }, `Total enrichable members found in the tenant: ${totalMembers}`)

            do {
              const { ids: memberIds } = await MemberRepository.getMemberIdsandCountForEnrich(
                { limit, offset },
                optionsWithTenant,
              )

              await sendBulkEnrichMessage(tenantId, memberIds, segmentIds, false, true)

              offset += limit
            } while (totalMembers > offset)
          }

          log.info({ tenantId }, `Members enrichment operation finished for tenant: ${tenantId}`)
        }

        if (enrichOrganizations) {
          const organizations = await OrganizationRepository.findAndCountAll({}, optionsWithTenant)

          const totalOrganizations = organizations.count

          log.info({ tenantId }, `Total organizations found in the tenant: ${totalOrganizations}`)

          const payload = {
            type: NodeWorkerMessageType.NODE_MICROSERVICE,
            service: 'enrich-organizations',
            tenantId,
            // Since there is no pagination implemented for the organizations enrichment,
            // we set a limit of 10,000 to ensure all organizations are included when enriched in bulk.
            maxEnrichLimit: 10000,
          } as NodeWorkerMessageBase

          await sendNodeWorkerMessage(tenantId, payload)
          log.info(
            { tenantId },
            `Organizations enrichment operation finished for tenant ${tenantId}`,
          )
        }
      }
    }

    process.exit(0)
  })
}
