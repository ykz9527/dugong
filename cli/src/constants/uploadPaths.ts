import { join } from 'path'
import { tmpdir } from 'os'

export const DUGONG_BLOBS_DIR_NAME = 'hapi-blobs'

export function getHapiBlobsDir(): string {
    return join(tmpdir(), DUGONG_BLOBS_DIR_NAME)
}
