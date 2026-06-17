import Foundation
import MediaPlayer

/// Drives the iOS lock-screen / Control-Center "Now Playing" panel for a voice
/// room — like a music player. The info center shows the room title + the live
/// subtitle (the sentence TTS is reading), and a play/pause remote command is
/// wired straight back to the room's pause/resume. Audio already plays on the
/// lock screen (AVAudioSession `.playback` + the `audio` background mode); this
/// adds the visible transport + metadata on top.
@MainActor
final class NowPlayingController {
    /// Fired when the user hits play / pause / toggle on the lock screen or a
    /// connected accessory (headphones, CarPlay).
    var onToggle: (() -> Void)?

    private var commandsWired = false

    /// Push the current state. `subtitle` is the spoken line (字幕) — usually
    /// "<speaker> · <sentence>". `isPlaying` drives the transport button + the
    /// route's playing indicator.
    func update(title: String, subtitle: String, isPlaying: Bool) {
        wireCommandsIfNeeded()
        var info: [String: Any] = [:]
        info[MPMediaItemPropertyTitle] = title.isEmpty ? "Boardroom" : title
        info[MPMediaItemPropertyArtist] = subtitle
        info[MPNowPlayingInfoPropertyIsLiveStream] = true            // continuous stream · no scrubber
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
    }

    /// Tear down the panel + remote commands (leaving the room / adjourning).
    func clear() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.removeTarget(nil)
        c.pauseCommand.removeTarget(nil)
        c.togglePlayPauseCommand.removeTarget(nil)
        commandsWired = false
    }

    private func wireCommandsIfNeeded() {
        guard !commandsWired else { return }
        commandsWired = true
        let c = MPRemoteCommandCenter.shared()
        // A room has no seek / skip semantics — only play/pause.
        for cmd in [c.nextTrackCommand, c.previousTrackCommand, c.seekForwardCommand,
                    c.seekBackwardCommand, c.changePlaybackPositionCommand,
                    c.skipForwardCommand, c.skipBackwardCommand] {
            cmd.isEnabled = false
        }
        c.playCommand.isEnabled = true
        c.pauseCommand.isEnabled = true
        c.togglePlayPauseCommand.isEnabled = true
        let handler: (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus = { [weak self] _ in
            self?.onToggle?()
            return .success
        }
        c.playCommand.addTarget(handler: handler)
        c.pauseCommand.addTarget(handler: handler)
        c.togglePlayPauseCommand.addTarget(handler: handler)
    }
}
