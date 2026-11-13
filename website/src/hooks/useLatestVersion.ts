import { useEffect, useState } from "react";
import { GITHUB_REPO } from "@/const";

const CACHE_KEY = "dugong-site-latest-version";
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

interface CachedVersion {
    version: string;
    timestamp: number;
}

/** The latest release tag, or null until (and unless) it is known. */
export function useLatestVersion(): string | null {
    const [version, setVersion] = useState<string | null>(() => {
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                const { version, timestamp }: CachedVersion = JSON.parse(cached);
                if (Date.now() - timestamp < CACHE_TTL) {
                    return version;
                }
            }
        } catch {
            // Ignore cache errors
        }
        return null;
    });

    useEffect(() => {
        const fetchVersion = async () => {
            try {
                const res = await fetch(
                    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
                    { headers: { Accept: "application/vnd.github.v3+json" } }
                );
                if (!res.ok) return;

                const data = await res.json();
                const tag = data.tag_name as string | undefined;
                if (tag) {
                    setVersion(tag);
                    localStorage.setItem(
                        CACHE_KEY,
                        JSON.stringify({ version: tag, timestamp: Date.now() })
                    );
                }
            } catch {
                // Show nothing on error
            }
        };

        fetchVersion();
    }, []);

    return version;
}
