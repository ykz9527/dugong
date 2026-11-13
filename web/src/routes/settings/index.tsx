import { SettingsNav } from '@/components/settings/SettingsNav'
import SettingsDisplayPage from './display'

export default function SettingsHubPage() {
    return (
        <>
            <div className="lg:hidden">
                <div className="px-4 pt-4">
                    <SettingsNav mobile />
                </div>
            </div>
            <div className="hidden lg:block">
                <SettingsDisplayPage />
            </div>
        </>
    )
}
