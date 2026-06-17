// swift-tools-version: 6.0
import PackageDescription

// BoardroomKit · the on-device boardroom engine, ported from the TypeScript
// backend (`src/`). Phase 0 ships only `BoardroomCore`: the canonical event
// model (`RoomEvent`) + the seam protocols the SwiftUI app consumes, decoupled
// from the SSE wire format so a future in-process engine can emit the SAME
// events. Storage / AI / Voice / Orchestrator targets land in later phases.
let package = Package(
    name: "BoardroomKit",
    platforms: [.iOS("26.0"), .macOS("14.0")],
    products: [
        .library(name: "BoardroomCore", targets: ["BoardroomCore"]),
        .library(name: "BoardroomStorage", targets: ["BoardroomStorage"]),
        .library(name: "BoardroomAI", targets: ["BoardroomAI"]),
        .library(name: "BoardroomVoice", targets: ["BoardroomVoice"]),
        .library(name: "BoardroomSearch", targets: ["BoardroomSearch"]),
        .library(name: "BoardroomEngine", targets: ["BoardroomEngine"]),
        .library(name: "BoardroomSync", targets: ["BoardroomSync"]),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0"),
    ],
    targets: [
        .target(name: "BoardroomCore"),
        .testTarget(name: "BoardroomCoreTests", dependencies: ["BoardroomCore"]),
        .target(
            name: "BoardroomStorage",
            dependencies: [
                "BoardroomCore",
                .product(name: "GRDB", package: "GRDB.swift"),
            ],
            resources: [.process("Resources/seed.json")]   // codegen'd from src/seed (gen-ios-seed.mjs)
        ),
        .testTarget(name: "BoardroomStorageTests", dependencies: ["BoardroomStorage"]),
        .target(name: "BoardroomAI", dependencies: ["BoardroomCore"]),
        .testTarget(name: "BoardroomAITests", dependencies: ["BoardroomAI"]),
        .target(name: "BoardroomVoice", dependencies: ["BoardroomCore"]),
        .testTarget(name: "BoardroomVoiceTests", dependencies: ["BoardroomVoice"]),
        .target(name: "BoardroomSearch", dependencies: ["BoardroomCore"]),
        .testTarget(name: "BoardroomSearchTests", dependencies: ["BoardroomSearch"]),
        .target(name: "BoardroomEngine", dependencies: [
            "BoardroomCore", "BoardroomAI", "BoardroomStorage", "BoardroomVoice",
            .product(name: "GRDB", package: "GRDB.swift"),
        ], resources: [
            .process("Resources/director-prompts.json"),   // codegen'd from prompt.ts (gen-ios-prompts.mjs)
            .process("Resources/brief-prompts.json"),       // codegen'd from brief-stages.ts (gen-ios-brief-prompts.mjs)
        ]),
        .testTarget(name: "BoardroomEngineTests", dependencies: ["BoardroomEngine"]),
        .target(name: "BoardroomSync", dependencies: [
            "BoardroomCore", "BoardroomStorage",
            .product(name: "GRDB", package: "GRDB.swift"),
        ]),
        .testTarget(name: "BoardroomSyncTests", dependencies: ["BoardroomSync", "BoardroomStorage"]),
    ]
)
