import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: false,
            retry: 1,
        },
        mutations: {
            retry: 0,
            // Never park a user action waiting for a browser `online` event
            // (phones can miss it); try the request and let errors surface.
            networkMode: 'always',
        },
    },
})
