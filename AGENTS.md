# AGENTS.md

## 專案
- 名稱：都市彩繪行事曆
- 路徑：`/Users/henry/Downloads/Henry-agent/city-painter-calendar/`
- 技術：React + TypeScript + Vite + Firebase + PWA

## 本地預覽
- 固定網址：`http://localhost:5175/`
- 啟動指令：`npm run dev`
- 此專案固定使用 port `5175`，不得與其他專案共用。

## Firebase
- 共用 ERP/HR 的 Firebase 專案設定。
- 登入權限共用 HR 專案的 `userRoles` collection。
- 員工與部門資料共用 HR 的 `employees`、`departments` collections。
- 行事曆專用資料：
  - `calendarCalendars`
  - `calendarEvents`
  - `calendarEvents/{eventId}/comments`

## TimeTree 匯入紀錄
- 已從 TimeTree 匯入 `2021-01-01` 之後的都市彩繪工作事件；若未來要補更早日期，再沿用同一套匯入方式往前追加。
- 匯入來源是使用者已登入 Chrome 的 TimeTree IndexedDB：`~/Library/Application Support/Google/Chrome/Default/IndexedDB/https_timetreeapp.com_0.indexeddb.leveldb`。
- 匯入流程：用 `dfindexeddb` 匯出 IndexedDB，重建 `/timetree` SQLite 資料庫，再讀取 `events` 表寫入 Firestore `calendarEvents`。
- Firestore 文件 ID 使用 `timeTree_{TimeTree event id}`，避免重跑時產生重複事件。
- 匯入資料標記：
  - `source`: `timeTreeImport`
  - `sourceId`: `timeTreeFullFrom202101`
  - `timeTreeCalendarId`: `52713068`
  - `timeTreeEventId` / `timeTreeLabelId` 保留原始 TimeTree 對應資訊。
- 已匯入判斷規則：
  - `label_id = 1`：廣告部。
  - `label_id = 9`：活動部。
  - `label_id = 4`：早期主工作標籤，歸廣告部。
  - `label_id = 2`：設計類工作，先歸廣告部。
  - `label_id = 8`：活動、場刊、心健月、失智月類，歸活動部。
  - `label_id = 3`：混有私人與工作，只匯入含工作 icon 的事件，例如 `👷`、`📦`、`📐`、`🎪`、`🚗`、`💗`、`👨‍🦳`、`💼`、`🎨`、`🚀`；魚缸、生日、私人雜項不匯入。
- 目前匯入結果：合計 `3203` 筆，廣告部 `2854` 筆，活動部 `349` 筆，日期範圍 `2021-01-01` 至 `2026-11-07`。
- 管理部補匯：TimeTree 的 `calendar_id = 2641090` 與 `2641052` 已歸入管理部，`sourceId` 為 `timeTreeManagementCalendarsFrom202101`；合計 `620` 筆，日期範圍 `2021-01-01` 至 `2026-11-28`。

## 權限
- `userRoles.role === "admin"`：可建立、編輯、刪除行事曆與工作。
- `employee`：只能查看自己被授權的行事曆與工作。
- 行事曆可用 `departmentIds` 與 `employeeIds` 控制可見範圍。

## 資訊安全與 App Check（強制）

- Firestore／Storage App Check 已強制執行。`src/lib/firebase.ts` 必須初始化 App Check；未經使用者明確同意不得關閉或降級。
- 本機 App Check debug token 僅放 `.env.local`，並先登記於 Firebase Console；變更後必須完整重啟固定 `5175` dev server，且不得同時保留讀取舊環境變數的重複行程。
- 新增或修改前端 `/api/*` 呼叫時，必須同時送出 Firebase ID token 與最新 `X-Firebase-AppCheck` token；token 取得失敗不得靜默改成無驗證請求。
- 寫入、刪除、密碼、推播設定與附件上傳 API 每次都要驗證 Firebase ID token、`userRoles/{uid}`、員工在職狀態、行事曆可見範圍與必要角色／action；不可只驗證已登入或相信前端傳入的 UID、employeeId、calendarId。
- 附件公開 GET 僅限 LINE 等無法帶 Auth header 的必要情境，且必須使用 HMAC 簽名網址並驗證 `fileId`、variant 與 signature；Google Drive fileId 或網址難猜不能當作授權。
- 上傳需限制檔案大小、允許類型與解析結果，檔名不得直接用於本機路徑；暫存檔無論成功或失敗都要清理，錯誤訊息不得洩漏 service account、Drive token 或伺服器路徑。
- `firebase-admin` 目前固定為精確版本 `13.10.0`，不得改回 `^`、`~` 或直接升 v14。升級前必須先把所有 `api/*.js` 遷移為 modular imports，並逐端點實測 Auth、App Check、Firestore、推播與 Drive 上傳。
- 曾發生 v14 搭配舊式 default import，使所有 API token 被誤判為「登入已失效」；遇到全站 API 同時 401 時，先檢查 lockfile 實際版本與 Admin SDK 初始化，不得先叫使用者重設密碼。
- 資安或上傳修改完成前，至少測試：合法員工成功、一般員工越權被拒、缺少／無效 App Check 被拒、錯誤簽名被拒，以及實際上傳成功後刪除測試檔案。

## UI
- 介面風格比照 TimeTree：左側行事曆清單、主月曆、右側當日工作清單。
- 手機版必須保留完整功能，底部操作列需計入 safe-area。

## 效能
- 手機版 PWA 首頁必須秒入：先顯示 App Shell 或上次快取的行事曆資料，再背景同步最新 Firestore 資料。
- 首頁不得因等待所有行事曆、員工、部門、附件或通知資料載完才顯示。
- PWA 導航頁面優先使用快取回應，避免弱網路下白畫面。
- 新增功能時若會增加首頁請求或 bundle，必須改成延後載入或背景載入。

## PWA / 快取更新
- 每次 build / deploy 必須產生 `/app-version.json`，版本值優先使用 `VERCEL_GIT_COMMIT_SHA`，其次 `VERCEL_DEPLOYMENT_ID`。
- 前端啟動、回到前景、視窗 focus 時，以 `cache: 'no-store'` 檢查 `/app-version.json?t=...`。
- 若版本與 localStorage 記錄不同，必須清除 Cache Storage 並重新整理頁面；需用 sessionStorage reload flag 防止無限重載。
- Service Worker 必須啟用 `skipWaiting`、`clientsClaim`、`autoUpdate`，部署後不可讓手機版長時間停在舊快取。
