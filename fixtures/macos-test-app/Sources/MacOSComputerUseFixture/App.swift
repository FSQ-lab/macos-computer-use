import SwiftUI

@main
struct FixtureApp: App {
  init() {
    _ = CommandLine.arguments.contains("--reset")
  }
  var body: some Scene {
    WindowGroup("Computer Use Fixture") { FixtureView() }
      .defaultSize(width: 680, height: 520)
  }
}

private struct FixtureView: View {
  @State private var status = "Ready"
  @State private var text = ""
  @State private var checked = false
  @State private var hover = false
  @State private var dropped = false
  @State private var showModal = false
  @State private var hiddenVisible = true

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("macOS Computer Use Fixture").font(.title).accessibilityIdentifier("fixture.title")
      Text(status).accessibilityIdentifier("fixture.status")

      HStack {
        Button("Click") { status = "Clicked" }.accessibilityIdentifier("fixture.click")
        Button("Double click") { status = "Double clicked" }.accessibilityIdentifier("fixture.double-click")
        Button("Right click") { status = "Right clicked" }
          .accessibilityIdentifier("fixture.right-click")
          .contextMenu { Button("Context action") { status = "Context selected" } }
        Button("Hover") { status = "Hover clicked" }
          .accessibilityIdentifier("fixture.hover")
          .onHover { value in hover = value; status = value ? "Hovered" : "Ready" }
        Text(hover ? "Hover active" : "Hover idle").accessibilityIdentifier("fixture.hover-state")
      }

      TextField("Text input", text: $text)
        .accessibilityIdentifier("fixture.text-input")
      Text(text).accessibilityIdentifier("fixture.text-value")
      Toggle("Checked", isOn: $checked).accessibilityIdentifier("fixture.checkbox")
      HStack {
        Text("First").accessibilityIdentifier("fixture.order.first")
        Text("Second").accessibilityIdentifier("fixture.order.second")
      }
      if hiddenVisible { Text("Hide me").accessibilityIdentifier("fixture.hide-target") }
      Button("Hide target") { hiddenVisible = false }.accessibilityIdentifier("fixture.hide")
      Button("Open modal") { showModal = true }.accessibilityIdentifier("fixture.open-modal")
      Button("Keyboard action") { status = "Keyboard activated" }
        .keyboardShortcut("k", modifiers: [.command])
        .accessibilityIdentifier("fixture.keyboard")

      ScrollView(.horizontal) {
        HStack {
          ForEach(0..<20, id: \.self) { index in
            Text("Item \(index)").frame(width: 90, height: 40).accessibilityIdentifier("fixture.item.\(index)")
          }
        }
      }
      .accessibilityIdentifier("fixture.scroll")

      HStack(spacing: 40) {
        Text("Drag source")
          .frame(width: 140, height: 70)
          .background(.blue.opacity(0.2))
          .accessibilityIdentifier("fixture.drag-source")
          .draggable("fixture-drag")
        Text(dropped ? "Dropped" : "Drop target")
          .frame(width: 180, height: 70)
          .background(.green.opacity(0.2))
          .accessibilityIdentifier("fixture.drop-target")
          .dropDestination(for: String.self) { values, _ in
            dropped = values.contains("fixture-drag")
            status = dropped ? "Drag completed" : status
            return dropped
          }
      }

      Button("Reset") {
        status = "Ready"
        text = ""
        checked = false
        hover = false
        dropped = false
        showModal = false
        hiddenVisible = true
      }
        .accessibilityIdentifier("fixture.reset")
    }
    .padding(24)
    .frame(minWidth: 640, minHeight: 480)
    .keyboardShortcut("r", modifiers: [.command])
    .sheet(isPresented: $showModal) {
      VStack {
        Text("Fixture modal").accessibilityIdentifier("fixture.modal.title")
        Button("Close") { showModal = false }.accessibilityIdentifier("fixture.modal.close")
      }.padding(30)
    }
  }
}
