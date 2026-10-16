import { Eye, EyeOff } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode, type SubmitEvent } from 'react'
import { NAME_MAX, PASSWORD_MAX, PASSWORD_MIN } from '../api/auth'
import { ApiError } from '../api/client'
import { Logo } from '../layout/Logo'
import { NoteFan } from '../layout/NoteFan'
import { useLogin, useSignup } from './session'
import styles from './AuthScreen.module.css'

type Mode = 'login' | 'signup'
type Field = 'name' | 'email' | 'password'
type FieldErrors = Partial<Record<Field, string>>

const FIELDS: Record<Mode, Field[]> = {
  login: ['email', 'password'],
  signup: ['name', 'email', 'password'],
}

// The server checks properly; this only catches typos before a round trip.
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const COPY = {
  login: {
    heading: 'Log in',
    detail: 'Your notes are where you left them.',
    submit: 'Log in',
    pending: 'Logging in…',
    switchPrompt: 'New here?',
    switchLabel: 'Create an account',
  },
  signup: {
    heading: 'Create your account',
    detail: 'Notes you write are saved to your account, and only you can see them.',
    submit: 'Create account',
    pending: 'Creating account…',
    switchPrompt: 'Already have an account?',
    switchLabel: 'Log in',
  },
} as const

/** Log in or sign up. `notice` explains why someone is here, such as an ended session. */
export function AuthScreen({ notice }: { notice?: string }) {
  const [mode, setMode] = useState<Mode>('login')
  const [values, setValues] = useState<Record<Field, string>>({ name: '', email: '', password: '' })
  const [errors, setErrors] = useState<FieldErrors>({})
  const [showPassword, setShowPassword] = useState(false)
  const login = useLogin()
  const signup = useSignup()
  const active = mode === 'login' ? login : signup
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
    login.reset()
    signup.reset()
  }

  function update(field: Field, value: string) {
    setValues((current) => ({ ...current, [field]: value }))
    // A fixed field stops saying it's wrong; a new attempt clears the old answer.
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }))
    if (active.isError) active.reset()
  }

  function check(): FieldErrors {
    const found: FieldErrors = {}
    if (mode === 'signup' && !values.name.trim()) found.name = 'Enter your name.'
    const email = values.email.trim()
    if (!email) found.email = 'Enter your email address.'
    else if (!LOOKS_LIKE_EMAIL.test(email)) found.email = 'Enter an email address like name@example.com.'
    if (!values.password) found.password = 'Enter your password.'
    else if (mode === 'signup' && values.password.length < PASSWORD_MIN) {
      found.password = `Use at least ${PASSWORD_MIN} characters.`
    } else if (values.password.length > PASSWORD_MAX) {
      found.password = `Use ${PASSWORD_MAX} characters or fewer.`
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
    if (mode === 'login') login.mutate({ email, password: values.password })
    else signup.mutate({ name: values.name.trim(), email, password: values.password })
  }

  function renderField(field: Field, label: string, input: ReactNode, hint?: string) {
    const error = errors[field]
    return (
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${ids}-${field}`}>
          {label}
        </label>
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
    'aria-describedby': errors[field] || (field === 'password' && mode === 'signup') ? `${ids}-${field}-message` : undefined,
  })

  const serverError = active.error
  const emailTaken = mode === 'signup' && serverError instanceof ApiError && serverError.status === 409

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
        <form className={styles.form} noValidate aria-labelledby={`${ids}-heading`} onSubmit={handleSubmit}>
          <div className={styles.formHead}>
            <h1 id={`${ids}-heading`} className={styles.heading}>
              {copy.heading}
            </h1>
            <p className={styles.detail}>{copy.detail}</p>
          </div>

          {notice && (
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

          {renderField(
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

          {renderField(
            'password',
            'Password',
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
            mode === 'signup' ? `At least ${PASSWORD_MIN} characters.` : undefined,
          )}

          {serverError && (
            <div className={styles.alert} role="alert">
              <p>{serverError.message}</p>
              {emailTaken && (
                <button type="button" className={styles.link} onClick={() => switchMode('login')}>
                  Log in instead
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
            {copy.switchPrompt}{' '}
            <button
              type="button"
              className={styles.link}
              onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
            >
              {copy.switchLabel}
            </button>
          </p>
        </form>
      </main>
    </div>
  )
}

/** While the app asks the server who is logged in. Usually gone before anyone notices. */
export function AuthSplash() {
  return (
    <div className={styles.splash}>
      <span className={`${styles.logo} ${styles.splashLogo}`}>
        <Logo />
      </span>
      <p className="visually-hidden" role="status">
        Loading…
      </p>
    </div>
  )
}

/** The server couldn't be asked who is logged in. */
export function AuthUnavailable({
  message,
  retrying,
  onRetry,
}: {
  message: string
  retrying: boolean
  onRetry: () => void
}) {
  return (
    <main className={styles.splash}>
      <div className={styles.unavailable}>
        <h1 className={styles.heading}>Notes didn't load</h1>
        <p className={styles.detail}>{message}</p>
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
      </div>
    </main>
  )
}
