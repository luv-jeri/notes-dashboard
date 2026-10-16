import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ToastContext, type ToastOptions } from './ToastContext'
import styles from './Toast.module.css'

const AUTO_DISMISS_MS = 6000
const MAX_VISIBLE = 3

interface Toast extends ToastOptions {
  id: number
  /** Dismissed and playing its way out. */
  leaving?: boolean
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)))
  }, [])

  const show = useCallback((toast: ToastOptions) => {
    const id = ++nextId.current
    setToasts((current) => {
      // Over the limit, the oldest toasts are dismissed the usual way.
      const staying = current.filter((item) => !item.leaving)
      const surplus = new Set(staying.slice(0, Math.max(0, staying.length - (MAX_VISIBLE - 1))).map((item) => item.id))
      return [
        ...current.map((item) => (surplus.has(item.id) ? { ...item, leaving: true } : item)),
        { ...toast, id },
      ]
    })
  }, [])

  const api = useMemo(() => ({ show }), [show])

  return (
    <ToastContext value={api}>
      {children}
      {/* The region is always in the page, so screen readers hear each new toast. */}
      <div className={styles.region} aria-label="Notifications" role="region" aria-live="polite">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} onRemove={remove} />
        ))}
      </div>
    </ToastContext>
  )
}

interface ToastItemProps {
  toast: Toast
  onDismiss: (id: number) => void
  /** Takes the toast out of the page once it has finished leaving. */
  onRemove: (id: number) => void
}

function ToastItem({ toast, onDismiss, onRemove }: ToastItemProps) {
  const { id, leaving = false } = toast
  const isError = toast.tone === 'error'
  // The timer pauses while the pointer or keyboard focus is on the toast,
  // so its button can't vanish just as someone reaches for it.
  const [paused, setPaused] = useState(false)
  const node = useRef<HTMLDivElement>(null)
  // Where focus was before it came into the toast, so it can go back there.
  const focusOrigin = useRef<HTMLElement | null>(null)

  // Every way out (a button, the timer, a newer toast pushing this one out)
  // starts here, while the toast still holds focus: focus goes straight back,
  // then the toast plays its exit and is removed.
  useLayoutEffect(() => {
    const toastNode = node.current
    if (!leaving || !toastNode) return
    if (toastNode.contains(document.activeElement) && focusOrigin.current?.isConnected) {
      focusOrigin.current.focus({ preventScroll: true })
    }
    const exit = toastNode.getAnimations?.() ?? []
    if (exit.length === 0) {
      onRemove(id)
      return
    }
    let current = true
    void Promise.allSettled(exit.map((animation) => animation.finished)).then(() => {
      if (current) onRemove(id)
    })
    return () => {
      current = false
    }
  }, [leaving, id, onRemove])

  // The safety net if the whole provider goes, toasts and all.
  useLayoutEffect(() => {
    const toastNode = node.current
    return () => {
      if (toastNode?.contains(document.activeElement) && focusOrigin.current?.isConnected) {
        focusOrigin.current.focus({ preventScroll: true })
      }
    }
  }, [])

  useEffect(() => {
    if (isError || paused || leaving) return
    const timer = window.setTimeout(() => onDismiss(id), AUTO_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [id, isError, paused, leaving, onDismiss])

  const Icon = isError ? CircleAlert : CircleCheck

  return (
    <div
      ref={node}
      className={isError ? `${styles.toast} ${styles.error}` : styles.toast}
      role={isError ? 'alert' : undefined}
      data-leaving={leaving || undefined}
      // On its way out it can't be clicked or focused.
      inert={leaving}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={(event) => {
        setPaused(true)
        if (!event.currentTarget.contains(event.relatedTarget)) {
          focusOrigin.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false)
      }}
    >
      <Icon className={styles.icon} size={20} aria-hidden="true" />
      <p className={styles.message}>{toast.message}</p>
      {toast.action && (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            onDismiss(id)
            toast.action?.onAction()
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className={styles.close} aria-label="Dismiss" onClick={() => onDismiss(id)}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  )
}
