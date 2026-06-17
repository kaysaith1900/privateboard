// The room event payload structs (MessageAppended, MessageToken, MessageFinal,
// VoiceChunk, VoiceFinal, ConfigEvent, QueueUpdate) moved into the
// `BoardroomCore` package (`BoardroomKit/Sources/BoardroomCore/EventPayloads.swift`)
// so the on-device engine can construct + emit them too. They reach the app via
// `import BoardroomCore`, wrapped in the `RoomEvent` enum that `RoomSession`
// switches on. This file is intentionally left as a pointer.
