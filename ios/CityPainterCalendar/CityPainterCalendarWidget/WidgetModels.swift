import Foundation

struct WidgetMonth: Decodable {
    let month: String
    let title: String
    let generatedAt: String
    let days: [WidgetDay]
}

struct WidgetDay: Decodable, Identifiable {
    var id: String { date }
    let date: String
    let day: Int
    let inMonth: Bool
    let isToday: Bool
    let events: [WidgetEvent]
}

struct WidgetEvent: Decodable, Identifiable {
    let id: String
    let title: String
    let date: String
    let endDate: String
    let startTime: String
    let endTime: String
    let allDay: Bool
    let color: String
    let done: Bool
}

extension WidgetMonth {
    static let placeholder = WidgetMonth(
        month: "2026-05",
        title: "5月",
        generatedAt: "",
        days: (0..<42).map { index in
            WidgetDay(
                date: "2026-05-\(String(format: "%02d", min(index + 1, 31)))",
                day: index < 31 ? index + 1 : index - 30,
                inMonth: index < 31,
                isToday: index == 24,
                events: index % 4 == 0 ? [
                    WidgetEvent(id: "\(index)-1", title: "施工", date: "", endDate: "", startTime: "", endTime: "", allDay: true, color: "#1fb6a6", done: false),
                    WidgetEvent(id: "\(index)-2", title: "送貨", date: "", endDate: "", startTime: "", endTime: "", allDay: true, color: "#f6b100", done: false)
                ] : []
            )
        }
    )
}
