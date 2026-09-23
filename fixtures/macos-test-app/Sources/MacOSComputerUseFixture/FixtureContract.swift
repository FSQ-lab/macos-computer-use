enum FixtureContract {
  static let bundleId = "com.example.MacOSComputerUseFixture"
  static let build = "1"
  static let requiredAccessibilityIdentifiers = [
    "fixture.title",
    "fixture.status",
    "fixture.click",
    "fixture.double-click",
    "fixture.right-click",
    "fixture.hover",
    "fixture.text-input",
    "fixture.checkbox",
    "fixture.scroll",
    "fixture.drag-source",
    "fixture.drop-target",
    "fixture.keyboard",
    "fixture.hide-target",
    "fixture.modal.title",
    "fixture.reset",
  ]
}

struct FixtureState: Equatable {
  var status = "Ready"
  var text = ""
  var checked = false
  var hover = false
  var dropped = false
  var showModal = false
  var hiddenVisible = true
  var scrollGeneration = 0
  var scrollOffset = 0

  mutating func reset() {
    self = FixtureState(scrollGeneration: scrollGeneration + 1)
  }
}
