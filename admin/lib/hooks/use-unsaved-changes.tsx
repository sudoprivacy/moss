'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

type ChangesGuard = {
  isDirty: boolean
  isSaving: boolean
  discard: () => void
}

type UnsavedChangesContextValue = {
  registerGuard: (guard: ChangesGuard) => () => void
  confirmDiscard: () => Promise<boolean>
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null)

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const guardRef = useRef<ChangesGuard | null>(null)
  const pendingRef = useRef<{ promise: Promise<boolean>; resolve: (value: boolean) => void } | null>(null)
  const [open, setOpen] = useState(false)

  const registerGuard = useCallback((guard: ChangesGuard) => {
    guardRef.current = guard
    return () => { if (guardRef.current === guard) guardRef.current = null }
  }, [])

  const confirmDiscard = useCallback(() => {
    if (guardRef.current?.isSaving) {
      toast.info('正在保存，请完成后再离开。')
      return Promise.resolve(false)
    }
    if (!guardRef.current?.isDirty) return Promise.resolve(true)
    if (pendingRef.current) return pendingRef.current.promise
    let resolve!: (value: boolean) => void
    const promise = new Promise<boolean>(done => { resolve = done })
    pendingRef.current = { promise, resolve }
    setOpen(true)
    return promise
  }, [])

  const resolveDiscard = useCallback((discard: boolean) => {
    const pending = pendingRef.current
    pendingRef.current = null
    if (discard) {
      const guard = guardRef.current
      // Clear before logout / organization switching can initiate a full reload.
      guardRef.current = null
      guard?.discard()
    }
    setOpen(false)
    pending?.resolve(discard)
  }, [])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!guardRef.current?.isDirty && !guardRef.current?.isSaving) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      pendingRef.current?.resolve(false)
      pendingRef.current = null
    }
  }, [])

  const value = useMemo(() => ({ registerGuard, confirmDiscard }), [registerGuard, confirmDiscard])
  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      <AlertDialog open={open} onOpenChange={next => { if (!next) resolveDiscard(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
            <AlertDialogDescription>这些更改尚未写入服务器。继续操作将放弃当前草稿，已保存的配置不受影响。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => resolveDiscard(false)}>继续编辑</AlertDialogCancel>
            <AlertDialogAction onClick={() => resolveDiscard(true)}>放弃更改</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UnsavedChangesContext.Provider>
  )
}

export function useUnsavedChanges() {
  const context = useContext(UnsavedChangesContext)
  if (!context) throw new Error('useUnsavedChanges must be used within UnsavedChangesProvider')
  return context
}
