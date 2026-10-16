import { Eye, EyeOff } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode, type SubmitEvent } from 'react'
import { NAME_MAX, PASSWORD_MAX, PASSWORD_MIN } from '../api/auth'
import { ApiError } from '../api/client'
import { Logo } from '../layout/Logo'
import { NoteFan } from '../layout/NoteFan'
import type { LinkOutcome } from './emailLink'
import { useForgotPassword, useLogin, useResetPassword, useSignup } from './session'
import styles from './AuthScreen.module.css'

type Mode = 'login' | 'signup' | 'forgot' | 'reset'
type Field = 'name' | 'email' | 'password'
type FieldErrors = Partial<Record<Field, string>>

const FIELDS: Record<Mode, Field[]> = {
  login: ['email', 'password'],
  signup: ['name', 'email', 'password'],
  forgot: ['email'],
  reset: ['password'],
}

// The server checks properly; this only catches typos before a round trip.
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The server sends at most one reset email a minute, so Send again waits as long. */
const RESEND_GAP_SECONDS = 60

const COPY = {
  login: {
    heading: 'Log in',
    detail: 'Your notes are where you left them.',
    submit: 'Log in',
    pending: 'Logging in…',
  },
  signup: {
    heading: 'Create your account',
    detail: 'Notes you write are saved to your account, and only you can see them.',
    submit: 'Create account',
    pending: 'Creating account…',
  },
  forgot: {
    heading: 'Reset your password',
    detail: "Enter the email you signed up with. We'll send you a link to choose a new password.",
    submit: 'Email me a link',
    pending: 'Sending…',
  },
  reset: {
    heading: 'Choose a new password',
    detail: "You'll be logged in with it, and logged out on your other devices.",
    submit: 'Save password',
    pending: 'Saving…',
  },
} as const

interface AuthScreenProps {
  /** Why someone is here, such as an ended session or a confirmed email. */
  notice?: string
  /** Opened from a reset email: starts on Choose a new password with this token. */
  resetToken?: string
  /** Someone is already logged in on this browser, so the way out is back to the notes. */
  signedIn?: boolean
  /** Called when a reset link's screen is finished with: logged in, saved, or left. */
  onDone?: (outcome: LinkOutcome | null) => void
}

/** Log in, sign up, or get back in with a reset email. */
export function AuthScreen({ notice, resetToken, signedIn = false, onDone }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>(resetToken ? 'reset' : 'login')
  const [values, setValues] = useState<Record<Field, string>>({ name: '', email: '', password: '' })
  const [errors, setErrors] = useState<FieldErrors>({})
  const [showPassword, setShowPassword] = useState(false)
  /** Set once a reset email is on its way: the screen becomes Check your email. */
  const [sent, setSent] = useState<{ email: string; at: number } | null>(null)
  const login = useLogin()
  const signup = useSignup()
  const forgot = useForgotPassword()
  const reset = useResetPassword()
  const active = { login, signup, forgot, reset }[mode]
  const copy = COPY[mode]
  const ids = useId()
  const inputs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({})

  // On arrival and on each switch, start in the first field still empty.
  useEffect(() => {
    const fields = FIELDS[mode]
    const target = fields.find((field) => !inputs.current[field]?.value) ?? fields[0]
    inputs.current[target]?.focus()
  }, [mode])

  function switchMode(next: Mode) {
    setMode(next)
    setErrors({})
    setSent(null)
    setShowPassword(false)
    login.reset()
    signup.reset()
    forgot.reset()
    reset.reset()
  }

  function update(field: Field, value: string) {
    setValues((current) => ({ ...current, [field]: value }))
    // A fixed field stops saying it's wrong; a new attempt clears the old answer.
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }))
    if (active.isError) active.reset()
  }

  function check(): FieldErrors {
    const found: FieldErrors = {}
    const fields = FIELDS[mode]
    if (fields.includes('name') && !values.name.trim()) found.name = 'Enter your name.'
    if (fields.includes('email')) {
      const email = values.email.trim()
      if (!email) found.email = 'Enter your email address.'
      else if (!LOOKS_LIKE_EMAIL.test(email)) found.email = 'Enter an email address like name@example.com.'
    }
    if (fields.includes('password')) {
      const choosing = mode !== 'login'
      if (!values.password) found.password = mode === 'reset' ? 'Enter a new password.' : 'Enter your password.'
      else if (choosing && values.password.length < PASSWORD_MIN) {
        found.password = `Use at least ${PASSWORD_MIN} characters.`
      } else if (values.password.length > PASSWORD_MAX) {
        found.password = `Use ${PASSWORD_MAX} characters or fewer.`
      }
    }
    return found
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (active.isPending) return
    const found = check()
    setErrors(found)
    const firstWrong = FIELDS[mode].find((field) => found[field])
    if (firstWrong) {
      inputs.current[firstWrong]?.focus()
      return
    }
    const email = values.email.trim()
    // Passwords go as typed: spaces can be part of one.
    const password = values.password
    const done = () => onDone?.(null)
    if (mode === 'login') login.mutate({ email, password }, { onSuccess: done })
    else if (mode === 'signup') signup.mutate({ name: values.name.trim(), email, password }, { onSuccess: done })
    else if (mode === 'forgot') forgot.mutate(email, { onSuccess: () => setSent({ email, at: Date.now() }) })
    else if (resetToken) {
      reset.mutate({ token: resetToken, password }, { onSuccess: () => onDone?.('password-changed') })
    }
  }

  function renderField(field: Field, label: string, input: ReactNode, hint?: string, aside?: ReactNode) {
    const error = errors[field]
    return (
      <div className={styles.field}>
        <div className={styles.labelRow}>
          <label className={styles.label} htmlFor={`${ids}-${field}`}>
            {label}
          </label>
          {aside}
        </div>
        {input}
        {error ? (
          <p id={`${ids}-${field}-message`} className={styles.fieldError}>
            {error}
          </p>
        ) : (
          hint && (
            <p id={`${ids}-${field}-message`} className={styles.hint}>
              {hint}
            </p>
          )
        )}
      </div>
    )
  }

  const choosingPassword = mode === 'signup' || mode === 'reset'
  const inputProps = (field: Field) => ({
    id: `${ids}-${field}`,
    ref: (element: HTMLInputElement | null) => {
      inputs.current[field] = element
    },
    name: field,
    className: styles.input,
    value: values[field],
    onChange: (event: { target: { value: string } }) => update(field, event.target.value),
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': errors[field] || (field === 'password' && choosingPassword) ? `${ids}-${field}-message` : undefined,
  })

  const serverError = active.error
  const status = serverError instanceof ApiError ? serverError.status : undefined
  const emailTaken = mode === 'signup' && status === 409
  const linkExpired = mode === 'reset' && status === 400

  // From a reset link while logged in, every way out goes back to the notes.
  const leave = signedIn ? () => onDone?.(null) : () => switchMode('login')
  const way = {
    login: { prompt: 'New here?', label: 'Create an account', go: () => switchMode('signup') },
    signup: { prompt: 'Already have an account?', label: 'Log in', go: () => switchMode('login') },
    forgot: signedIn
      ? { prompt: '', label: 'Back to your notes', go: leave }
      : { prompt: 'Remembered it?', label: 'Log in', go: leave },
    reset: signedIn
      ? { prompt: '', label: 'Back to your notes', go: leave }
      : { prompt: 'Remembered it?', label: 'Log in', go: leave },
  }[mode]

  return (
    <div className={styles.screen}>
      <section className={styles.intro} aria-labelledby={`${ids}-brand`}>
        <div className={styles.brand}>
          <span className={styles.logo}>
            <Logo />
          </span>
          <span id={`${ids}-brand`}>Notes</span>
        </div>
        <div className={styles.fan}>
          <NoteFan />
        </div>
        <p className={styles.lede}>Notes for what you need to do, buy and remember.</p>
        <p className={styles.ledeDetail}>
          Give a note a due date and it shows up in Today. Tick it off and it counts toward your week.
        </p>
      </section>

      <main className={styles.formSide}>
        {mode === 'forgot' && sent ? (
          <CheckEmail
            email={sent.email}
            sentAt={sent.at}
            backLabel={signedIn ? 'Back to your notes' : 'Back to log in'}
            onBack={leave}
          />
        ) : (
          <form className={styles.form} noValidate aria-labelledby={`${ids}-heading`} onSubmit={handleSubmit}>
            <div className={styles.formHead}>
              <h1 id={`${ids}-heading`} className={styles.heading}>
                {copy.heading}
              </h1>
              <p className={styles.detail}>{copy.detail}</p>
            </div>

            {notice && mode === 'login' && (
              <p className={styles.notice} role="status">
                {notice}
              </p>
            )}

            {mode === 'signup' &&
              renderField(
                'name',
                'Name',
                <input {...inputProps('name')} type="text" autoComplete="name" maxLength={NAME_MAX} />,
              )}

            {FIELDS[mode].includes('email') &&
              renderField(
                'email',
                'Email',
                <input
                  {...inputProps('email')}
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                />,
              )}

            {FIELDS[mode].includes('password') &&
              renderField(
                'password',
                mode === 'reset' ? 'New password' : 'Password',
                <div className={styles.passwordWrap}>
                  <input
                    {...inputProps('password')}
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  />
                  <button
                    type="button"
                    className={styles.reveal}
                    aria-label="Show password"
                    aria-pressed={showPassword}
                    aria-controls={`${ids}-password`}
                    data-tip={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword((current) => !current)}
                  >
                    {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                  </button>
                </div>,
                choosingPassword ? `At least ${PASSWORD_MIN} characters.` : undefined,
                mode === 'login' && (
                  <button type="button" className={`${styles.link} ${styles.small}`} onClick={() => switchMode('forgot')}>
                    Forgot password?
                  </button>
                ),
              )}

            {serverError && (
              <div className={styles.alert} role="alert">
                <p>{serverError.message}</p>
                {emailTaken && (
                  <button type="button" className={styles.link} onClick={() => switchMode('login')}>
                    Log in instead
                  </button>
                )}
                {linkExpired && (
                  <button type="button" className={styles.link} onClick={() => switchMode('forgot')}>
                    Send a new link
                  </button>
                )}
              </div>
            )}

            <button
              type="submit"
              className={`button button-primary ${styles.submit}`}
              aria-disabled={active.isPending || undefined}
            >
              {active.isPending ? copy.pending : copy.submit}
            </button>

            <p className={styles.switch}>
              {way.prompt && `${way.prompt} `}
              <button type="button" className={styles.link} onClick={way.go}>
                {way.label}
              </button>
            </p>
          </form>
        )}
      </main>
    </div>
  )
}

/**
 * After Email me a link. It reads the same whether or not the address has an
 * account, so the screen never tells a stranger who has signed up.
 */
function CheckEmail({
  email,
  sentAt: firstSentAt,
  backLabel,
  onBack,
}: {
  email: string
  sentAt: number
  backLabel: string
  onBack: () => void
}) {
  const forgot = useForgotPassword()
  const [sentAt, setSentAt] = useState(firstSentAt)
  const [now, setNow] = useState(firstSentAt)
  const [sentAgain, setSentAgain] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const ids = useId()
  const wait = Math.max(0, RESEND_GAP_SECONDS - Math.floor((now - sentAt) / 1000))
  const waiting = wait > 0

  // The heading takes focus, so a screen reader says where the form went.
  useEffect(() => heading.current?.focus(), [])

  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [waiting, sentAt])

  function sendAgain() {
    if (waiting || forgot.isPending) return
    forgot.mutate(email, {
      onSuccess: () => {
        const at = Date.now()
        setSentAt(at)
        setNow(at)
        setSentAgain(true)
      },
    })
  }

  return (
    <div className={styles.form}>
      <div className={styles.formHead}>
        <h1 ref={heading} id={`${ids}-heading`} className={styles.heading} tabIndex={-1}>
          Check your email
        </h1>
        <p className={styles.detail}>
          If an account uses <strong className={styles.address}>{email}</strong>, we've sent it a link to reset the
          password. The link works for 1 hour.
        </p>
      </div>

      <p className={styles.notice} role="status">
        {sentAgain ? 'Sent again. Only the newest link works.' : "Nothing yet? Check the spam folder."}
      </p>

      {forgot.isError && (
        <div className={styles.alert} role="alert">
          <p>{forgot.error.message}</p>
        </div>
      )}

      <button
        type="button"
        className={`button ${styles.submit}`}
        aria-disabled={waiting || forgot.isPending || undefined}
        onClick={sendAgain}
      >
        {forgot.isPending ? 'Sending…' : waiting ? `Send again in ${wait} s` : 'Send again'}
      </button>

      <p className={styles.switch}>
        <button type="button" className={styles.link} onClick={onBack}>
          {backLabel}
        </button>
      </p>
    </div>
  )
}

/** While the app asks the server who is logged in. Usually gone before anyone notices. */
export function AuthSplash({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className={styles.splash}>
      <span className={`${styles.logo} ${styles.splashLogo}`}>
        <Logo />
      </span>
      <p className="visually-hidden" role="status">
        {label}
      </p>
    </div>
  )
}

/** The server couldn't be reached. `onSkip` offers a way on without it. */
export function AuthUnavailable({
  heading = "Notes didn't load",
  message,
  retrying,
  onRetry,
  onSkip,
}: {
  heading?: string
  message: string
  retrying: boolean
  onRetry: () => void
  onSkip?: () => void
}) {
  return (
    <main className={styles.splash}>
      <div className={styles.unavailable}>
        <h1 className={styles.heading}>{heading}</h1>
        <p className={styles.detail}>{message}</p>
        <div className={styles.retryRow}>
          <button
            type="button"
            className={`button button-primary ${styles.retry}`}
            aria-disabled={retrying || undefined}
            onClick={() => {
              if (!retrying) onRetry()
            }}
          >
            {retrying ? 'Trying again…' : 'Try again'}
          </button>
          {onSkip && (
            <button type="button" className={styles.link} onClick={onSkip}>
              Skip for now
            </button>
          )}
        </div>
      </div>
    </main>
  )
}
