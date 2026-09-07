'use client'

import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@jobnok/ui'
import { FileText, Sparkles } from 'lucide-react'
import { PREVIEW_BASE_WIDTH } from './constants'

// Reuses the SAME already-paginated HTML the live preview canvas is showing
// (see page.tsx's slotAHtml/slotBHtml + activeSlot) rather than re-fetching
// or re-building anything — the modal is just a second, larger place to view
// content the app already rendered. sandbox="allow-same-origin allow-scripts"
// is still required since that HTML carries the Paged.js bootstrap (see
// buildPaginatedHtml in page.tsx), so it re-paginates once inside this fresh
// iframe context, giving real page breaks here too.
function TailoredPane({ html, naturalHeight }: { html: string | null; naturalHeight: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const compute = () => {
      const width = el.clientWidth
      // Capped at 1 (never upscale past 100%) - a wide modal pane shouldn't
      // blow the resume up beyond its real print size, only shrink to fit.
      if (width > 0) setScale(Math.min(1, (width - 32) / PREVIEW_BASE_WIDTH))
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={containerRef} className="h-full w-full overflow-auto scrollbar-thin bg-[#f8f8fc] p-4">
      {html && scale > 0 ? (
        <div style={{ width: PREVIEW_BASE_WIDTH * scale, height: naturalHeight * scale }} className="mx-auto">
          <iframe
            srcDoc={html}
            className="border-0"
            style={{
              width: PREVIEW_BASE_WIDTH, height: naturalHeight,
              transform: `scale(${scale})`, transformOrigin: 'top left',
            }}
            sandbox="allow-same-origin allow-scripts"
            title="Tailored resume"
          />
        </div>
      ) : (
        <div className="flex items-center justify-center h-full text-sm text-slate-400">Preparing preview…</div>
      )}
    </div>
  )
}

interface CompareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  originalPdfUrl: string | null
  newHtml: string | null
  newHeight: number
}

export function CompareDialog({ open, onOpenChange, originalPdfUrl, newHtml, newHeight }: CompareDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl w-[95vw] h-[88vh] p-0 gap-0 rounded-2xl overflow-hidden flex flex-col">
        <DialogHeader className="px-5 py-3.5 border-b border-slate-100 shrink-0">
          <DialogTitle className="text-sm font-bold">Compare with original</DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100">
          <div className="flex flex-col min-h-0">
            <div className="px-4 py-2 border-b border-slate-100 flex items-center gap-2 shrink-0 bg-white">
              <FileText className="h-3.5 w-3.5 text-slate-400" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Original</span>
            </div>
            <div className="flex-1 min-h-0 bg-slate-100">
              {originalPdfUrl ? (
                <iframe src={originalPdfUrl} className="w-full h-full border-0" title="Original resume" />
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-slate-400">No original on file</div>
              )}
            </div>
          </div>

          <div className="flex flex-col min-h-0">
            <div className="px-4 py-2 border-b border-slate-100 flex items-center gap-2 shrink-0 bg-white">
              <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Tailored</span>
            </div>
            <div className="flex-1 min-h-0">
              <TailoredPane html={newHtml} naturalHeight={newHeight} />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
