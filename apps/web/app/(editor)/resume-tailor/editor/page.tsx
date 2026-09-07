'use client'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import {
  CvData, CvExperience, CvEducation, CvSkill, CvProject, CvFeaturedProject, CvOtherSection,
  SectionKey, TemplateId, TemplateMeta,
} from '@/lib/types'
import { Button, Input, Textarea, Label, useToast, cn } from '@jobnok/ui'
import {
  ArrowLeft, Download, Loader2, Plus, Minus, Trash2, ChevronDown,
  FileText, Briefcase, GraduationCap, Wrench, FolderOpen, BookOpen,
  Languages, AlertTriangle, Star, Eye, EyeOff, Layers, RotateCcw,
  LayoutTemplate, User, GripVertical, Pencil,
} from 'lucide-react'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { TemplatePickerDialog } from './template-picker'
import { TemplateRail } from './template-rail'
import { PREVIEW_BASE_HEIGHT, PREVIEW_BASE_WIDTH, ZOOM_LEVELS } from './constants'

// ── Step-tab form ─────────────────────────────────────────────────
// One section's fields fill the form pane at a time (switched via the
// tabs below) instead of a stacked accordion — less scrolling per section,
// and each step reads as a single focused task. Tabs mirror section_order
// 1:1 (see lib/types.ts::SectionKey) so dragging a tab directly reorders
// the printed resume — "Personal Info" is the one exception, pinned first
// and non-draggable since it's contact fields, not a printed section.

type StepId = 'personal' | SectionKey

// Display label when a session hasn't been renamed yet — never persisted as
// the actual title (that stays null server-side until the user renames it),
// just what shows in the toolbar and what the PDF filename falls back to.
const DEFAULT_SESSION_TITLE = 'Primary Resume'

// Strips characters invalid across Windows/macOS/Linux filenames rather than
// just the couple that happen to break on the developer's own OS — a title
// with a "/" or ":" (e.g. "Backend Eng: Round 2") would otherwise silently
// truncate or fail the download on some platforms.
function sanitizeFilename(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').slice(0, 100) || 'Resume'
}

// Splices a Paged.js bootstrap into the raw template HTML from /preview so
// the preview shows real, correctly-broken A4 pages (matching what WeasyPrint
// will actually produce) instead of one continuous scroll. Runs INSIDE the
// preview iframe's own document — not in the main app bundle, and not
// against a plain <div> in the app's own DOM — specifically so the
// templates' bare, high-collision-risk selectors (body, p, h1, ul, li) stay
// isolated from the rest of the app exactly like they already are today.
// Requires sandbox="allow-same-origin allow-scripts" on the iframe: scripts
// to run Paged.js at all, same-origin so the ES module import resolves as a
// normal same-origin fetch (a sandboxed srcDoc iframe without
// allow-same-origin gets a unique opaque origin, which CORS-blocks module
// script fetches — classic <script> tags don't have this restriction, but
// Paged.js's browser build is only shipped as an ES module here).
//
// Injected into <head>, NOT <body> — the bootstrap script itself reads
// `document.body.innerHTML` to get the "source content" to hand to Paged.js.
// If the bootstrap's own <style>/<script> tags lived in <body> (as they
// originally did), that read would capture them too, and Paged.js's
// Previewer scans whatever source content it's given for embedded <style>
// tags and applies them while it constructs its OWN .pagedjs_page elements.
// Since our override style also targets the exact class name `.pagedjs_page`
// (for the page-gap/shadow/caption look), that created a feedback loop:
// margins and spacing intended as a one-time cosmetic wrapper got reapplied
// during Paged.js's internal layout pass, inflating each page's effective
// height and pushing content onto extra pages. Module scripts execute after
// the document finishes parsing regardless of where they sit in the document
// (deferred by default, same as a classic script with the `defer`
// attribute), so moving both tags into <head> doesn't change when this runs —
// it only keeps them out of the content Paged.js actually measures. Global
// CSS in <head> still applies normally to whatever Paged.js generates later,
// so the gap/shadow/caption styling is unaffected.
function buildPaginatedHtml(rawHtml: string, requestId: number): string {
  const bootstrap = `
<style>
  /* Overrides each template's own "@media screen { body { padding: 16mm 20mm } }"
     rule - a leftover workaround from before real pagination existed, meant
     to fake page margins on screen since @page margins normally only apply
     to print. Paged.js now applies the real per-page margins itself from
     the template's own @page rule, so that old body padding is redundant -
     left in place it stacks an extra margin around the whole page stack on
     top of the correct one Paged.js already renders per page. Comes later in
     the document than the template's own <style>, so it wins on equal
     specificity without needing !important. */
  /* Gap background matches the editor page's own background
     (bg-[#F8F8FC] in app/(editor)/layout.tsx) exactly, not white like the
     page card itself and not an arbitrary gray - a white gap next to a white
     page (both under the same soft shadow) reads as one blurry surface, and
     a mismatched gray would look like a stray color patch instead of "the
     page card ending and the real app background showing through." */
  html, body { overflow: hidden !important; margin: 0; padding: 0; background: #f8f8fc; }
  .pagedjs_pages { display: block; }
  .pagedjs_page {
    margin: 0 auto 28px; background: #fff;
    /* box-shadow blurs outward in every direction, not just where the
       y-offset points - every page has this shadow, so a strong one bleeds
       into the gap from BOTH sides (the page above bleeding down, the page
       below bleeding up) as well as sideways, visually "framing" the gap
       like it's its own bordered box instead of plain open background.
       Kept deliberately small (3px blur, no spread) so what's left is a
       barely-there paper edge, not a frame around the separator. */
    box-shadow: 0 1px 3px rgba(15,23,42,0.08);
    position: relative;
  }
  .pagedjs_page:last-child { margin-bottom: 0; }
  .pagedjs_page:not(:last-child)::after {
    content: attr(data-page-caption);
    position: absolute; left: 0; right: 0; bottom: -22px; text-align: center;
    font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #64748b;
  }
</style>
<script type="module">
  const requestId = ${requestId}
  const fallbackHeight = ${PREVIEW_BASE_HEIGHT}
  const measure = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, fallbackHeight)

  // A sandboxed srcDoc document has an opaque origin - window.location.origin
  // here is literally the string "null", which postMessage explicitly rejects
  // as an invalid targetOrigin (throws a SyntaxError). We can't know or fake a
  // real origin from inside this document, so we broadcast with '*' and let
  // the parent verify the sender via e.source identity instead of origin
  // string matching. The payload itself (requestId + a pixel height) carries
  // no sensitive data, so a wildcard target is an acceptable trade-off.
  function report(height) {
    parent.postMessage({ type: 'paged-ready', requestId, height }, '*')
  }

  // A dynamic import wrapped in try/catch, not a static "import { Previewer }
  // from ..." at the top of the module — a static import that fails (wrong
  // path, blocked request, anything) fails the WHOLE module silently with no
  // catchable error, meaning report() would never be called at all: the
  // parent's "Updating…" spinner would spin forever with zero signal, and
  // the iframe's height would never advance past its stale default, clipping
  // any page beyond the first. Also: body.innerHTML is only cleared AFTER
  // the import succeeds, so a failed import still leaves the original
  // (unpaginated, but complete and visible) content in place as a fallback
  // instead of an empty page.
  ;(async () => {
    try {
      const { Previewer } = await import('/vendor/pagedjs/paged.esm.js')
      const content = document.body.innerHTML
      document.body.innerHTML = ''
      // The 2nd arg MUST be left undefined, not []. Paged.js's Previewer only
      // auto-discovers the document's own <style>/<link> tags (via its
      // internal removeStyles()) when this argument is falsy - an empty
      // array is truthy, so passing [] silently skips auto-discovery AND
      // supplies zero rules of its own. That starves Paged.js of the
      // template's actual "@page { margin: 16mm 20mm; size: A4 }" rule (and
      // our own .pagedjs_page cosmetic <style> above), so it was falling
      // back to its own built-in default page size/margins instead of the
      // real ones - the actual cause of the mismatched spacing and wrong
      // page count, not the earlier <body>-vs-<head> placement bug.
      const flow = await new Previewer().preview(content, undefined, document.body)
      document.querySelectorAll('.pagedjs_page').forEach((page, i) => {
        page.setAttribute('data-page-caption', 'Page ' + (i + 1) + ' of ' + flow.total + ' \\u00b7 A4')
      })
      if (document.fonts && document.fonts.ready) {
        try { await document.fonts.ready } catch (e) { /* ignore */ }
      }
      report(measure())
      // Fonts/images can still shift layout slightly after the first
      // measurement settles — one late re-measure catches that without
      // needing an open-ended observer for a document that never changes
      // again once Paged.js has finished.
      setTimeout(() => report(measure()), 200)
    } catch (err) {
      report(measure())
    }
  })()
</script>
`
  const idx = rawHtml.lastIndexOf('</head>')
  return idx === -1 ? rawHtml + bootstrap : rawHtml.slice(0, idx) + bootstrap + rawHtml.slice(idx)
}

const DEFAULT_SECTION_ORDER: SectionKey[] = [
  'summary', 'featured_project', 'experience', 'education',
  'skills', 'projects', 'publications', 'languages', 'other_sections',
]

// "core" sections stay visible (and addable-to) even when empty, since
// virtually every resume has them. Optional ones stay hidden until the user
// explicitly adds one (see the "+" chips below the tab list) — matches the
// "adapt tabs to content" decision instead of always showing all 9.
const STEP_DEFS: Record<SectionKey, { label: string; core: boolean }> = {
  summary: { label: 'Summary', core: true },
  featured_project: { label: 'Featured Project', core: false },
  experience: { label: 'Experience', core: true },
  education: { label: 'Education', core: true },
  skills: { label: 'Skills', core: true },
  projects: { label: 'Projects', core: true },
  publications: { label: 'Publications', core: false },
  languages: { label: 'Languages', core: true },
  other_sections: { label: 'Other Sections', core: false },
}

function hasSectionContent(cvData: CvData, key: SectionKey): boolean {
  switch (key) {
    case 'summary': return !!cvData.summary?.trim()
    case 'featured_project': return !!cvData.featured_project
    case 'experience': return cvData.experience.length > 0
    case 'education': return cvData.education.length > 0
    case 'skills': return cvData.skills.length > 0
    case 'projects': return cvData.projects.length > 0
    case 'publications': return cvData.publications.length > 0
    case 'languages': return cvData.languages.length > 0
    case 'other_sections': return (cvData.other_sections || []).length > 0
  }
}

function sectionBadge(cvData: CvData, key: SectionKey): string | undefined {
  switch (key) {
    case 'experience': return cvData.experience.length ? String(cvData.experience.length) : undefined
    case 'education': return cvData.education.length ? String(cvData.education.length) : undefined
    case 'skills': return cvData.skills.length ? `${cvData.skills.length} categories` : undefined
    case 'projects': return cvData.projects.length ? String(cvData.projects.length) : undefined
    case 'publications': return cvData.publications.length ? String(cvData.publications.length) : undefined
    case 'other_sections': return (cvData.other_sections || []).length ? String(cvData.other_sections.length) : undefined
    case 'featured_project': return cvData.featured_project?.name ? '1' : undefined
    default: return undefined
  }
}

function SortableStepRow({ id, index, label, active, badge, onClick }: {
  id: string
  index: number
  label: string
  active: boolean
  badge?: string
  onClick: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-1.5 rounded-xl border px-2 py-2 transition-colors',
        active ? 'border-indigo-200 bg-indigo-50/70 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'
      )}
    >
      <button
        {...attributes} {...listeners}
        className="h-6 w-6 flex items-center justify-center text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing shrink-0"
        aria-label="Drag to reorder"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button onClick={onClick} className="flex items-center gap-2 flex-1 min-w-0 text-left">
        <span className={cn(
          'h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0',
          active ? 'bg-indigo-500 text-white' : 'bg-slate-100 text-slate-400'
        )}>
          {index}
        </span>
        <span className={cn('text-[13px] font-semibold leading-tight truncate flex-1', active ? 'text-slate-900' : 'text-slate-500')}>
          {label}
        </span>
        {badge && (
          <span className="text-[10px] font-semibold bg-indigo-100 text-indigo-600 rounded-full px-1.5 py-0.5 shrink-0">{badge}</span>
        )}
      </button>
    </div>
  )
}

function FieldLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <Label className={cn('text-sm font-semibold text-slate-900 mb-1.5 block', className)}>{children}</Label>
}

function SubHeading({ icon, title, badge }: { icon: React.ReactNode; title: string; badge?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="h-7 w-7 rounded-lg bg-indigo-50 text-indigo-500 flex items-center justify-center shrink-0">{icon}</span>
      <h3 className="text-sm font-bold text-slate-900 flex-1">{title}</h3>
      {badge && (
        <span className="text-[10px] font-semibold bg-indigo-100 text-indigo-600 rounded-full px-2 py-0.5">{badge}</span>
      )}
    </div>
  )
}

// ── Empty entry templates ───────────────────────────────────────────

const EMPTY_EXP: CvExperience = {
  title: '', company: '', location: null, period: '', bullets: [''],
}

const EMPTY_EDU: CvEducation = {
  degree: '', institution: '', location: null, period: '', details: null,
}

const EMPTY_PROJ: CvProject = { name: '', tech: null, bullets: [''] }
const EMPTY_OTHER_SECTION: CvOtherSection = { heading: '', bullets: [''] }

// ── Editor inner ──────────────────────────────────────────────────

function EditorInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const sessionId = searchParams.get('session_id')
  const { toast } = useToast()

  const [originalPdfUrl, setOriginalPdfUrl] = useState<string | null>(null)
  const [showOriginalPdf, setShowOriginalPdf] = useState(false)
  const [cvData, setCvData] = useState<CvData | null>(null)
  const [sessionTitle, setSessionTitle] = useState<string | null>(null)
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [templates, setTemplates] = useState<TemplateMeta[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateId>('standard')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [sessionError, setSessionError] = useState(false)
  const [sessionErrorMessage, setSessionErrorMessage] = useState<string | null>(null)
  const [profileOkForLebenslauf, setProfileOkForLebenslauf] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  // Real pagination (Paged.js, injected into the fetched HTML — see
  // buildPaginatedHtml) breaks the resume into actual A4 "page" boxes with a
  // gap + "Page X of Y" caption between them, matching what WeasyPrint will
  // actually produce. Two iframe "slots" double-buffer this: writing new
  // content into the currently-INACTIVE slot and only flipping `activeSlot`
  // once that slot's pagination finishes (paged-ready message) means the
  // visible preview keeps showing the last-good paginated result while a new
  // one is computed in the background, instead of flashing blank/unpaginated
  // content on every edit — pagination isn't free, so re-running it after
  // every debounced keystroke would otherwise be visibly janky.
  const [slotAHtml, setSlotAHtml] = useState<string | null>(null)
  const [slotBHtml, setSlotBHtml] = useState<string | null>(null)
  const [activeSlot, setActiveSlot] = useState<'a' | 'b'>('a')
  // The iframe must be sized to the FULL natural height of the paginated
  // result (all pages + gaps), not a fixed one-page height, or content gets
  // clipped and the iframe grows its own nested scrollbar instead of the
  // outer canvas scrolling the whole document.
  const [previewNaturalHeight, setPreviewNaturalHeight] = useState(PREVIEW_BASE_HEIGHT)
  const [draftSaving, setDraftSaving] = useState(false)
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null)
  const [zoom, setZoom] = useState(100)
  // Whether zoom should auto-track the canvas's available width ("fit to
  // width", like Google Docs/Figma) rather than sitting at a fixed preset.
  // Starts true so the initial render always fits whatever space the
  // form/rail panes leave, instead of assuming a fixed layout width that
  // breaks (horizontal scroll, clipped content) on narrower screens or when
  // the rail is expanded. Turns off once the user manually zooms.
  const [autoZoom, setAutoZoom] = useState(true)
  const [activeStep, setActiveStep] = useState<StepId>('personal')
  const sectionDragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [thumbnails, setThumbnails] = useState<Record<string, string> | null>(null)
  const [railCollapsed, setRailCollapsed] = useState(false)
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const thumbnailsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewCanvasRef = useRef<HTMLDivElement>(null)
  const previewIframeRefA = useRef<HTMLIFrameElement>(null)
  const previewIframeRefB = useRef<HTMLIFrameElement>(null)
  // Monotonically increasing per fetched preview — lets the message listener
  // discard a stale slot's paged-ready event if the user kept editing before
  // that slot's pagination finished (its content has already been
  // superseded, so promoting it to active would show outdated content).
  const pendingPreviewRequestIdRef = useRef(0)
  // Source of truth for "which slot is visible" for code that needs the
  // CURRENT value synchronously (the debounced fetch callback, the message
  // listener) — activeSlot state exists only to drive the visibility styles
  // in JSX, and reading it from a closure in an async callback risks staleness.
  const activeSlotRef = useRef<'a' | 'b'>('a')
  // True once either slot has ever been given content — read via ref rather
  // than checking slotAHtml/slotBHtml directly so the debounced-fetch effect
  // doesn't need those in its dependency array (which would otherwise tear
  // down and rebuild the in-flight debounce/AbortController on every
  // pagination update, not just on actual content edits).
  const anySlotEverSetRef = useRef(false)
  // Skips the autosave effect's very first fire (the initial load setting
  // cvData for the first time) — otherwise every editor visit immediately
  // PATCHes back the exact data it just fetched.
  const hasLoadedRef = useRef(false)

  // Load session's saved draft (if any) or base_cv_data + tailoring overlay,
  // plus template list + profile check. Pulled into its own callback (not
  // just inline in the effect) so the "Retry" button on a failed load can
  // re-run exactly this without a full navigation — most failures here are
  // a transient upstream AI outage/rate-limit, not a truly missing session,
  // so retrying in place is the right recovery action.
  const loadEditor = useCallback(() => {
    if (!sessionId) { setSessionErrorMessage(null); setSessionError(true); setLoading(false); return }
    setLoading(true)
    setSessionError(false)
    hasLoadedRef.current = false

    const pdfUrl = sessionStorage.getItem(`resume_original_pdf_url:${sessionId}`)
    if (pdfUrl) setOriginalPdfUrl(pdfUrl)

    Promise.all([
      apiFetch(`/api/ai/tailor/${sessionId}/editor`).then(async (r) => {
        if (r.ok) return r.json()
        const body = await r.json().catch(() => null)
        throw new Error(body?.detail || `Couldn't load resume data (HTTP ${r.status}).`)
      }),
      apiFetch('/api/profile').then(r => r.json()).catch(() => ({})),
    ]).then(([editorRes, profile]) => {
      if (editorRes.templates) setTemplates(editorRes.templates)
      if (editorRes.template_id) setSelectedTemplate(editorRes.template_id)
      setSessionTitle(editorRes.title ?? null)
      if (editorRes.cv_data) {
        setCvData(editorRes.cv_data)
        if (editorRes.is_draft) toast({ title: 'Resumed your saved draft' })
      } else {
        throw new Error('Resume data came back empty.')
      }
      const ok = !!(profile?.full_name && profile?.phone &&
        (profile?.address_city || profile?.address_country) && profile?.cv_photo_url)
      setProfileOkForLebenslauf(ok)
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Failed to load resume data.'
      setSessionErrorMessage(message)
      toast({ title: 'Failed to load resume data', description: message, variant: 'destructive' })
      setSessionError(true)
    }).finally(() => {
      setLoading(false)
      hasLoadedRef.current = true
    })
  }, [sessionId, toast])

  useEffect(() => { loadEditor() }, [loadEditor])

  // Debounced autosave of edits — mirrors the live-preview debounce below,
  // but saves to the session's draft_cv_data instead of rendering HTML.
  useEffect(() => {
    if (!cvData || !sessionId || !hasLoadedRef.current) return
    if (draftDebounceRef.current) clearTimeout(draftDebounceRef.current)
    draftDebounceRef.current = setTimeout(async () => {
      setDraftSaving(true)
      try {
        const res = await apiFetch(`/api/ai/tailor/${sessionId}/draft`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cv_data: cvData }),
        })
        if (res.ok) setDraftSavedAt(Date.now())
      } catch { /* silent — autosave, user can still download manually */ }
      finally { setDraftSaving(false) }
    }, 1500)
    return () => {
      if (draftDebounceRef.current) clearTimeout(draftDebounceRef.current)
    }
  }, [cvData, sessionId])

  // Debounced live preview fetch — 450ms, not 1500ms: this fires once per
  // typing PAUSE (not per keystroke), and /preview is a cheap Jinja-only
  // render (no AI, no PDF), so a short debounce is safe against the burst
  // limiter (3 requests/10s) while making the preview feel far more instant.
  useEffect(() => {
    if (!cvData) return
    if (!sessionId) return
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current)
    const controller = new AbortController()
    previewDebounceRef.current = setTimeout(async () => {
      // Tagged at DISPATCH time, not once the response comes back — fetches
      // can resolve out of order (a bigger multi-line edit renders slower
      // server-side than a smaller edit fired right after it), so ordering
      // by "which response arrived first" let an older edit's slow response
      // land after a newer one's and silently overwrite it with stale
      // content. Tagging by dispatch order and checking staleness the moment
      // each response arrives means whichever edit was made LAST always
      // wins, regardless of which network response happens to land first.
      const requestId = ++pendingPreviewRequestIdRef.current
      setPreviewLoading(true)
      try {
        const res = await apiFetch(`/api/ai/tailor/${sessionId}/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template_id: selectedTemplate, cv_data: cvData }),
          signal: controller.signal,
        })
        if (pendingPreviewRequestIdRef.current !== requestId) return // a newer edit already superseded this one
        if (res.ok) {
          const html = await res.text()
          if (pendingPreviewRequestIdRef.current !== requestId) return // superseded while reading the body
          const paginated = buildPaginatedHtml(html, requestId)
          // First-ever load: nothing to hold onto yet, so write straight into
          // the (visible) active slot and accept the brief pre-pagination
          // flash. Every later update writes into the INACTIVE slot instead —
          // the visible slot keeps showing the last-good paginated result
          // until this one finishes (see the message-listener effect) and
          // gets promoted, so re-editing never flashes blank/unpaginated
          // content. previewLoading deliberately stays true here — it's
          // cleared once pagination actually finishes, not once the HTTP
          // fetch resolves, since the fetch is only half the work now.
          const isFirstLoad = !anySlotEverSetRef.current
          anySlotEverSetRef.current = true
          const targetSlot: 'a' | 'b' = isFirstLoad || activeSlotRef.current === 'b' ? 'a' : 'b'
          if (targetSlot === 'a') setSlotAHtml(paginated); else setSlotBHtml(paginated)

          // Defense in depth: the injected script (buildPaginatedHtml) should
          // always eventually call report() even on its own internal
          // failures, but if something outside its control goes wrong (the
          // iframe never loads, the message gets dropped, a browser quirk)
          // there'd be nothing to stop the "Updating…" spinner from spinning
          // forever with the second page permanently clipped. If this exact
          // request is still unacknowledged after 6s, fall back to reading
          // the iframe's height directly (allow-same-origin permits this)
          // and force it active — degraded (unpaginated) but visible and
          // correctly sized, never stuck.
          setTimeout(() => {
            if (pendingPreviewRequestIdRef.current !== requestId) return // superseded by a newer edit
            if (activeSlotRef.current === targetSlot) return // already promoted — the message arrived in time
            const targetRef = targetSlot === 'a' ? previewIframeRefA : previewIframeRefB
            const doc = targetRef.current?.contentDocument
            const height = doc
              ? Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, PREVIEW_BASE_HEIGHT)
              : PREVIEW_BASE_HEIGHT
            activeSlotRef.current = targetSlot
            setActiveSlot(targetSlot)
            setPreviewNaturalHeight(height)
            setPreviewLoading(false)
          }, 6000)
        } else {
          setPreviewLoading(false)
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError' && pendingPreviewRequestIdRef.current === requestId) setPreviewLoading(false)
      }
    }, 450)
    return () => {
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current)
      controller.abort()
    }
  }, [cvData, selectedTemplate, sessionId])

  // Receives "pagination finished" from whichever preview iframe slot just
  // ran Paged.js (see buildPaginatedHtml) — onLoad fires far too early for
  // this (before Paged.js has restructured the document), so completion has
  // to come from the iframe's own script instead. No dependency array reads
  // matter here since every value needed is read through a ref, not a
  // closure, so this listener never goes stale across re-renders.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // The preview iframe is a sandboxed srcDoc document, so it has an
      // opaque origin and broadcasts with postMessage(..., '*') - e.origin
      // is always the string "null" here, never window.location.origin.
      // e.source identity is the real check: it can only match a window we
      // ourselves created and are actively tracking as a preview slot.
      if (!e.data || e.data.type !== 'paged-ready') return
      if (e.data.requestId !== pendingPreviewRequestIdRef.current) return // superseded by a newer edit
      const fromA = e.source === previewIframeRefA.current?.contentWindow
      const fromB = e.source === previewIframeRefB.current?.contentWindow
      if (!fromA && !fromB) return
      const slot: 'a' | 'b' = fromA ? 'a' : 'b'
      activeSlotRef.current = slot
      setActiveSlot(slot)
      const height = e.data.height
      setPreviewNaturalHeight(typeof height === 'number' && height > 0 ? height : PREVIEW_BASE_HEIGHT)
      setPreviewLoading(false)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Debounced live thumbnails fetch — powers the template rail/dialog's
  // real-content swatches. Renders EVERY template in one backend call rather
  // than one /preview call per template (see routes.py's comment: firing 17
  // individual calls would blow through the per-user burst limit almost
  // immediately). Skipped while the rail is collapsed since nothing is
  // showing the thumbnails anyway. Every one of the 17 templates' rendered
  // HTML genuinely changes whenever any field does (the edited text shows up
  // in all of them), so each fetch that lands forces all 17 thumbnail
  // iframes to reload — a real, unavoidable cost of "live" thumbnails, not a
  // bug. What IS tunable is how often that lands: 6s (not the main preview's
  // 450ms, and longer than an earlier 2.5s) so an ordinary pause mid-typing
  // doesn't repeatedly retrigger a visible reload flash across the whole
  // rail — it only fires once actual editing has settled.
  useEffect(() => {
    if (!cvData || !sessionId || railCollapsed) return
    if (thumbnailsDebounceRef.current) clearTimeout(thumbnailsDebounceRef.current)
    const controller = new AbortController()
    thumbnailsDebounceRef.current = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/ai/tailor/${sessionId}/preview/thumbnails`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cv_data: cvData }),
          signal: controller.signal,
        })
        if (res.ok) {
          const json = await res.json()
          setThumbnails(json.thumbnails)
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') { /* silent — thumbnails are cosmetic */ }
      }
    }, 6000)
    return () => {
      if (thumbnailsDebounceRef.current) clearTimeout(thumbnailsDebounceRef.current)
      controller.abort()
    }
  }, [cvData, sessionId, railCollapsed])

  const set = useCallback(<K extends keyof CvData>(key: K, value: CvData[K]) => {
    setCvData(prev => prev ? { ...prev, [key]: value } : prev)
  }, [])

  // zoom is continuous while autoZoom is on (it tracks the canvas's actual
  // available width, which rarely lands exactly on a preset), so stepping
  // uses "next preset above/below the current value" rather than
  // indexOf-based stepping, which would silently no-op on a non-preset value.
  function zoomOut() {
    setAutoZoom(false)
    setZoom(z => [...ZOOM_LEVELS].reverse().find(l => l < Math.round(z)) ?? ZOOM_LEVELS[0])
  }
  function zoomIn() {
    setAutoZoom(false)
    setZoom(z => ZOOM_LEVELS.find(l => l > Math.round(z)) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1])
  }
  function resetZoomToFit() {
    setAutoZoom(true)
  }

  // Auto-fit: a CEILING, not a discount. Target a comfortable 80% by
  // default, but only drop below that if the container genuinely can't fit
  // 80% without overflowing — never shrink further than what's actually
  // necessary. A flat multiplier (tried previously) compounds instead of
  // helping: on a container that only fits ~72% before any discount,
  // multiplying by 0.8 produces an unreadable ~58%. A ceiling fixes both
  // complaints at once — wide screens cap at a comfortable 80% instead of
  // stretching to fill 100%+, narrow screens still get the largest size that
  // actually fits, unmodified. A ResizeObserver (not just a window resize
  // listener) so toggling the rail — which changes available width without
  // resizing the window — also re-fits. `loading` is in the deps for a real
  // reason, not just as a safety net: on first mount this effect runs while
  // the page is still in its loading state, before the canvas <div> (and
  // previewCanvasRef) exist in the DOM — `el` is null, so it bails out
  // immediately without ever attaching the ResizeObserver. Since `autoZoom`
  // itself never changes on a normal page load, nothing would otherwise
  // re-run this effect once the canvas actually mounts. Including `loading`
  // makes the effect re-run the moment the canvas becomes available.
  useEffect(() => {
    if (!autoZoom) return
    const el = previewCanvasRef.current
    if (!el) return
    const COMFORT_ZOOM_CAP = 90
    const compute = () => {
      const style = window.getComputedStyle(el)
      const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      // A few px of safety margin below the exact fit — rounding the fitted
      // width up to the pixel can leave it 1-2px wider than the container,
      // which is enough for the browser to spawn a horizontal scrollbar and
      // (with justify-center) clip both edges instead of neither.
      const availableWidth = el.clientWidth - paddingX - 4
      if (availableWidth <= 0) return
      const rawFitPercent = Math.min(
        ZOOM_LEVELS[ZOOM_LEVELS.length - 1],
        Math.max(ZOOM_LEVELS[0], (availableWidth / PREVIEW_BASE_WIDTH) * 100)
      )
      const fitPercent = Math.min(COMFORT_ZOOM_CAP, rawFitPercent)
      setZoom(Math.floor(fitPercent))
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [autoZoom, loading])

  // ── Experience helpers ──────────────────────────────────────────

  function updateExp(i: number, field: keyof CvExperience, value: string | string[] | null) {
    setCvData(prev => {
      if (!prev) return prev
      const exp = [...prev.experience]
      exp[i] = { ...exp[i], [field]: value }
      return { ...prev, experience: exp }
    })
  }

  function addExp() {
    setCvData(prev => prev ? { ...prev, experience: [...prev.experience, { ...EMPTY_EXP }] } : prev)
  }

  function removeExp(i: number) {
    setCvData(prev => prev ? { ...prev, experience: prev.experience.filter((_, idx) => idx !== i) } : prev)
  }

  function updateExpBullet(expIdx: number, bulletIdx: number, value: string) {
    setCvData(prev => {
      if (!prev) return prev
      const exp = [...prev.experience]
      const bullets = [...exp[expIdx].bullets]
      bullets[bulletIdx] = value
      exp[expIdx] = { ...exp[expIdx], bullets }
      return { ...prev, experience: exp }
    })
  }

  function addExpBullet(expIdx: number) {
    setCvData(prev => {
      if (!prev) return prev
      const exp = [...prev.experience]
      exp[expIdx] = { ...exp[expIdx], bullets: [...exp[expIdx].bullets, ''] }
      return { ...prev, experience: exp }
    })
  }

  function removeExpBullet(expIdx: number, bulletIdx: number) {
    setCvData(prev => {
      if (!prev) return prev
      const exp = [...prev.experience]
      exp[expIdx] = { ...exp[expIdx], bullets: exp[expIdx].bullets.filter((_, i) => i !== bulletIdx) }
      return { ...prev, experience: exp }
    })
  }

  // ── Education helpers ───────────────────────────────────────────

  function updateEdu(i: number, field: keyof CvEducation, value: string | null) {
    setCvData(prev => {
      if (!prev) return prev
      const education = [...prev.education]
      education[i] = { ...education[i], [field]: value }
      return { ...prev, education }
    })
  }

  function addEdu() {
    setCvData(prev => prev ? { ...prev, education: [...prev.education, { ...EMPTY_EDU }] } : prev)
  }

  function removeEdu(i: number) {
    setCvData(prev => prev ? { ...prev, education: prev.education.filter((_, idx) => idx !== i) } : prev)
  }

  // ── Skills helpers ──────────────────────────────────────────────

  function updateSkill(i: number, field: keyof CvSkill, value: string) {
    setCvData(prev => {
      if (!prev) return prev
      const skills = [...prev.skills]
      skills[i] = { ...skills[i], [field]: value }
      return { ...prev, skills }
    })
  }

  function addSkill() {
    setCvData(prev => prev ? { ...prev, skills: [...prev.skills, { category: '', items: '' }] } : prev)
  }

  function removeSkill(i: number) {
    setCvData(prev => prev ? { ...prev, skills: prev.skills.filter((_, idx) => idx !== i) } : prev)
  }

  // ── Project helpers ─────────────────────────────────────────────

  function updateProject(i: number, field: keyof CvProject, value: string | string[] | null) {
    setCvData(prev => {
      if (!prev) return prev
      const projects = [...prev.projects]
      projects[i] = { ...projects[i], [field]: value }
      return { ...prev, projects }
    })
  }

  function addProject() {
    setCvData(prev => prev ? { ...prev, projects: [...prev.projects, { ...EMPTY_PROJ }] } : prev)
  }

  function removeProject(i: number) {
    setCvData(prev => prev ? { ...prev, projects: prev.projects.filter((_, idx) => idx !== i) } : prev)
  }

  // ── Publication helpers ─────────────────────────────────────────

  function addPublication() {
    setCvData(prev => prev ? { ...prev, publications: [...prev.publications, { title: '', venue: '', year: null }] } : prev)
  }

  function removePublication(i: number) {
    setCvData(prev => prev ? { ...prev, publications: prev.publications.filter((_, idx) => idx !== i) } : prev)
  }

  // ── Other-section helpers ────────────────────────────────────────
  // Catch-all for resume sections that don't fit any fixed category
  // (Volunteering, Patents, Awards, ...) — see CvOtherSection.

  function updateOtherSection(i: number, field: keyof CvOtherSection, value: string | string[]) {
    setCvData(prev => {
      if (!prev) return prev
      const sections = [...(prev.other_sections || [])]
      sections[i] = { ...sections[i], [field]: value }
      return { ...prev, other_sections: sections }
    })
  }

  function addOtherSection() {
    setCvData(prev => prev ? { ...prev, other_sections: [...(prev.other_sections || []), { ...EMPTY_OTHER_SECTION }] } : prev)
  }

  function removeOtherSection(i: number) {
    setCvData(prev => prev ? { ...prev, other_sections: (prev.other_sections || []).filter((_, idx) => idx !== i) } : prev)
  }

  // ── Featured project helpers ────────────────────────────────────

  function updateFeatured<K extends keyof CvFeaturedProject>(field: K, value: CvFeaturedProject[K]) {
    setCvData(prev => {
      if (!prev) return prev
      const fp = prev.featured_project ?? { name: '', year: null, tech: null, bullets: [], results: null }
      return { ...prev, featured_project: { ...fp, [field]: value } }
    })
  }

  function updateFeaturedBullet(bulletIdx: number, value: string) {
    setCvData(prev => {
      if (!prev?.featured_project) return prev
      const bullets = [...prev.featured_project.bullets]
      bullets[bulletIdx] = value
      return { ...prev, featured_project: { ...prev.featured_project, bullets } }
    })
  }

  function addFeaturedBullet() {
    setCvData(prev => {
      if (!prev) return prev
      const fp = prev.featured_project ?? { name: '', year: null, tech: null, bullets: [], results: null }
      return { ...prev, featured_project: { ...fp, bullets: [...fp.bullets, ''] } }
    })
  }

  function removeFeaturedBullet(bulletIdx: number) {
    setCvData(prev => {
      if (!prev?.featured_project) return prev
      return {
        ...prev,
        featured_project: {
          ...prev.featured_project,
          bullets: prev.featured_project.bullets.filter((_, i) => i !== bulletIdx),
        },
      }
    })
  }

  // ── Template selection with lebenslauf guard ────────────────────

  function selectTemplate(id: TemplateId) {
    if (id === 'lebenslauf' && !profileOkForLebenslauf) {
      toast({
        title: 'Profile incomplete',
        description: 'Lebenslauf requires a photo, phone, and city. Complete your profile first.',
        variant: 'destructive',
      })
      return
    }
    setSelectedTemplate(id)
  }

  // ── Rename session ───────────────────────────────────────────────

  async function saveTitle(newTitle: string) {
    const trimmed = newTitle.trim()
    setTitleEditing(false)
    if (!sessionId || !trimmed || trimmed === (sessionTitle ?? DEFAULT_SESSION_TITLE)) return
    try {
      const res = await apiFetch(`/api/ai/tailor/${sessionId}/title`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      })
      if (res.ok) {
        setSessionTitle(trimmed)
      } else {
        const json = await res.json().catch(() => null)
        toast({ title: json?.detail || 'Could not rename resume', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Network error renaming resume', variant: 'destructive' })
    }
  }

  // ── Download ────────────────────────────────────────────────────

  async function handleDownload() {
    if (!cvData || !sessionId) return
    setGenerating(true)
    try {
      const res = await apiFetch(`/api/ai/tailor/${sessionId}/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: selectedTemplate, cv_data: cvData }),
      })
      if (!res.ok) {
        const json = await res.json()
        toast({ title: json.detail || 'Generation failed', variant: 'destructive' })
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${sanitizeFilename(sessionTitle ?? DEFAULT_SESSION_TITLE)}.pdf`
      a.click()
      URL.revokeObjectURL(url)
      toast({ title: 'PDF downloaded!' })
    } catch {
      toast({ title: 'Network error', variant: 'destructive' })
    } finally {
      setGenerating(false)
    }
  }

  // ── Empty / loading states ──────────────────────────────────────

  if (sessionError) {
    const noSession = !sessionId
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 px-4">
        <AlertTriangle className="h-10 w-10 text-amber-400" />
        <p className="font-semibold text-slate-700">{noSession ? 'Session expired' : 'Could not load your resume'}</p>
        <p className="text-sm text-slate-500 max-w-sm text-center">
          {noSession
            ? 'Run a new analysis to open the editor.'
            : (sessionErrorMessage || 'Something went wrong loading this session.')}
        </p>
        <div className="flex gap-3">
          {!noSession && (
            <Button onClick={loadEditor} className="rounded-xl gradient-brand text-white border-0 shadow-brand-sm hover:opacity-90">
              <RotateCcw className="h-4 w-4 mr-2" /> Retry
            </Button>
          )}
          <Button onClick={() => router.push('/resume-tailor')} variant="outline" className="rounded-xl">
            <ArrowLeft className="h-4 w-4 mr-2" /> Back to Resume Tailor
          </Button>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <Loader2 className="h-10 w-10 animate-spin text-indigo-500" />
        <p className="font-semibold text-slate-700">Structuring your resume…</p>
        <p className="text-sm text-slate-400">This takes about 10–20 seconds</p>
      </div>
    )
  }

  if (!cvData) return null

  const fp = cvData.featured_project
  const currentTemplateLabel = templates.find(t => t.id === selectedTemplate)?.label ?? selectedTemplate

  const orderedSectionKeys = cvData.section_order?.length ? cvData.section_order : DEFAULT_SECTION_ORDER
  const visibleSectionKeys = orderedSectionKeys.filter(key => STEP_DEFS[key].core || hasSectionContent(cvData, key))
  const hiddenOptionalKeys = orderedSectionKeys.filter(key => !STEP_DEFS[key].core && !hasSectionContent(cvData, key))

  function addOptionalSection(key: SectionKey) {
    if (key === 'featured_project') set('featured_project', { name: '', year: null, tech: null, bullets: [''], results: null })
    else if (key === 'publications') addPublication()
    else if (key === 'other_sections') addOtherSection()
  }

  function handleSectionDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = visibleSectionKeys.indexOf(active.id as SectionKey)
    const newIndex = visibleSectionKeys.indexOf(over.id as SectionKey)
    if (oldIndex === -1 || newIndex === -1) return
    const reorderedVisible = arrayMove(visibleSectionKeys, oldIndex, newIndex)
    const hiddenKeys = orderedSectionKeys.filter(k => !visibleSectionKeys.includes(k))
    set('section_order', [...reorderedVisible, ...hiddenKeys])
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Toolbar ── */}
      <div className="sticky top-0 z-20 h-16 shrink-0 bg-white/95 backdrop-blur border-b border-slate-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)] flex items-center gap-2 sm:gap-4 px-4 sm:px-6 lg:px-8">
        <button
          onClick={() => router.push('/resume-tailor')}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors shrink-0"
        >
          <ArrowLeft className="h-4 w-4" /> <span className="hidden sm:inline">Back</span>
        </button>

        <div className="hidden md:flex items-center gap-2.5 shrink-0 mr-2 min-w-0">
          <div className="h-8 w-8 rounded-lg bg-indigo-50 text-indigo-500 flex items-center justify-center shrink-0">
            <FileText className="h-4 w-4" />
          </div>
          <div className="flex flex-col min-w-0">
            {titleEditing ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={e => setTitleDraft(e.target.value)}
                onFocus={e => e.currentTarget.select()}
                onBlur={e => saveTitle(e.currentTarget.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setTitleEditing(false)
                }}
                maxLength={200}
                className="text-sm font-semibold text-slate-900 leading-tight bg-white border border-indigo-300 rounded px-1 -mx-1 outline-none ring-2 ring-indigo-100 w-44"
              />
            ) : (
              <button
                onClick={() => { setTitleDraft(sessionTitle ?? DEFAULT_SESSION_TITLE); setTitleEditing(true) }}
                className="group flex items-center gap-1.5 min-w-0 text-left"
                title="Rename this resume"
              >
                <span className="text-sm font-semibold text-slate-900 leading-tight truncate max-w-[180px]">
                  Editing: {sessionTitle ?? DEFAULT_SESSION_TITLE}
                </span>
                <Pencil className="h-3 w-3 text-slate-500 transition-colors shrink-0" />
              </button>
            )}
            <span className="text-[11px] text-slate-400 leading-tight flex items-center gap-1">
              {draftSaving ? 'Saving…' : draftSavedAt ? <span className="text-emerald-500 font-medium">Saved</span> : 'Edit content · pick layout · download PDF'}
            </span>
          </div>
        </div>

        <div className="flex-1" />

        {/* Change template — mobile/tablet only; the desktop layouts rail replaces this */}
        <button
          onClick={() => setTemplatePickerOpen(true)}
          className="lg:hidden flex items-center gap-2 h-9 px-3 rounded-lg border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors shrink-0"
        >
          <LayoutTemplate className="h-4 w-4 text-slate-400" />
          <span className="text-xs font-semibold text-slate-700 hidden sm:inline">{currentTemplateLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
        </button>

        {/* Compare to original — mobile/tablet only; folded into the control cluster on desktop */}
        {originalPdfUrl && (
          <button
            onClick={() => setShowOriginalPdf(v => !v)}
            title={showOriginalPdf ? 'Hide original PDF' : 'Compare to original PDF'}
            className={cn(
              'lg:hidden h-9 w-9 flex items-center justify-center rounded-lg border transition-colors shrink-0',
              showOriginalPdf ? 'border-indigo-200 bg-indigo-50 text-indigo-600' : 'border-slate-200 text-slate-500 hover:bg-slate-50'
            )}
          >
            {showOriginalPdf ? <EyeOff className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
          </button>
        )}

        {/* Control cluster: zoom + compare-original, grouped (desktop only) */}
        <div className="hidden lg:flex items-center gap-0.5 bg-slate-100/80 rounded-xl p-1 shrink-0">
          <div className="flex items-center gap-1 px-0.5">
            <button
              onClick={zoomOut}
              disabled={zoom <= ZOOM_LEVELS[0]}
              className="h-7 w-7 flex items-center justify-center rounded-lg text-slate-500 hover:bg-white hover:shadow-sm disabled:opacity-30 transition-all"
              aria-label="Zoom out"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={resetZoomToFit}
              title={autoZoom ? 'Fitted to width' : 'Reset to fit width'}
              className={cn(
                'text-xs font-semibold w-10 text-center tabular-nums rounded-md py-0.5 transition-colors',
                autoZoom ? 'text-indigo-600' : 'text-slate-600 hover:bg-white'
              )}
            >
              {Math.round(zoom)}%
            </button>
            <button
              onClick={zoomIn}
              disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
              className="h-7 w-7 flex items-center justify-center rounded-lg text-slate-500 hover:bg-white hover:shadow-sm disabled:opacity-30 transition-all"
              aria-label="Zoom in"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {originalPdfUrl && (
            <>
              <div className="h-5 w-px bg-slate-200 mx-0.5" />
              <button
                onClick={() => setShowOriginalPdf(v => !v)}
                title={showOriginalPdf ? 'Hide original PDF' : 'Compare to original PDF'}
                className={cn(
                  'h-7 w-7 flex items-center justify-center rounded-lg transition-all',
                  showOriginalPdf ? 'bg-indigo-500 text-white shadow-sm' : 'text-slate-500 hover:bg-white hover:shadow-sm'
                )}
              >
                {showOriginalPdf ? <EyeOff className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
              </button>
            </>
          )}
        </div>

        <Button
          onClick={handleDownload}
          disabled={generating}
          className="h-9 gradient-brand text-white border-0 shadow-brand-sm hover:opacity-90 rounded-lg font-semibold text-sm px-4 shrink-0"
        >
          {generating
            ? <><Loader2 className="h-4 w-4 sm:mr-2 animate-spin" /> <span className="hidden sm:inline">Generating…</span></>
            : <><Download className="h-4 w-4 sm:mr-2" /> <span className="hidden sm:inline">Download PDF</span></>
          }
        </Button>
      </div>

      {/* ── Body: form + preview + layouts rail ── */}
      <div className="flex-1 flex flex-col lg:flex-row gap-6 px-4 sm:px-6 lg:px-8 py-6 min-w-0">

        {/* LEFT: form */}
        <div className="lg:w-[380px] xl:w-[420px] shrink-0 space-y-4 lg:sticky lg:top-[88px] lg:h-[calc(100vh-104px)] lg:overflow-y-auto lg:pr-2 scrollbar-thin">

          {/* Step tabs — vertical, draggable. Personal Info is pinned (not a
              printed section, doesn't participate in section_order); the
              rest mirror section_order 1:1, so dragging a row here directly
              reorders the printed resume. */}
          <div className="space-y-2">
            <button
              onClick={() => setActiveStep('personal')}
              className={cn(
                'w-full flex items-center gap-2 rounded-xl border px-2 py-2 transition-colors',
                activeStep === 'personal' ? 'border-indigo-200 bg-indigo-50/70 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'
              )}
            >
              <span className="h-6 w-6 flex items-center justify-center shrink-0" />
              <span className={cn(
                'h-6 w-6 rounded-full flex items-center justify-center shrink-0',
                activeStep === 'personal' ? 'bg-indigo-500 text-white' : 'bg-slate-100 text-slate-400'
              )}>
                <User className="h-3.5 w-3.5" />
              </span>
              <span className={cn('text-[13px] font-semibold leading-tight text-left flex-1', activeStep === 'personal' ? 'text-slate-900' : 'text-slate-500')}>
                Personal Info
              </span>
            </button>

            <DndContext sensors={sectionDragSensors} collisionDetection={closestCenter} onDragEnd={handleSectionDragEnd}>
              <SortableContext items={visibleSectionKeys} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {visibleSectionKeys.map((key, idx) => (
                    <SortableStepRow
                      key={key}
                      id={key}
                      index={idx + 1}
                      label={STEP_DEFS[key].label}
                      active={activeStep === key}
                      badge={sectionBadge(cvData, key)}
                      onClick={() => setActiveStep(key)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            {hiddenOptionalKeys.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {hiddenOptionalKeys.map(key => (
                  <button
                    key={key}
                    onClick={() => { addOptionalSection(key); setActiveStep(key) }}
                    className="text-[11px] font-medium text-indigo-500 hover:text-indigo-700 bg-indigo-50/60 hover:bg-indigo-50 rounded-full px-2.5 py-1 flex items-center gap-1"
                  >
                    <Plus className="h-3 w-3" /> {STEP_DEFS[key].label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Active step content */}
          <div className="bg-white rounded-2xl border border-slate-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)] p-5 space-y-5">

            {activeStep === 'personal' && (
              <>
                <h2 className="text-base font-bold text-slate-900">Personal Information</h2>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <FieldLabel>Full Name</FieldLabel>
                    <Input value={cvData.full_name} onChange={e => set('full_name', e.target.value)} className="h-11 text-sm rounded-xl" />
                  </div>
                  <div className="col-span-2">
                    <FieldLabel>Professional Title</FieldLabel>
                    <Input value={cvData.job_title} onChange={e => set('job_title', e.target.value)} className="h-11 text-sm rounded-xl" />
                  </div>
                  <div>
                    <FieldLabel>Email</FieldLabel>
                    <Input value={cvData.email} onChange={e => set('email', e.target.value)} className="h-11 text-sm rounded-xl" />
                  </div>
                  <div>
                    <FieldLabel>Phone</FieldLabel>
                    <Input value={cvData.phone ?? ''} onChange={e => set('phone', e.target.value || null)} className="h-11 text-sm rounded-xl" />
                  </div>
                  <div>
                    <FieldLabel>Location</FieldLabel>
                    <Input value={cvData.location} onChange={e => set('location', e.target.value)} className="h-11 text-sm rounded-xl" />
                  </div>
                  <div>
                    <FieldLabel>Work Auth</FieldLabel>
                    <Input value={cvData.work_authorization ?? ''} onChange={e => set('work_authorization', e.target.value || null)} className="h-11 text-sm rounded-xl" />
                  </div>
                  <div>
                    <FieldLabel>LinkedIn</FieldLabel>
                    <Input value={cvData.linkedin ?? ''} onChange={e => set('linkedin', e.target.value || null)} className="h-11 text-sm rounded-xl" />
                  </div>
                  <div>
                    <FieldLabel>GitHub</FieldLabel>
                    <Input value={cvData.github ?? ''} onChange={e => set('github', e.target.value || null)} className="h-11 text-sm rounded-xl" />
                  </div>
                  <div className="col-span-2">
                    <FieldLabel>Website</FieldLabel>
                    <Input value={cvData.website ?? ''} onChange={e => set('website', e.target.value || null)} className="h-11 text-sm rounded-xl" />
                  </div>
                </div>
              </>
            )}

            {activeStep === 'summary' && (
              <>
                <SubHeading icon={<FileText className="h-4 w-4" />} title="Career Summary" />
                <Textarea
                  value={cvData.summary}
                  onChange={e => set('summary', e.target.value)}
                  rows={8}
                  className="text-sm rounded-xl border-slate-200 resize-none"
                />
              </>
            )}

            {activeStep === 'skills' && (
              <>
                <SubHeading icon={<Wrench className="h-4 w-4" />} title="Skills" badge={`${cvData.skills.length} categories`} />
                <div className="space-y-2">
                  {cvData.skills.map((skill, i) => (
                    <div key={i} className="border border-slate-200/70 rounded-xl p-4 space-y-2 bg-slate-50/60">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-slate-500 font-medium">{skill.category || `Category ${i + 1}`}</span>
                        <button onClick={() => removeSkill(i)} className="text-slate-300 hover:text-red-400">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div>
                        <FieldLabel>Category name</FieldLabel>
                        <Input value={skill.category} onChange={e => updateSkill(i, 'category', e.target.value)} className="h-11 text-sm rounded-xl bg-white" />
                      </div>
                      <div>
                        <FieldLabel>Items (comma-separated)</FieldLabel>
                        <Input value={skill.items} onChange={e => updateSkill(i, 'items', e.target.value)} className="h-11 text-sm rounded-xl bg-white" />
                      </div>
                    </div>
                  ))}
                </div>
                <Button variant="outline" size="sm" className="w-full rounded-xl border-dashed text-slate-500 text-xs" onClick={addSkill}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Skill Category
                </Button>
              </>
            )}

            {activeStep === 'featured_project' && (
              <>
                <SubHeading icon={<Star className="h-4 w-4" />} title="Featured Project" badge={fp?.name ? '1' : undefined} />
                {fp !== null && fp !== undefined && (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <FieldLabel className="mb-0">Project</FieldLabel>
                      <button
                        onClick={() => set('featured_project', null)}
                        className="text-[10px] text-red-400 hover:text-red-600 flex items-center gap-0.5"
                      >
                        <Trash2 className="h-3 w-3" /> Remove
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="col-span-2">
                        <FieldLabel>Name</FieldLabel>
                        <Input value={fp.name} onChange={e => updateFeatured('name', e.target.value)} className="h-11 text-sm rounded-xl" />
                      </div>
                      <div>
                        <FieldLabel>Year</FieldLabel>
                        <Input value={fp.year ?? ''} onChange={e => updateFeatured('year', e.target.value || null)} className="h-11 text-sm rounded-xl" />
                      </div>
                      <div>
                        <FieldLabel>Tech stack</FieldLabel>
                        <Input value={fp.tech ?? ''} onChange={e => updateFeatured('tech', e.target.value || null)} className="h-11 text-sm rounded-xl" />
                      </div>
                      <div className="col-span-2">
                        <FieldLabel>Key result / impact</FieldLabel>
                        <Input value={fp.results ?? ''} onChange={e => updateFeatured('results', e.target.value || null)} className="h-11 text-sm rounded-xl" />
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <FieldLabel className="mb-0">Bullets</FieldLabel>
                        <button onClick={addFeaturedBullet} className="text-[10px] text-indigo-500 hover:text-indigo-700 font-medium flex items-center gap-0.5">
                          <Plus className="h-3 w-3" /> Add
                        </button>
                      </div>
                      <div className="space-y-1.5">
                        {fp.bullets.map((b, bi) => (
                          <div key={bi} className="flex gap-1.5">
                            <Textarea
                              value={b}
                              onChange={e => updateFeaturedBullet(bi, e.target.value)}
                              rows={2}
                              className="text-xs rounded-xl border-slate-200 resize-none flex-1"
                            />
                            <button onClick={() => removeFeaturedBullet(bi)} className="text-slate-300 hover:text-red-400 mt-1 shrink-0">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {activeStep === 'experience' && (
              <>
                <SubHeading icon={<Briefcase className="h-4 w-4" />} title="Experience" badge={String(cvData.experience.length)} />
                <div className="space-y-3">
                  {cvData.experience.map((exp, i) => (
                    <div key={i} className="border border-slate-200/70 rounded-xl p-4 space-y-2.5 bg-slate-50/60">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-slate-500">Entry {i + 1}</span>
                        <button
                          onClick={() => removeExp(i)}
                          className="text-slate-300 hover:text-red-400 flex items-center gap-0.5 text-[10px]"
                        >
                          <Trash2 className="h-3 w-3" /> Remove
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="col-span-2">
                          <FieldLabel>Job Title</FieldLabel>
                          <Input value={exp.title} onChange={e => updateExp(i, 'title', e.target.value)} className="h-11 text-sm rounded-xl bg-white" />
                        </div>
                        <div>
                          <FieldLabel>Company</FieldLabel>
                          <Input value={exp.company} onChange={e => updateExp(i, 'company', e.target.value)} className="h-11 text-sm rounded-xl bg-white" />
                        </div>
                        <div>
                          <FieldLabel>Period</FieldLabel>
                          <Input value={exp.period} onChange={e => updateExp(i, 'period', e.target.value)} className="h-11 text-sm rounded-xl bg-white" />
                        </div>
                        <div className="col-span-2">
                          <FieldLabel>Location</FieldLabel>
                          <Input value={exp.location ?? ''} onChange={e => updateExp(i, 'location', e.target.value || null)} className="h-11 text-sm rounded-xl bg-white" />
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <FieldLabel className="mb-0">Bullets</FieldLabel>
                          <button onClick={() => addExpBullet(i)} className="text-[10px] text-indigo-500 hover:text-indigo-700 font-medium flex items-center gap-0.5">
                            <Plus className="h-3 w-3" /> Add
                          </button>
                        </div>
                        <div className="space-y-1.5">
                          {exp.bullets.map((b, bi) => (
                            <div key={bi} className="flex gap-1.5">
                              <Textarea
                                value={b}
                                onChange={e => updateExpBullet(i, bi, e.target.value)}
                                rows={2}
                                className="text-xs rounded-xl border-slate-200 resize-none flex-1 bg-white"
                              />
                              <button onClick={() => removeExpBullet(i, bi)} className="text-slate-300 hover:text-red-400 mt-1 shrink-0">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <Button variant="outline" size="sm" className="w-full rounded-xl border-dashed text-slate-500 text-xs" onClick={addExp}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Experience Entry
                </Button>
              </>
            )}

            {activeStep === 'projects' && (
              <>
                <SubHeading
                  icon={<FolderOpen className="h-4 w-4" />}
                  title="Projects"
                  badge={cvData.projects.length > 0 ? String(cvData.projects.length) : undefined}
                />
                <div className="space-y-3">
                  {cvData.projects.map((proj, i) => (
                    <div key={i} className="border border-slate-200/70 rounded-xl p-4 space-y-2 bg-slate-50/60">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-slate-500">{proj.name || `Project ${i + 1}`}</span>
                        <button onClick={() => removeProject(i)} className="text-slate-300 hover:text-red-400 flex items-center gap-0.5 text-[10px]">
                          <Trash2 className="h-3 w-3" /> Remove
                        </button>
                      </div>
                      <div>
                        <FieldLabel>Name</FieldLabel>
                        <Input value={proj.name} onChange={e => updateProject(i, 'name', e.target.value)} className="h-11 text-sm rounded-xl bg-white" />
                      </div>
                      <div>
                        <FieldLabel>Tech stack</FieldLabel>
                        <Input value={proj.tech ?? ''} onChange={e => updateProject(i, 'tech', e.target.value || null)} className="h-11 text-sm rounded-xl bg-white" />
                      </div>
                      <div>
                        <FieldLabel>Bullets (one per line)</FieldLabel>
                        <Textarea
                          value={proj.bullets.join('\n')}
                          onChange={e => updateProject(i, 'bullets', e.target.value.split('\n'))}
                          rows={3}
                          className="text-xs rounded-xl border-slate-200 resize-none bg-white"
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <Button variant="outline" size="sm" className="w-full rounded-xl border-dashed text-slate-500 text-xs" onClick={addProject}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Project
                </Button>
              </>
            )}

            {activeStep === 'education' && (
              <>
                <SubHeading icon={<GraduationCap className="h-4 w-4" />} title="Education" badge={String(cvData.education.length)} />
                <div className="space-y-3">
                  {cvData.education.map((edu, i) => (
                    <div key={i} className="border border-slate-200/70 rounded-xl p-4 space-y-2 bg-slate-50/60">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-slate-500">Entry {i + 1}</span>
                        <button onClick={() => removeEdu(i)} className="text-slate-300 hover:text-red-400 flex items-center gap-0.5 text-[10px]">
                          <Trash2 className="h-3 w-3" /> Remove
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="col-span-2">
                          <FieldLabel>Degree</FieldLabel>
                          <Input value={edu.degree} onChange={e => updateEdu(i, 'degree', e.target.value)} className="h-11 text-sm rounded-xl bg-white" />
                        </div>
                        <div>
                          <FieldLabel>Institution</FieldLabel>
                          <Input value={edu.institution} onChange={e => updateEdu(i, 'institution', e.target.value)} className="h-11 text-sm rounded-xl bg-white" />
                        </div>
                        <div>
                          <FieldLabel>Period</FieldLabel>
                          <Input value={edu.period} onChange={e => updateEdu(i, 'period', e.target.value)} className="h-11 text-sm rounded-xl bg-white" />
                        </div>
                        <div className="col-span-2">
                          <FieldLabel>Details (GPA, honours, etc.)</FieldLabel>
                          <Input value={edu.details ?? ''} onChange={e => updateEdu(i, 'details', e.target.value || null)} className="h-11 text-sm rounded-xl bg-white" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <Button variant="outline" size="sm" className="w-full rounded-xl border-dashed text-slate-500 text-xs" onClick={addEdu}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Education Entry
                </Button>
              </>
            )}

            {activeStep === 'publications' && (
              <>
                <SubHeading icon={<BookOpen className="h-4 w-4" />} title="Publications" badge={String(cvData.publications.length)} />
                <div className="space-y-3">
                  {cvData.publications.map((pub, i) => (
                    <div key={i} className="border border-slate-200/70 rounded-xl p-4 space-y-2 bg-slate-50/60">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-slate-500">Entry {i + 1}</span>
                        <button onClick={() => removePublication(i)} className="text-slate-300 hover:text-red-400 flex items-center gap-0.5 text-[10px]">
                          <Trash2 className="h-3 w-3" /> Remove
                        </button>
                      </div>
                      <div>
                        <FieldLabel>Title</FieldLabel>
                        <Input value={pub.title} onChange={e => {
                          const pubs = [...cvData.publications]
                          pubs[i] = { ...pubs[i], title: e.target.value }
                          set('publications', pubs)
                        }} className="h-11 text-sm rounded-xl bg-white" />
                      </div>
                      <div>
                        <FieldLabel>Venue</FieldLabel>
                        <Input value={pub.venue} onChange={e => {
                          const pubs = [...cvData.publications]
                          pubs[i] = { ...pubs[i], venue: e.target.value }
                          set('publications', pubs)
                        }} className="h-11 text-sm rounded-xl bg-white" />
                      </div>
                      <div>
                        <FieldLabel>Year</FieldLabel>
                        <Input value={pub.year ?? ''} onChange={e => {
                          const pubs = [...cvData.publications]
                          pubs[i] = { ...pubs[i], year: e.target.value || null }
                          set('publications', pubs)
                        }} className="h-11 text-sm rounded-xl bg-white" />
                      </div>
                    </div>
                  ))}
                </div>
                <Button variant="outline" size="sm" className="w-full rounded-xl border-dashed text-slate-500 text-xs" onClick={addPublication}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Publication
                </Button>
              </>
            )}

            {activeStep === 'languages' && (
              <>
                <SubHeading icon={<Languages className="h-4 w-4" />} title="Languages" />
                <div>
                  <FieldLabel>One per line</FieldLabel>
                  <Textarea
                    value={cvData.languages.join('\n')}
                    onChange={e => set('languages', e.target.value.split('\n').filter(Boolean))}
                    rows={5}
                    className="text-sm rounded-xl border-slate-200 resize-none"
                  />
                </div>
              </>
            )}

            {/* Other Sections — catch-all for anything that doesn't fit a fixed
                category above (Volunteering, Patents, Certifications, Awards,
                ...). Rendered by every template now (previously only Standard). */}
            {activeStep === 'other_sections' && (
              <>
                <SubHeading
                  icon={<Layers className="h-4 w-4" />}
                  title="Other Sections"
                  badge={(cvData.other_sections || []).length > 0 ? String(cvData.other_sections.length) : undefined}
                />
                <div className="space-y-3">
                  {(cvData.other_sections || []).map((section, i) => (
                    <div key={i} className="border border-slate-200/70 rounded-xl p-4 space-y-2 bg-slate-50/60">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-slate-500">{section.heading || `Section ${i + 1}`}</span>
                        <button onClick={() => removeOtherSection(i)} className="text-slate-300 hover:text-red-400 flex items-center gap-0.5 text-[10px]">
                          <Trash2 className="h-3 w-3" /> Remove
                        </button>
                      </div>
                      <div>
                        <FieldLabel>Heading</FieldLabel>
                        <Input
                          value={section.heading}
                          onChange={e => updateOtherSection(i, 'heading', e.target.value)}
                          placeholder="e.g. Volunteering, Patents, Certifications, Awards"
                          className="h-11 text-sm rounded-xl bg-white"
                        />
                      </div>
                      <div>
                        <FieldLabel>Bullets (one per line)</FieldLabel>
                        <Textarea
                          value={section.bullets.join('\n')}
                          onChange={e => updateOtherSection(i, 'bullets', e.target.value.split('\n'))}
                          rows={3}
                          className="text-xs rounded-xl border-slate-200 resize-none bg-white"
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <Button variant="outline" size="sm" className="w-full rounded-xl border-dashed text-slate-500 text-xs" onClick={addOtherSection}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Section
                </Button>
              </>
            )}

          </div>
        </div>

        {/* CENTER: preview canvas */}
        <div className="flex-1 min-w-0 flex flex-col gap-3 lg:sticky lg:top-[88px] lg:h-[calc(100vh-104px)]">
          <div className="w-full flex items-center justify-between shrink-0 px-0.5">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Live preview
              {previewLoading && (
                <span className="flex items-center gap-1 text-slate-400">
                  <Loader2 className="h-3 w-3 animate-spin" /> Updating…
                </span>
              )}
            </span>

            {/* Zoom controls — mobile/tablet only; the toolbar's control
                cluster (hidden lg:flex, up near Download) already covers
                this on desktop, so showing both there would be a duplicate. */}
            <div className="flex items-center gap-1.5 lg:hidden">
              <button
                onClick={zoomOut}
                className="h-7 w-7 rounded-lg border border-slate-200 hover:border-slate-300 hover:bg-slate-50 flex items-center justify-center text-slate-600 transition-colors"
                title="Zoom out"
                aria-label="Zoom out"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={resetZoomToFit}
                className={cn(
                  'h-7 px-2.5 text-xs font-medium rounded-lg border transition-colors flex items-center gap-1',
                  autoZoom
                    ? 'border-indigo-200 bg-indigo-50 text-indigo-700 font-semibold'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                )}
                title={autoZoom ? 'Auto-fit to available width enabled' : 'Click to auto-fit to width'}
              >
                <span>{Math.round(zoom)}%</span>
                {autoZoom && <span className="text-[10px] bg-indigo-200/60 px-1 rounded">Fit</span>}
              </button>
              <button
                onClick={zoomIn}
                className="h-7 w-7 rounded-lg border border-slate-200 hover:border-slate-300 hover:bg-slate-50 flex items-center justify-center text-slate-600 transition-colors"
                title="Zoom in"
                aria-label="Zoom in"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div
            ref={previewCanvasRef}
            className="scrollbar-thin flex-1 w-full overflow-auto p-3 sm:p-4 lg:p-5"
          >
            {/* mx-auto, not a flex justify-center parent — centered flex
                content that overflows has a known browser quirk where you
                can't scroll all the way back to the start edge. A block
                element with auto margins degrades correctly: margins just
                resolve to 0 once the content is wider than the container, so
                zooming past 100% stays fully scrollable in both directions
                instead of clipping the far side. */}
            <div style={{ width: PREVIEW_BASE_WIDTH * zoom / 100, height: previewNaturalHeight * zoom / 100 }} className="shrink-0 mx-auto transition-all duration-150 ease-out">
              <div
                className="relative bg-white overflow-hidden rounded-sm"
                style={{
                  width: PREVIEW_BASE_WIDTH,
                  height: previewNaturalHeight,
                  transform: `scale(${zoom / 100})`,
                  transformOrigin: 'top left',
                }}
              >
                {/* Two iframe "slots" instead of one — see the slotAHtml/
                    slotBHtml state comment. Both stay mounted once they've
                    ever had content (so a hidden slot keeps quietly
                    re-paginating in the background); only the active one is
                    visible. allow-scripts is required for Paged.js to run at
                    all; allow-same-origin is required alongside it so the
                    bootstrap's ES module import resolves as an ordinary
                    same-origin fetch instead of being CORS-blocked (a
                    sandboxed srcDoc iframe without allow-same-origin gets a
                    unique opaque origin). The resume HTML itself is
                    Jinja-autoescaped server-side, so this doesn't hand
                    user-supplied resume content any new way to execute
                    script — only our own injected bootstrap runs. */}
                {slotAHtml && (
                  <iframe
                    ref={previewIframeRefA}
                    srcDoc={slotAHtml}
                    className="absolute inset-0 w-full h-full border-0"
                    style={{ visibility: activeSlot === 'a' ? 'visible' : 'hidden', zIndex: activeSlot === 'a' ? 1 : 0 }}
                    title="Resume live preview"
                    sandbox="allow-same-origin allow-scripts"
                  />
                )}
                {slotBHtml && (
                  <iframe
                    ref={previewIframeRefB}
                    srcDoc={slotBHtml}
                    className="absolute inset-0 w-full h-full border-0"
                    style={{ visibility: activeSlot === 'b' ? 'visible' : 'hidden', zIndex: activeSlot === 'b' ? 1 : 0 }}
                    title="Resume live preview"
                    sandbox="allow-same-origin allow-scripts"
                  />
                )}
                {!slotAHtml && !slotBHtml && (
                  <div className="flex flex-col items-center justify-center gap-2 text-slate-400 h-full">
                    {previewLoading
                      ? <><Loader2 className="h-6 w-6 animate-spin text-indigo-400" /><span className="text-xs">Rendering preview…</span></>
                      : <><Eye className="h-6 w-6" /><span className="text-xs">Preview will appear here</span></>
                    }
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Original PDF (collapsible reference) */}
          {originalPdfUrl && showOriginalPdf && (
            <div className="w-full bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
                <FileText className="h-4 w-4 text-slate-400" />
                <span className="text-xs font-semibold text-slate-600">Original Resume (reference)</span>
              </div>
              <iframe
                src={originalPdfUrl}
                className="w-full"
                style={{ height: '360px' }}
                title="Original resume PDF"
              />
            </div>
          )}
        </div>

        {/* RIGHT: layouts rail (desktop only — mobile uses the toolbar's dialog) */}
        <TemplateRail
          templates={templates}
          selectedTemplate={selectedTemplate}
          onSelect={selectTemplate}
          profileOkForLebenslauf={profileOkForLebenslauf}
          thumbnails={thumbnails}
          collapsed={railCollapsed}
          onToggleCollapsed={() => setRailCollapsed(v => !v)}
        />

      </div>

      <TemplatePickerDialog
        open={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
        templates={templates}
        selectedTemplate={selectedTemplate}
        onSelect={selectTemplate}
        profileOkForLebenslauf={profileOkForLebenslauf}
        thumbnails={thumbnails}
      />
    </div>
  )
}

export default function ResumeEditorPage() {
  return (
    <Suspense>
      <EditorInner />
    </Suspense>
  )
}
