import type { ButtonHTMLAttributes, ReactElement } from 'react'
import './ButtonSoft.css'

export type ButtonSoftProps = ButtonHTMLAttributes<HTMLButtonElement>

export function ButtonSoft({ className, children, ...rest }: ButtonSoftProps): ReactElement {
  return (
    <button className={className ? `button-soft ${className}` : 'button-soft'} {...rest}>
      {children}
    </button>
  )
}
