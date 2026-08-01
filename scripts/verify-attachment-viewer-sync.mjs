import fs from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()
const projectName = path.basename(projectRoot)
const siblingName = projectName === 'city-painter-erp'
  ? 'city-painter-calendar'
  : 'city-painter-erp'
const relativeModulePath = path.join('src', 'components', 'shared', 'AttachmentImageViewer.tsx')
const localModulePath = path.join(projectRoot, relativeModulePath)
const siblingModulePath = path.join(path.dirname(projectRoot), siblingName, relativeModulePath)

if (!fs.existsSync(localModulePath)) {
  throw new Error(`找不到照片檢視共用模組：${localModulePath}`)
}

if (!fs.existsSync(siblingModulePath)) {
  console.log('照片檢視共用模組同步檢查略過：目前環境沒有另一個本機專案。')
  process.exit(0)
}

const localSource = fs.readFileSync(localModulePath)
const siblingSource = fs.readFileSync(siblingModulePath)

if (!localSource.equals(siblingSource)) {
  throw new Error('ERP 與行事曆的 AttachmentImageViewer.tsx 不一致，請同步修改後再建置。')
}

console.log('照片檢視共用模組同步檢查通過。')
