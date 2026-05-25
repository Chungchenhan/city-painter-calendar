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
