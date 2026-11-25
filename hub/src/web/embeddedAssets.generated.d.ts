// Stub types for embeddedAssets.generated.ts when the manifest is not generated.

export interface EmbeddedWebAsset {
    path: string;
    sourcePath: string;
    mimeType: string;
    /** Brotli copy made by the web build; served when the client accepts br. */
    brotliSourcePath?: string;
}

export const embeddedAssets: EmbeddedWebAsset[];
