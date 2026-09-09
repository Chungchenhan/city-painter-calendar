# 都市彩繪行事曆 iOS Wrapper + Widget

這個資料夾是第一版 iOS 外殼 App 與主畫面月檢視 Widget。

## 架構

- `CityPainterCalendarApp`：用 `WKWebView` 打開現有正式行事曆網站。
- `CityPainterCalendarWidget`：iPhone 主畫面大型 Widget，呼叫 `/api/widget-calendar` 顯示本月月檢視。
- `Shared/WidgetConfig.swift`：正式站網址與 Widget API 設定。

## 開啟 Xcode 專案

目前已產生：

```text
CityPainterCalendar.xcodeproj
```

直接用 Xcode 開啟：

```bash
open ios/CityPainterCalendar/CityPainterCalendar.xcodeproj
```

若之後有新增 Swift 檔案或要重新產生專案，可執行：

```bash
cd ios/CityPainterCalendar
ruby scripts/generate_xcodeproj.rb
```

也保留 `project.yml`，未來若要改用 XcodeGen：

```bash
brew install xcodegen
cd ios/CityPainterCalendar
xcodegen generate
```

## Xcode 內需要設定

1. 在 App target 與 Widget target 設定 Apple Developer Team。
2. 確認 Bundle ID：
   - App：`com.citypainter.calendar`
   - Widget：`com.citypainter.calendar.widget`
3. 選擇真機 iPhone。
4. Scheme 選 `CityPainterCalendarApp`。
5. 按 Run 安裝到 iPhone。

## iPhone 加入主畫面 Widget

1. 先從 Xcode 把 `CityPainterCalendarApp` 安裝到 iPhone，並打開一次。
2. 回到 iPhone 主畫面。
3. 長按桌面空白處，進入編輯模式。
4. 點左上角 `＋`。
5. 搜尋或找到「都市彩繪行事曆」。
6. 選擇大型 Widget。
7. 點「加入小工具」。

第一版 Widget 會顯示本月月檢視，並每 5 分鐘向 iOS 請求更新一次；實際更新時間仍由 iOS WidgetKit 的系統預算決定，不能保證秒級即時刷新。打開 App 回到前景時，也會主動要求 Widget 重新整理。

## API

Widget 會呼叫：

```text
https://sch.city-painter.com/api/widget-calendar?month=YYYY-MM
```

目前正式站網域是 `https://sch.city-painter.com`。如果正式站網域變更，請修改 `Shared/WidgetConfig.swift`。

## 登入與小工具授權

- 不使用全站共用 token，也不需要 `WIDGET_API_TOKEN` 或 `WIDGET_USER_UID`。
- App 登入後，網頁透過受限 WKWebView bridge 提供短效 Firebase ID token 與 App Check。只接受 `https://sch.city-painter.com` 主 frame，拒絕外域及 iframe。
- 原生 App 呼叫 `/api/widget-calendar?action=widget-device-register`，後端以已驗證 UID 綁定員工與裝置並核發 30 天隨機憑證；`calendarWidgetDevices` 只保存雜湊，Rules 禁止前端讀寫。
- 憑證只存 App／Widget 共用 Keychain（ThisDeviceOnly），不放 UserDefaults、JavaScript、Swift 常數或 Git。兩 target 必須使用同一 Team、`Shared/WidgetAuth.entitlements` 與 `WidgetKeychainAccessGroup`。
- 每次讀取重新核對在職、停用、員工映射、Firebase 撤銷時間、裝置撤銷及有效期限，並套用事件可見範圍。
- 登出立即清除本機憑證並要求刷新；離線撤銷保留 Keychain 待下次開啟重試。管理端可將指定裝置文件 `revokedAt` 設為目前毫秒時間，或撤銷 Firebase refresh tokens，拒絕後續讀取。
- 未登入／失效顯示「請開啟 App 登入」。Web 與原生 App 都更新後，需開啟 App 一次完成自動綁定，既有有效登入不需重登。
- iOS 既有 Widget 快照由系統控制，斷網／系統延後刷新時不能保證畫面立即清除。

測試：`node --test shared/widgetDeviceAuth.test.js api/calendar-security.test.js`。
