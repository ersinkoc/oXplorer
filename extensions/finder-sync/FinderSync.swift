// Finder Sync extension: "Open in OXplorer" in Finder's context menu and toolbar.
// It only hands the selected folders to the containing app, which opens them
// in new tabs (the same path as `open -a OXplorer <folder>`).

import Cocoa
import FinderSync

final class FinderSync: FIFinderSync {
    private let turkish = Locale.preferredLanguages.first?.hasPrefix("tr") ?? false

    override init() {
        super.init()
        // The menu is offered everywhere; nothing is monitored or badged.
        FIFinderSyncController.default().directoryURLs = [URL(fileURLWithPath: "/")]
    }

    private var title: String { turkish ? "OXplorer’da Aç" : "Open in OXplorer" }

    override var toolbarItemName: String { "OXplorer" }
    override var toolbarItemToolTip: String { title }
    override var toolbarItemImage: NSImage {
        NSWorkspace.shared.icon(forFile: containingApp.path)
    }

    override func menu(for menuKind: FIMenuKind) -> NSMenu {
        let menu = NSMenu(title: "")
        let item = NSMenuItem(title: title, action: #selector(openInOXplorer(_:)), keyEquivalent: "")
        item.image = NSWorkspace.shared.icon(forFile: containingApp.path)
        item.image?.size = NSSize(width: 16, height: 16)
        menu.addItem(item)
        return menu
    }

    /// OXplorer.app, three levels up from Contents/PlugIns/OXplorerFinder.appex.
    private var containingApp: URL {
        Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    @objc func openInOXplorer(_ sender: AnyObject?) {
        let controller = FIFinderSyncController.default()
        var urls = controller.selectedItemURLs() ?? []
        if urls.isEmpty, let folder = controller.targetedURL() {
            urls = [folder]
        }
        guard !urls.isEmpty else { return }
        NSWorkspace.shared.open(urls, withApplicationAt: containingApp, configuration: NSWorkspace.OpenConfiguration())
    }
}
