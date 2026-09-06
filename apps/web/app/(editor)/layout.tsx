'use client'

import { useAuth } from '@clerk/nextjs'
import { Loader2 } from 'lucide-react'

// Sidebar-free counterpart to (dashboard)/layout.tsx, for pages that want the
// full viewport width instead of sharing it with the global Sidebar (e.g. the
// resume editor's two-pane form+preview workspace). Keeps only the auth-hydration
// gate from the dashboard layout — Sidebar/SidebarProvider carry no other
// side effects (no data fetching, no global state beyond their own collapse
// UI), and Toaster/ClerkProvider/QueryProvider already live in the root
// layout above every route group, so nothing else needs duplicating here.
export default function EditorLayout({ children }: { children: React.ReactNode }) {
  const { isLoaded } = useAuth()

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#F8F8FC]">
      {children}
    </div>
  )
}
