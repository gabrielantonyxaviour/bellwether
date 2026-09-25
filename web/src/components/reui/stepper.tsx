import { createContext, useContext, type HTMLAttributes, type ReactNode } from "react"
import { cn } from "cn"

type StepperContextValue = { current: number }
const StepperContext = createContext<StepperContextValue | null>(null)
const ItemContext = createContext<number | null>(null)

function useStepper() {
  const value = useContext(StepperContext)
  if (!value) throw new Error("Stepper items require a Stepper")
  return value
}

export function Stepper({ value, className, children }: { value: number; className?: string; children: ReactNode }) {
  return <StepperContext.Provider value={{ current: value }}><div className={cn("w-full", className)}>{children}</div></StepperContext.Provider>
}

export function StepperNav({ className, children, ...props }: HTMLAttributes<HTMLElement>) {
  return <nav className={cn("flex w-full", className)} {...props}>{children}</nav>
}

export function StepperItem({ step, className, children }: { step: number; className?: string; children: ReactNode }) {
  const { current } = useStepper()
  const state = step < current ? "completed" : step === current ? "active" : "inactive"
  return <ItemContext.Provider value={step}><div className={cn("min-w-0 flex-1", className)} data-state={state}>{children}</div></ItemContext.Provider>
}

export function StepperTrigger({ className, children }: { className?: string; children: ReactNode }) {
  const step = useContext(ItemContext)
  const { current } = useStepper()
  return <div className={cn("w-full", className)} role="group" aria-current={step === current ? "step" : undefined}>{children}</div>
}

export function StepperIndicator({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("w-full", className)}>{children}</div>
}
