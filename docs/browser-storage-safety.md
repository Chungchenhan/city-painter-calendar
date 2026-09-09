# 瀏覽器儲存容量事故與防回歸

日期：2026/09/06

## 原因與影響

Chrome 的行事曆 localStorage 中，完整搜尋結果與最多 2,000 筆完整歷史事件重複占用空間。Firestore 多分頁同步寫入 firestore_targets 時出現 quota 錯誤，接著觸發內部 assertion 與路由錯誤頁。同帳號在另一台電腦或無痕可正常使用，符合本機儲存問題；不能據此推定雲端配額耗盡。

## 最終處理

- `localQueryCache.ts`：只管理 cityPainterCalendarQuery:，總預算 1 MiB（UTF-16 上界）；整站寫入門檻 3 MiB。完整搜尋保留 React Query 記憶體，歷史 archive 可裁切，正式查詢仍補齊。
- 啟動在 Firebase 初始化之前遷移並清理舊 query schema；淘汰時不保留獨立月份完整性旗標。背景預載以 React Query 五分鐘快取去重，再合併實際結果。
- `photoGeolocation.ts`：事件定位提示八小時 TTL，啟動與寫入主動掃描，總量 64 KiB；只移除可重新定位的提示快取，不刪照片及已保存 metadata。
- `browserStorage.ts`：小型操作標記容錯；本機 quota 僅釋放 query allowlist 後重試，local/session 分開處理，回報保存結果。
- 通知已讀在本機寫入失敗時仍更新當前畫面。照片復原紀錄不能任意截斷；必要保存失敗要可讀錯誤，雲端成功不因本機清理失敗改報上傳失敗。
- 版本更新在兩種儲存都禁止時仍可導覽，以一次性網址版本標記避免跨重載迴圈；編譯版本更新後移除標記。版本請求與 Service Worker 共用防重入，清理失敗不得留下永久跳過標記。

## 不得刪除

Firebase Auth、Firestore／IndexedDB 待同步資料、照片離線檔案、上傳復原紀錄以及其他非 allowlist 資料。不得呼叫 localStorage.clear() 或刪除整個 IndexedDB。

## 回歸命令

```sh
node --experimental-strip-types --test scripts/local-query-cache.test.ts
node --test scripts/browser-storage-safety.test.mjs
npm run test:photo-metadata
```

測試包含超額／封鎖、容量上限、舊 cache 清理、過期位置未再次讀取、受保護資料不變、雙請求並發、網址標記防循環與快取清理失敗可恢復。桌面及手機須另確認頁面正常顯示；單元測試不代表員工裝置已實測。

2026-09-09：Query schema 更新 v4，所有查詢 key 以 Firebase Auth UID 隔離。Auth 尚未確定前不讀寫查詢快取；舊無 UID query cache 在原 allowlist 範圍淘汰。React Query events/groups/search/activity keys 同樣含 UID；原總預算、搜尋不持久化、上傳復原保護保持不變。新增跨 UID／未登入讀寫測試。
