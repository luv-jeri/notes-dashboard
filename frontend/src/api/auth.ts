import { request } from './client'

/** Same limits as backend/main.py. */
export const NAME_MAX = 60
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128

/** The signed-in person. The password never comes back from the server. */
export interface User {
  id: number
  name: string
  email: string
  /** False until they open the link in the confirmation email. */
  email_verified: boolean
}

export interface SignupInput {
  name: string
  email: string
  password: string
}

export interface LoginInput {
  email: string
  password: string
}

export interface ResetPasswordInput {
  /** From the link in the reset email. */
  token: string
  password: string
}

/**
 * The session lives in an httpOnly cookie the server sets and clears, so
 * nothing here stores a token: the browser sends the cookie with every
 * same-origin request on its own.
 */
export const authApi = {
  /** The current user, or null when nobody is logged in. */
  me: (signal?: AbortSignal) => request<User | null>('/auth/me', { signal }),

  signup: (input: SignupInput) =>
    request<User>('/auth/signup', { method: 'POST', body: JSON.stringify(input) }),

  login: (input: LoginInput) =>
    request<User>('/auth/login', { method: 'POST', body: JSON.stringify(input) }),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  /** Confirms the address the token was sent to. Works without a session. */
  verifyEmail: (token: string) =>
    request<void>('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }),

  /** Emails the logged-in person a new confirmation link. */
  resendVerification: () => request<void>('/auth/verify-email/resend', { method: 'POST' }),

  /** Always answers the same way, so it never shows whether an email has an account. */
  forgotPassword: (email: string) =>
    request<void>('/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email }) }),

  /** Sets the new password and logs in as that account. */
  resetPassword: (input: ResetPasswordInput) =>
    request<User>('/auth/password/reset', { method: 'POST', body: JSON.stringify(input) }),
}
