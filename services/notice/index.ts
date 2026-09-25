/**
 * Public-notice builder and issuer-notice tracker: what the API and the web's notice page call.
 *
 *   const chain = await resolveChainFacts({ rpcUrl, programId, venue, mints })
 *   const draft = buildNoticeDraft({ chain, config: loadVenueConfig(), issuerNotices, publishedOn, revisions })
 *   renderNoticeMarkdown(draft)          // the same draft as plain-English Markdown
 *   noticeDraftFor({ cluster: "fork" })  // both steps, with the deployment and listings from venue.config.json
 */
import { loadVenueConfig, type Cluster, type VenueConfigFile } from "./config.js"
import { resolveChainFacts } from "./chain.js"
import { buildNoticeDraft } from "./draft.js"
import type { IssuerNoticeRecord, NoticeDraft, RevisionEvent } from "./schema.js"

export { NOTICE_ITEMS, ORDER_CITE, type ItemSource, type NoticeItemTemplate } from "./items.js"
export { loadVenueConfig, parseVenueConfig, VENUE_CONFIG_PATH, type VenueConfigFile, type Cluster } from "./config.js"
export { resolveChainFacts, resolveProgram, resolveVenue, resolveToken, type ResolveOptions } from "./chain.js"
export { buildNoticeDraft, compareDrafts, SEC_MAILBOX, type BuildDraftInput, type FactChange } from "./draft.js"
export { renderNoticeMarkdown } from "./markdown.js"
export { trackIssuerNotice, trackIssuerNotices, chainActivation, NOTICE_WINDOW_S, ACTIVATION_ERRORS } from "./issuer.js"
export { addBusinessDays, addCalendarDays, isBusinessDay, quarterEnd, easternDate } from "./calendar.js"
export {
  recordIssuerNoticeInstruction, recordObjectionInstruction, activatePoolInstruction,
  initVenueInstruction, registerSymbolInstruction, initPoolInstruction, type VenueParams,
} from "./instructions.js"
export { venuePda, symbolPda, poolPda, programDataPda } from "./layout.js"
export {
  NoticeDraftSchema, NoticeItemSchema, ChainFactsSchema, IssuerNoticeRecordSchema, IssuerNoticeStatusSchema, RevisionEventSchema,
  type NoticeDraft, type NoticeItem, type ChainFacts, type Fact, type IssuerNoticeRecord, type IssuerNoticeStatus, type Reminder,
  type RevisionEvent, type OnChainSymbol,
} from "./schema.js"

/** Resolve and build in one call for a configured deployment; throws if its program or venue is not set. */
export async function noticeDraftFor(input: {
  cluster: Cluster; rpcUrl: string; config?: VenueConfigFile; programId?: string; venue?: string
  issuerNotices?: IssuerNoticeRecord[]; publishedOn?: string | null; revisions?: RevisionEvent[]; now?: Date
}): Promise<NoticeDraft> {
  const config = input.config ?? loadVenueConfig()
  const deployment = config.deployments[input.cluster]
  const programId = input.programId ?? deployment.programId
  const venue = input.venue ?? deployment.venue
  if (!programId || !venue) throw new Error(`no ${input.cluster} deployment in the venue config: set deployments.${input.cluster}.programId and .venue`)
  const chain = await resolveChainFacts({ rpcUrl: input.rpcUrl, programId, venue, mints: config.listings.map((l) => l.mint) })
  return buildNoticeDraft({ chain, config, issuerNotices: input.issuerNotices, publishedOn: input.publishedOn, revisions: input.revisions, now: input.now })
}
