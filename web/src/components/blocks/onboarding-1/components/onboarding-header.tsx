import { CheckCircleIcon } from "lucide-react"

/** Header adapted from ReUI onboarding-1 for Bellwether's admission steps. */
export function OnboardingHeader({ currentStep, statusLabel }: { currentStep: number; statusLabel?: string }) {
  return <header className="flex items-center justify-between gap-3 border-b px-5 py-4 sm:px-8">
    <span className="font-semibold">Bellwether</span>
    {statusLabel ? <span className="inline-flex items-center gap-1 text-sm"><CheckCircleIcon className="size-4" />{statusLabel}</span>
      : <span className="text-sm text-muted-foreground">Step {currentStep} of 3</span>}
  </header>
}
