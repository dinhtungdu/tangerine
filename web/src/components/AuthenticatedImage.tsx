import { useEffect, useState, type ImgHTMLAttributes } from "react"
import { cn } from "@/lib/utils"
import { buildAuthHeaders, emitAuthFailure } from "../lib/auth"

function requiresAuthenticatedFetch(src: string): boolean {
  return src.startsWith("/api/")
}

export function AuthenticatedImage({
  src,
  alt,
  className,
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")

  useEffect(() => {
    if (!src) {
      setResolvedSrc(null)
      setStatus("error")
      return
    }

    if (!requiresAuthenticatedFetch(src)) {
      setResolvedSrc(src)
      setStatus("ready")
      return
    }

    let cancelled = false
    let objectUrl: string | null = null
    setResolvedSrc(null)
    setStatus("loading")

    fetch(src, { headers: buildAuthHeaders() })
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 401) emitAuthFailure()
          throw new Error(`Image request failed (${res.status})`)
        }
        const blob = await res.blob()
        objectUrl = URL.createObjectURL(blob)
        if (!cancelled) {
          setResolvedSrc(objectUrl)
          setStatus("ready")
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedSrc(null)
          setStatus("error")
        }
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [src])

  if (!src) return null

  if (resolvedSrc) {
    return <img {...props} alt={alt} className={className} src={resolvedSrc} />
  }

  if (!requiresAuthenticatedFetch(src)) {
    return <img {...props} alt={alt} className={className} src={src} />
  }

  return (
    <div
      aria-busy={status === "loading" ? true : undefined}
      aria-label={alt}
      className={cn("bg-muted", className)}
      role="img"
    >
      <span className="sr-only">{status === "loading" ? "Loading image" : "Image unavailable"}</span>
    </div>
  )
}
