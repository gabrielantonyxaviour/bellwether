/** Root: react-query, the wallet, toasts and the router. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"
import { RouterProvider } from "react-router"
import { createRouter } from "@/app/routes"
import { Toaster } from "@/components/ui/sonner"
import { ApiError } from "@/lib/api"
import { WalletProvider } from "@/lib/wallet"

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        // A 4xx is the service's final answer; retry only network and 5xx failures.
        retry: (count, error) => count < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      },
    },
  })
}

export function App() {
  const [queryClient] = useState(makeQueryClient)
  const [router] = useState(createRouter)
  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <RouterProvider router={router} />
        <Toaster position="bottom-right" />
      </WalletProvider>
    </QueryClientProvider>
  )
}
