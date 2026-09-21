// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "MacOSComputerUseFixture",
  platforms: [.macOS(.v15)],
  products: [.executable(name: "MacOSComputerUseFixture", targets: ["MacOSComputerUseFixture"])],
  targets: [
    .executableTarget(
      name: "MacOSComputerUseFixture",
      resources: [.copy("FixtureMetadata.json")]
    ),
    .testTarget(name: "MacOSComputerUseFixtureTests", dependencies: ["MacOSComputerUseFixture"])
  ]
)
