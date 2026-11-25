import 'katex/dist/katex.min.css'
import rehypeKatex from 'rehype-katex'
import type { Root } from 'hast'
import type { VFile } from 'vfile'

export function createKatexTransform(): (tree: Root, file: VFile) => void {
    return rehypeKatex() as unknown as (tree: Root, file: VFile) => void
}
