#!/usr/bin/env swift

// Reads text out of a simulator screenshot and asserts the expected strings are
// on screen.
//
// This exists because "the app launched and did not crash" is a much weaker
// claim than it sounds. A React Native app with no JavaScript bundle launches
// happily and shows a redbox; one whose JS renders nothing shows a blank
// screen. Both stay alive, and both passed CI here once. Reading the pixels is
// the only check that distinguishes "running" from "working".
//
// Usage: swift assert-screenshot-text.swift <image> <required substring>...

import Foundation
import Vision
import CoreGraphics
import ImageIO

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("usage: assert-screenshot-text.swift <image> <substring>...\n".utf8))
    exit(2)
}

let path = args[0]
let required = Array(args.dropFirst())

guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    FileHandle.standardError.write(Data("could not read image at \(path)\n".utf8))
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
// The UI is bilingual, and the roster names are Chinese.
request.recognitionLanguages = ["en-US", "zh-Hans"]

do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    FileHandle.standardError.write(Data("OCR failed: \(error)\n".utf8))
    exit(1)
}

let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print("Text found on screen (\(lines.count) lines):")
for line in lines { print("  \(line)") }

let haystack = lines.joined(separator: "\n")
let missing = required.filter { !haystack.localizedCaseInsensitiveContains($0) }

guard missing.isEmpty else {
    for want in missing {
        print("::error::expected to see \"\(want)\" on screen, but it was not there")
    }
    exit(1)
}

print("All \(required.count) expected strings are on screen.")
