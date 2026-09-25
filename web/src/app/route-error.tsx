import { isRouteErrorResponse, Link, useRouteError } from "react-router"
import { paths } from "@/app/paths"

export function RouteError() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : "Something went wrong"
  return (
    <section className="flex min-h-[40vh] flex-col items-start justify-center gap-3 px-4 py-12 md:px-8" role="alert">
      <h1 className="text-xl font-semibold">This page failed to load</h1>
      <p className="text-sm text-muted-foreground">{message}</p>
      <Link to={paths.home} className="text-sm underline underline-offset-4">Back to home</Link>
    </section>
  )
}

export function NotFound() {
  return (
    <section className="flex min-h-[40vh] flex-col items-start justify-center gap-3 px-4 py-12 md:px-8">
      <h1 className="text-xl font-semibold">No page here</h1>
      <Link to={paths.home} className="text-sm underline underline-offset-4">Back to home</Link>
    </section>
  )
}
