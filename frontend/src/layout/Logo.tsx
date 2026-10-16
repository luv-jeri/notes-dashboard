/** A note with a folded corner and a tick: notes you can also finish. Same shape as the favicon. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V9z" />
      <path d="M14 3v4a2 2 0 0 0 2 2h4" />
      <path d="m8.5 14.5 2.5 2.5 4.5-4.5" />
    </svg>
  )
}
