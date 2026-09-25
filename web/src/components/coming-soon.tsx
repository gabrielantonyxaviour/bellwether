/** Placeholder body for a screen that has not been built yet. */
export function ComingSoon({ screen, surface }: { screen: string; surface: string }) {
  return (
    <section className="flex min-h-[40vh] flex-col items-start justify-center gap-2 px-4 py-12 md:px-8" data-surface={surface}>
      <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">{surface}</p>
      <h1 className="text-xl font-semibold">Coming soon: {screen}</h1>
    </section>
  )
}
