//
//  AppDelegate.swift
//  Notion2GPT
//
//  Created by Karat Sidhu on 05/03/26.
//

import Cocoa
import os.log

private let logger = Logger(subsystem: "com.karatsidhu.Notion2GPT", category: "OAuth")

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first,
              url.scheme == "notion2gpt",
              url.host == "oauth-callback",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let queryItems = components.queryItems
        else {
            logger.error("Received invalid OAuth callback URL")
            return
        }

        let code = queryItems.first(where: { $0.name == "code" })?.value
        let state = queryItems.first(where: { $0.name == "state" })?.value

        guard let code, let state else {
            logger.error("OAuth callback missing code or state parameter")
            return
        }

        SharedDefaults.pendingCode = code
        SharedDefaults.callbackState = state
        logger.info("OAuth callback code and state saved to shared UserDefaults")
    }
}
