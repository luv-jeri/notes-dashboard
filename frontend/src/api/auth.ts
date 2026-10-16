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
}
