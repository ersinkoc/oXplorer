mod archive_fs;
mod dir;
mod error;
mod git;
mod integration;
mod jobs;
mod mac;
mod menu;
mod model;
mod preview;
mod pty;
mod releases;
mod remote;
mod running;
mod search;
mod security;
mod system;
mod uri_scheme;
mod usage;
mod windows;

use tauri::Manager as _;
use tauri_specta::{collect_commands, collect_events};

pub fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            dir::open_dir,
            dir::stat_path,
            dir::complete_path,
            dir::watch_dir,
            dir::unwatch_dir,
            jobs::start_job,
            jobs::cancel_job,
            jobs::resolve_conflict,
            jobs::measure,
            jobs::rename_path,
            jobs::create_item,
            jobs::make_symlink,
            jobs::checksum,
            jobs::set_permissions,
            jobs::pause_job,
            jobs::find_duplicates,
            jobs::compare_folders,
            jobs::verify_checksums,
            jobs::trash_count,
            jobs::archive_unlock,
            jobs::convert_image,
            jobs::is_locked,
            jobs::archive_encrypted,
            jobs::set_locked,
            jobs::batch_rename,
            integration::pasteboard_write_files,
            integration::pasteboard_read_files,
            integration::pasteboard_save,
            integration::set_dates,
            integration::pasteboard_has_content,
            integration::set_desktop_picture,
            integration::apps_for_path,
            integration::open_with,
            integration::drag_preview,
            integration::edit_tags,
            integration::quick_look,
            integration::quick_look_close,
            integration::quick_look_visible,
            preview::preview_text,
            preview::preview_hex,
            preview::allow_preview,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            search::search_start,
            search::search_cancel,
            system::favorite_tags,
            system::log_file,
            system::updates_enabled,
            releases::newer_release,
            git::git_status,
            usage::disk_usage,
            usage::disk_usage_cancel,
            archive_fs::archive_list,
            archive_fs::archive_open_member,
            remote::remote_set_connections,
            remote::remote_save_secret,
            remote::remote_has_secret,
            remote::remote_test,
            remote::remote_list,
            remote::remote_create_dir,
            remote::remote_rename,
            remote::remote_delete,
            remote::remote_open_member,
            remote::remote_register_test_folder,
            menu::menu_items,
            menu::set_shortcuts,
            menu::set_menu_titles,
            menu::open_settings,
            system::home_dir,
            system::launch_dir,
            system::self_test_dir,
            system::shots_dir,
            system::save_screenshot,
            system::standard_locations,
            system::list_volumes,
            system::eject_volume,
            system::space_for,
            system::check_full_disk_access,
            system::open_path,
            system::reveal_in_finder,
            system::open_full_disk_access_settings,
            system::take_open_requests,
            windows::open_window,
            windows::window_start_path,
        ])
        .events(collect_events![
            menu::MenuCommand,
            model::DirChanged,
            model::QuickLookState,
            model::QuickLookKey,
            model::OpenRequested,
        ])
}

pub fn export_bindings(builder: &tauri_specta::Builder<tauri::Wry>, path: &str) {
    builder
        .export(
            specta_typescript::Typescript::default()
                .header("// @ts-nocheck\n/* eslint-disable */\n// biome-ignore-all lint: generated file"),
            path,
        )
        .expect("failed to export typescript bindings");
}

/// Panics end up in the log file (release builds abort right after), so a
/// "Report a Problem" can include what happened.
fn log_panics() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}\n{}", std::backtrace::Backtrace::force_capture());
        log::logger().flush();
        default(info);
    }));
}

/// Dev builds run as `net.oxog.oxplorer.dev`: their settings, session, logs and
/// single-instance lock stay apart from an installed OXplorer, so `tauri dev`
/// and the self-test never touch the real appâs state.
fn context() -> tauri::Context<tauri::Wry> {
    let mut ctx = tauri::generate_context!();
    if cfg!(debug_assertions) {
        ctx.config_mut().identifier.push_str(".dev");
        // The self-test runs out of sight: its windows never show or take focus, and
        // WebKit mustn’t suspend their hidden pages.
        if self_test() {
            for w in &mut ctx.config_mut().app.windows {
                w.visible = false;
                w.focus = false;
                w.background_throttling = Some(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
                // README screenshots all have one size.
                if shots() {
                    (w.width, w.height) = (1360.0, 860.0);
                }
            }
        }
    }
    ctx
}

/// Remembers window sizes and places; the self-test's hidden windows stay hidden.
fn window_state() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_window_state::StateFlags;
    let flags = match (self_test(), shots()) {
        (_, true) => StateFlags::all() - StateFlags::VISIBLE - StateFlags::SIZE,
        (true, false) => StateFlags::all() - StateFlags::VISIBLE,
        _ => StateFlags::all(),
    };
    tauri_plugin_window_state::Builder::new().with_state_flags(flags).build()
}

/// Dev build started with `OX_SELFTEST_DIR` (or `OX_SHOTS_DIR`, which also runs out of sight).
fn self_test() -> bool {
    cfg!(debug_assertions) && (std::env::var_os("OX_SELFTEST_DIR").is_some() || shots())
}

/// Dev build taking the README screenshots (`scripts/screenshots.sh`).
fn shots() -> bool {
    cfg!(debug_assertions) && std::env::var_os("OX_SHOTS_DIR").is_some()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log_panics();
    let builder = specta_builder();

    #[cfg(debug_assertions)]
    export_bindings(&builder, "../src/bindings.ts");

    tauri::Builder::default()
        // Must be registered first so a second launch focuses the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(w) = windows::primary(app) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            system::request_open(app, system::paths_from_args(&args, &cwd));
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info })
                .build(),
        )
        .plugin(window_state())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(builder.invoke_handler())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::forward_event(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                release_window(window.app_handle(), window.label());
            }
        })
        // A reloaded page starts over: what the old page started has no listener.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                release_window(webview.app_handle(), webview.label());
            }
        })
        .register_asynchronous_uri_scheme_protocol(uri_scheme::SCHEME, uri_scheme::handle)
        .manage(system::OpenRequests::default())
        .manage(menu::MenuConfig::default())
        .setup(move |app| {
            builder.mount_events(app);
            if self_test() {
                // No Dock icon and no activation, so the user's front app keeps focus.
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            if let Some(window) = app.get_webview_window("main") {
                mac::quicklook::install(app.handle(), &window);
            }
            // The only stores the frontend may use: it gets them with `getStore`
            // and has no `store:allow-load`, which would read and write any path.
            {
                use tauri_plugin_store::StoreExt as _;
                // Keep in sync with `StoreFile` in src/lib/app-store-file.ts.
                for file in ["settings.json", "session.json", "folder-views.json", "recents.json"] {
                    app.store(file)?;
                }
            }
            app.manage(dir::DirWatcher::new(app.handle().clone())?);
            app.manage(std::sync::Arc::new(jobs::JobManager::default()));
            app.manage(std::sync::Arc::new(pty::PtyManager::default()));
            app.manage(std::sync::Arc::new(search::SearchManager::default()));
            app.manage(std::sync::Arc::new(usage::UsageScans::default()));
            Ok(())
        })
        .build(context())
        .expect("error while building OXplorer")
        .run(|app, event| {
            // Folders dropped on the Dock icon or sent with `open -a OXplorer <dir>`.
            if let tauri::RunEvent::Opened { urls } = event {
                system::request_open(app, urls.iter().filter_map(|u| u.to_file_path().ok()));
            }
        });
}

/// Ends what a window's page started: shells, folder watches, searches and
/// disk-usage scans. Channels to a page that is gone still accept messages, so
/// that work would otherwise run on unnoticed.
fn release_window(app: &tauri::AppHandle, label: &str) {
    if let Some(ptys) = app.try_state::<std::sync::Arc<pty::PtyManager>>() {
        ptys.close_window(label);
    }
    if let Some(watcher) = app.try_state::<dir::DirWatcher>() {
        watcher.release_window(label);
    }
    if let Some(searches) = app.try_state::<std::sync::Arc<search::SearchManager>>() {
        searches.cancel_window(label);
    }
    if let Some(scans) = app.try_state::<std::sync::Arc<usage::UsageScans>>() {
        scans.cancel_window(label);
    }
}

#[cfg(test)]
mod tests {
    /// `cargo test export_bindings` regenerates `src/bindings.ts` without launching the app.
    #[test]
    fn export_bindings() {
        super::export_bindings(&super::specta_builder(), "../src/bindings.ts");
    }
}
