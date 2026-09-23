import SwiftUI
import AppKit

private struct PointerTarget: NSViewRepresentable {
  let title: String
  let identifier: String
  let onDoubleClick: () -> Void
  let onRightClick: () -> Void

  final class TargetView: NSView {
    var onDoubleClick: () -> Void = {}
    var onRightClick: () -> Void = {}
    override func mouseDown(with event: NSEvent) {
      if event.clickCount == 2 { onDoubleClick() }
    }
    override func rightMouseDown(with event: NSEvent) { onRightClick() }
  }

  func makeNSView(context: Context) -> TargetView {
    let view = TargetView()
    view.setAccessibilityElement(true)
    view.setAccessibilityRole(.button)
    view.setAccessibilityEnabled(true)
    let label = NSTextField(labelWithString: title)
    label.setAccessibilityElement(false)
    label.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(label)
    NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: view.centerXAnchor), label.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
    return view
  }

  func updateNSView(_ view: TargetView, context: Context) {
    view.setAccessibilityIdentifier(identifier)
    view.setAccessibilityLabel(title)
    view.onDoubleClick = onDoubleClick
    view.onRightClick = onRightClick
  }
}

@main
struct FixtureApp: App {
  init() {
    _ = CommandLine.arguments.contains("--reset")
  }
  var body: some Scene {
    WindowGroup("Computer Use Fixture") { FixtureView() }
      .defaultSize(width: 760, height: 850)
  }
}

private struct FixtureView: View {
  @State private var fixture = FixtureState()

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("macOS Computer Use Fixture").font(.title).accessibilityIdentifier("fixture.title")
      Text(fixture.status).accessibilityIdentifier("fixture.status")

      HStack {
        Button("Click") { fixture.status = "Clicked" }.accessibilityIdentifier("fixture.click")
        PointerTarget(title: "Double click", identifier: "fixture.double-click", onDoubleClick: { fixture.status = "Double clicked" }, onRightClick: {})
          .frame(width: 100, height: 30)
        PointerTarget(title: "Right click", identifier: "fixture.right-click", onDoubleClick: {}, onRightClick: { fixture.status = "Right clicked" })
          .frame(width: 100, height: 30)
        Button("Hover") { fixture.status = "Hover clicked" }
          .accessibilityIdentifier("fixture.hover")
          .onHover { value in fixture.hover = value; fixture.status = value ? "Hovered" : "Ready" }
        Text(fixture.hover ? "Hover active" : "Hover idle").accessibilityIdentifier("fixture.hover-state")
      }

      TextField("Text input", text: $fixture.text)
        .accessibilityIdentifier("fixture.text-input")
      Text(fixture.text).accessibilityIdentifier("fixture.text-value")
      Toggle("Checked", isOn: $fixture.checked).accessibilityIdentifier("fixture.checkbox")
      HStack {
        Text("First").accessibilityIdentifier("fixture.order.first")
        Text("Second").accessibilityIdentifier("fixture.order.second")
      }
      if fixture.hiddenVisible { Text("Hide me").accessibilityIdentifier("fixture.hide-target") }
      Button("Hide target") { fixture.hiddenVisible = false }.accessibilityIdentifier("fixture.hide")
      Button("Open modal") { fixture.showModal = true }.accessibilityIdentifier("fixture.open-modal")
      Button("Keyboard action") { fixture.status = "Keyboard activated" }
        .keyboardShortcut(.return, modifiers: [.command])
        .accessibilityIdentifier("fixture.keyboard")

      ScrollView(.horizontal) {
        HStack {
          ForEach(0..<20, id: \.self) { index in
            Text("Item \(index)").frame(width: 90, height: 40).accessibilityIdentifier("fixture.item.\(index)")
          }
        }
      }
      .accessibilityIdentifier("fixture.scroll")
      .id(fixture.scrollGeneration)
      .onScrollGeometryChange(for: Int.self) { geometry in
        Int(geometry.contentOffset.x.rounded())
      } action: { _, offset in
        fixture.scrollOffset = offset
      }
      Text("Scroll offset: \(fixture.scrollOffset)").accessibilityIdentifier("fixture.scroll-state")

      HStack(spacing: 40) {
        Text("Drag source")
          .frame(width: 140, height: 70)
          .background(.blue.opacity(0.2))
          .accessibilityIdentifier("fixture.drag-source")
          .draggable("fixture-drag")
        Text(fixture.dropped ? "Dropped" : "Drop target")
          .frame(width: 180, height: 70)
          .background(.green.opacity(0.2))
          .accessibilityIdentifier("fixture.drop-target")
          .dropDestination(for: String.self) { values, _ in
            fixture.dropped = values.contains("fixture-drag")
            fixture.status = fixture.dropped ? "Drag completed" : fixture.status
            return fixture.dropped
          }
      }

      Button("Reset") {
        fixture.reset()
      }
        .accessibilityIdentifier("fixture.reset")
    }
    .padding(24)
    .frame(minWidth: 720, minHeight: 800)
    .keyboardShortcut("r", modifiers: [.command])
    .sheet(isPresented: $fixture.showModal) {
      VStack {
        Text("Fixture modal").accessibilityIdentifier("fixture.modal.title")
        Button("Close") { fixture.showModal = false }.accessibilityIdentifier("fixture.modal.close")
      }.padding(30)
    }
  }
}
