import Testing
@testable import MacOSComputerUseFixture

@Test func fixtureIdentityAndAccessibilityContractIsStable() {
  #expect(FixtureContract.bundleId == "com.example.MacOSComputerUseFixture")
  #expect(FixtureContract.build == "1")
  #expect(Set(FixtureContract.requiredAccessibilityIdentifiers).count == 15)
}

@Test func fixtureResetRestoresEveryObservableState() {
  var state = FixtureState(
    status: "Changed",
    text: "text",
    checked: true,
    hover: true,
    dropped: true,
    showModal: true,
    hiddenVisible: false,
    scrollGeneration: 4,
    scrollOffset: 200
  )
  state.reset()
  #expect(state.status == "Ready")
  #expect(state.text.isEmpty)
  #expect(state.checked == false)
  #expect(state.hover == false)
  #expect(state.dropped == false)
  #expect(state.showModal == false)
  #expect(state.hiddenVisible == true)
  #expect(state.scrollGeneration == 5)
  #expect(state.scrollOffset == 0)
}
