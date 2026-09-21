import Testing
@testable import MacOSComputerUseFixture

@Test func fixtureIdentityAndAccessibilityContractIsStable() {
  #expect(FixtureContract.bundleId == "com.example.MacOSComputerUseFixture")
  #expect(FixtureContract.build == "1")
  #expect(Set(FixtureContract.requiredAccessibilityIdentifiers).count == 15)
}
