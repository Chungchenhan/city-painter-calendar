import assert from 'node:assert/strict'
import { parseUploadPhotoMetadata } from '../api/upload-drive.js'
import { photoCaptureMetadataFromExif } from '../src/lib/photoMetadata.ts'

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

console.log('photo metadata tests passed')

