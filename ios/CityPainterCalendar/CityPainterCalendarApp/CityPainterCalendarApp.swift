import SwiftUI
import WidgetKit

@main
struct CityPainterCalendarApp: App {
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            WebCalendarView()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                WidgetCenter.shared.reloadAllTimelines()
            }
        }
    }
}
