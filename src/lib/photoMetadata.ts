export type PhotoCapturedAtSource = 'exif' | 'manual' | 'unknown'

export interface PhotoLocation {
  latitude: number
  longitude: number
  source: 'exif' | 'manual'
  label?: string
}

export interface PhotoCaptureMetadata {
  capturedAt?: string
  capturedAtSource: PhotoCapturedAtSource
  location?: PhotoLocation
}

function validDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.trim().replace(
    /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/,
    '$1-$2-$3T$4:$5:$6',
  )
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function finiteCoordinate(value: unknown, minimum: number, maximum: number): number | null {
  const coordinate = Number(value)
  return Number.isFinite(coordinate) && coordinate >= minimum && coordinate <= maximum
    ? coordinate
    : null
}

export function photoCaptureMetadataFromExif(metadata: Record<string, unknown> | undefined): PhotoCaptureMetadata {
  const capturedAt = validDate(
    metadata?.DateTimeOriginal ?? metadata?.CreateDate ?? metadata?.DateTimeDigitized,
  )
  const latitude = finiteCoordinate(metadata?.latitude, -90, 90)
  const longitude = finiteCoordinate(metadata?.longitude, -180, 180)
  return {
    ...(capturedAt ? { capturedAt: capturedAt.toISOString() } : {}),
    capturedAtSource: capturedAt ? 'exif' : 'unknown',
    ...(latitude !== null && longitude !== null
      ? { location: { latitude, longitude, source: 'exif' } as const }
      : {}),
  }
}

export async function extractPhotoCaptureMetadata(file: File): Promise<PhotoCaptureMetadata> {
  try {
    const { parse } = await import('exifr')
    const metadata = await parse(file, {
      tiff: true,
      exif: true,
      gps: true,
      xmp: false,
      icc: false,
      iptc: false,
      jfif: false,
      ihdr: false,
      mergeOutput: true,
    }) as Record<string, unknown> | undefined
    return photoCaptureMetadataFromExif(metadata)
  } catch {
    // 部分舊圖或截圖沒有可解析的 EXIF，仍需允許上傳。
    return { capturedAtSource: 'unknown' }
  }
}

