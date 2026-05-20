# AGENTS.md

## 專案
- 名稱：都市彩繪行事曆
- 路徑：`/Users/henry/Downloads/Henry-agent/city-painter-calendar/`
- 技術：React + TypeScript + Vite + Firebase + PWA

## Firebase
- 共用 ERP/HR 的 Firebase 專案設定。
- 登入權限共用 HR 專案的 `userRoles` collection。
- 員工與部門資料共用 HR 的 `employees`、`departments` collections。
- 行事曆專用資料：
  - `calendarCalendars`
  - `calendarEvents`

## 權限
- `userRoles.role === "admin"`：可建立、編輯、刪除行事曆與工作。
- `employee`：只能查看自己被授權的行事曆與工作。
- 行事曆可用 `departmentIds` 與 `employeeIds` 控制可見範圍。

## UI
- 介面風格比照 TimeTree：左側行事曆清單、主月曆、右側當日工作清單。
- 手機版必須保留完整功能，底部操作列需計入 safe-area。

## 效能
- 手機版 PWA 首頁必須秒入：先顯示 App Shell 或上次快取的行事曆資料，再背景同步最新 Firestore 資料。
- 首頁不得因等待所有行事曆、員工、部門、附件或通知資料載完才顯示。
- PWA 導航頁面優先使用快取回應，避免弱網路下白畫面。
- 新增功能時若會增加首頁請求或 bundle，必須改成延後載入或背景載入。
