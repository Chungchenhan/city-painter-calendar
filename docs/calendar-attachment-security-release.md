# 行事曆附件授權發布與歷史權限清理

本次僅完成本機修正，未改正式 Drive 權限、Firestore 資料或 LINE 訊息。

## 本機變更

- 同步與背景上傳都不再新增 `anyone` 權限；上傳前檢查目標資料夾可見的所有 permission 分頁，存在公開繼承權限時拒絕上傳。
- 網站以 Firebase Auth、App Check 及目前員工／事件權限取得 10 分鐘連結，檔案必須在事件或其留言附件清單；一般檔案以 attachment 回應下載，圖片維持既有處理格式。
- LINE 圖片網址的 HMAC 同時包含 fileId、variant、expires，24 小時過期。GET 不接受沒有 expires 的永久網址，不允許改 variant，且不保存代理快取。
- ERP `server/calendarLineImageUrl.js` 僅在既有已授權的傳送／下載流程，驗證伺服器附件保存的舊或新 HMAC 後產生新網址。缺少簽名金鑰會報錯，金鑰不符或偽造網址不會重簽。

## 發布前門檻

1. 比對 Calendar API、Calendar Functions、ERP API 的 `LINE_IMAGE_SIGNING_SECRET`；沒有顯式 secret 的現有環境以 service account private key 為相容來源。只能輸出相等／不同，不能列印金鑰。若來源不同，先安全同步既有同組金鑰；本次不能直接輪替以免既有附件簽名無法驗證。
2. 此修改需連同 Calendar 前端/API、Calendar backgroundAttachmentWorker 與 ERP API 相容變更協調發布。先更新 ERP 使其產生 expiring URL（舊 Calendar API 無法驗證新簽名），或先更新 Calendar（舊 ERP 不會刷新永久URL）都會有短暫不相容；需規劃同一維護窗口，不可只部署單站。
3. 在測試／本機環境實測：合法在職員工上傳，事件及留言預覽、一般檔案下載；無權限／停用員工、缺少或無效 App Check 必須拒絕；保留分頁超过 10 分鐘後能刷新、手機縮圖與全螢幕顯示正常。測試檔上傳後刪除。
4. ERP 的 LINE 測試使用 mock transport：舊附件、已過期的新附件、延後點擊照片下載皆重新簽名；不能拿正式客戶訊息當測試。

## 歷史 public 權限 dry-run 盤點（只讀）

由管理者以現有 Drive OAuth 與 Firebase Admin 執行，清單存入本專案 `firebase-backups/` 專用日期目錄（不可 commit）。

1. 收集 `calendarEvents` 的 attachments、每個事件 comments 的 attachments、Calendar target 的 attachmentUploadJobs.result.image/thumbnail 路徑，以及 ERP sales 中保留相同 sourceAttachmentId/path 的附件。以精確 Drive fileId 合併，不以檔名或人名猜測。
2. 對每個 fileId 執行 `drive.files.get(fields=id,parents,appProperties,trashed)` 與 `drive.permissions.list(fields=nextPageToken,permissions(id,type,role,allowFileDiscovery,permissionDetails))`，讀完全部分頁。向上盤點 parents 的相同欄位直到根目錄，記錄共有父層與 inheritedFrom。
3. 產出計數：唯一檔案總數、存在／404／無權限／失敗數、直接 anyone grants、父層繼承 anyone、跨 Calendar/ERP 共用數、缺少權威引用數。未知與失敗必須列為未完成，不當作 private。
4. 保存每筆 event/comment/job/sales 精確引用、檔案目前 parents、完整 permissions 原值與觀察時間。若父資料夾同時服務其他業務，不得自動撤除父層權限。

## 核准後的遷移（本次未執行）

- 先驗證新版網站代理與 LINE 舊附件重簽可用，才逐批撤除已核實檔案上的直接 `anyone` permission ID。
- 每筆 mutation 前重讀並比對 fileId、parents、permission ID/type/role 與 dry-run 快照；有異動就跳過回報。超時視為未知，先讀回確認，不能盲目重送。
- 父層公開繼承需單独審核：只在全部子檔案／業務影響已盤點且核准後修改父層；否則規劃移到私有目錄並重新核對跨站引用，不直接撤廣泛共享權限。
- 每批後獨立 `permissions.list` read-back；匿名原 Drive URL 必須拒絕，而授權網站預覽及 mock LINE 重簽仍成功。保存完成／跳過／失敗審計紀錄，重跑只處理仍存在的已核准 permission。
- 舊代理曾給一年 public immutable 快取：新 no-store 不會追溯清掉先前的外部瀏覽器或 CDN 快取。維護窗口需盤點 CDN 可清除範圍並執行已核准的 purge；曾被下載的副本無法撤回。

## 限制

歷史匿名可讀性只有完成上述盤點、撤權與外部 read-back 後才算修復。此文件不是已執行結果。
