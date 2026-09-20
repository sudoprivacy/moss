import { useEffect, useRef } from 'react'
import { useBlocker } from 'react-router-dom'
import { useUnsavedChanges } from './use-unsaved-changes'

export function useSettingsNavigationGuard(isDirty: boolean, isSaving: boolean, discard: () => void) {
  const { registerGuard, confirmDiscard } = useUnsavedChanges()
  const handlingNavigation = useRef(false)
  useEffect(() => registerGuard({ isDirty, isSaving, discard }), [registerGuard, isDirty, isSaving, discard])
  const blocker = useBlocker(isDirty || isSaving)
  useEffect(() => {
    if (blocker.state !== 'blocked' || handlingNavigation.current) return
    handlingNavigation.current = true
    void confirmDiscard().then(confirmed => {
      if (confirmed) blocker.proceed()
      else blocker.reset()
    }).finally(() => { handlingNavigation.current = false })
  }, [blocker, confirmDiscard])
  return confirmDiscard
}
