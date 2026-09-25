"use client"

import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperTrigger,
} from "@/components/reui/stepper"
import { motion, useReducedMotion } from "motion/react"

export type OnboardingStep = { id: string; value: number; label: string }

export function OnboardingStepper({
  currentStep,
  steps,
}: {
  currentStep: number
  steps: OnboardingStep[]
}) {
  const shouldReduceMotion = useReducedMotion()
  const progress = steps.length
    ? Math.min(Math.max(currentStep / steps.length, 0), 1)
    : 0

  return (
    <Stepper
      value={currentStep}
      className="relative h-1 overflow-visible rounded-none! leading-none"
    >
      <StepperNav
        aria-label="Onboarding progress"
        className="flex h-1 rounded-none!"
      >
        {steps.map((step) => (
          <StepperItem
            key={step.id}
            step={step.value}
            className="h-1 flex-1 overflow-hidden rounded-none! transition-all duration-300"
          >
            <StepperTrigger className="h-1 w-full flex-col items-start gap-0 rounded-none!">
              <StepperIndicator className="bg-muted data-[state=active]:bg-muted data-[state=completed]:bg-muted h-1 w-full rounded-none! border-0 p-0">
                <span className="sr-only">{step.label}</span>
              </StepperIndicator>
            </StepperTrigger>
          </StepperItem>
        ))}
      </StepperNav>

      <motion.div
        data-slot="onboarding-stepper-progress"
        className="bg-primary pointer-events-none absolute inset-y-0 left-0 z-10 w-full origin-left"
        initial={false}
        animate={{ scaleX: progress }}
        transition={
          shouldReduceMotion
            ? { duration: 0 }
            : { duration: 0.36, ease: [0.16, 1, 0.3, 1] }
        }
        aria-hidden="true"
      >
        {!shouldReduceMotion ? (
          <motion.span
            key={currentStep}
            data-slot="onboarding-stepper-progress-sweep"
            className="from-primary/0 via-primary-foreground/65 to-primary/0 absolute top-1/2 right-0 h-5 w-44 translate-x-1/2 -translate-y-1/2 bg-gradient-to-r blur-sm"
            initial={{ opacity: 0, x: -56 }}
            animate={{ opacity: [0, 0.5, 0], x: 64 }}
            transition={{ duration: 0.56, ease: [0.16, 1, 0.3, 1] }}
          />
        ) : null}
      </motion.div>
    </Stepper>
  )
}
