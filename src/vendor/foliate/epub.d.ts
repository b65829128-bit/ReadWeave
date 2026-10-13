export class EPUB {
  constructor(loader: { loadText(path: string): Promise<string | null>; loadBlob(path: string): Promise<Blob | null>; getSize(path: string): number })
  metadata: Record<string, unknown>
  rendition: { layout?: string }
  sections: { id: string; cfi: string; size: number; createDocument(): Promise<Document> }[]
  toc: { label: string; href: string; subitems?: { label: string; href: string }[] }[]
  transformTarget: EventTarget
  init(): Promise<EPUB>
  destroy(): void
}
