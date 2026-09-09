# Calendar 資料存取保護（本機）

2026-09-09：事件／行事曆／來源關聯／活動紀錄／留言統一經現有 `/api/widget-calendar?action=data` 讀取。每次驗證 Firebase Auth、撤銷／停用、在職與 App Check，事件依 `shared/calendarEventAccess.js` 過濾；保留非管理部跨部門共享與 visible 優先 hidden。非管理人員不回傳 HR 請假 note 或假別；以權威假單 employeeId 查員工目錄組成「姓名 請假」，清除 titleOverrides 防止替代標題繞過。API 不採用前端提供的員工 ID 或角色。

事件列表每頁最多掃描 200，回傳 cursor，搜尋由前端逐頁取得完整可見結果；當月範圍與重複工作分開查詢。React Query 所有關聯 key 與本機 Query cache 依 UID 隔離，沒有登入身分不讀取或保存查詢快取。原本 query 快取預算與未同步照片／上傳復原資料保護不變。

前端訂閱不含事件內容的 calendarDataRevisions/global 版本訊號，以 300ms debounce 即時失效查詢並刷新來源關聯／留言；focus、本機操作也立即補查。60 秒輪詢僅作後備，Functions 尚未部署前沒有跨裝置即時版本訊號。本機 shell 與 UID 快取先顯示，資料 API 每頁 20 秒逾時並接受 AbortSignal。

活動記錄由後端取 actor、事件標題、收件員工與日期，以事件文件 revision＋actor＋action 雜湊去重並transaction只追加一次。`changes` 僅為該操作者提供的有界說明，不作授權或推播收件依據。刪除事件沿用 delete-calendar-event API 持有的可信事件 snapshot 產生稽核。舊無 scopeVerified 且事件已不存在的紀錄僅管理者可見。

留言列表與刪除走 data API；新增沿用 upload-drive 的受保護 create-background-comment，文字-only允許 pendingAttachmentCount=0。原直接 Firestore 留言讀寫封閉。一般員工的直接事件讀取同樣封閉（ERP/HR 特定業務例外由共用 Rules 的對應資源權限限制）；事件修改依原事件管理權限及原 source 關係檢查，禁止修改未知事件取得自己可見權。

管理部固定 `dept_mgmt`，已於本次以 Admin 唯讀確認 `departments.name == 管理部` 唯一文件；`calendarCalendars` 對應 `departmentCalendar_dept_mgmt`。新增／更名／合併部門需同步覆核 Rules 與 server policy，不能由前端顯示名稱決定授權。

尚未部署 Rules、Functions、API 或前端；正式保護須協調同批發布並執行跨帳號 smoke test。

驗證：`node --test scripts/calendar-data-security.test.mjs`；`node --experimental-strip-types --test scripts/local-query-cache.test.ts`；`node --test scripts/browser-storage-safety.test.mjs`；`npx tsc -b --pretty false`。共用 Rules 的 emulator allow/deny 測試由 ERP 主專案執行。

前端不再寫入未被 UI／Widget 使用的 calendarEventViews projection，避免跨員工整份事件副本與批次權限失敗；舊 projection 僅保留共用 Rules 核准的 ERP 附件清理／還原用途。
