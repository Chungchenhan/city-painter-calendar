# 都市彩繪行事曆 iOS Wrapper + Widget

這個資料夾是第一版 iOS 外殼 App 與主畫面月檢視 Widget。

## 架構

- `CityPainterCalendarApp`：用 `WKWebView` 打開現有正式行事曆網站。
- `CityPainterCalendarWidget`：iPhone 主畫面大型 Widget，呼叫 `/api/widget-calendar` 顯示本月月檢視。
- `Shared/WidgetConfig.swift`：正式站網址與 Widget API 設定。

## 產生 Xcode 專案

本資料夾使用 XcodeGen 管理專案檔：

```bash
brew install xcodegen
cd ios/CityPainterCalendar
xcodegen generate
open CityPainterCalendar.xcodeproj
```

## Xcode 內需要設定

1. 在 App target 與 Widget target 設定 Apple Developer Team。
2. 確認 Bundle ID：
   - App：`com.citypainter.calendar`
   - Widget：`com.citypainter.calendar.widget`
3. 確認 App Group：
   - `group.com.citypainter.calendar`
4. 先用真機執行 App，再到 iPhone 主畫面新增「都市彩繪行事曆」Widget。

## API

Widget 會呼叫：

```text
https://sch.city-painter.com/api/widget-calendar?month=YYYY-MM
```

目前正式站網域是 `https://sch.city-painter.com`。如果正式站網域變更，請修改 `Shared/WidgetConfig.swift`。
