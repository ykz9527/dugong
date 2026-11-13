// Documentation screenshots mount production screens with synthetic API responses.
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from '@tanstack/react-router'
import { ApiClient } from '../src/api/client'
import { AppContextProvider } from '../src/lib/app-context'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider } from '../src/lib/toast-context'
import SettingsLayout from '../src/routes/settings/layout'
import { NewSession } from '../src/components/NewSession'
import { CURRENT_MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import { MACHINE } from './assistant-panel-demo-data'
import FilesPage from '../src/routes/sessions/files'
import FilePage from '../src/routes/sessions/file'
import TerminalPage from '../src/routes/sessions/terminal'
import '@fontsource-variable/host-grotesk'
import '../src/index.css'
import Page0 from '../src/routes/settings/general'
import Page1 from '../src/routes/settings/display'
import Page2 from '../src/routes/settings/chat'
import Page3 from '../src/routes/settings/voice'
import Page4 from '../src/routes/settings/machines'
import Page5 from '../src/routes/settings/git-host'
import Page6 from '../src/routes/settings/storage'
import Page7 from '../src/routes/settings/usage'
import Page8 from '../src/routes/settings/about'
import Page9 from '../src/routes/settings/voice-voices'
import Page10 from '../src/routes/settings/voice-advanced'

const api = new ApiClient('documentation-only')
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const rootRoute = createRootRoute({ component: Outlet })
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsLayout })
const settingsPages = [
    createRoute({ getParentRoute: () => settingsRoute, path: 'general', component: Page0 }),
    createRoute({ getParentRoute: () => settingsRoute, path: 'display', component: Page1 }),
    createRoute({ getParentRoute: () => settingsRoute, path: 'chat', component: Page2 }),
    createRoute({ getParentRoute: () => settingsRoute, path: 'voice', component: Page3 }),
    createRoute({ getParentRoute: () => settingsRoute, path: 'machines', component: Page4 }),
    createRoute({ getParentRoute: () => settingsRoute, path: 'git-host', component: Page5 }),
    createRoute({ getParentRoute: () => settingsRoute, path: 'storage', component: Page6 }),
    createRoute({ getParentRoute: () => settingsRoute, path: 'usage', component: Page7 }),
    createRoute({ getParentRoute: () => settingsRoute, path: 'about', component: Page8 }),
    createRoute({ getParentRoute: () => settingsRoute, path: 'voice/voices', component: Page9 }),
    createRoute({ getParentRoute: () => settingsRoute, path: 'voice/advanced', component: Page10 }),
 ]
const newRoute = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/new', component: () => <NewSession api={api} machines={[{ ...MACHINE, metadata: { ...MACHINE.metadata, capabilities: [...CURRENT_MACHINE_CAPABILITIES] } }]} initialMachineId={MACHINE.id} initialDirectory="/home/demo/projects/dugong" onSuccess={() => {}} onCancel={() => {}} /> })
const filesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$sessionId/files', component: FilesPage })
const fileRoute = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$sessionId/file', component: FilePage, validateSearch: (search: Record<string, unknown>) => ({ path: typeof search.path === 'string' ? search.path : '', staged: search.staged === true, mode: search.mode === 'diff' ? 'diff' : undefined }) })
const terminalRoute = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$sessionId/terminal', component: TerminalPage })
const router = createRouter({ routeTree: rootRoute.addChildren([settingsRoute.addChildren(settingsPages), newRoute, filesRoute, fileRoute, terminalRoute]), history: createMemoryHistory({ initialEntries: [new URLSearchParams(location.search).get('path') ?? '/settings/general'] }) })
ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <AppContextProvider value={{ api, token: 'docs.eyJucyI6ImRlZmF1bHQifQ.docs', baseUrl: '' }}>
            <I18nProvider><ToastProvider><RouterProvider router={router} /></ToastProvider></I18nProvider>
        </AppContextProvider>
    </QueryClientProvider>
)
