'use client'

import * as React from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Password input with a show/hide (view) toggle — drop-in replacement for
 * <Input type="password" />. Do NOT pass a `type` prop; the input type is
 * controlled internally (password ⇄ text) by the eye button.
 */
function PasswordInput({ className, ...props }: React.ComponentProps<'input'>) {
  const [show, setShow] = React.useState(false)
  return (
    <div className="relative w-full">
      <Input
        type={show ? 'text' : 'password'}
        className={cn('pr-9', className)}
        {...props}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
        onClick={() => setShow(s => !s)}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

export { PasswordInput }
