import { useEffect, useState, type ImgHTMLAttributes, type VideoHTMLAttributes } from "react"
import { cn } from "@/lib/utils"
import { isVideoSrc } from "@tangerine/shared"
import { buildAuthHeaders, emitAuthFailure } from "../lib/auth"

function requiresAuthenticatedFetch(src: string): boolean {
  return src.startsWith("/api/")
}

type MediaProps = {
  src?: string
  alt?: string
  className?: string
} & Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> &
  Pick<VideoHTMLAttributes<HTMLVideoElement>, "controls" | "muted" | "loop" | "autoPlay">

export function AuthenticatedMedia({
  src,
  alt,
  className,
  controls,
  muted,
  loop,
  autoPlay,
  ...props
}: MediaProps) {
  const source = typeof src === "string" ? src : null
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")

  useEffect(() => {
    if (!source) {
      setResolvedSrc(null)
      setStatus("error")
      return
    }

    if (!requiresAuthenticatedFetch(source)) {
      setResolvedSrc(source)
      setStatus("ready")
      return
    }

    let cancelled = false
    let objectUrl: string | null = null
    setResolvedSrc(null)
    setStatus("loading")

    fetch(source, { headers: buildAuthHeaders() })
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 401) emitAuthFailure()
          throw new Error(`Media request failed (${res.status})`)
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
  }, [source])

  if (!source) return null

  const isVideo = isVideoSrc(source)

  if (resolvedSrc) {
    if (isVideo) {
      return (
        <video
          src={resolvedSrc}
          className={className}
          controls={controls ?? true}
          muted={muted}
          loop={loop}
          autoPlay={autoPlay}
          playsInline
        />
      )
    }
    return <img {...props} alt={alt} className={className} src={resolvedSrc} />
  }

  if (!requiresAuthenticatedFetch(source)) {
    if (isVideo) {
      return (
        <video
          src={source}
          className={className}
          controls={controls ?? true}
          muted={muted}
          loop={loop}
          autoPlay={autoPlay}
          playsInline
        />
      )
    }
    return <img {...props} alt={alt} className={className} src={source} />
  }

  return (
    <div
      aria-busy={status === "loading" ? true : undefined}
      aria-label={alt}
      className={cn("bg-muted", className)}
      role="img"
    >
      <span className="sr-only">{status === "loading" ? "Loading media" : "Media unavailable"}</span>
    </div>
  )
}
