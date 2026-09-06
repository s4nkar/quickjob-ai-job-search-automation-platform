export type TemplateCategory =
  | 'Cold DM - Recruiter'
  | 'Cold DM - Hiring Manager'
  | 'Follow-Up'
  | 'Referral Ask'
  | 'Email Outreach'
  | 'Custom'

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  'Cold DM - Recruiter',
  'Cold DM - Hiring Manager',
  'Follow-Up',
  'Referral Ask',
  'Email Outreach',
  'Custom',
]

export interface Template {
  id: string
  user_id: string
  name: string
  category: TemplateCategory
  content: string
  placeholders: string[]
  use_count: number
  created_at: string
  is_prebuilt?: boolean
}

export type ApplicationStatus =
  | 'Applied'
  | 'Phone Screen'
  | 'Interview'
  | 'Offer'
  | 'Rejected'
  | 'Withdrawn'

export const APPLICATION_STATUSES: ApplicationStatus[] = [
  'Applied',
  'Phone Screen',
  'Interview',
  'Offer',
  'Rejected',
  'Withdrawn',
]

// Applied/Phone Screen/Interview all share one "in progress" accent (matches
// the dashboard's Active/Interviewing tiles) — only the terminal states carry
// distinct semantic color: Offer (success), Rejected (error), Withdrawn (neutral).
export const STATUS_COLORS: Record<ApplicationStatus, string> = {
  Applied:       'bg-indigo-100 text-indigo-800',
  'Phone Screen': 'bg-indigo-100 text-indigo-800',
  Interview:     'bg-indigo-100 text-indigo-800',
  Offer:         'bg-emerald-100 text-emerald-800',
  Rejected:      'bg-red-100 text-red-800',
  Withdrawn:     'bg-gray-100 text-gray-800',
}

export interface JobApplication {
  id: string
  user_id: string
  company: string
  role: string
  applied_at: string
  status: ApplicationStatus
  follow_up_date: string | null
  notes: string | null
  salary_min: number | null
  salary_max: number | null
  created_at: string
  updated_at: string
}

export type CampaignStatus = 'draft' | 'queued' | 'sending' | 'completed' | 'paused' | 'failed'
export type RecipientStatus = 'queued' | 'sending' | 'sent' | 'failed'

export interface EmailCampaign {
  id: string
  user_id: string
  name: string
  subject: string
  body: string
  status: CampaignStatus
  delay_seconds: number
  created_at: string
}

export interface EmailRecipient {
  id: string
  campaign_id: string
  email: string
  name: string
  variables: Record<string, string>
  status: RecipientStatus
  sent_at: string | null
  error: string | null
}

export interface LinkedInProfile {
  name?: string
  headline?: string
  current_role?: string
  current_company?: string
  location?: string
  about?: string
  recent_experience?: string
  skills?: string[]
  education?: string
  profile_url: string
}

export interface ResumeAnalysis {
  match_score: number
  matched_keywords: string[]
  missing_keywords: Array<{ keyword: string; suggested_placement: string }>
  score_breakdown: Record<string, number>
  transferable_strengths: string[]
  critical_missing: string[]
  degraded: boolean
}

export interface ResumeTailoring {
  target_role: string
  target_company: string
  profile_headline: string
  tailored_summary: string
  bullet_rewrites: Array<{ original: string; improved: string }>
  summary: string
  validation_flags: string[]
}

export interface ResumeAiStatus {
  status: 'ok' | 'degraded'
  provider: string | null
}

export interface ResumeTailorResult {
  session_id: string
  status: 'ready' | 'failed'
  analysis: ResumeAnalysis
  tailoring: ResumeTailoring | null
  ai: ResumeAiStatus
}

export type TemplateId =
  | 'standard' | 'modern' | 'creative' | 'classic' | 'balanced'
  | 'minimalist' | 'professional' | 'corporate' | 'bold' | 'slate'
  | 'professional_compact' | 'executive' | 'insight' | 'atelier'
  | 'elegant' | 'aqua' | 'lebenslauf'

export interface TemplateMeta {
  id: TemplateId
  label: string
  desc: string
  font: string
  columns: 1 | 2
  requires_photo?: boolean
}

export interface CvExperience {
  title: string
  company: string
  location: string | null
  period: string
  bullets: string[]
}

export interface CvEducation {
  degree: string
  institution: string
  location: string | null
  period: string
  details: string | null
}

export interface CvSkill {
  category: string
  items: string
}

export interface CvProject {
  name: string
  tech: string | null
  bullets: string[]
}

export interface CvPublication {
  title: string
  venue: string
  year: string | null
}

export interface CvFeaturedProject {
  name: string
  year: string | null
  tech: string | null
  bullets: string[]
  results: string | null
}

export interface CvOtherSection {
  heading: string
  bullets: string[]
}

export interface CvData {
  full_name: string
  job_title: string
  location: string
  email: string
  phone: string | null
  github: string | null
  linkedin: string | null
  website: string | null
  work_authorization: string | null
  summary: string
  featured_project: CvFeaturedProject | null
  experience: CvExperience[]
  education: CvEducation[]
  skills: CvSkill[]
  projects: CvProject[]
  publications: CvPublication[]
  languages: string[]
  relocation: string | null
  // Catch-all for resume sections that don't fit any category above (e.g.
  // Volunteering, Patents, Awards) — preserved with their original heading
  // rather than dropped or misfiled. Editable in the editor's step tabs and
  // rendered by every template.
  other_sections: CvOtherSection[]
  // User-controlled order of section "kinds" (see SectionKey) — empty means
  // "not customized," and each template falls back to its own historical
  // hardcoded order. Excludes "relocation" (bundled with languages) and
  // treats other_sections as ONE slot (its entries keep their own array
  // order rather than being individually interleaved).
  section_order: SectionKey[]
}

export type SectionKey =
  | 'summary' | 'featured_project' | 'experience' | 'education'
  | 'skills' | 'projects' | 'publications' | 'languages' | 'other_sections'

export interface InterviewQuestion {
  question: string
  framework: string
  answer_framework: string
  tips: string[]
}

export interface SalaryResearchResult {
  job_title: string
  location: string
  median_salary: string
  salary_range: { min: string; max: string }
  factors: string[]
  negotiation_points: string[]
  data_sources: string[]
}

export type JobSearchApplicationStatus = 'saved' | 'applied' | 'skipped'

export interface JobCitation {
  source_name: string
  canonical_url: string
  job_url: string
  posted_at: string | null
  evidence: string[]
  extraction_note: string
}

export interface JobSearchResult {
  source_name: string
  provider_type: string
  external_job_id: string | null
  company: string
  role: string
  location: string
  job_url: string
  job_url_canonical: string
  posted_at: string | null
  applied: boolean
  application_status: JobSearchApplicationStatus | null
  tracked_application_id: string | null
  citation: JobCitation
  description_text: string | null
  salary_min: number | null
  salary_max: number | null
}

// Bonus finds come from Arbeitnow only, which has no country field - title
// matched, location NOT verified. Deliberately no citation/salary (no
// evidence to cite), keep this shape in sync with
// apps/api/app/modules/job_search/scoring.py::score_bonus_job's return dict.
export interface BonusJob {
  source_name: string
  provider_type: string
  external_job_id: string | null
  company: string
  role: string
  location: string
  job_url: string
  job_url_canonical: string
  posted_at: string | null
  applied: boolean
  application_status: JobSearchApplicationStatus | null
  tracked_application_id: string | null
  description_text: string | null
}

export interface JobSearchResponse {
  results: JobSearchResult[]
  bonus_jobs: BonusJob[]
  parsed_preferences: {
    keywords: string[]
    languages: string[]
    company_stage: string | null
    notes: string[]
  }
  searches_remaining: number | null
}

export interface JobSearchApplication {
  id: string
  user_id: string
  job_url: string
  job_url_canonical: string
  source_name: string
  external_job_id: string | null
  company: string
  role: string
  location: string
  job_description: string | null
  posted_at: string | null
  discovered_at: string
  applied_at: string | null
  application_status: JobSearchApplicationStatus
  tracker_application_id: string | null
  citation_payload: JobCitation
  search_context: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type StartupHuntOpportunityStatus = 'saved' | 'applied' | 'contacted' | 'skipped'
export type StartupHuntOpportunityKind = 'job' | 'outreach_lead'

export interface StartupHuntContact {
  name: string
  title: string
  contact_type: string
  email: string | null
  email_confidence: string
  linkedin_url: string | null
  source: string
  provider_chain?: string[]
}

export interface StartupHuntCompanyProfile {
  stage: string | null
  company_size: string | null
  country: string | null
  city: string | null
  english_friendly: boolean
  ai_relevance: string | null
  relocation_support: string | null
  company_website_url: string | null
  company_careers_url: string | null
  source_tags: string[]
}

export interface StartupHuntResult {
  company_name: string
  company_domain: string | null
  company_website_url: string | null
  company_careers_url: string | null
  role_title: string
  location: string
  country: string | null
  source_name: string
  source_type: string
  direct_apply_url: string | null
  canonical_job_url: string | null
  portal_job_url: string | null
  posted_at: string | null
  opportunity_kind: StartupHuntOpportunityKind
  score_total: number
  score_labels: string[]
  score_reasons: string[]
  citation: JobCitation
  company: StartupHuntCompanyProfile
  contacts: StartupHuntContact[]
  saved: boolean
  saved_status: StartupHuntOpportunityStatus | null
  saved_opportunity_id: string | null
  source_bucket?: string
  cache_hit?: boolean
  description_text?: string | null
}

export type OpportunityArtifactType = 'resume_analysis' | 'cover_letter' | 'interview_prep'

export interface OpportunityArtifact {
  id: string
  user_id: string
  opportunity_id: string | null
  artifact_type: OpportunityArtifactType
  tool_used: string
  content: string
  metadata: Record<string, unknown>
  created_at: string
}

export type StartupHuntSourceType =
  | 'greenhouse' | 'lever' | 'ashby' | 'startup_company' | 'startup_directory'
  | 'google_web' | 'web_search' | 'ats_discovery' | 'apify_actor' | 'indeed_search' | 'theirstack_search'

export type StartupHuntSourceStatus = 'resolved' | 'pending' | 'failed'

export interface StartupHuntSource {
  id: string
  user_id: string | null
  type: StartupHuntSourceType | null
  name: string
  company: string
  slug: string | null
  url: string | null
  metadata: Record<string, unknown>
  status: StartupHuntSourceStatus
  resolution_error: string | null
  created_at: string
}

export interface StartupHuntSavedOpportunity {
  id: string
  company_name: string
  company_domain: string | null
  company_website_url: string | null
  company_careers_url: string | null
  role_title: string
  location: string
  country: string | null
  source_name: string
  source_type: string
  direct_apply_url: string | null
  canonical_job_url: string | null
  portal_job_url: string | null
  opportunity_kind: StartupHuntOpportunityKind
  opportunity_status: StartupHuntOpportunityStatus
  score_total: number
  score_labels: string[]
  score_reasons: string[]
  tracker_application_id: string | null
  company_id: string | null
  citation_payload: Record<string, unknown>
  company_payload: Record<string, unknown>
  search_context: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface UserProfile {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  plan: string
  created_at: string
  // CV-specific fields
  job_title: string | null
  phone: string | null
  address_street: string | null
  address_city: string | null
  address_postal_code: string | null
  address_country: string | null
  date_of_birth: string | null
  nationality: string | null
  linkedin_url: string | null
  github_url: string | null
  website_url: string | null
  work_authorization: string | null
  cv_photo_url: string | null
  cv_email: string | null
}

// ── Startup Scout ────────────────────────────────────────────────────────────

export type ScoutCrawlStatus = 'pending' | 'crawling' | 'enriched' | 'partial' | 'failed'

export interface ScoutCompany {
  id: string
  user_id: string
  name: string
  description: string | null
  what_they_do: string | null
  funding_stage: string | null
  size_range: string | null
  location: string | null
  website: string | null
  linkedin_url: string | null
  source: string
  crawl_status: ScoutCrawlStatus
  created_at: string
  updated_at: string
}

export interface ScoutContact {
  id: string
  company_id: string
  user_id: string
  name: string | null
  title: string | null
  email: string | null
  linkedin_url: string | null
  source: 'google' | 'apollo' | 'web_scrape' | string
  source_url: string | null        // URL where this contact was found — shown as citation
  is_verified: boolean             // true when Stage 2 cross-check confirmed the person
  verification_url: string | null  // independent source that confirmed the association
  confidence: number | null
  created_at: string
}

// A filtered-out result carries the same Open/Save-relevant fields as a
// normal result - the filters that excluded it (keyword match, location,
// freshness, seniority, etc.) are heuristics, not certainties, so the UI
// offers the same actions rather than only explaining why it was hidden.
// No score fields - _score_opportunity returns before computing them for
// anything it filters out, so there's no real score to show.
export interface StartupHuntFilteredOutResult extends Omit<StartupHuntResult, 'score_total' | 'score_labels' | 'score_reasons' | 'cache_hit' | 'description_text'> {
  reason: string
}

export interface StartupHuntResponse {
  results: StartupHuntResult[]
  overflow_results: StartupHuntResult[]
  filtered_out: StartupHuntFilteredOutResult[]
  parsed_strategy: {
    keywords: string[]
    languages: string[]
    company_stage: string | null
    preferred_cities: string[]
    hidden_gem_signals: string[]
    contact_focus: string[]
  }
  configured_source_count: number
  source_result_counts: Record<string, number>
  source_diagnostics: Record<string, {
    bucket: string
    requested_limit: number
    enabled: boolean
    available: boolean
    configured: boolean
    active_sources: number
    raw_count: number
    accepted_count: number
    status: 'inactive' | 'ok' | 'filtered' | 'empty' | 'error'
    message: string
    sources: Array<{
      name: string
      type: string
      error: string | null
      raw_count: number
    }>
  }>
}
