declare module 'bun:bundle' {
    interface Registry {
        features:
            | 'DUGONG_TARGET_DARWIN_ARM64'
            | 'DUGONG_TARGET_DARWIN_X64'
            | 'DUGONG_TARGET_LINUX_ARM64'
            | 'DUGONG_TARGET_LINUX_X64'
            | 'DUGONG_TARGET_WIN32_X64';
    }

    export function feature(name: Registry['features']): boolean;
}
