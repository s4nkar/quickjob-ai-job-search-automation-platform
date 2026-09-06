'use client'

import { TemplateId, TemplateMeta } from '@/lib/types'
import { cn } from '@jobnok/ui'
import { Check, ChevronLeft, ChevronRight, Lock } from 'lucide-react'
import { PREVIEW_BASE_HEIGHT, PREVIEW_BASE_WIDTH } from './constants'

// Real-content thumbnail width — the rest (rail width, card padding) is
// derived from this. Height follows the A4 aspect ratio automatically.
const THUMB_WIDTH = 148
const THUMB_SCALE = THUMB_WIDTH / PREVIEW_BASE_WIDTH
const THUMB_HEIGHT = Math.round(PREVIEW_BASE_HEIGHT * THUMB_SCALE)
const RAIL_WIDTH = 192

function RailCard({
  template, selected, locked, html, onSelect,
}: {
  template: TemplateMeta
  selected: boolean
  locked: boolean
  html: string | null | undefined
  onSelect: (id: TemplateId) => void
}) {
  return (
    <button
      onClick={() => { if (!locked) onSelect(template.id) }}
      title={locked ? 'Requires profile photo, phone and city' : template.desc}
      className={cn(
        'w-full text-left rounded-xl border-2 p-2 transition-all relative',
        selected ? 'border-indigo-500 bg-indigo-50/50' : 'border-slate-200 hover:border-slate-300 bg-white',
        locked && 'opacity-60'
      )}
    >
      <div
        className="rounded-md overflow-hidden border border-slate-200 bg-white mx-auto relative"
        style={{ width: THUMB_WIDTH, height: THUMB_HEIGHT }}
      >
        {html ? (
          <div style={{
            width: PREVIEW_BASE_WIDTH, height: PREVIEW_BASE_HEIGHT,
            transform: `scale(${THUMB_SCALE})`, transformOrigin: 'top left',
          }}>
            <iframe
              srcDoc={html}
              className="w-full h-full border-0 pointer-events-none"
              sandbox=""
              title={template.label}
              tabIndex={-1}
            />
          </div>
        ) : (
          <div className="w-full h-full animate-pulse bg-slate-100" />
        )}
      </div>
      <p className="text-[11px] font-semibold text-slate-700 mt-1.5 leading-tight truncate">{template.label}</p>

      {selected && (
        <div className="absolute top-1.5 left-1.5 h-4 w-4 rounded-full bg-indigo-500 text-white flex items-center justify-center shadow-sm">
          <Check className="h-2.5 w-2.5" />
        </div>
      )}
      {locked && (
        <div className="absolute top-1.5 right-1.5 bg-amber-100 text-amber-700 rounded px-1 py-0.5 flex items-center gap-0.5">
          <Lock className="h-2.5 w-2.5" />
        </div>
      )}
    </button>
  )
}

interface TemplateRailProps {
  templates: TemplateMeta[]
  selectedTemplate: TemplateId
  onSelect: (id: TemplateId) => void
  profileOkForLebenslauf: boolean
  thumbnails: Record<string, string> | null
  collapsed: boolean
  onToggleCollapsed: () => void
}

export function TemplateRail({
  templates, selectedTemplate, onSelect, profileOkForLebenslauf, thumbnails, collapsed, onToggleCollapsed,
}: TemplateRailProps) {
  const singleCol = templates.filter(t => t.columns === 1)
  const twoCol = templates.filter(t => t.columns === 2)

  return (
    <div className="hidden lg:block shrink-0 relative">
      <button
        onClick={onToggleCollapsed}
        className="absolute -left-3 top-6 z-10 h-7 w-7 rounded-full bg-white border border-slate-200 shadow-card flex items-center justify-center text-slate-400 hover:text-slate-700 hover:border-slate-300 transition-colors"
        aria-label={collapsed ? 'Show layouts panel' : 'Hide layouts panel'}
        title={collapsed ? 'Show layouts' : 'Hide layouts'}
      >
        {collapsed ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>

      <div
        className="overflow-hidden transition-[width] duration-200 ease-out sticky top-[88px] h-[calc(100vh-104px)]"
        style={{ width: collapsed ? 0 : RAIL_WIDTH }}
      >
        <div
          className="h-full flex flex-col bg-white border border-slate-100 rounded-2xl shadow-card overflow-hidden"
          style={{ width: RAIL_WIDTH }}
        >
          <div className="px-4 pt-4 pb-3 border-b border-slate-100 shrink-0">
            <p className="text-xs font-semibold text-slate-700">Layouts</p>
            <p className="text-[11px] text-slate-400 mt-0.5">{templates.length} styles &middot; click to switch</p>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
            {singleCol.length > 0 && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 px-1">Single column</p>
                <div className="space-y-2.5">
                  {singleCol.map(t => (
                    <RailCard
                      key={t.id}
                      template={t}
                      selected={selectedTemplate === t.id}
                      locked={false}
                      html={thumbnails?.[t.id]}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              </div>
            )}

            {twoCol.length > 0 && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 px-1">Two column</p>
                <div className="space-y-2.5">
                  {twoCol.map(t => (
                    <RailCard
                      key={t.id}
                      template={t}
                      selected={selectedTemplate === t.id}
                      locked={t.id === 'lebenslauf' && !profileOkForLebenslauf}
                      html={thumbnails?.[t.id]}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
