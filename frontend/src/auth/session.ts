import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { authApi, type LoginInput, type SignupInput, type User } from '../api/auth'
import { ApiError } from '../api/client'

export const sessionKey = ['session'] as const
/** Mutations under this key answer 401 for a wrong password, not an ended session. */
export const authKey = ['auth'] as const

/**
 * Who is logged in, and why nobody is, when there is a reason worth saying.
 * The reason sits next to the user, so the log-in screen reads both from one place.
 */
export interface Session {
  user: User | null
  notice?: string
}

export const SESSION_ENDED = 'Your session ended. Log in again to see your notes.'

/** A 401 from anything but the log-in form means the cookie has expired or gone. */
export const isSessionEnded = (error: unknown) => error instanceof ApiError && error.status === 401

export function useSession() {
  return useQuery({
    queryKey: sessionKey,
    queryFn: async ({ signal }): Promise<Session> => ({ user: await authApi.me(signal) }),
    // Only log in, log out and a 401 change who is logged in, and each of
    // those writes the answer here directly. No need to ask again on focus.
    staleTime: Infinity,
  })
}

/**
 * Switches the app to another person (or to nobody). The previous person's
 * notes leave the cache, so the next account never sees them, not even for
 * a frame while its own list loads.
 */
export function setSession(client: QueryClient, session: Session) {
  client.setQueryData<Session>(sessionKey, session)
  client.removeQueries({ queryKey: ['notes'] })
}

export function useLogin() {
  const client = useQueryClient()
  return useMutation({
    mutationKey: [...authKey, 'login'],
    mutationFn: (input: LoginInput) => authApi.login(input),
    onSuccess: (user) => setSession(client, { user }),
  })
}

export function useSignup() {
  const client = useQueryClient()
  return useMutation({
    mutationKey: [...authKey, 'signup'],
    mutationFn: (input: SignupInput) => authApi.signup(input),
    onSuccess: (user) => setSession(client, { user }),
  })
}

export function useLogout() {
  const client = useQueryClient()
  return useMutation({
    mutationKey: [...authKey, 'logout'],
    mutationFn: () => authApi.logout(),
    onSuccess: () => setSession(client, { user: null }),
  })
}
