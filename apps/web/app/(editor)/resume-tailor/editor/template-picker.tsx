'use client'

import { TemplateId, TemplateMeta } from '@/lib/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, cn } from '@jobnok/ui'
import { Lock } from 'lucide-react'
import { PREVIEW_BASE_HEIGHT, PREVIEW_BASE_WIDTH } from './constants'

// Mobile-only fallback surface (the desktop rail is the primary picker) — real
// content thumbnails when available, generic placeholder shapes otherwise
// (e.g. before the first thumbnails fetch resolves). Fixed pixel size (not
// w-full) so the transform-scale math stays exact — matches the ~170px
// column width the dialog's grid-cols-4/max-w-3xl produces in practice.
const DIALOG_THUMB_WIDTH = 168
const DIALOG_THUMB_SCALE = DIALOG_THUMB_WIDTH / PREVIEW_BASE_WIDTH
const DIALOG_THUMB_HEIGHT = Math.round(PREVIEW_BASE_HEIGHT * DIALOG_THUMB_SCALE)

function LiveThumb({ html, label }: { html: string; label: string }) {
  return (
    <div
      className="rounded-lg border border-slate-200 bg-white overflow-hidden mx-auto"
      style={{ width: DIALOG_THUMB_WIDTH, height: DIALOG_THUMB_HEIGHT }}
    >
      <div style={{
        width: PREVIEW_BASE_WIDTH, height: PREVIEW_BASE_HEIGHT,
        transform: `scale(${DIALOG_THUMB_SCALE})`, transformOrigin: 'top left',
      }}>
        <iframe srcDoc={html} className="w-full h-full border-0 pointer-events-none" sandbox="" title={label} tabIndex={-1} />
      </div>
    </div>
  )
}

// ── Template thumbnails ───────────────────────────────────────────
// Small hand-drawn previews (no real render cost) standing in for each
// template's actual layout shape, keyed by TEMPLATE_THUMBS below.

function SingleColThumb({ accent = '#1a1a1a' }: { accent?: string }) {
  return (
    <div className="w-full h-24 rounded-lg bg-white border border-slate-200 p-2.5 overflow-hidden space-y-1">
      <div className="h-2 rounded w-3/5 mx-auto" style={{ background: accent }} />
      <div className="h-1 bg-slate-300 rounded w-2/5 mx-auto" />
      <div className="h-px bg-slate-200 w-full mt-1" />
      <div className="h-1 bg-slate-400 rounded w-1/3 mt-1" />
      <div className="space-y-0.5 mt-0.5">
        <div className="h-0.5 bg-slate-200 rounded" />
        <div className="h-0.5 bg-slate-200 rounded w-5/6" />
        <div className="h-0.5 bg-slate-200 rounded w-4/5" />
      </div>
    </div>
  )
}

function TwoColThumb({ sideColor = '#475569', accent = '#1a1a1a' }: { sideColor?: string; accent?: string }) {
  return (
    <div className="w-full h-24 rounded-lg border border-slate-200 overflow-hidden flex">
      <div className="w-[35%] p-2 space-y-0.5" style={{ background: sideColor }}>
        <div className="h-2 rounded-full bg-white/30 w-4/5" />
        <div className="h-0.5 bg-white/20 rounded" />
        <div className="h-0.5 bg-white/20 rounded w-3/4" />
        <div className="h-0.5 bg-white/20 rounded w-3/4 mt-1" />
        <div className="h-0.5 bg-white/20 rounded" />
      </div>
      <div className="flex-1 bg-white p-2 space-y-0.5">
        <div className="h-1.5 rounded w-3/4 mb-1" style={{ background: accent }} />
        <div className="h-px bg-slate-300" />
        <div className="h-0.5 bg-slate-300 rounded" />
        <div className="h-0.5 bg-slate-300 rounded w-5/6" />
        <div className="h-0.5 bg-slate-300 rounded w-4/5" />
      </div>
    </div>
  )
}

function HeaderBandThumb({ bandColor = '#1e3a5f' }: { bandColor?: string }) {
  return (
    <div className="w-full h-24 rounded-lg border border-slate-200 overflow-hidden">
      <div className="h-7 px-2 flex items-center justify-between" style={{ background: bandColor }}>
        <div className="h-1.5 bg-white/70 rounded w-1/3" />
        <div className="space-y-0.5">
          <div className="h-0.5 bg-white/40 rounded w-10" />
          <div className="h-0.5 bg-white/40 rounded w-8" />
        </div>
      </div>
      <div className="flex" style={{ height: 'calc(100% - 28px)' }}>
        <div className="w-[35%] bg-slate-50 p-1.5 space-y-0.5 border-r border-slate-200">
          <div className="h-0.5 bg-slate-300 rounded" />
          <div className="h-0.5 bg-slate-200 rounded w-4/5" />
        </div>
        <div className="flex-1 bg-white p-1.5 space-y-0.5">
          <div className="h-0.5 bg-slate-400 rounded w-1/2" />
          <div className="h-0.5 bg-slate-200 rounded" />
          <div className="h-0.5 bg-slate-200 rounded w-5/6" />
        </div>
      </div>
    </div>
  )
}

const TEMPLATE_THUMBS: Record<TemplateId, React.ReactNode> = {
  standard:             <SingleColThumb />,
  modern:               <TwoColThumb sideColor="#f8f9fa" accent="#343a40" />,
  creative:             <SingleColThumb accent="#e05a2b" />,
  classic:              <SingleColThumb accent="#111" />,
  balanced:             <SingleColThumb accent="#2563eb" />,
  minimalist:           <SingleColThumb accent="#555" />,
  professional:         <SingleColThumb accent="#111" />,
  corporate:            <HeaderBandThumb bandColor="#1e3a5f" />,
  bold:                 <SingleColThumb accent="#1a1a1a" />,
  slate:                <TwoColThumb sideColor="#475569" accent="#475569" />,
  professional_compact: <SingleColThumb accent="#111" />,
  executive:            <TwoColThumb sideColor="#f0f2f5" accent="#2d4a7a" />,
  insight:              <TwoColThumb sideColor="#0f2844" accent="#0f2844" />,
  atelier:              <TwoColThumb sideColor="#faf8f5" accent="#2c1a0e" />,
  elegant:              <SingleColThumb accent="#5a3e2b" />,
  aqua:                 <HeaderBandThumb bandColor="#00897b" />,
  lebenslauf:           <TwoColThumb sideColor="#1b2d4f" accent="#1b2d4f" />,
}

interface TemplatePickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  templates: TemplateMeta[]
  selectedTemplate: TemplateId
  onSelect: (id: TemplateId) => void
  profileOkForLebenslauf: boolean
  thumbnails?: Record<string, string> | null
}

export function TemplatePickerDialog({
  open, onOpenChange, templates, selectedTemplate, onSelect, profileOkForLebenslauf, thumbnails,
}: TemplatePickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl rounded-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Choose a layout</DialogTitle>
        </DialogHeader>

        <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2 mt-2">Single Column</p>
        <div className="grid grid-cols-4 gap-3 mb-5">
          {templates.filter(t => t.columns === 1).map(t => (
            <button
              key={t.id}
              onClick={() => { onSelect(t.id as TemplateId); onOpenChange(false) }}
              title={t.desc}
              className={cn(
                'text-left rounded-xl border-2 p-2.5 transition-all',
                selectedTemplate === t.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'
              )}
            >
              {thumbnails?.[t.id] ? <LiveThumb html={thumbnails[t.id]} label={t.label} /> : TEMPLATE_THUMBS[t.id as TemplateId]}
              <p className="text-xs font-semibold text-slate-700 mt-2 leading-tight">{t.label}</p>
              <p className="text-[10px] text-slate-400 mt-0.5 truncate">{t.font.split(',')[0]}</p>
            </button>
          ))}
        </div>

        <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2">Two Column</p>
        <div className="grid grid-cols-4 gap-3">
          {templates.filter(t => t.columns === 2).map(t => {
            const locked = t.id === 'lebenslauf' && !profileOkForLebenslauf
            return (
              <button
                key={t.id}
                onClick={() => { if (!locked) { onSelect(t.id as TemplateId); onOpenChange(false) } }}
                title={locked ? 'Requires profile photo, phone and city' : t.desc}
                className={cn(
                  'text-left rounded-xl border-2 p-2.5 transition-all relative',
                  selectedTemplate === t.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300',
                  locked && 'opacity-60'
                )}
              >
                {thumbnails?.[t.id] ? <LiveThumb html={thumbnails[t.id]} label={t.label} /> : TEMPLATE_THUMBS[t.id as TemplateId]}
                <p className="text-xs font-semibold text-slate-700 mt-2 leading-tight">{t.label}</p>
                <p className="text-[10px] text-slate-400 mt-0.5 truncate">{t.font.split(',')[0]}</p>
                {locked && (
                  <div className="absolute top-2 right-2 bg-amber-100 text-amber-700 rounded px-1.5 py-0.5 flex items-center gap-1">
                    <Lock className="h-2.5 w-2.5" />
                    <span className="text-[9px] font-semibold">Photo req.</span>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
