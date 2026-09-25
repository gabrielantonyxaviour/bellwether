import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "@/app/app"
import { initClusterConfig } from "@/lib/cluster"
import "./index.css"

const root = createRoot(document.getElementById("root")!)

// The cluster config (env + /config.json runtime override) is resolved before first render,
// so every module can read it synchronously through clusterConfig().
try {
  await initClusterConfig()
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
} catch (error) {
  root.render(
    <main className="p-6 text-sm" role="alert">
      <h1 className="font-semibold">Bellwether is misconfigured</h1>
      <p className="mt-2 text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>
    </main>,
  )
}
