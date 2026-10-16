import {
  useMutation,
  useQuery,
  useQueryClient,
  type DefaultError,
  type QueryClient,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { authApi, type LoginInput, type ResetPasswordInput, type SignupInput, type User } from '../api/auth'
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
  client.removeQueries({ queryKey: ['categories'] })
}

/** Whose notes the cache holds right now: null when nobody is logged in. */
const accountIn = (client: QueryClient) => client.getQueryData<Session>(sessionKey)?.user?.id ?? null

/** What onMutate hands the other callbacks: whose change it was, and the mutation's own result. */
interface Stamped<TResult> {
  account: number | null
  result: TResult
}

/**
 * useMutation for a change to one person's notes or categories.
 *
 * setSession clears the cache when someone else logs in, but a save can still
 * be on its way. Its answer belongs to the person who made it, so if someone
 * else is logged in by the time it arrives, it is dropped: no cache write, no
 * toast, no Try again. Otherwise a late answer would put the first person's
 * note or category into the next person's lists.
 */
export function useAccountMutation<TData, TVariables = void, TResult = unknown>(
  options: UseMutationOptions<TData, DefaultError, TVariables, TResult>,
) {
  const client = useQueryClient()
  const { onMutate, onSuccess, onError, onSettled, ...rest } = options
  // No stamp means onMutate itself failed: the request was never sent, so
  // nothing can have changed hands in between.
  const stillTheirs = (stamp: Stamped<TResult> | undefined) =>
    stamp === undefined || stamp.account === accountIn(client)

  return useMutation<TData, DefaultError, TVariables, Stamped<TResult>>({
    ...rest,
    onMutate: async (variables, context) => {
      const account = accountIn(client)
      return { account, result: (await onMutate?.(variables, context)) as TResult }
    },
    onSuccess: (data, variables, stamp, context) =>
      stillTheirs(stamp) ? onSuccess?.(data, variables, stamp.result, context) : undefined,
    onError: (error, variables, stamp, context) =>
      stillTheirs(stamp) ? onError?.(error, variables, stamp?.result, context) : undefined,
    onSettled: (data, error, variables, stamp, context) =>
      stillTheirs(stamp) ? onSettled?.(data, error, variables, stamp?.result, context) : undefined,
  })
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

export function useForgotPassword() {
  return useMutation({
    mutationKey: [...authKey, 'forgot'],
    mutationFn: (email: string) => authApi.forgotPassword(email),
  })
}

export function useResetPassword() {
  const client = useQueryClient()
  return useMutation({
    mutationKey: [...authKey, 'reset'],
    mutationFn: (input: ResetPasswordInput) => authApi.resetPassword(input),
    // The server ended every other session and logged this browser in.
    onSuccess: (user) => setSession(client, { user }),
  })
}

export function useVerifyEmail() {
  const client = useQueryClient()
  return useMutation({
    mutationKey: [...authKey, 'verify'],
    mutationFn: (token: string) => authApi.verifyEmail(token),
    // Whoever is logged in may be the account that was just confirmed.
    onSuccess: () => client.invalidateQueries({ queryKey: sessionKey }),
  })
}

/** Not under the auth key: a 401 here does mean the session ended. */
export function useResendVerification() {
  const client = useQueryClient()
  return useMutation({
    mutationKey: ['verification', 'resend'],
    mutationFn: () => authApi.resendVerification(),
    onError: (error) => {
      // Confirmed in another tab: ask again, and the banner goes away.
      if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey: sessionKey })
    },
  })
}
