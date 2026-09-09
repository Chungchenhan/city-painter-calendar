import assert from 'node:assert/strict'
import { parseUploadPhotoMetadata } from '../api/upload-drive.js'
import { photoCaptureMetadataFromExif } from '../src/lib/photoMetadata.ts'
import {
  cachedDevicePhotoLocation,
  mergePhotoCaptureMetadata,
  requestDevicePhotoLocation,
  requestDevicePhotoLocationForEvent,
} from '../src/lib/photoGeolocation.ts'

const capture = photoCaptureMetadataFromExif({
  DateTimeOriginal: new Date('2026-07-23T02:03:04.000Z'),
  latitude: 25.0478,
  longitude: 121.5319,
})
assert.deepEqual(capture, {
  capturedAt: '2026-07-23T02:03:04.000Z',
  capturedAtSource: 'exif',
  location: {
    latitude: 25.0478,
    longitude: 121.5319,
    source: 'exif',
  },
})

assert.deepEqual(photoCaptureMetadataFromExif({ latitude: 91, longitude: 121 }), {
  capturedAtSource: 'unknown',
})

assert.deepEqual(parseUploadPhotoMetadata({
  capturedAt: ['2026-07-23T02:03:04.000Z'],
  capturedAtSource: ['exif'],
  location: [JSON.stringify({ latitude: 25.0478, longitude: 121.5319, source: 'exif' })],
}), capture)

assert.throws(
  () => parseUploadPhotoMetadata({ location: '{"latitude":999,"longitude":121,"source":"exif"}' }),
  /照片拍攝地點格式不正確/,
)

let requestedOptions: PositionOptions | undefined
const deviceLocation = await requestDevicePhotoLocation({
  getCurrentPosition(success, _error, options) {
    requestedOptions = options
    success({
      coords: {
        latitude: 22.646772,
        longitude: 120.310425,
        accuracy: 12,
      },
      timestamp: Date.now(),
    } as GeolocationPosition)
  },
})
assert.deepEqual(requestedOptions, {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 0,
})
assert.deepEqual(deviceLocation.location, {
  latitude: 22.646772,
  longitude: 120.310425,
  accuracy: 12,
  source: 'device',
})

assert.deepEqual(parseUploadPhotoMetadata({
  capturedAtSource: 'unknown',
  location: JSON.stringify(deviceLocation.location),
}), {
  capturedAtSource: 'unknown',
  location: deviceLocation.location,
})

assert.deepEqual(mergePhotoCaptureMetadata(
  { capturedAtSource: 'unknown' },
  { capturedAtSource: 'unknown', location: deviceLocation.location },
), {
  capturedAtSource: 'unknown',
  location: deviceLocation.location,
})

assert.deepEqual(mergePhotoCaptureMetadata(capture, {
  capturedAtSource: 'unknown',
  location: deviceLocation.location,
}), capture)

const deniedLocation = await requestDevicePhotoLocation({
  getCurrentPosition(_success, error) {
    error({ code: 1 } as GeolocationPositionError)
  },
})
assert.equal(deniedLocation.location, undefined)
assert.match(deniedLocation.warning ?? '', /尚未允許位置權限/)

const cacheRows = new Map<string, string>()
const storage = {
  getItem(key: string) {
    return cacheRows.get(key) ?? null
  },
  setItem(key: string, value: string) {
    cacheRows.set(key, value)
  },
  removeItem(key: string) {
    cacheRows.delete(key)
  },
}
let permissionRequests = 0
const eventLocation = await requestDevicePhotoLocationForEvent('event-1', {
  storage,
  now: Date.parse('2026-09-05T01:00:00.000Z'),
  geolocation: {
    getCurrentPosition(success) {
      permissionRequests += 1
      success({
        coords: {
          latitude: 22.646772,
          longitude: 120.310425,
          accuracy: 12,
        },
        timestamp: Date.now(),
      } as GeolocationPosition)
    },
  },
})
const reusedEventLocation = await requestDevicePhotoLocationForEvent('event-1', {
  storage,
  now: Date.parse('2026-09-05T02:00:00.000Z'),
  geolocation: {
    getCurrentPosition() {
      permissionRequests += 1
    },
  },
})
assert.deepEqual(reusedEventLocation, eventLocation)
assert.equal(permissionRequests, 1)
assert.equal(cachedDevicePhotoLocation(
  'event-1',
  storage,
  Date.parse('2026-09-05T10:00:00.001Z'),
), undefined)

console.log('photo metadata tests passed')

const unavailableLocation = await requestDevicePhotoLocation({
  getCurrentPosition() {
    throw new Error('Location service unavailable')
  },
})
assert.equal(unavailableLocation.location, undefined)
assert.match(unavailableLocation.warning ?? '', /暫時無法取得目前位置/)
