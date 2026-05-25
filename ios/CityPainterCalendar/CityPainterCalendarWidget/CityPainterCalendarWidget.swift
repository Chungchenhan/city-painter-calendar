import SwiftUI
import WidgetKit

struct CalendarEntry: TimelineEntry {
    let date: Date
    let month: WidgetMonth
}

struct CalendarProvider: TimelineProvider {
    func placeholder(in context: Context) -> CalendarEntry {
        CalendarEntry(date: Date(), month: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (CalendarEntry) -> Void) {
        completion(CalendarEntry(date: Date(), month: .placeholder))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<CalendarEntry>) -> Void) {
        Task {
            let month = await fetchWidgetMonth() ?? .placeholder
            let nextRefresh = Calendar.current.date(byAdding: .minute, value: 5, to: Date()) ?? Date().addingTimeInterval(300)
            completion(Timeline(entries: [CalendarEntry(date: Date(), month: month)], policy: .after(nextRefresh)))
        }
    }

    private func fetchWidgetMonth() async -> WidgetMonth? {
        let month = DateFormatter.widgetMonth.string(from: Date())
        var components = URLComponents(url: WidgetConfig.widgetAPIURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "month", value: month)]
        guard let url = components?.url else { return nil }

        var request = URLRequest(url: url)
        if !WidgetConfig.widgetAPIToken.isEmpty {
            request.setValue(WidgetConfig.widgetAPIToken, forHTTPHeaderField: "X-Widget-Token")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return try JSONDecoder().decode(WidgetMonth.self, from: data)
        } catch {
            return nil
        }
    }
}

struct CityPainterCalendarWidgetEntryView: View {
    let entry: CalendarEntry

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 1), count: 7)
    private let weekdays = ["日", "一", "二", "三", "四", "五", "六"]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(entry.month.title)
                    .font(.headline.weight(.bold))
                Spacer()
                Image(systemName: "plus")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.green)
            }

            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(weekdays, id: \.self) { weekday in
                    Text(weekday)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
                ForEach(entry.month.days) { day in
                    DayCell(day: day)
                }
            }
        }
        .padding(9)
        .containerBackground(.background, for: .widget)
        .widgetURL(WidgetConfig.appURL)
    }
}

struct DayCell: View {
    let day: WidgetDay

    private var numberColor: Color {
        if day.isToday { return .white }
        return day.inMonth ? .primary : .secondary
    }

    var body: some View {
        VStack(spacing: 1) {
            Text("\(day.day)")
                .font(.caption2.weight(day.isToday ? .bold : .regular))
                .frame(width: 20, height: 16)
                .background(day.isToday ? Color.black : Color.clear)
                .foregroundStyle(numberColor)
                .clipShape(Capsule())

            VStack(spacing: 1.5) {
                ForEach(day.events.prefix(3)) { event in
                    Text(event.title)
                        .font(.system(size: 7, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                        .padding(.horizontal, 2)
                        .frame(maxWidth: .infinity, minHeight: 8, alignment: .leading)
                        .background(Color(hex: event.color))
                        .clipShape(RoundedRectangle(cornerRadius: 2))
                }
            }
            .frame(height: 29, alignment: .top)
        }
        .frame(minHeight: 46, alignment: .top)
    }
}

@main
struct CityPainterCalendarWidget: Widget {
    let kind = "CityPainterCalendarWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: CalendarProvider()) { entry in
            CityPainterCalendarWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("都市彩繪行事曆")
        .description("在主畫面查看本月工作行程。")
        .supportedFamilies([.systemLarge])
    }
}

extension DateFormatter {
    static let widgetMonth: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM"
        return formatter
    }()
}

extension Color {
    init(hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var value: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&value)
        let red = Double((value >> 16) & 0xff) / 255
        let green = Double((value >> 8) & 0xff) / 255
        let blue = Double(value & 0xff) / 255
        self.init(red: red, green: green, blue: blue)
    }
}
