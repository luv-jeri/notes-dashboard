import { createContext, useContext } from 'react'

export interface ToastOptions {
  message: string
  /**
   * "error" toasts stay until the person dismisses them or presses the action,
   * so nobody misses a failed save. "info" toasts leave after a few seconds.
   */
  tone?: 'info' | 'error'
  action?: { label: string; onAction: () => void }
}

export interface ToastApi {
  show: (toast: ToastOptions) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const toast = useContext(ToastContext)
  if (!toast) throw new Error('useToast must be used inside <ToastProvider>')
  return toast
}
