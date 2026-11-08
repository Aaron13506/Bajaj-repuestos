// La foto chica del despiece al lado de un nombre. El nombre va al lado: la foto es decorativa.
export default function Miniatura({ src }: { src: string | null }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" loading="lazy" className="size-11 object-contain rounded-md border border-gray-100 bg-white shrink-0" />
  ) : (
    <div aria-hidden="true" className="size-11 rounded-md border border-gray-100 bg-gray-50 shrink-0" />
  )
}
